// @ts-nocheck
/**
 * Shared compute worker (module worker) for the app's background worker pool.
 *
 * One worker holds its own WASM instance and dispatches by a `task` string to a handler
 * in the registry below, so the same warm worker can serve many kinds of time-critical
 * work over its lifetime (today: polyhedra candidate generation). Add a handler here and
 * call it via `workerPool.runOnAll(task, …)` / `workerPool.run(task, …)`.
 *
 * Message in:  { reqId, task, payload }
 * Message out: { reqId, result }                  (result's ArrayBuffers transferred)
 *          or: { reqId, error }
 */

import init, { compute_candidates } from '../compiled/periodic_wasm.js';

// Idempotent; `import.meta.url` resolves the .wasm relative to this module (works in a
// module worker). Resolving `ready` is what the warm-up task awaits.
const ready = init(new URL('../compiled/periodic_wasm_bg.wasm', import.meta.url));

// A tiny synthetic structure (a cation octahedrally coordinated by 6 anions in a roomy
// 20 Å cell) used only to warm the JIT: running the real compute paths a handful of times
// tiers up the hot functions (convex_hull, voronoi, gather_within, the cage path) so the
// first real job runs optimized code instead of slow baseline code. The optimization is
// per-function on type feedback, so warming on 7 atoms transfers to any size.
const WARM = (() => {
  const frac = new Float64Array([
    0.5, 0.5, 0.5, 0.6, 0.5, 0.5, 0.4, 0.5, 0.5,
    0.5, 0.6, 0.5, 0.5, 0.4, 0.5, 0.5, 0.5, 0.6, 0.5, 0.5, 0.4,
  ]);
  const n = 7;
  const L = 20;
  const centerCart = new Float64Array(3 * n);
  for (let i = 0; i < 3 * n; i++) centerCart[i] = frac[i] * L;
  const visibleKeys = new Int32Array(4 * n);
  for (let i = 0; i < n; i++) visibleKeys[4 * i] = i;
  return {
    frac,
    elem: new Uint32Array([0, 1, 1, 1, 1, 1, 1]),
    lattice: new Float64Array([L, 0, 0, 0, L, 0, 0, 0, L]),
    cutoff: new Float64Array([0, 2.5, 2.5, 0]),
    electroneg: new Float64Array([1, 3]),
    radii: new Float64Array([1, 1]),
    centerSrc: new Uint32Array([0, 1, 2, 3, 4, 5, 6]),
    centerShift: new Int32Array(3 * n),
    centerCart,
    visibleKeys,
    seedVisible: new Uint8Array([1, 1, 1, 1, 1, 1, 1]),
    n,
  };
})();

function warmCompute() {
  const W = WARM;
  // A few dozen iterations is enough to make the inner hot functions tier up, and it's
  // sub-millisecond on 7 atoms.
  for (let it = 0; it < 24; it++) {
    const r = compute_candidates(
      W.frac, W.elem, W.lattice, W.cutoff, 2, W.electroneg, W.radii, 2.5, true, true,
      W.centerSrc, W.centerShift, W.centerCart, W.visibleKeys, W.seedVisible,
      0, W.n, 0, W.n,
    );
    r.free();
  }
}

/**
 * Each handler returns `{ result, transfer }`. `result` is posted back; `transfer` lists
 * its ArrayBuffers to hand over zero-copy.
 */
const handlers = {
  // Forces wasm init and tiers up the compute paths; used by the pool to pre-warm.
  warmup: () => {
    warmCompute();
    return { result: { ok: true }, transfer: [] };
  },

  // Polyhedra candidate generation for a centre/seed partition.
  polyhedraCandidates: (payload) => {
    const { inputs: I, cs, ce, ss, se } = payload;
    const r = compute_candidates(
      I.fracFlat, I.elemIdx, I.latticeFlat, I.cutoffMatrix, I.nElem,
      I.electroneg, I.radii, I.maxCutoff, I.useChemicalFilter, I.detectCages,
      I.centerSrc, I.centerShift, I.centerCart, I.visibleKeys, I.seedVisible,
      cs, ce, ss, se,
    );
    const result = {
      isCage: r.is_cage(),
      colorElem: r.color_elem(),
      centerSrc: r.center_src(),
      centerShift: r.center_shift(),
      refPoint: r.ref_point(),
      vertCounts: r.vert_counts(),
      vertices: r.vertices(),
      vertexSrcs: r.vertex_srcs(),
      vertexShifts: r.vertex_shifts(),
      nCentered: r.n_centered(),
    };
    r.free();
    return {
      result,
      transfer: [
        result.isCage.buffer, result.colorElem.buffer, result.centerSrc.buffer,
        result.centerShift.buffer, result.refPoint.buffer, result.vertCounts.buffer,
        result.vertices.buffer, result.vertexSrcs.buffer, result.vertexShifts.buffer,
      ],
    };
  },
};

self.onmessage = async (e) => {
  const { reqId, task, payload } = e.data;
  try {
    await ready;
    const handler = handlers[task];
    if (!handler) throw new Error(`unknown worker task: ${task}`);
    const { result, transfer } = await handler(payload);
    self.postMessage({ reqId, result }, transfer || []);
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) });
  }
};
