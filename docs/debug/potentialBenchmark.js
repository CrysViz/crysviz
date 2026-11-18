/**
 * Interatomic-potential benchmark: MD through the real MD panel for NEP and
 * PET-MAD (XS / S; one CPU thread, all CPU threads, WebGPU, and XS on the
 * main thread) on supercells of the default cell, for a ladder of viewer
 * options. Used by the Debug window's Benchmark tab (ui/DebugBenchmarkTab.js)
 * so anyone can map their own machine — real GPU, real WebGPU — and by the
 * headless bench (tools/browsertest/tests/potentialperf.bench.js).
 *
 * Each run loads the default structure, builds the supercell, sets the viewer
 * options, makes the potential ready, times one force evaluation (after a
 * warm-up, which also runs the multi-thread calibration for that size), sizes
 * the MD run to roughly `targetMs`, presses Start in the MD panel and reads
 * the run's timing breakdown (MD.js getLastMdTiming). A 16 ms timer measures
 * the longest stretch the page could not run anything (a frozen UI). The rows
 * the run added to the file list are removed again afterwards.
 *
 * The PET-MAD CPU runs can also be swept over thread counts and the matrix
 * kernel (blocked GEMM vs ggml's dot products, an A/B switch in the wasm):
 * cpuBenchKey() names such a run, benchSpec() resolves any key.
 *
 * The record shape is what tools/bench/plot_potential_perf.py reads.
 */

import { general, fileBrowser, structureShip } from '../state/store.js';
import { webgpuUnsupportedReason } from '../external/mlip_wasm/mlip_runner.js';
import { measureGpuRoundTrip, measureCanvasReadback, measureDispatchCost } from './gpuRoundTrip.js';
import { SLOW_MAP_MS } from '../external/mlip_wasm/canvas_readback.js';

/**
 * One entry per measurable configuration. `needs` gates availability;
 * `kernel` marks the PET-MAD CPU runs (matrix kernel, see BENCH_KERNELS).
 */
export const BENCH_POTENTIALS = [
  { key: 'nep', label: 'NEP89', family: 'nep', potential: 'nep' },
  { key: 'xsmt', label: 'PET-MAD-XS · CPU, all threads', family: 'xs', potential: 'mlip', model: 'pet-mad-xs.gguf',
    backend: 'cpu', threads: 'auto', needs: 'isolation', kernel: 'blocked' },
  { key: 'xs1', label: 'PET-MAD-XS · CPU, 1 thread', family: 'xs', potential: 'mlip', model: 'pet-mad-xs.gguf',
    backend: 'cpu', threads: 1, kernel: 'blocked' },
  { key: 'xsgpu', label: 'PET-MAD-XS · WebGPU', family: 'xs', potential: 'mlip', model: 'pet-mad-xs.gguf',
    backend: 'webgpu', threads: 1, needs: 'webgpu' },
  { key: 'xsmain', label: 'PET-MAD-XS · main thread', family: 'xs', potential: 'mlip', model: 'pet-mad-xs.gguf',
    backend: 'cpu', threads: 1, mainThread: true, maxCells: 3, kernel: 'blocked' },
  { key: 'smt', label: 'PET-MAD-S · CPU, all threads', family: 's', potential: 'mlip', model: 'pet-mad-s.gguf',
    backend: 'cpu', threads: 'auto', needs: 'isolation', kernel: 'blocked' },
  { key: 's1', label: 'PET-MAD-S · CPU, 1 thread', family: 's', potential: 'mlip', model: 'pet-mad-s.gguf',
    backend: 'cpu', threads: 1, kernel: 'blocked' },
  { key: 'sgpu', label: 'PET-MAD-S · WebGPU', family: 's', potential: 'mlip', model: 'pet-mad-s.gguf',
    backend: 'webgpu', threads: 1, needs: 'webgpu' },
];

/** CPU matrix kernels for PET-MAD (README "Matrix kernel" in external/mlip_wasm). */
export const BENCH_KERNELS = [
  { key: 'blocked', label: 'blocked GEMM (new)' },
  { key: 'dot', label: 'dot products (old)' },
];

