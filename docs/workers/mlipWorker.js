// @ts-nocheck
/**
 * Dedicated PET-MAD (mlip.cpp) worker — the PET-MAD twin of nepWorker.js.
 *
 * A module worker (mlip.js is pure ESM, unlike the NEP glue), owning one
 * MLIPRunner: its own wasm instance and model weights. One worker per
 * backend lives for the session (atomistic/mlipWorkerClient.js).
 *
 * Why a worker: a PET-MAD evaluation takes tens to hundreds of milliseconds
 * even for a handful of atoms, and on the main thread every one of them
 * blocks paint and input. Off-thread the viewer keeps drawing (and the MD loop
 * yields with a macrotask instead of a rAF, see MD.js) while the next step is
 * being computed. The threaded wasm variant also needs this: its ggml main
 * thread participates in the compute and must not be the page's UI thread.
 *
 * Message in:  { reqId, type: 'init', backend, threads, blockedGemm, gpuReadback, gpuMatmul }
 *              { reqId, type: 'loadUrl', url }           (progress messages)
 *              { reqId, type: 'loadFile', file }
 *              { reqId, type: 'compute', lattice, positions: Float64Array,
 *                types: Int32Array|null }
 *              { reqId, type: 'setThreads', threads }
 *              { reqId, type: 'setBlockedGemm', on }
 *              { reqId, type: 'setGpuReadback', mode } / { reqId, type: 'setGpuMatmul', kernel }
 *              { reqId, type: 'setOpProfile', on } / { reqId, type: 'takeOpProfile' }
 *              { reqId, type: 'destroy' }
 * Message out: { reqId, result } | { reqId, error } | { reqId, progress }
 * Positions in and forces out travel as transferred Float64Arrays.
 */

import { MLIPRunner } from '../external/mlip_wasm/mlip_runner.js';

let runner = null;
// types only change when the structure does; cached like nepWorker does.
let cachedTypes = null;

async function handleInit({ backend, threads, blockedGemm, gpuReadback, gpuMatmul }) {
  runner = new MLIPRunner({ backend, threads, blockedGemm, gpuReadback, gpuMatmul });
  await runner.init();
  return runner.describe();
}

function requireRunner() {
  if (!runner) throw new Error('mlipWorker: message before init');
  return runner;
}

async function handleLoadUrl(url, onProgress) {
  const info = await requireRunner().loadModelFromUrl(url, onProgress);
  return { modelInfo: info, ...runner.describe() };
}

async function handleLoadFile(file) {
  const info = await requireRunner().loadModelFromFile(file);
  return { modelInfo: info, ...runner.describe() };
}

async function handleCompute({ lattice, positions, types }) {
  const r = requireRunner();
  const n = positions.length / 3;
  if (types) cachedTypes = Array.from(types);
  if (!cachedTypes || cachedTypes.length !== n) {
    throw new Error('mlipWorker: types missing for this atom count');
  }
  const asRows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    asRows[i] = [positions[o], positions[o + 1], positions[o + 2]];
  }
  const out = await r.compute({ lattice, positions: asRows, types: cachedTypes });
  const forces = new Float64Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const f = out.forces[i];
    const o = i * 3;
    forces[o] = f[0];
    forces[o + 1] = f[1];
    forces[o + 2] = f[2];
  }
  const m = r.module;
  const threads = m && typeof m.getNumThreads === 'function' ? m.getNumThreads() : 1;
  return { forces, total_energy: out.total_energy, stress: out.stress, threads, timings: r.lastTimings ?? null };
}

self.onmessage = async (event) => {
  const { reqId, type } = event.data;
  try {
    if (type === 'init') {
      self.postMessage({ reqId, result: await handleInit(event.data) });
    } else if (type === 'loadUrl') {
      const result = await handleLoadUrl(event.data.url, (progress) => {
        self.postMessage({ reqId, progress });
      });
      self.postMessage({ reqId, result });
    } else if (type === 'loadFile') {
      self.postMessage({ reqId, result: await handleLoadFile(event.data.file) });
    } else if (type === 'compute') {
      const result = await handleCompute(event.data);
      self.postMessage({ reqId, result }, [result.forces.buffer]);
    } else if (type === 'setThreads') {
      self.postMessage({ reqId, result: requireRunner().setThreads(event.data.threads) });
    } else if (type === 'setBlockedGemm') {
      self.postMessage({ reqId, result: requireRunner().setBlockedGemm(event.data.on) });
    } else if (type === 'setGpuReadback') {
      self.postMessage({ reqId, result: requireRunner().setGpuReadback(event.data.mode) });
    } else if (type === 'setGpuMatmul') {
      self.postMessage({ reqId, result: requireRunner().setGpuMatmul(event.data.kernel) });
    } else if (type === 'setOpProfile') {
      self.postMessage({ reqId, result: requireRunner().setOpProfile(event.data.on) });
    } else if (type === 'takeOpProfile') {
      self.postMessage({ reqId, result: requireRunner().takeOpProfile() });
    } else if (type === 'destroy') {
      if (runner) runner.destroy();
      runner = null;
      cachedTypes = null;
      self.postMessage({ reqId, result: { ok: true } });
    } else {
      throw new Error(`mlipWorker: unknown message type ${type}`);
    }
  } catch (error) {
    self.postMessage({ reqId, error: error?.message || String(error) });
  }
};
