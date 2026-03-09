import { StructureContainer } from './StructureContainer.js';

export class StructureShip {
  len = null;
  container = [];

  constructor({ container = [] } = {}) {
    this.container = this._ensureListOfClass(container, StructureContainer);
    this.len = this.container.length;
  }

  _ensureListOfClass(list, ClassRef) {
    return list.map(item => (item instanceof ClassRef ? item : new ClassRef(item)));
  }
}