/**
 * Key of a PET-MAD CPU (worker) run: 'xsmt' / 'xs1' as in BENCH_POTENTIALS,
 * 'xs4t' for an explicit count, a '-dot' suffix for the dot-product kernel.
 * @param {'xs'|'s'} family
 * @param {number|'auto'} threads
 * @param {string} [kernel]
 */
export function cpuBenchKey(family, threads, kernel = 'blocked') {
  const t = threads === 'auto' ? 'mt' : Number(threads) === 1 ? '1' : `${Number(threads)}t`;
  return `${family}${t}${kernel === 'dot' ? '-dot' : ''}`;
}

/**
 * PET-MAD WebGPU result readback (README "Canvas readback" in
 * external/mlip_wasm): a '-map' suffix on 'xsgpu' / 'sgpu' forces mapAsync.
 */
export const BENCH_READBACKS = [
  { key: 'auto', label: 'canvas snapshot where exact (new)' },
  { key: 'map', label: 'mapAsync (old)' },
];

/**
 * PET-MAD WebGPU f32 matrix kernel (README "f32 matrix kernel" in
 * external/mlip_wasm): a '-regtile' suffix on a WebGPU key runs upstream's.
 */
export const BENCH_MATMULS = [
  { key: 'tile4', label: 'vec4 tiles (new)' },
  { key: 'reg_tile', label: 'register tiles (old)' },
];

/**
 * Key of a PET-MAD WebGPU run: 'xsgpu', plus '-map' for mapAsync readback and
 * '-regtile' for the old matrix kernel.
 * @param {string} base 'xsgpu' | 'sgpu'
 * @param {string} readback 'auto' | 'map'
 * @param {string} matmul 'tile4' | 'reg_tile'
 */
export function gpuBenchKey(base, readback, matmul) {
  return `${base}${readback === 'map' ? '-map' : ''}${matmul === 'reg_tile' ? '-regtile' : ''}`;
}

/** The spec for a key: a BENCH_POTENTIALS entry, a gpuBenchKey() run or a cpuBenchKey() run. */
export function benchSpec(key) {
  const fixed = BENCH_POTENTIALS.find((p) => p.key === key);
  if (fixed) return fixed;
  const g = /^(xs|s)gpu(-map)?(-regtile)?$/.exec(key);
  if (g) {
    const base = BENCH_POTENTIALS.find((p) => p.key === `${g[1]}gpu`);
    return {
      ...base, key, readback: g[2] ? 'map' : 'auto', matmul: g[3] ? 'reg_tile' : 'tile4',
      label: `${base.label}${g[2] ? ' · mapAsync' : ''}${g[3] ? ' · reg-tile' : ''}`,
    };
  }
  const m = /^(xs|s)(mt|1|(\d+)t)(-dot)?$/.exec(key);
  if (!m) return null;
  const threads = m[2] === 'mt' ? 'auto' : m[2] === '1' ? 1 : Number(m[3]);
  const base = BENCH_POTENTIALS.find((p) => p.key === `${m[1]}${threads === 1 ? '1' : 'mt'}`);
  const kernel = m[4] ? 'dot' : 'blocked';
  const where = threads === 'auto' ? 'all threads' : `${threads} thread${threads === 1 ? '' : 's'}`;
  return {
    ...base,
    key,
    threads,
    kernel,
    label: `${base.label.split(' · ')[0]} · CPU, ${where}${kernel === 'dot' ? ' · dot products' : ''}`,
  };
}

/**
 * Thread counts worth offering on this machine: 'auto' (calibrated per size:
 * the fastest of all cores / one / half), powers of two up to the core count,
 * and the core count itself.
 * @param {{ cores: number|null }} caps
 */
export function benchThreadOptions(caps = benchCapabilities()) {
  const cores = Math.max(1, caps.cores || 1);
  const counts = [1, 2, 4, 8, 16, 32].filter((n) => n <= cores);
  if (!counts.includes(cores)) counts.push(cores);
  return ['auto', ...counts];
}

