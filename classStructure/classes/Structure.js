import { general, defaultColorMap, jmolColorMap } from '../store.js';
import { Spin } from './Spin.js';
import { Force } from './Force.js';
import { Polyhedra } from './Polyhedra.js';
import { Symmetry } from './Symmetry.js';
import { Stress } from './Stress.js';
import { Atom } from './Atom.js';


// Helper function to deep freeze objects
function deepFreeze(object) {
  if (object === null || typeof object !== 'object') {
    return object;
  }

  Object.getOwnPropertyNames(object).forEach(prop => {
    const value = object[prop];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });

  return Object.freeze(object);
}

function deepCopyArrayOfObjects(array) {
  if (!array) return null;
  return array.map(item => ({ ...item }));
}


export class Structure {
  constructor({
    elements = [],
    supercell = {},
    uniqueElements = [],
    lattice = [],
    atoms = [],
    symmetry = null,
    spins = [],
    forces = [],
    stress = null,
    polyhedra = null,
    colors = [],
    NeighborMap = {},
  } = {}) {
    // Mutable instance properties
    this.elements = elements;
    this.supercell = supercell;
    this.uniqueElements = [...new Set(elements)];
    this.lattice = lattice;       // 3×3
    this.atoms = atoms;           // list of atoms
    this.symmetry = symmetry;
    this.spins = spins;           // list of spins
    this.forces = forces;         // list of forces
    this.stress = stress;
    this.polyhedra = polyhedra;
    this.colors = colors;
    this.NeighborMap = {};
        // Create an immutable snapshot of the original data
    this.original = deepFreeze({
      elements: [...elements],
      supercell: { ...supercell },
      uniqueElements: [...new Set(elements)],
      lattice: lattice.map(row => [...row]),  // deep copy of lattice array
      atoms: deepCopyArrayOfObjects(atoms),  // deep copy of atom objects
      spins: deepCopyArrayOfObjects(spins),  // deep copy of spin objects
      forces: deepCopyArrayOfObjects(forces), // deep copy of force objects
      //stress: stress ? { ...stress } : null, // deep copy of stress object if it exists
      //polyhedra: polyhedra ? { ...polyhedra } : null,
      colors: [...colors],
      //NeighborMap: NeighborMap,
    });


    // Undo/Redo functionality
    this.history = []; // Stack to store snapshots for undo
    this.future = [];  // Stack to store snapshots for redo
    this.maxHistoryLength = 10; // Limit the number of stored snapshots
  }

  get NumberOfAtoms() {
    return this.atoms.length;
  }

  get ucNumberOfAtoms() {
    return this.ucatoms.length;
  }

  validate() {
    if (this.atoms.length !== this.NumberOfAtoms) {
      throw new Error("Atoms array length is inconsistent");
    }

    if (this.lattice.length !== 3 || this.lattice.some(row => row.length !== 3)) {
      throw new Error("Lattice must be 3×3");
    }

    if (this.elements.length !== this.NumberOfAtoms) {
      throw new Error("Elements must be N");
    }

    if (this.colors.length !== this.NumberOfAtoms) {
      throw new Error("Colors must be N");
    }
  }

}

