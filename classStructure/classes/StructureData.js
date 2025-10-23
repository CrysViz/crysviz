import { Structure } from './Structure.js';
import { Spin } from './Spin.js';
import { Forces } from './Forces.js';
import { Polyhedra } from './Polyhedra.js';
import { Symmetry } from './Symmetry.js';

class StructureData {
  constructor({
    structure = {},
    symmetry = {},
    spin = {},
    forces = {},
    polyhedra = {},
  } = {}) {
    this.structure = structure instanceof Structure ? structure : new Structure(structure);
    this.symmetry = symmetry instanceof Symmetry ? symmetry : new Symmetry(symmetry);
    this.spin = spin instanceof Spin ? spin : new Spin(spin);
    this.forces = forces instanceof Forces ? forces : new Forces(forces);
    this.polyhedra = polyhedra instanceof Polyhedra ? polyhedra : new Polyhedra(polyhedra);
  }

  validate() {
    this.structure.validate();
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

