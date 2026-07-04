import {general} from '../state/store.js';
import {defaultColorMap, jmolColorMap} from '../defaults/color_texture_defaults.js'
import { colorHexToCss } from '../utils/ColorModule.js';

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

function normalizePolyhedraSettings(settings = null) {
  return {
    useChemicalFilter: settings?.useChemicalFilter !== false,
    detectCages: settings?.detectCages !== false,
  };
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
    polyhedraSettings = null,
    bondMapping = {}, // Mapping from bond index number to the indices in the THREE mesh object.
    bondObjectMapping = {},     // Lookup table from bondHalf to the actual bond objects stored in the structure.  Mainly necessary for color changes . 
    atomImages = {}, // stores all images in the visualisation for each object. Meaning the index of the atom maps to all indices in the THREE mesh
    bondhalfToAtom={}, //  Mapping from the index of a bond half to the index of the respective atom. Neccessary for color updates. 
    periodic = {}, // Accept periodic as an input
    volumetricFields = null,
    planes = [],
  } = {}) {
    // Mutable instance properties
    this.elements = elements;
    this.supercell = supercell;
    // NOTE: uniqueElements is always derived from `elements`; the
    // `uniqueElements` constructor argument is intentionally ignored.
    this.uniqueElements = [...new Set(elements)];
    this.lattice = lattice;       // 3×3
    this.atoms = atoms;           // list of atoms
    this.symmetry = symmetry;
    this.spins = spins;           // list of spins
    this.forces = forces;         // list of forces
    this.stress = stress;
    this.polyhedra = polyhedra;
    this.polyhedraSettings = normalizePolyhedraSettings(polyhedraSettings);
    // NOTE: the bond/atom-image lookup maps are populated later by the bonds/
    // atoms render-update modules, so they always start empty here and the
    // matching constructor arguments (bondMapping, bondObjectMapping,
    // atomImages, bondhalfToAtom) are intentionally ignored. bondhalfToAtom is
    // not stored on the instance at all until those modules build it.
    this.bondMapping={};
    this.bondObjectMapping={};
    this.bonds = bonds;           // list of bonds
    // Per-bond user style overrides, keyed by bondKey(bond.indices)
    // ("min_max" of the wrapped-index pair) -> { color?, alpha?, radiusScale?,
    // elements }. Unlike the maps above this intentionally SURVIVES bond
    // rebuilds so user-picked bond styles persist across length-slider changes
    // and re-renders. Keys go stale if the wrapped set changes (supercell/PBC/
    // atom edits); the stored elements pair guards against misapplication and
    // stale entries are simply ignored.
    this.bondUserStyles = {};
    // Per-polyhedron / per-polyhedron-category user style overrides, keyed by
    // the stable keys computed in render/PolyhedraModule.js (assignPolyhedraKeys):
    // polyhedraUserStyles[polyKey] -> { color?, alpha? } and
    // polyhedraCategoryStyles[catKey] -> { color?, alpha?, visible? }.
    // Like bondUserStyles these intentionally SURVIVE the (frequent, async)
    // polyhedra rebuilds; keys go stale if atoms/lattice change and stale
    // entries are simply ignored.
    this.polyhedraUserStyles = {};
    this.polyhedraCategoryStyles = {};
    // Per-periodic-copy atom style overrides, keyed by atomImageKey()
    // ("srcIndex:dx,dy,dz", computed in render/AtomsFracUpdateModule.js
    // finishAtomsMesh) -> { element, color?, alpha?, radiusScale? }. Used by the
    // Atoms tab when "Link periodic copies" is off. SURVIVES atom rebuilds;
    // stale keys (changed wrapped set) are ignored via the element check.
    this.atomImageStyles = {};
    this.periodic = periodic;     // Initialize periodic
    this.atomImages = {};
    this.planes = planes;
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
      polyhedraSettings: { ...this.polyhedraSettings },
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
