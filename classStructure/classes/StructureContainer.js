import { Structure } from './Structure.js';
import { Spin } from './Spin.js';
import { Forces } from './Forces.js';
import { Polyhedra } from './Polyhedra.js';
import { Symmetry } from './Symmetry.js';
import {Stress} from './Stress.js';

export class StructureContainer {
  constructor({
    fileName = null,
    structures = [],
    symmetries = [],
    spins = [],
    forces = [],
    stresses = [],
    polyhedra = []
  } = {}) {
    this.fileName = fileName ? fileName : "Unspecified";
    this.structures = this._ensureListOfClass(structures, Structure);
    this.symmetries = this._ensureListOfClass(symmetries, Symmetry);
    this.spins = this._ensureListOfClass(spins, Spin);
    this.forces = this._ensureListOfClass(forces, Forces);
    this.stresses = this._ensureListOfClass(stresses, Stress)
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

