import { Structure } from './Structure.js';
import { Spin } from './Spin.js';
import { Forces } from './Forces.js';
import { Polyhedra } from './Polyhedra.js';
import { Symmetry } from './Symmetry.js';

export class StructureData {
  constructor({
    id = [],
    structure = [],
    symmetry = [],
    spin = [],
    forces = [],
    polyhedra = []
  } = {}) {
    this.id = id
    this.structure = this._ensureListOfClass(structure, Structure);
    this.symmetry = this._ensureListOfClass(symmetry, Symmetry);
    this.spin = this._ensureListOfClass(spin, Spin);
    this.forces = this._ensureListOfClass(forces, Forces);
    this.polyhedra = this._ensureListOfClass(polyhedra, Polyhedra);
  }

  _ensureListOfClass(input, ClassType) {
    if (!Array.isArray(input)) {
      input = [input];
    }

    return input.map(item =>
      item instanceof ClassType ? item : new ClassType(item)
    );
  }

  toJSON() {
    return {
      structure: this.structure,
      symmetry: this.symmetry,
      spin: this.spin,
      forces: this.forces,
      polyhedra: {
        items: this.polyhedra.items.map(p => ({ ...p })),
        colors: this.polyhedra.colors,
      },
    };
  }
}

