import { ColoredComponent } from './ColoredComponent.js';
import { general, defaultColorMap, jmolColorMap} from '../store.js';
import { Spin } from './Spin.js';
import { Force } from './Force.js';
import { Polyhedra } from './Polyhedra.js';
import { Symmetry } from './Symmetry.js';
import {Stress} from './Stress.js';
import {Atom} from './Atom.js';

export class Structure extends ColoredComponent {
  constructor({
    elements = [],
    supercell = {},
    uniqueElements = [],
    lattice = [],
    atoms = [],
    symmetry = null,
    spins = [] ,
    forces = [],
    stress = null,
    polyhedra = null,
    colors = [],
    atomsGroup = null,
    latticeGroup = null,
  } = {}) {
    // Call parent constructor
    super({ colors, defaultColors });

    // Mutable instance properties
    this.elements = elements;
    this.supercell = supercell;
    this.uniqueElements = [...new Set(elements)];
    this.lattice = lattice;       // 3×3
    this.atoms = atoms;   // list of atoms 
    this.symmetry = symmetry;
    this.spins = spins; // list of spins
    this.forces = forces;// list of forces
    this.stress = stress;
    this.polyhedra = polyhedra;

    // Create an immutable snapshot of the original data
    this.original = Object.freeze({
      elements: [...elements],
      supercell: { ...supercell },
      uniqueElements: [...new Set(elements)],
      lattice: lattice.map(row => [...row]),  // deep copy
      atoms: [...atoms],
      spins: spins,
      forces: forces,
      stress: stress,
    });

  }
  get NumberOfAtoms() {
    return this.atoms.length;
    }

  validate() {
    if (this.atoms.length !== 3 * this.NumberOfAtoms)
      throw new Error("positions must be 3×N");

    if (this.lattice.length !== 9)
      throw new Error("lattice must be 3×3");

    if (this.elements !== this.NumberOfAtoms);
      throw new Error("elements must be N");

    if (this.defaultColors.length !== this.NumberOfAtoms);
      throw new Error("defaultColors must be N");
    }
  }