/** The viewer-option ladder; each step adds to the previous one. */
export const BENCH_VISUALS = [
  { key: 'atoms', label: 'atoms only', showBonds: false, images: false, forceColors: false },
  { key: 'bonds', label: '+ bonds', showBonds: true, images: false, forceColors: false },
  { key: 'images', label: '+ periodic images', showBonds: true, images: true, forceColors: false },
  { key: 'force', label: '+ force colour map', showBonds: true, images: true, forceColors: true },
];

/** Supercells of the default (13-atom YBCO) cell: n×n×n. */
export const BENCH_SIZES = [1, 2, 3, 4];

/** What this browser can run. */
export function benchCapabilities() {
  return {
    isolated: typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true,
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null,
  };
}

/** benchCapabilities plus a real WebGPU probe (adapter + 'shader-f16'). */
export async function probeBenchCapabilities() {
  const caps = benchCapabilities();
  const why = caps.webgpu ? await webgpuUnsupportedReason() : 'WebGPU is not available in this browser';
  // Which GPU the browser offers WebGPU on (integrated, discrete, software):
  // needed to read the WebGPU timings.
  let gpuAdapter = null;
  if (caps.webgpu) {
    try {
      const info = (await /** @type {any} */ (navigator).gpu.requestAdapter({ powerPreference: 'high-performance' }))?.info;
      if (info) gpuAdapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
    } catch { /* no adapter details */ }
  }
  return { ...caps, webgpu: !why, webgpuReason: why, gpuAdapter };
}

/**
 * One line for debug/gpuRoundTrip.js's canvas readback result, e.g.
 * "snapshot 1.2 ms exact / VideoFrame 0.9 ms exact".
 * @param {any} k measureCanvasReadback's result
 * @returns {string|null}
 */
export function canvasReadbackSummary(k) {
  if (!k) return null;
  if (k.error) return k.error;
  const one = (name, r) => (r?.error ? `${name}: ${r.error}` : `${name} ${r.ms.toFixed(1)} ms ${r.result}`);
  return `${one('snapshot', k.snapshot)} / ${one('VideoFrame', k.videoFrame)}`;
}

/**
 * One line for debug/gpuRoundTrip.js's measureDispatchCost result, e.g.
 * "12 µs per kernel (ggml-like; 8 µs reusing one bind group)".
 * @param {any} d
 * @returns {string|null}
 */
export function dispatchCostSummary(d) {
  if (!d) return null;
  if (d.error) return d.error;
  return `${d.ggmlUs.toFixed(0)} µs per kernel (ggml-like; ${d.sameUs.toFixed(0)} µs reusing one bind group`
    + `${d.wait === 'canvas' ? '' : `; timed with ${d.wait}`})`;
}

/**
 * Summary of one profiled WebGPU evaluation (MLIPRunner.takeOpProfile):
 * each kernel's time minus the median empty wait, totals per op (descending)
 * and the 20 slowest kernels.
 * @param {{ op: string, name: string, ne: number[], ms: number }[]} prof
 */
export function summarizeOpProfile(prof) {
  const waits = prof.filter((x) => x.op === '(wait)').map((x) => x.ms).sort((a, b) => a - b);
  const baseWaitMs = waits.length ? waits[waits.length >> 1] : 0;
  const ops = prof.filter((x) => x.op !== '(wait)').map((x) => ({ ...x, net: Math.max(0, x.ms - baseWaitMs) }));
  /** @type {Map<string, { op: string, n: number, ms: number }>} */
  const by = new Map();
  for (const x of ops) {
    const e = by.get(x.op) || { op: x.op, n: 0, ms: 0 };
    e.n += 1;
    e.ms += x.net;
    by.set(x.op, e);
  }
  const byOp = [...by.values()].sort((a, b) => b.ms - a.ms);
  return {
    kernels: ops.length,
    baseWaitMs,
    netTotalMs: byOp.reduce((t, e) => t + e.ms, 0),
    byOp,
    top: [...ops].sort((a, b) => b.net - a.net).slice(0, 20).map((x) => ({ op: x.op, name: x.name, ne: x.ne, ms: x.net })),
  };
}

