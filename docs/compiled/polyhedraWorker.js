// @ts-nocheck
/**
 * Polyhedra candidate-generation worker (module worker).
 *
 * Holds its own WASM instance and runs `compute_candidates` for the centre range
 * [cs,ce) and seed range [ss,se) it is assigned. The main thread (polyhedraWorkerPool)
 * marshals the inputs once and posts them here; this posts back the flattened
 * `CandidateResult` typed arrays (transferring their buffers), tagged with the request id
 * so the pool can match/ignore responses. Acceptance is done on the main thread.
 */

import init, { compute_candidates } from './periodic_wasm.js';

// Idempotent; resolves once the wasm is ready. `import.meta.url` resolves the .wasm
// relative to this module, which works inside a module worker.
const ready = init(new URL('./periodic_wasm_bg.wasm', import.meta.url));

self.onmessage = async (e) => {
  const { reqId, inputs: I, cs, ce, ss, se } = e.data;
  try {
    await ready;
    const r = compute_candidates(
      I.fracFlat, I.elemIdx, I.latticeFlat, I.cutoffMatrix, I.nElem,
      I.electroneg, I.radii, I.maxCutoff, I.useChemicalFilter, I.detectCages,
      I.centerSrc, I.centerShift, I.centerCart, I.visibleKeys, I.seedVisible,
      cs, ce, ss, se,
    );
    const out = {
      reqId,
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
    self.postMessage(out, [
      out.isCage.buffer, out.colorElem.buffer, out.centerSrc.buffer,
      out.centerShift.buffer, out.refPoint.buffer, out.vertCounts.buffer,
      out.vertices.buffer, out.vertexSrcs.buffer, out.vertexShifts.buffer,
    ]);
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) });
  }
};
