import {general} from '../store.js';
import {defaultColorMap, jmolColorMap} from '../defaults/color_texture_defaults.js'
import { colorHexToCss } from '../ui/ColorModule.js';

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
    bondMapping = {}, // Mapping from bond index number to the indices in the THREE mesh object.
    bondObjectMapping = {},     // Lookup table from bondHalf to the actual bond objects stored in the structure.  Mainly necessary for color changes . 
    atomImages = {}, // stores all images in the visualisation for each object. Meaning the index of the atom maps to all indices in the THREE mesh
    bondhalfToAtom={}, //  Mapping from the index of a bond half to the index of the respective atom. Neccessary for color updates. 
    periodic = {}, // Accept periodic as an input
    volumetricFields = null,
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
    this.bondMapping={};
    this.bondObjectMapping={};
    this.bonds = bonds;           // list of bonds
    this.periodic = periodic;     // Initialize periodic
    this.atomImages = {};

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
      bonds: deepCopyArrayOfObjects(this.bonds), // deep copy of bond objects
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
      if (!element) return;
      elementColors[element] ||= [];
      const color = colorHexToCss(atom.getColor());
      if (!elementColors[element].includes(color)) {
        elementColors[element].push(color);
      }
    });
    return elementColors;
  }

  getElementOpacities() {
    const elementOpacities = {};
    this.atoms.forEach((atom, index) => {
      const element = this.elements[index];
      if (!element) return;
      elementOpacities[element] ||= [];
      const opacity = atom.getOpacity?.() ?? atom.opacity ?? 1;
      if (!elementOpacities[element].includes(opacity)) {
        elementOpacities[element].push(opacity);
      }
    });
    return elementOpacities;
  }
}  