/**
 * WebGPU round-trip latency (one tiny copy + map, and an empty submit's
 * onSubmittedWorkDone), on this page and in a worker; medians in ms, null
 * where WebGPU is unavailable. Every PET-MAD WebGPU step waits once.
 * @returns {Promise<{ page: object|null, worker: object|null }>}
 */
export async function probeGpuRoundTrip() {
  /** @type {any} */
  const pageRt = await measureGpuRoundTrip().catch((e) => ({ error: e?.message || String(e) }));
  // The kernel-launch probe first: in some browsers (headless Chromium) a
  // WebGPU canvas snapshot loses the context's WebGPU instance. It waits
  // through the canvas only where mapAsync is slow, as PET-MAD does.
  const page = pageRt && !pageRt.error
    ? {
      ...pageRt,
      dispatch: await measureDispatchCost({ canvas: pageRt.mapMs > SLOW_MAP_MS })
        .catch((e) => ({ error: e?.message || String(e) })),
      canvas: await measureCanvasReadback().catch((e) => ({ error: e?.message || String(e) })),
    } : pageRt;
  const worker = await new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL('../workers/gpuProbeWorker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      resolve({ error: e?.message || String(e) });
      return;
    }
    const timer = setTimeout(() => { w.terminate(); resolve({ error: 'timed out' }); }, 40000);
    w.onmessage = (ev) => { clearTimeout(timer); w.terminate(); resolve(ev.data); };
    w.onerror = (ev) => { clearTimeout(timer); w.terminate(); resolve({ error: ev.message || 'worker error' }); };
    w.postMessage(null);
  });
  return { page, worker };
}

/** Why a configuration cannot run here, or null. */
export function unavailableReason(spec, caps = benchCapabilities()) {
  if (spec.needs === 'isolation' && !caps.isolated) {
    return 'needs a cross-origin isolated page (enable multi-threading above, or tick "multi-threaded" in the PET-MAD controls)';
  }
  if (typeof spec.threads === 'number' && caps.cores && spec.threads > caps.cores) {
    return `this machine has ${caps.cores} logical cores`;
  }
  if (spec.needs === 'webgpu' && !caps.webgpu) return caps.webgpuReason || 'WebGPU is not available in this browser';
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function tableRows() {
  return /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('#objectTable tbody tr')));
}

/** Remove file-list rows added since `keep` rows were there (newest first). */
function removeRowsAfter(keep) {
  const rows = tableRows();
  for (let i = rows.length - 1; i >= keep; i -= 1) {
    /** @type {HTMLElement|null} */ (rows[i].querySelector('.delete'))?.click();
  }
}

async function loadDefaultCell() {
  const cv = await import('../core/crystal-viewer.js');
  const defaults = await import('../defaults/structure_defaults.js');
  const before = structureShip.container.length;
  await cv.loadStructure(defaults.defaultPOSCAR, 'YBCO');
  await waitFor(() => structureShip.container.length > before && !!fileBrowser.selectedStructure?.periodic?.wrapped, 10000);
  await sleep(150);
}

