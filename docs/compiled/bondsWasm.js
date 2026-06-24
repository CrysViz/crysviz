/**
 * Neighbour-bond pair finder — WASM-backed (cell list, O(n)) drop-in for the O(n²) JS
 * double loop in BondsFracUpdateModule.buildBondObjects. The caller marshals the wrapped
 * atom set + cutoff² matrices; this returns the bonding pairs (i, j) with i < j, and the
 * caller builds the `Bond` objects.
 *
 * Shares the wasm module (idempotent init) with the other compiled wrappers.
 */

import init, { compute_bond_pairs } from './periodic_wasm.js';

await init(new URL('./periodic_wasm_bg.wasm', import.meta.url));

/**
 * @param {{
 *   cartFlat: Float64Array, elemIdx: Uint32Array,
 *   cutoffSqFlat: Float64Array, minCutoffSqFlat: Float64Array,
 *   nElem: number, minDistSq: number, maxCutoff: number,
 * }} args
 * @returns {{i: Uint32Array, j: Uint32Array}} bonding pair index arrays
 */
export function computeBondPairsWasm(args) {
  const { cartFlat, elemIdx, cutoffSqFlat, minCutoffSqFlat, nElem, minDistSq, maxCutoff } = args;
  const r = compute_bond_pairs(
    cartFlat, elemIdx, cutoffSqFlat, minCutoffSqFlat, nElem, minDistSq, maxCutoff,
    0, elemIdx.length,
  );
  const i = r.i();
  const j = r.j();
  r.free();
  return { i, j };
}
