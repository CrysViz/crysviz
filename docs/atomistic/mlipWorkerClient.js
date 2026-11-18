/**
 * Main-thread client for workers/mlipWorker.js: `WorkerMLIPRunner` has the
 * same surface as MLIPRunner (external/mlip_wasm/mlip_runner.js) — init,
 * loadDefaultModel / loadModelFromUrl / loadModelFromFile, modelInfo,
 * compute({lattice, positions, types}), destroy — so AtomisticPanels can hand
 * either one to the relaxer, MD, EOS and phonon code unchanged. The difference
 * is that the wasm and the model live in a dedicated worker, so a PET-MAD
 * evaluation never blocks the page (nepWorkerClient.js is the NEP twin).
 *
 * `compute` is async either way (MLIPRunner's already was), and `offThread`
 * tells MD.js to yield with a macrotask rather than a rAF between steps.
 */

const DEFAULT_MODEL_URL =
  'https://huggingface.co/peterspackman/mlip-gguf/resolve/main/pet-mad-xs.gguf';

export class WorkerMLIPRunner {
  /**
   * @param {{ backend?: 'cpu'|'webgpu'|'auto', threads?: number|'auto'|false,
   *   blockedGemm?: boolean, gpuReadback?: 'auto'|'map', gpuMatmul?: 'tile4'|'reg_tile',
   *   defaultModelUrl?: string }} [options]
   */
  constructor(options = {}) {
    this.backend = options.backend || 'cpu';
    this.threads = options.threads ?? 'auto';
    this.blockedGemm = options.blockedGemm ?? true;
    this.gpuReadback = options.gpuReadback || 'auto';
    this.gpuMatmul = options.gpuMatmul === 'reg_tile' ? 'reg_tile' : 'tile4';
    this.defaultModelUrl = options.defaultModelUrl || DEFAULT_MODEL_URL;
    this.modelInfo = null;
    // Same flags MLIPRunner carries (AtomisticPanels reads supportsStress;
    // MD.js reads offThread through the panel).
    this.supportsStress = true;
    this.offThread = true;
    /** Filled by init(): { variant, threads, maxThreads, backendName }. */
    this.runtime = null;
    /** @type {Worker|null} */
    this._worker = null;
    this._nextReqId = 1;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, onProgress?: (p: any) => void}>} */
    this._pending = new Map();
    this._initPromise = null;
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const worker = new Worker(new URL('../workers/mlipWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { reqId, result, error, progress } = event.data;
      const entry = this._pending.get(reqId);
      if (!entry) return;
      if (progress !== undefined) {
        if (entry.onProgress) entry.onProgress(progress);
        return;
      }
      this._pending.delete(reqId);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    worker.onerror = (event) => {
      const failure = new Error(`mlipWorker failed: ${event.message || 'unknown error'}`);
      this._pending.forEach((entry) => entry.reject(failure));
      this._pending.clear();
    };
    this._worker = worker;
    return worker;
  }

  _post(message, transfer = [], onProgress = undefined) {
    const reqId = this._nextReqId;
    this._nextReqId += 1;
    const worker = this._ensureWorker();
    return new Promise((resolve, reject) => {
      this._pending.set(reqId, { resolve, reject, onProgress });
      worker.postMessage({ ...message, reqId }, transfer);
    });
  }

  /** Boot the worker and instantiate the wasm module inside it. */
  async init() {
    if (!this._initPromise) {
      this._initPromise = this._post({
        type: 'init', backend: this.backend, threads: this.threads, blockedGemm: this.blockedGemm,
        gpuReadback: this.gpuReadback, gpuMatmul: this.gpuMatmul,
      })
        .then((runtime) => {
          this.runtime = runtime;
          return this;
        })
        .catch((error) => {
          // A failed boot must not poison the runner: drop the worker so the
          // caller can retry or fall back to the in-thread runner.
          this._initPromise = null;
          this.terminate();
          throw error;
        });
    }
    return this._initPromise;
  }

  /**
   * Change the CPU thread count in the worker (MLIPRunner.setThreads).
   * @param {number|'auto'|false} threads
   */
  async setThreads(threads) {
    await this.init();
    this.threads = threads;
    this.runtime = await this._post({ type: 'setThreads', threads });
    return this.runtime;
  }

  /**
   * Switch the CPU matrix kernel in the worker (MLIPRunner.setBlockedGemm).
   * @param {boolean} on
   */
  async setBlockedGemm(on) {
    await this.init();
    this.blockedGemm = on;
    this.runtime = await this._post({ type: 'setBlockedGemm', on });
    return this.runtime;
  }

  /**
   * WebGPU result readback in the worker (MLIPRunner.setGpuReadback).
   * @param {'auto'|'map'} mode
   */
  async setGpuReadback(mode) {
    await this.init();
    this.gpuReadback = mode;
    this.runtime = await this._post({ type: 'setGpuReadback', mode });
    return this.runtime;
  }

  /**
   * WebGPU f32 matrix kernel in the worker (MLIPRunner.setGpuMatmul).
   * @param {'tile4'|'reg_tile'} kernel
   */
  async setGpuMatmul(kernel) {
    await this.init();
    this.gpuMatmul = kernel;
    this.runtime = await this._post({ type: 'setGpuMatmul', kernel });
    return this.runtime;
  }

  /**
   * Per-kernel GPU timing in the worker (MLIPRunner.setOpProfile).
   * @param {boolean} on
   * @returns {Promise<boolean>}
   */
  async setOpProfile(on) {
    await this.init();
    return this._post({ type: 'setOpProfile', on });
  }

  /** The kernel times recorded in the worker (MLIPRunner.takeOpProfile). */
  async takeOpProfile() {
    await this.init();
    return this._post({ type: 'takeOpProfile' });
  }

  /** Same shape MLIPRunner.describe() returns, for status lines. */
  describe() {
    return this.runtime
      || { backend: this.backend, variant: null, threads: 0, maxThreads: 0, blockedGemm: null, gpuReadback: null };
  }

  /**
   * @param {(p: { loadedBytes: number, totalBytes: number }) => void} [onProgress]
   */
  async loadDefaultModel(onProgress) {
    return this.loadModelFromUrl(this.defaultModelUrl, onProgress);
  }

  /**
   * @param {string} url
   * @param {(p: { loadedBytes: number, totalBytes: number }) => void} [onProgress]
   */
  async loadModelFromUrl(url, onProgress) {
    await this.init();
    // Resolve against the page, not the worker script: a relative model URL
    // would otherwise be looked up next to workers/mlipWorker.js.
    const absolute = typeof document !== 'undefined' ? new URL(url, document.baseURI).href : url;
    const result = await this._post({ type: 'loadUrl', url: absolute }, [], onProgress);
    return this._adoptLoad(result);
  }

  /** @param {File} file */
  async loadModelFromFile(file) {
    await this.init();
    const result = await this._post({ type: 'loadFile', file });
    return this._adoptLoad(result);
  }

  _adoptLoad(result) {
    const { modelInfo, ...runtime } = result;
    this.modelInfo = modelInfo;
    this.runtime = runtime;
    return modelInfo;
  }

  /**
   * Predict energy / forces / stress for a structure (same contract as
   * MLIPRunner.compute). Types travel only when they change.
   * @param {{ lattice: number[][], positions: number[][], types: number[] }} structure
   */
  async compute(structure) {
    if (!this.modelInfo) {
      throw new Error('Model is not loaded. Call loadDefaultModel/loadModelFrom... first.');
    }
    const { lattice, positions, types } = structure;
    const n = positions.length;
    const flat = new Float64Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const p = positions[i];
      const o = i * 3;
      flat[o] = p[0];
      flat[o + 1] = p[1];
      flat[o + 2] = p[2];
    }
    const typesChanged = !this._sentTypes || this._sentTypes.length !== types.length
      || types.some((value, index) => value !== this._sentTypes[index]);
    const payload = {
      type: 'compute',
      lattice: lattice.map((row) => [row[0], row[1], row[2]]),
      positions: flat,
      types: typesChanged ? Int32Array.from(types) : null,
    };
    if (typesChanged) this._sentTypes = [...types];
    const transfer = [flat.buffer];
    if (payload.types) transfer.push(payload.types.buffer);
    let result;
    const tPost = performance.now();
    try {
      result = await this._post(payload, transfer);
    } catch (error) {
      // The worker's cache of types is lost with the worker; resend next time.
      this._sentTypes = null;
      throw error;
    }
    const forces = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const o = i * 3;
      forces[i] = [result.forces[o], result.forces[o + 1], result.forces[o + 2]];
    }
    // Thread count the wasm used for this evaluation (after the runner's
    // per-size calibration), for status lines and benchmarks.
    if (Number.isFinite(result.threads)) this.lastThreads = result.threads;
    // The wasm's own timing of this evaluation (MLIPRunner.lastTimings), plus
    // the whole round trip through the worker as seen from here.
    this.lastTimings = result.timings ? { ...result.timings, roundTripMs: performance.now() - tPost } : null;
    return {
      total_energy: result.total_energy,
      energy_per_atom: result.total_energy / n,
      forces,
      stress: result.stress,
    };
  }

  /** Free the model and the wasm instance, and stop the worker. */
  destroy() {
    if (this._worker) {
      // Best effort: let the worker release embind handles before it goes.
      this._post({ type: 'destroy' }).catch(() => { /* already gone */ });
    }
    this.modelInfo = null;
    this.terminate();
  }

  terminate() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    const failure = new Error('mlipWorker terminated');
    this._pending.forEach((entry) => entry.reject(failure));
    this._pending.clear();
    this._sentTypes = null;
    this._initPromise = null;
  }
}

export default WorkerMLIPRunner;