/** Point the PET-MAD controls at this run's model and backend. */
function selectMlipControls(spec, modelBase) {
  const selector = document.getElementById('BackendPotentialSelector');
  if (!selector) throw new Error('PET-MAD controls not found');
  /** @type {HTMLSelectElement|null} */
  const model = selector.querySelector('[data-role="mlip-model"]');
  /** @type {HTMLSelectElement|null} */
  const backend = selector.querySelector('[data-role="mlip-backend"]');
  if (model) {
    const value = modelBase ? `${modelBase.replace(/\/?$/, '/')}${spec.model}` : spec.model;
    if (![...model.options].some((o) => o.value === value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = spec.model;
      model.appendChild(opt);
    }
    model.value = value;
  }
  if (backend) backend.value = spec.backend || 'cpu';
}

/** Click a potential in the persistent picker (re-renders the action body). */
function pickPotential(potential) {
  /** @type {HTMLElement|null} */
  const btn = document.querySelector(`#BackendPotentialSelector [data-role="potential-toggle"] button[data-potential="${potential}"]`);
  if (btn && !btn.classList.contains('active')) btn.click();
  general.atomisticPotential = potential;
}

/**
 * Measure one configuration on one cell with one viewer option.
 * @returns {Promise<object>} the record
 */
async function runOne(spec, cells, visual, opts) {
  const { createSupercell } = await import('../ui/SuperCellModule.js');
  const { updateVisualization } = await import('../core/crystal-viewer.js');
  const { openPanel } = await import('../ui/panels/PanelManager.js');
  const { ensureCalculatorRunner } = await import('../ui/BackendPanel/AtomisticPanels.js');
  const { buildNEPStructure } = await import('../atomistic/relaxer.js');
  const { getLastMdTiming } = await import('../atomistic/MD.js');

  const keepRows = tableRows().length;
  await loadDefaultCell();
  if (cells > 1) createSupercell(cells, cells, cells);

  general.showBonds = visual.showBonds;
  general.showPeriodic = visual.images;
  general.showPBCBonds = visual.images;
  general.atomsColor = visual.forceColors ? 'force' : 'elements';
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPeriodic: true });

  openPanel('backend');
  await sleep(150);
  general.mlipWorker = !spec.mainThread;
  general.mlipThreads = spec.threads ?? 'auto';
  general.mlipBlockedGemm = spec.kernel !== 'dot';
  general.mlipGpuReadback = spec.readback === 'map' ? 'map' : 'auto';
  general.mlipGpuMatmul = spec.matmul === 'reg_tile' ? 'reg_tile' : 'tile4';
  pickPotential(spec.potential);
  if (spec.potential === 'mlip') selectMlipControls(spec, opts.modelBase);

  const { runner } = await ensureCalculatorRunner((t) => opts.onStatus?.(t));
  const runtime = typeof runner.describe === 'function' ? runner.describe() : { variant: 'nep', threads: 1 };
  if (spec.backend === 'webgpu' && runtime.variant !== 'gpu') {
    throw new Error(`WebGPU did not start (fell back to ${runtime.variant})`);
  }
  if (spec.kernel === 'dot' && runtime.blockedGemm == null) {
    throw new Error('this PET-MAD build has no matrix-kernel switch');
  }
  const s = buildNEPStructure(runner, fileBrowser.selectedStructure);
  await runner.compute(s); // warm-up: allocation, and the thread calibration for this size
  // Three timed evaluations; the median one, with the wasm's breakdown of it
  // (runner.lastTimings: phases, and on WebGPU encode / wait / read-back).
  const evals = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    await runner.compute(s);
    evals.push({ ms: performance.now() - t0, timings: runner.lastTimings ?? null });
  }
  evals.sort((x, y) => x.ms - y.ms);
  const evalMs = evals[1].ms;
  const tw = evals[1].timings || {};
  // Every current WebGPU runner reports how it read results back. Without it
  // the worker (or page) ran an older external/mlip_wasm/mlip_runner.js from
  // the browser cache, and the numbers would describe that old code.
  if (spec.backend === 'webgpu' && evals[1].timings && !('gpuReadback' in tw)) {
    throw new Error('PET-MAD ran older cached code (mlip_runner.js): clear the browser cache, '
      + 'or serve with `make serve` / tools/devserver.py (no caching), and reload');
  }
  // WebGPU: once per potential and cell size, one more evaluation with every
  // kernel timed on its own (where a wait is quick: canvas readback, or a
  // fast mapAsync; with Firefox's 100 ms mapAsync it would take a minute).
  let opProfile = null;
  if (spec.backend === 'webgpu' && opts.profileOps && typeof runner.setOpProfile === 'function'
      && (tw.gpuReadback === 'canvas' || (runtime.gpuMapMs != null && runtime.gpuMapMs <= SLOW_MAP_MS))) {
    try {
      await runner.setOpProfile(true);
      await runner.compute(s);
      opProfile = summarizeOpProfile(await runner.takeOpProfile());
    } finally {
      await runner.setOpProfile(false);
    }
  }
  const steps = Math.max(3, Math.min(opts.maxSteps, Math.round(opts.targetMs / Math.max(1, evalMs + 15))));
  const wrapped = fileBrowser.selectedStructure.periodic?.visibleWrapped?.elements?.length ?? null;
  const atoms = fileBrowser.selectedStructure.atoms.length;
  const bonds = fileBrowser.selectedStructure.bonds?.length ?? 0;

  /** @type {HTMLElement|null} */ (document.querySelector('#BackendModeSwitch button[data-mode="md"]'))?.click();
  await sleep(250);
  /** @type {HTMLInputElement|null} */
  const stepsInput = document.querySelector('#mdStepsInput');
  /** @type {HTMLButtonElement|null} */
  const startBtn = document.querySelector('#mdStartBtn');
  if (!stepsInput || !startBtn) throw new Error('MD controls not found');
  stepsInput.value = String(steps);

  const prevProfile = general.mdProfile;
  general.mdProfile = true; // fills the viewer/plot/save buckets
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 16);
  const tRun = performance.now();
  let finished = false;
  try {
    startBtn.click();
    await sleep(200);
    finished = await waitFor(() => !startBtn.disabled || opts.shouldStop?.(), 60 * 60 * 1000, 100);
    if (opts.shouldStop?.() && startBtn.disabled) {
      /** @type {HTMLElement|null} */ (document.querySelector('#mdStopBtn'))?.click();
      await waitFor(() => !startBtn.disabled, 60000, 100);
      finished = false;
    }
  } finally {
    clearInterval(timer);
    general.mdProfile = prevProfile;
  }
  const wallMs = performance.now() - tRun;
  const tm = getLastMdTiming() || {};
  const n = Math.max(1, tm.steps || steps);
  /** @type {HTMLElement|null} */ (document.querySelector('#BackendModeSwitch button[data-mode="relax"]'))?.click();
  await sleep(100);
  removeRowsAfter(keepRows);

  return {
    potential: spec.key,
    potentialLabel: spec.label,
    family: spec.family,
    backend: spec.backend || 'cpu',
    cells,
    visual: visual.key,
    visualLabel: visual.label,
    atoms,
    drawnAtoms: wrapped,
    bonds,
    steps,
    evalMs,
    threads: runner.lastThreads ?? runtime.threads ?? 1,
    threadsRequested: spec.threads ?? null,
    // The matrix kernel the CPU products used ('blocked' | 'dot'); null for
    // NEP and WebGPU runs, and for builds without the switch.
    kernel: spec.kernel && runtime.variant !== 'gpu' && runtime.blockedGemm != null
      ? (runtime.blockedGemm ? 'blocked' : 'dot') : null,
    variant: runtime.variant ?? 'nep',
    finished: finished && (tm.steps || 0) > 0,
    wallMs,
    longestGapMs: longest,
    stepsPerS: tm.totalMs ? (1000 * n) / tm.totalMs : NaN,
    msPerStep: tm.totalMs ? tm.totalMs / n : NaN,
    forceMs: (tm.forceEvalMs ?? NaN) / n,
    onStepMs: (tm.onStepMs ?? NaN) / n,
    viewerMs: (tm.viewerMs ?? NaN) / n,
    plotMs: (tm.plotMs ?? NaN) / n,
    saveMs: (tm.saveMs ?? NaN) / n,
    waitMs: (tm.waitMs ?? NaN) / n,
    fastFrames: tm.fastFrames ?? null,
    fullFrames: tm.fullFrames ?? null,
    // One PET-MAD evaluation broken down (ms; null for NEP): inside the wasm
    // the neighbour list + inputs, graph build, allocation, graph compute
    // (WebGPU: encoding + submitting, waiting for the GPU) and reading the
    // results; outside it the worker round trip.
    wasmMs: tw.totalMs ?? null,
    wasmInputsMs: tw.inputsMs ?? null,
    wasmGraphMs: tw.graphMs ?? null,
    wasmAllocMs: tw.allocMs ?? null,
    wasmComputeMs: tw.computeMs ?? null,
    wasmResultsMs: tw.resultsMs ?? null,
    gpuEncodeMs: tw.gpuEncodeMs ?? null,
    gpuWaitMs: tw.gpuWaitMs ?? null,
    gpuReadMs: tw.gpuReadMs ?? null,
    // WebGPU: how results came back, 'canvas' (snapshot) or 'map' (mapAsync).
    gpuReadback: tw.gpuReadback ?? null,
    // WebGPU: the f32 matrix kernel that ran ('tile4' | 'reg_tile').
    gpuMatmul: tw.gpuMatmul ?? null,
    roundTripMs: tw.roundTripMs ?? null,
    // One WebGPU evaluation with every kernel timed alone (summarizeOpProfile):
    // the JSON keeps the table, the CSV the total and the top ops.
    gpuOpProfile: opProfile,
    gpuProfileNetMs: opProfile ? opProfile.netTotalMs : null,
    gpuProfileTop: opProfile ? opProfile.byOp.slice(0, 6).map((o) => `${o.op} ${o.ms.toFixed(1)} ms ×${o.n}`).join('; ') : null,
  };
}

