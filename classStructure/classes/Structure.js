import { general, defaultColorMap, jmolColorMap } from '../store.js';
import { Spin } from './Spin.js';
import { Force } from './Force.js';
import { Polyhedra } from './Polyhedra.js';
import { Symmetry } from './Symmetry.js';
import { Stress } from './Stress.js';
import { Atom } from './Atom.js';


export class Structure {
  constructor({
    elements = [],
    ucelements = [],
    supercell = {},
    uniqueElements = [],
    lattice = [],
    atoms = [],
    ucatoms = [],
    symmetry = null,
    spins = [],
    ucspins = [],
    forces = [],
    ucforces = [],
    stress = null,
    polyhedra = null,
    colors = [],
    atomsGroup = null,
    latticeGroup = null,
    NeighborMap = {},
  } = {}) {
    // Mutable instance properties
    this.elements = elements;
    this.ucelements = ucelements;
    this.supercell = supercell;
    this.uniqueElements = [...new Set(elements)];
    this.lattice = lattice;       // 3×3
    this.atoms = atoms;           // list of atoms
    this.ucatoms = ucatoms;           // list of atoms
    this.symmetry = symmetry;
    this.spins = spins;           // list of spins
    this.ucspins = ucspins;           // list of spins
    this.forces = forces;         // list of forces
    this.ucforces = ucforces;         // list of forces
    this.stress = stress;
    this.polyhedra = polyhedra;
    this.colors = colors;
    this.atomsGroup = atomsGroup;
    this.latticeGroup = latticeGroup;
    this.NeighborMap = {};


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

