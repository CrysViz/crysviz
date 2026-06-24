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

/**
 * Each handler returns `{ result, transfer }`. `result` is posted back; `transfer` lists
 * its ArrayBuffers to hand over zero-copy.
 */
const handlers = {
  // Forces wasm init; used by the pool to pre-warm in the background.
  warmup: () => ({ result: { ok: true }, transfer: [] }),

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