/**
 * Run the selected grid. `potentials` are keys (BENCH_POTENTIALS or
 * cpuBenchKey()), run in that order. Viewer settings the runs change are
 * restored at the end; the user's own rows stay in the file list and the
 * previously selected one is re-selected.
 * @param {{ potentials: string[], sizes: number[], visuals: string[],
 *   targetMs?: number, maxSteps?: number, modelBase?: string,
 *   onProgress?: (p: {index: number, total: number, label: string}) => void,
 *   onRecord?: (r: object) => void, onStatus?: (t: string) => void,
 *   shouldStop?: () => boolean }} opts
 * @returns {Promise<{ meta: object, records: object[] }>}
 */
export async function runPotentialBenchmark(opts) {
  const caps = await probeBenchCapabilities();
  const specs = [...new Set(opts.potentials)].map(benchSpec).filter((p) => p && !unavailableReason(p, caps));
  const visuals = BENCH_VISUALS.filter((v) => opts.visuals.includes(v.key));
  const sizes = [...opts.sizes].sort((a, b) => a - b);
  const settings = {
    targetMs: opts.targetMs ?? 6000,
    maxSteps: opts.maxSteps ?? 60,
    modelBase: opts.modelBase ?? '',
    onStatus: opts.onStatus,
    shouldStop: opts.shouldStop,
  };
  const saved = {
    showBonds: general.showBonds,
    showPeriodic: general.showPeriodic,
    showPBCBonds: general.showPBCBonds,
    atomsColor: general.atomsColor,
    mlipWorker: general.mlipWorker,
    mlipThreads: general.mlipThreads,
    mlipBlockedGemm: general.mlipBlockedGemm,
    mlipGpuReadback: general.mlipGpuReadback,
    mlipGpuMatmul: general.mlipGpuMatmul,
    atomisticPotential: general.atomisticPotential,
  };
  const selectedIndex = fileBrowser.selectedRowIndex;

  const plan = [];
  for (const spec of specs) {
    for (const cells of sizes) {
      if (spec.maxCells && cells > spec.maxCells) continue;
      visuals.forEach((visual, k) => plan.push({ spec, cells, visual, profileOps: k === 0 }));
    }
  }
  const meta = {
    date: new Date().toISOString(),
    cpus: caps.cores,
    isolated: caps.isolated,
    webgpu: caps.webgpu,
    gpuAdapter: caps.gpuAdapter,
    gpuRoundTrip: caps.webgpu ? await probeGpuRoundTrip().catch(() => null) : null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    note: 'In-app benchmark (Debug window). MD through the MD panel; viewer timings use this machine\'s GPU.',
  };
  const records = [];
  try {
    for (let i = 0; i < plan.length; i += 1) {
      if (opts.shouldStop?.()) break;
      const { spec, cells, visual, profileOps } = plan[i];
      opts.onProgress?.({ index: i, total: plan.length, label: `${spec.label} · ${cells}×${cells}×${cells} · ${visual.label}` });
      let rec;
      try {
        rec = await runOne(spec, cells, visual, { ...settings, profileOps });
      } catch (error) {
        rec = {
          potential: spec.key, potentialLabel: spec.label, family: spec.family, backend: spec.backend || 'cpu',
          cells, visual: visual.key, visualLabel: visual.label, finished: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // The run's WebGPU context on every row, so the CSV carries it too.
      rec.gpuAdapter = caps.gpuAdapter
        ? [caps.gpuAdapter.vendor, caps.gpuAdapter.architecture, caps.gpuAdapter.description].filter(Boolean).join(' ') : null;
      rec.gpuRoundTripPageMs = meta.gpuRoundTrip?.page?.mapMs ?? null;
      rec.gpuRoundTripWorkerMs = meta.gpuRoundTrip?.worker?.mapMs ?? null;
      const canvasPage = meta.gpuRoundTrip?.page?.canvas;
      const canvasWorker = meta.gpuRoundTrip?.worker?.canvas;
      rec.gpuCanvasPageMs = canvasPage?.snapshot?.ms ?? null;
      rec.gpuCanvasWorkerMs = canvasWorker?.snapshot?.ms ?? null;
      rec.gpuVideoFrameWorkerMs = canvasWorker?.videoFrame?.ms ?? null;
      rec.gpuCanvasResult = canvasReadbackSummary(canvasWorker || canvasPage);
      // µs per kernel launch in the worker (ggml-like, and reusing one bind group).
      rec.gpuDispatchUsWorker = meta.gpuRoundTrip?.worker?.dispatch?.ggmlUs ?? null;
      rec.gpuDispatchSameUsWorker = meta.gpuRoundTrip?.worker?.dispatch?.sameUs ?? null;
      records.push(rec);
      opts.onRecord?.(rec);
    }
  } finally {
    Object.assign(general, saved);
    try {
      const { selectStructure } = await import('../ui/FileBrowswerPanel.js');
      if (selectedIndex >= 0 && selectedIndex < structureShip.container.length) selectStructure(selectedIndex);
    } catch { /* selection restore is best effort */ }
    const { updateVisualization } = await import('../core/crystal-viewer.js');
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPeriodic: true });
  }
  return { meta, records };
}

/** CSV of the records (the table view of the figures). */
export function benchRecordsToCsv(records) {
  const cols = ['potentialLabel', 'backend', 'variant', 'threadsRequested', 'threads', 'kernel', 'atoms', 'drawnAtoms', 'bonds', 'visualLabel',
    'steps', 'stepsPerS', 'msPerStep', 'forceMs', 'viewerMs', 'plotMs', 'saveMs', 'waitMs', 'longestGapMs',
    'fastFrames', 'fullFrames', 'evalMs', 'wasmMs', 'wasmInputsMs', 'wasmGraphMs', 'wasmAllocMs', 'wasmComputeMs',
    'wasmResultsMs', 'gpuEncodeMs', 'gpuWaitMs', 'gpuReadMs', 'gpuReadback', 'gpuMatmul', 'gpuProfileNetMs', 'gpuProfileTop', 'roundTripMs', 'gpuRoundTripPageMs', 'gpuRoundTripWorkerMs',
    'gpuCanvasPageMs', 'gpuCanvasWorkerMs', 'gpuVideoFrameWorkerMs', 'gpuCanvasResult', 'gpuDispatchUsWorker',
    'gpuDispatchSameUsWorker', 'gpuAdapter', 'finished', 'error'];
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(','), ...records.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}
