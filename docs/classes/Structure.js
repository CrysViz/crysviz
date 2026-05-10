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
    bonds = [],
    atoms = [],
    symmetry = null,
    spins = [],
    forces = [],
    stress = null,
    polyhedra = null,
    colors = [],
    bondMapping = {},
    bondObjectMapping = {},
    atomImages = {},
    periodic = {}, // Accept periodic as an input
    volumetricFields = null,
    planes = [],
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
    this.bondMapping={};
    this.bondObjectMapping={};
    this.bonds = bonds;           // list of bonds
    this.periodic = periodic;     // Initialize periodic
    this.atomImages = {};
    this.planes = planes;

    // Calculate periodic wrapped positions for atoms in-place

    // Build bond objects if not provided
    this.bonds = bonds
    this.volumetricFields = volumetricFields;
        // Create an immutable snapshot of the original data
    this.original = deepFreeze({
      elements: [...elements],
      supercell: { ...supercell },
      uniqueElements: [...new Set(elements)],
      lattice: lattice.map(row => [...row]),  // deep copy of lattice array
      atoms: deepCopyArrayOfObjects(atoms),   // deep copy of atom objects
      spins: deepCopyArrayOfObjects(spins),   // deep copy of spin objects
      forces: deepCopyArrayOfObjects(forces), // deep copy of force objects
      stress: stress ? { ...stress } : null,  // deep copy of stress object if it exists
      polyhedra: polyhedra ? { ...polyhedra } : null,
      colors: [...colors],
      bonds: deepCopyArrayOfObjects(this.bonds), // deep copy of bond objects
      planes: deepCopyArrayOfObjects(planes),
    });

  }
  getDefaultElementColor(element) {
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    return colorScheme[element] || 0x808080;
  }
  getElementColors() {
    const elementColors = {};
    this.atoms.forEach((atom, index) => {
      const element = this.elements[index];
      if (!element || elementColors[element] !== undefined) return;
      elementColors[element] = atom.getColor();
    });
    return elementColors;
  }
}  

