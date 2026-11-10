// Element classes used by structure heuristics.
//
// Metals, for "Complete Rings & Fragments": a bond to a metal does not hold a
// fragment together for display purposes. Without this, the Ca–O bonds in calcite join
// every CO3 into one infinite network and no carbonate is ever completed; the
// same goes for sulfates, ammonium, and the organic linkers of a MOF. Alkali,
// alkaline-earth, d- and f-block, and the post-transition metals count; the
// metalloids (B, Si, Ge, As, Sb, Te) do not, since their bonds are covalent.
export const METALS = new Set([
  'Li', 'Be', 'Na', 'Mg', 'Al', 'K', 'Ca', 'Rb', 'Sr', 'Cs', 'Ba', 'Fr', 'Ra',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd',
  'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn',
  'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
  'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr',
  'Ga', 'In', 'Sn', 'Tl', 'Pb', 'Bi', 'Po', 'Nh', 'Fl', 'Mc', 'Lv',
]);

/** @param {string} element symbol, possibly with a label suffix ("Fe1", "Fe_up") */
export function isMetal(element) {
  const m = /^[A-Z][a-z]?/.exec(String(element));
  return !!m && METALS.has(m[0]);
}
