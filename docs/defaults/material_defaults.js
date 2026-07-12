// Per-element ray/path-tracing material presets — the "CrysViz Default" entry
// of the "Element Materials Map" dropdown (Visual → Colors, ui/ColorPanel.js,
// general.elementMaterialsMap). Consumed as the LAST fallback of the tracer
// material cascade (per-copy > per-atom > per-species > this map) via
// Structure.getDefaultElementMaterial(); elements absent here keep the plain
// standard default (SceneEncoder's DEFAULT_MATERIAL_TEXEL). Material object
// shape: see model/Structure.js atomMaterials.
//
// The scheme follows periodic-table categories; the s/d/p division shows up
// as metal roughness grades (soft s-block dull → d-block shiny → p-block in
// between). Noble gases render as near-vacuum glass bubbles.

/** @type {Array<[string[], {type: string, gloss?: number, tint?: number, roughness?: number, frost?: number, ior?: number, tintDepth?: number, intensity?: number, scatterDepth?: number, reflectivity?: number}]>} */
const CATEGORIES = [
  // Alkali metals (s¹) — soft, dull metal
  [['Li', 'Na', 'K', 'Rb', 'Cs', 'Fr'],
    { type: 'metal', roughness: 0.4 }],
  // Alkaline earth (s²)
  [['Be', 'Mg', 'Ca', 'Sr', 'Ba', 'Ra'],
    { type: 'metal', roughness: 0.3 }],
  // Transition metals (d-block, minus the polished row below)
  [['Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Zn',
    'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Cd',
    'Hf', 'Ta', 'W', 'Re', 'Hg',
    'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn'],
    { type: 'metal', roughness: 0.18 }],
  // Polished noble/coinage metals — mirror finish
  [['Cu', 'Ru', 'Rh', 'Pd', 'Ag', 'Os', 'Ir', 'Pt', 'Au'],
    { type: 'metal', roughness: 0.05 }],
  // Lanthanides + actinides
  [['La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
    'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr'],
    { type: 'metal', roughness: 0.22 }],
  // Post-transition metals (p-block)
  [['Al', 'Ga', 'In', 'Sn', 'Tl', 'Pb', 'Bi', 'Po', 'Nh', 'Fl', 'Mc', 'Lv'],
    { type: 'metal', roughness: 0.28 }],
  // Metalloids — glassy semiconductor sheen
  [['B', 'Si', 'Ge', 'As', 'Sb', 'Te', 'At', 'Ts'],
    { type: 'standard', gloss: 0.85, tint: 0.8, reflectivity: 0.3 }],
  // Nonmetals — slightly matte, classic
  [['H', 'D', 'C', 'N', 'O', 'P', 'S', 'Se'],
    { type: 'standard', gloss: 0.5 }],
  // Halogens — waxy
  [['F', 'Cl', 'Br', 'I'],
    { type: 'translucent', scatterDepth: 0.4 }],
  // Noble gases — clear glass bubble
  [['He', 'Ne', 'Ar', 'Kr', 'Xe', 'Rn', 'Og'],
    { type: 'glass', ior: 1.05, frost: 0, tintDepth: 0.1 }],
];

/** @type {Object<string, {type: string, gloss?: number, tint?: number, roughness?: number, frost?: number, ior?: number, tintDepth?: number, intensity?: number, scatterDepth?: number, reflectivity?: number}>} */
export const crysvizMaterialMap = Object.freeze(Object.fromEntries(
  CATEGORIES.flatMap(([elements, material]) =>
    elements.map((el) => [el, Object.freeze({ ...material })]))));
