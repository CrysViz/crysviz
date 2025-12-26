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

// Helper function to deep copy arrays of objects
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
    atomsGroup = null,
    latticeGroup = null,
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
    this.atomsGroup = atomsGroup;
    this.latticeGroup = latticeGroup;

    // Create an immutable snapshot of the original data
    this.original = deepFreeze({
      elements: [...elements],
      supercell: { ...supercell },
      uniqueElements: [...new Set(elements)],
      lattice: lattice.map(row => [...row]),  // deep copy of lattice array
      atoms: deepCopyArrayOfObjects(atoms),  // deep copy of atom objects
      spins: deepCopyArrayOfObjects(spins),  // deep copy of spin objects
      forces: deepCopyArrayOfObjects(forces), // deep copy of force objects
      stress: stress ? { ...stress } : null, // deep copy of stress object if it exists
      polyhedra: polyhedra ? { ...polyhedra } : null,
      colors: [...colors],
    });

    // Undo/Redo functionality
    this.history = []; // Stack to store snapshots for undo
    this.future = [];  // Stack to store snapshots for redo
    this.maxHistoryLength = 10; // Limit the number of stored snapshots
    this.saveSnapshot(); // Save the initial state
  }

  get NumberOfAtoms() {
    return this.atoms.length;
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

  // Save the current state as a snapshot
  saveSnapshot() {
    const snapshot = deepFreeze({
      elements: [...this.elements],
      supercell: { ...this.supercell },
      uniqueElements: [...this.uniqueElements],
      lattice: this.lattice.map(row => [...row]),
      atoms: deepCopyArrayOfObjects(this.atoms),
      spins: deepCopyArrayOfObjects(this.spins),
      forces: deepCopyArrayOfObjects(this.forces),
      stress: this.stress ? { ...this.stress } : null,
      polyhedra: this.polyhedra ? { ...this.polyhedra } : null,
      colors: [...this.colors],
    });

    this.history.push(snapshot);

    // Limit the history length
    if (this.history.length > this.maxHistoryLength) {
      this.history.shift(); // Remove the oldest snapshot
    }

    this.future = []; // Clear the redo stack on new action
  }

  // Undo the last action
  undo() {
    if (this.history.length <= 1) return; // No states to undo

    this.future.push({ ...this.state() }); // Save current state for redo
    const previousState = this.history[this.history.length - 2];
    this.restoreState(previousState);
    this.history.pop(); // Remove the current state from history
  }

  // Redo the last undone action
  redo() {
    if (this.future.length === 0) return;

    const nextState = this.future.pop();
    this.saveSnapshot(); // Save current state before redoing
    this.restoreState(nextState);
  }

  // Restore the state from a snapshot
  restoreState(snapshot) {
    this.elements = [...snapshot.elements];
    this.supercell = { ...snapshot.supercell };
    this.uniqueElements = [...snapshot.uniqueElements];
    this.lattice = snapshot.lattice.map(row => [...row]);
    this.atoms = deepCopyArrayOfObjects(snapshot.atoms);
    this.spins = deepCopyArrayOfObjects(snapshot.spins);
    this.forces = deepCopyArrayOfObjects(snapshot.forces);
    this.stress = snapshot.stress ? { ...snapshot.stress } : null;
    this.polyhedra = snapshot.polyhedra ? { ...snapshot.polyhedra } : null;
    this.colors = [...snapshot.colors];
  }

  // Get the current state as an object
  state() {
    return {
      elements: [...this.elements],
      supercell: { ...this.supercell },
      uniqueElements: [...this.uniqueElements],
      lattice: this.lattice.map(row => [...row]),
      atoms: deepCopyArrayOfObjects(this.atoms),
      spins: deepCopyArrayOfObjects(this.spins),
      forces: deepCopyArrayOfObjects(this.forces),
      stress: this.stress ? { ...this.stress } : null,
      polyhedra: this.polyhedra ? { ...this.polyhedra } : null,
      colors: [...this.colors],
    };
  }

  // Modify a property and save a snapshot
  modify(propertyPath, newValue) {
    const path = propertyPath.split('.');
    let current = this;

    for (let i = 0; i < path.length - 1; i++) {
      current = current[path[i]];
    }

    current[path[path.length - 1]] = newValue;
    this.saveSnapshot();
  }
}

