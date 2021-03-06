import Component from './Component';
import Entity from './Entity';
import Aspect from './Aspect';

export default class World {
  constructor(name, db, systems = [], actionHandlers = []) {
    this.name = name;
    this.entityCollection = db.addCollection('entities', {
      disableChangesApi: false,
      indices: ['id'],
      unique: ['id'],
      clone: true,
      cloneMethod: 'shallow',
    });
    this.componentCollection = db.addCollection('components', {
      disableChangesApi: false,
      indices: ['name'],
      unique: ['name'],
      clone: true,
      cloneMethod: 'shallow',
    });
    this.systems = systems;
    this.actionHandlers = actionHandlers;

    // cache a list of the names of local components for easy filtration
    this.localComponents = [];
  }

  aspect(filter) {
    return new Aspect(this, filter);
  }

  /**
   * Returns an {Entity} based on its ID.
   * More than one ID can be provided in the parameters.
   * If more than one ID is provided, this will return a list of {Entity}s
   * @returns {Entity|null}
   * @param entityIds
   */
  get(...entityIds) {
    const entities = entityIds.map(id => this.constructEntityObj(id));

    return entities.length === 1 ? entities[0] : entities;
  }

  /**
   * Adds or updates an {Entity}
   * More than one entity can be provided in the parameters.
   * If more than one {Entity} is provided, this will add every {Entity} listed.
   * @param entities
   */
  put(...entities) {
    entities.forEach((entity) => {
      const docs = this.deconstructEntityObj(entity);
      // no meta and no loki id means this doc isn't already in storage
      if (!(docs.entityDoc.meta && docs.entityDoc.$loki)) {
        this.entityCollection.insert(docs.entityDoc);
      }

      docs.componentDocs.forEach((componentDoc) => {
        // no meta and no loki id means this doc isn't already in storage
        if (!(componentDoc.meta && componentDoc.$loki)) {
          if (componentDoc.local) this.localComponents.push(componentDoc.name);
          this.componentCollection.insert(componentDoc);
          return;
        }
        this.componentCollection.update(componentDoc);
      });
    });
  }

  /**
   * Deletes an existing entity from the database based on its entity ID.
   * @param entityId
   */
  delete(entityId) {
    const entity = this.entityCollection.by('id', entityId);
    if (entity === null) return;

    entity.components.forEach((component) => {
      const existingComponent = this.componentCollection.by('name', component);
      delete existingComponent.values[entityId];
      this.componentCollection.update(existingComponent);
    });

    this.entityCollection.remove(entity);
  }

  /**
   * Ticks all the systems.
   */
  tick() {
    this.systems.forEach(system => system(this.getEntities()));
  }

  /**
   * Returns a list of changes to the entity and component databases.
   * @returns {{components, entities}}
   */
  getChanges(includeLocal = false) {
    const changes = {
      entities: this.entityCollection.getChanges(),
      components: this.componentCollection.getChanges(),
    };

    if (!includeLocal) {
      changes.entities.forEach((operation) => {
        const entity = operation.obj;
        entity.components = entity.components.filter(name => !this.localComponents.includes(name));
      });
      changes.components = changes.components.filter(operation => !operation.obj.local);
      return changes;
    }
    return changes;
  }

  getEntities() {
    return this.get(...this.entityCollection.extract('id'));
  }

  /**
   * Flushes the list of changes generated by the entity and component databases.
   * Do this after broadcasting the changes to clients.
   */
  clearChanges() {
    this.entityCollection.flushChanges();
    this.componentCollection.flushChanges();
  }

  constructEntityObj(entityId) {
    const entityDoc = this.entityCollection.by('id', entityId);
    const { autoUpdate } = entityDoc;
    let entity = new Entity([], entityDoc.tags, autoUpdate, entityDoc.id);
    entityDoc.components.forEach((name) => {
      const componentDoc = this.componentCollection.by('name', name);
      const values = componentDoc.values[entityId];
      const component = new Component(
        componentDoc.name,
        autoUpdate ? this.autoUpdateProxy(entity, values) : values,
        componentDoc.local,
      );
      entity.components[componentDoc.name] = autoUpdate ? this.autoUpdateProxy(entity, component)
        : component;
    });
    entity = autoUpdate ? this.autoUpdateProxy(entity, entity) : entity;
    return entity;
  }

  deconstructEntityObj(entity) {
    const componentDocs = [];
    const entityDoc = this.entityCollection.by('id', entity.id) || {
      id: entity.id,
      components: [],
      tags: [],
      autoUpdate: entity.autoUpdate,
    };
    entityDoc.components = Object.keys(entity.components);
    entityDoc.tags = entity.tags;

    // set up all component docs
    entityDoc.components.forEach((name) => {
      const component = this.componentCollection.by('name', name) || {
        name,
        values: {},
        local: entity.components[name].local,
      };
      component.values[entity.id] = { ...entity.components[name].values };
      componentDocs.push(component);
    });

    return {
      componentDocs,
      entityDoc,
    };
  }

  autoUpdateProxy(entity, obj) {
    const handler = {
      set: (target, key, value) => {
        const reassigned = target;
        reassigned[key] = value;
        this.put(entity);
      },
    };

    return new Proxy(obj, handler);
  }
}
