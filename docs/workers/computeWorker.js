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
 * Interim:     { reqId, progress }                (0-100; only from handlers that
 *                                                  call their `progress` callback)
 */

import init, { compute_candidates } from '../compiled/periodic_wasm.js';

// Idempotent; `import.meta.url` resolves the .wasm relative to this module (works in a
// module worker). Resolving `ready` is what the warm-up task awaits.
const ready = init(new URL('../compiled/periodic_wasm_bg.wasm', import.meta.url));

/**
 * Each handler returns `{ result, transfer }`. `result` is posted back; `transfer` lists
 * its ArrayBuffers to hand over zero-copy. Handlers also receive a `progress(0-100)`
 * callback as their second argument; long-running parses report through it and the pool
 * routes the values to the caller's onProgress (workerPool.run).
 */
const handlers = {
  // Forces wasm instantiation in the background (the onmessage `await ready` does it).
  warmup: () => ({ result: { ok: true }, transfer: [] }),

  // Polyhedra candidate generation for a centre/seed partition.
  polyhedraCandidates: (payload) => {
    const { inputs: I, cs, ce, ss, se } = payload;
    const r = compute_candidates(
      I.fracFlat, I.elemIdx, I.latticeFlat, I.cutoffMatrix, I.nElem,
      I.electroneg, I.radii, I.maxCutoff, I.useChemicalFilter, I.detectCages,
      I.centerSrc, I.centerShift, I.centerCart, I.centerKeys, I.seedVisible,
      I.cutPlaneImmune, I.cutPlanesFlat, I.cutPlaneCount,
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

  // One WAVECAR band: scatter the plane-wave coefficients into an FFT box,
  // inverse-transform it and reduce to a Float32 scalar field. The complex
  // intermediate (up to hundreds of MB) is allocated and freed inside the WASM
  // module, so only the coefficients come in and only the field goes back.
  //
  // The wave module is imported lazily rather than alongside periodic_wasm at
  // the top of this file: most sessions never open a wavefunction, and every
  // worker in the pool would otherwise pay the instantiation.
  wavefunctionRealSpace: async (payload) => {
    const { getWaveBackend, transformToRealSpace } = await import('../math/wave-backend-wasm.js');
    const module = await getWaveBackend();
    const result = transformToRealSpace(module, payload);
    return { result, transfer: [result.values.buffer] };
  },

  // The same for one component of a non-collinear band. Kept as its own task
  // rather than a flag on the one above because it runs two FFTs and holds two
  // complex boxes at once, which is the sizing the pool has to reason about.
  wavefunctionSpinorRealSpace: async (payload) => {
    const { getWaveBackend, transformSpinorToRealSpace } =
      await import('../math/wave-backend-wasm.js');
    const module = await getWaveBackend();
    const result = transformSpinorToRealSpace(module, payload);
    return { result, transfer: [result.values.buffer] };
  },

  // Stream-parse a VASP OUTCAR trajectory. The payload's Blob arrived by
  // reference (structured-cloning a Blob copies a handle, not the bytes), so
  // this worker reads the file in chunks off the main thread and only the
  // parsed per-step data goes back. Imported lazily like the wave module:
  // most sessions never load an OUTCAR, and the pool's workers should not all
  // pay for the import at spawn.
  outcarParse: async (payload, progress) => {
    const { parseOutcarBlob } = await import('../io/outcarParse.js');
    const result = await parseOutcarBlob(payload.blob, progress);
    return { result, transfer: [] };
  },

  // The streaming variant: same sweep, but only frame byte offsets and
  // per-frame scalars come back — the atom data never leaves the file until
  // a frame is actually viewed (io/StreamingOutcarSource.js).
  outcarIndex: async (payload, progress) => {
    const { parseOutcarBlob } = await import('../io/outcarParse.js');
    const result = await parseOutcarBlob(payload.blob, progress, { mode: 'index' });
    return { result, transfer: [] };
  },
};

self.onmessage = async (e) => {
  const { reqId, task, payload } = e.data;
  try {
    await ready;
    const handler = handlers[task];
    if (!handler) throw new Error(`unknown worker task: ${task}`);
    const { result, transfer } = await handler(
      payload, (progress) => self.postMessage({ reqId, progress }));
    self.postMessage({ reqId, result }, transfer || []);
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) });
  }
};
