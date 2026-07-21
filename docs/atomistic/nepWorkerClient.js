/**
 * Main-thread client for workers/nepWorker.js — a force evaluator with the same
 * shape MD.js/relaxer.js already expect (`async ({lattice, positions, types})
 * => {forces, total_energy, stress}`), except the wasm runs off-thread.
 *
 * One worker, created lazily and kept warm for the session: it holds its own
 * NEP wasm instance and the 14.9 MB model, so spinning it up per run would cost
 * far more than it saves.
 */

const WASM_BASE = new URL('../external/nep_wasm/', import.meta.url).href;

let worker = null;
let readyPromise = null;
let nextReqId = 1;
/** @type {Map<number, {resolve: (value: any) => void, reject: (reason: Error) => void}>} */
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/nepWorker.js', import.meta.url));
  worker.onmessage = (event) => {
    const { reqId, result, error } = event.data;
    const entry = pending.get(reqId);
    if (!entry) return;
    pending.delete(reqId);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  };
  worker.onerror = (event) => {
    const failure = new Error(`nepWorker failed: ${event.message || 'unknown error'}`);
    pending.forEach((entry) => entry.reject(failure));
    pending.clear();
  };
  return worker;
}

function post(message, transfer = []) {
  const reqId = nextReqId;
  nextReqId += 1;
  const active = ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    active.postMessage({ ...message, reqId }, transfer);
  });
}

/**
 * Boot the worker and load the built-in model. Safe to call repeatedly — the
 * first call owns the load and every later one waits on the same promise.
 */
export function ensureWorkerNEPReady() {
  if (!readyPromise) {
    readyPromise = post({ type: 'init', base: WASM_BASE }).catch((error) => {
      // A failed boot must not poison the session: drop the cached promise so a
      // later attempt can retry (and so callers can fall back to the
      // main-thread runner meanwhile).
      readyPromise = null;
      worker = null;
      throw error;
    });
  }
  return readyPromise;
}

/**
 * Build a force evaluator backed by the worker. `types` are sent only when they
 * change (the worker caches them), since they are constant for a whole run.
 */
export function createWorkerNEPForceEvaluator() {
  let sentTypes = null;
  return async ({ lattice, positions, types }) => {
    await ensureWorkerNEPReady();

    const n = positions.length;
    const flat = new Float64Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const p = positions[i];
      const o = i * 3;
      flat[o] = p[0];
      flat[o + 1] = p[1];
      flat[o + 2] = p[2];
    }

    const typesChanged = !sentTypes || sentTypes.length !== types.length
      || types.some((value, index) => value !== sentTypes[index]);
    const payload = {
      type: 'compute',
      lattice,
      positions: flat,
      types: typesChanged ? Int32Array.from(types) : null,
    };
    if (typesChanged) sentTypes = [...types];

    const transfer = [flat.buffer];
    if (payload.types) transfer.push(payload.types.buffer);
    const result = await post(payload, transfer);

    // MD.js wants Nx3 rows; the wire format is flat so the buffer can be
    // transferred instead of structure-cloned.
    const forces = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const o = i * 3;
      forces[i] = [result.forces[o], result.forces[o + 1], result.forces[o + 2]];
    }
    return { forces, total_energy: result.total_energy, stress: result.stress };
  };
}

export function terminateWorkerNEP() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  readyPromise = null;
  pending.clear();
}
