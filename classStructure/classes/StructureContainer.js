import { Structure } from './Structure.js';

export class StructureContainer {
  constructor({
    fileName = null,
    structures = [],
    finalSCF = false,
  } = {}) {
    this.fileName = fileName ? fileName : "Unspecified";
    this.structures = this._ensureListOfClass(structures, Structure);
    this.finalSCF=finalSCF;
  }

  _ensureListOfClass(input, ClassType) {
    if (!Array.isArray(input)) {
      input = [input];
    }

    return input.map(item =>
      item instanceof ClassType ? item : new ClassType(item)
    );
  }
}
