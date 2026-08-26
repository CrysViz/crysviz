import { general } from '../state/store.js';

// Display/bonding radii in angstroms. The heavy elements follow Cordero et al.
// (2008) single-bond covalent radii (low-spin values for the transition
// metals); H is kept a little larger than its true covalent radius (0.31) so
// the sphere still reads clearly against the fixed-width bond cylinders in
// ball-and-stick mode (the same reason VESTA uses ~0.46 for H). He is set to
// 0.45 - a visible ball, and just under H so the lightest two elements keep
// the expected size order (its true covalent radius, 0.28, is too small).
export const atomicRadii = {
  H: 0.5, He: 0.45, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06,
  K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24,
  Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16,
  Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39,
  Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.40,
  Cs: 2.44, Ba: 2.15, La: 2.07, Ce: 2.04, Pr: 2.03, Nd: 2.01, Pm: 1.99, Sm: 1.98, Eu: 1.98, Gd: 1.96,
  Tb: 1.94, Dy: 1.92, Ho: 1.92, Er: 1.89, Tm: 1.90, Yb: 1.87, Lu: 1.87,
  Hf: 1.75, Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32,
  Tl: 1.45, Pb: 1.46, Bi: 1.48, Po: 1.40, At: 1.50, Rn: 1.50,
  // Period 7. Fr-Cm are Cordero (2008); the later actinides (Bk-Lr), which
  // Cordero does not tabulate and which essentially never appear in real
  // structures, use commonly-listed single-bond covalent radii so they no
  // longer fall back to the generic 1.0 A default.
  Fr: 2.60, Ra: 2.21, Ac: 2.15, Th: 2.06, Pa: 2.00, U: 1.96, Np: 1.90, Pu: 1.87, Am: 1.80, Cm: 1.69,
  Bk: 1.68, Cf: 1.68, Es: 1.65, Fm: 1.67, Md: 1.73, No: 1.76, Lr: 1.61,
}; // atomic radii in angstroms

// Single source of truth for "what base radius should this element use": a
// user-defined override (general.customAtomicRadii, see
// CustomUserSettingsPanel.js) wins if set, otherwise the built-in table,
// falling back to 1.0 Å for anything unlisted.
export function getElementRadius(element) {
  return general.customAtomicRadii?.[element] ?? atomicRadii[element] ?? 1.0;
}

// Default bond-cutoff tolerance: a pair's default max bond length is the summed
// display radii scaled by this factor. Greater than 1 because the covalent-
// based radii sum to roughly a single-bond length, so a bare sum (×1.0) sits
// right at the bond distance and misses slightly longer real bonds — e.g. C–C
// at 1.54 Å vs a summed radius of 1.52 Å. ~1.2 catches ordinary bonds with a
// small margin without reaching non-bonded neighbours.
export const BOND_CUTOFF_SCALE = 1.2;

/** Default maximum bond-length cutoff (Å) for an element pair: the summed
 *  display radii scaled by BOND_CUTOFF_SCALE, capped at 6 Å. Single source for
 *  every place that seeds a pair's default bond range, so the tolerance stays
 *  consistent across the bond builder, the Bonds panel and the overlay bonds. */
export function getDefaultBondCutoff(elementA, elementB) {
  return Math.min((getElementRadius(elementA) + getElementRadius(elementB)) * BOND_CUTOFF_SCALE, 6.0);
}
