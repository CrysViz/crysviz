import {general} from '../state/store.js';
import {defaultColorMap, jmolColorMap} from '../defaults/color_texture_defaults.js'
import {crysvizMaterialMap} from '../defaults/material_defaults.js'
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
    energy = null,
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
    // True as-loaded spins snapshot, captured once here rather than lazily by
    // SpinPanel.js's "Overwrite Structure" button — so "Restore" always has
    // something to restore to, even if Overwrite was never clicked. An empty
    // array (not null/undefined) when the structure had no spins at load, so
    // Restore correctly empties structure.spins back out rather than no-op'ing.
    this.originalSpins = spins.map(spin => ({
      vector: [...(spin.vector ?? [0, 0, 0])],
      scaling: spin.scaling,
      color: spin.color,
      atomIndex: spin.atomIndex,
      element: spin.element,
      position: spin.position ? [...spin.position] : null,
    }));
    this.stress = stress;
    this.energy = energy ?? null; // per-frame free energy in eV; null when unknown
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
    // bondCategoryStyles["El1-El2"] -> { color?, alpha?, radiusScale? }.
    // Category-level styling from the Bonds tab header dot; per-copy
    // bondUserStyles win over these. Survives bond rebuilds like bondUserStyles.
    this.bondCategoryStyles = {};
    // Per-polyhedron / per-polyhedron-category user style overrides, keyed by
    // the stable keys computed in render/PolyhedraModule.js (assignPolyhedraKeys):
    // polyhedraUserStyles[polyKey] -> { color?, alpha?, edgeColor?, edgeAlpha? } and
    // polyhedraCategoryStyles[catKey] -> { color?, alpha?, edgeColor?, edgeAlpha?, visible? }.
    // Like bondUserStyles these intentionally SURVIVE the (frequent, async)
    // polyhedra rebuilds; keys go stale if atoms/lattice change and stale
    // entries are simply ignored.
    this.polyhedraUserStyles = {};
    this.polyhedraCategoryStyles = {};
    // Ray/path-tracing materials: { type: 'standard'|'metal'|'glass'|
    // 'emissive', gloss?, tint?, roughness?, ior?, intensity?, reflectivity? }
    // — reflectivity (when set) overrides the global "Reflectivity" slider for
    // that object; tint (standard) colors the coat reflections by the surface
    // color (0.6 default, 0 = untinted white).
    // Per-SPECIES: atomMaterials[element]; per-ATOM override:
    // atomUserMaterials[atomIndex] (wins over the species entry). Bond and
    // polyhedra materials live as `material` sub-objects on
    // bondCategoryStyles/bondUserStyles and polyhedraCategoryStyles/
    // polyhedraUserStyles (individual wins over category). Only read by the
    // raytrace/pathtrace pipelines (render/pipeline/raytrace/SceneEncoder.js).
    this.atomMaterials = {};
    this.atomUserMaterials = {};
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
      energy: energy ?? null,                 // per-frame free energy in eV; null when unknown
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
  // Element-material analog of getDefaultElementColor: the per-species tracer
  // material the active "Element Materials Map" assigns, or null (= the plain
  // standard default). Sits BELOW atomMaterials/atomUserMaterials in the
  // SceneEncoder cascade; the returned object is frozen — treat as read-only.
  getDefaultElementMaterial(element) {
    if (general.elementMaterialsMap !== 'crysviz') return null;
    return crysvizMaterialMap[element] ?? null;
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
