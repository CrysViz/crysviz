// The bond breaking tolerance of MD / trajectory playback
// (general.bondBreakTolerance, Features ▸ Bond breaking tolerance).
//
// A bond — and the polyhedron corner with it — that exists keeps existing
// until its length exceeds cutoff × (1 + tol); one that does not exist forms
// once its length is within the plain cutoff (model/bondBreakTolerance.js).
// Thermal vibration of a bond about its cutoff then no longer makes the bond
// and the corner flicker, while a bond that really breaks still breaks.
//
// Per frame the rule is applied by render/PlaybackBondsModule.js (a `drawn`
// bit per pair) and render/PolyhedraFrameModule.js (a row's active corners).
// What this module adds is the memory ACROSS a full rebuild: a rebuild finds
// bonds with the strict cutoff, so a bond held only by the tolerance would
// vanish at every rebuild (every 20th frame). The playback bond state
// registers itself here (setBondToleranceSource); the next bond build
// (BondsFracUpdateModule.buildBondObjects) asks for the pairs drawn in the
// last frame (heldBondKeys) and keeps those of them still within the
// widened cutoff. The polyhedra keep theirs in the previous table's
// topology (PolyhedraFrameModule.mergeToleranceHeldPolyhedra).
//
// The memory lives on the structure object, so another structure (a fresh
// load) never sees it; it is dropped at tol = 0, when the bond cutoffs
// change (a cutoff edit means the new cutoff, strictly) and when the atoms
// change (a supercell).

import { general, BOND_BREAK_TOLERANCE_MAX } from '../state/store.js';
import { bondPairKey } from '../model/bondBreakTolerance.js';

/** Largest widening (Å) of a cutoff by the tolerance: the playback candidate
 *  list (PlaybackBondsModule.js BOND_SKIN) covers cutoff + 1 Å, so a held
 *  bond is always among the candidates. With cutoffs up to 3.3 Å and the
 *  tolerance up to 30 % the limit is never reached. */
export const TOLERANCE_LENGTH_LIMIT = 1.0;

/** Largest configured bond cutoff (Å) over every element pair. */
export function maxConfiguredCutoff() {
  const lengths = general.bondLengths;
  let max = 0;
  if (!lengths) return 0;
  for (const key in lengths) {
    const v = lengths[key];
    const c = typeof v === 'number' ? v : (v?.max ?? 0);
    if (c > max) max = c;
  }
  return max;
}

/**
 * The tolerance in effect (a fraction): the setting, clamped to
 * 0 … BOND_BREAK_TOLERANCE_MAX and so that no cutoff is widened by more than
 * TOLERANCE_LENGTH_LIMIT. Bonds and polyhedra read the same value.
 * @returns {number}
 */
export function bondBreakTolerance() {
  const raw = Number(general.bondBreakTolerance);
  if (!(raw > 0)) return 0;
  let tol = Math.min(raw, BOND_BREAK_TOLERANCE_MAX);
  const maxCut = maxConfiguredCutoff();
  if (maxCut > 0 && tol * maxCut > TOLERANCE_LENGTH_LIMIT) tol = TOLERANCE_LENGTH_LIMIT / maxCut;
  return tol;
}

/** (1 + tol)² for the tolerance in effect. */
export function toleranceFactorSq() {
  const f = 1 + bondBreakTolerance();
  return f * f;
}

/** Signature of the bond cutoffs: a memory made under other cutoffs is dropped. */
export function cutoffSignature() {
  try {
    return JSON.stringify([general.bondLengths ?? null, general.bondVisibility ?? null]);
  } catch {
    return '';
  }
}

const MEMORY = Symbol('bondToleranceMemory');

/**
 * Register the playback bond state of `structure` as the source of its next
 * memory: `derive()` returns the keys (bondPairKey) of the pairs drawn in its
 * last frame, relative to the structure's CURRENT source positions. Called
 * whenever a new playback state is built; only consulted by the next bond
 * build.
 * @param {any} structure
 * @param {() => Set<number>} derive
 */
export function setBondToleranceSource(structure, derive) {
  if (!structure) return;
  let m = structure[MEMORY];
  if (!m) structure[MEMORY] = m = { source: null, keys: null, sig: '', nAtoms: 0 };
  m.source = derive;
}

/**
 * The bonds a bond build must keep although they are beyond the strict
 * cutoff: keys (bondPairKey) of the pairs drawn in the last playback frame,
 * or null (no playback since the structure was loaded, tolerance 0, or the
 * cutoffs changed since). A pair is kept when its key is here and its
 * length is within cutoff × (1 + tol). The memory stays until a newer
 * playback frame replaces it, so two rebuilds in a row agree.
 * @param {any} structure
 * @returns {Set<number> | null}
 */
export function heldBondKeys(structure) {
  const m = structure?.[MEMORY];
  if (!m) return null;
  if (!(bondBreakTolerance() > 0)) {
    structure[MEMORY] = null;
    return null;
  }
  const sig = cutoffSignature();
  const nAtoms = structure.elements?.length ?? 0;
  if (m.source) {
    const derive = m.source;
    m.source = null;
    m.keys = derive();
    m.sig = sig;
    m.nAtoms = nAtoms;
  }
  // other cutoffs, or other atoms (a supercell): not this memory's bonds
  if (m.keys && (m.sig !== sig || m.nAtoms !== nAtoms)) m.keys = null;
  return m.keys?.size ? m.keys : null;
}

/** Forget the memory of `structure` (tests; a structure edit). */
export function dropBondToleranceMemory(structure) {
  if (structure) structure[MEMORY] = null;
}

/**
 * Source positions (fractional) of the frame on screen as one accessor:
 * the deferred frame column when given, else the atoms.
 * @param {Float64Array | null} col
 * @param {any[] | null} atoms
 * @returns {(src: number, k: number) => number}
 */
export function sourceFracReader(col, atoms) {
  if (col) return (src, k) => col[3 * src + k];
  return (src, k) => atoms?.[src]?.position?.[k] ?? 0;
}

/**
 * Key of the instance pair (i, j) of a wrapping: source atoms and the image
 * shift between the two ends relative to the current source positions
 * (each end's cell = round(frac − source position); exact for any wrapping,
 * fast-frame moved ones included, as long as the frame step is below half
 * a cell).
 * @param {number} nSrc
 * @param {{frac: ArrayLike<number>[], srcIndex: ArrayLike<number>}} wrapped
 * @param {(src: number, k: number) => number} pos
 * @param {number} i @param {number} j
 */
export function instancePairKey(nSrc, wrapped, pos, i, j) {
  const si = wrapped.srcIndex[i], sj = wrapped.srcIndex[j];
  const fi = wrapped.frac[i], fj = wrapped.frac[j];
  const rx = Math.round(fj[0] - pos(sj, 0)) - Math.round(fi[0] - pos(si, 0));
  const ry = Math.round(fj[1] - pos(sj, 1)) - Math.round(fi[1] - pos(si, 1));
  const rz = Math.round(fj[2] - pos(sj, 2)) - Math.round(fi[2] - pos(si, 2));
  return bondPairKey(nSrc, si, sj, rx, ry, rz);
}
