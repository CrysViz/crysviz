/**
 * Shared background worker pool.
 *
 * A lazily-created, app-wide pool of `min(hardwareConcurrency, 16)` module workers
 * (`computeWorker.js`), each holding its own WASM instance. It pre-warms itself in the
 * background shortly after startup (so the first real job doesn't pay worker-spawn +
 * wasm-compile cost), and exposes two dispatch styles that any time-critical feature can
 * reuse:
 *   - `runOnAll(task, payloads)` — data-parallel fan-out, one payload per worker.
 *   - `run(task, payload)`       — a single task on the next worker (round-robin).
 *
 * SharedArrayBuffer is unavailable on GitHub Pages (no COOP/COEP), so payloads are
 * structure-cloned to workers; results come back via transfer (zero-copy).
 */

const MAX_WORKERS = 16;

/** @type {{workers: Worker[], n: number} | null} */
let pool = null;
let reqCounter = 0;
let rr = 0; // round-robin cursor for run()

/** True if Web Workers are usable in this environment. */
export function available() {
  return typeof Worker !== 'undefined';
}

function create() {
  const n = Math.max(1, Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 4));
  const workers = [];
  for (let i = 0; i < n; i++) {
    workers.push(new Worker(
      new URL('./computeWorker.js', import.meta.url),
      { type: 'module' },
    ));
  }
  return { workers, n };
}

/** Get (creating if needed) the pool, or null if workers are unavailable. */
export function getPool() {
  if (!pool && available()) pool = create();
  return pool;
}

/** Number of workers (0 if unavailable). */
export function size() {
  const p = getPool();
  return p ? p.n : 0;
}

/**
 * Pre-warm: create the workers and trigger their wasm init in the background. Safe to
 * call repeatedly. Responses (reqId -1) are ignored.
 */
export function warmUp() {
  const p = getPool();
  if (!p) return;
  for (const w of p.workers) w.postMessage({ reqId: -1, task: 'warmup', payload: null });
}

/**
 * Resolve once for a single worker message matching `reqId`. Interim
 * `{reqId, progress}` messages (posted by handlers that report progress) are
 * routed to `onProgress` without settling the promise.
 * @param {Worker} w
 * @param {number} reqId
 * @param {(progress: number) => void} [onProgress]
 */
function awaitWorker(w, reqId, onProgress) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data.reqId !== reqId) return;
      if ('progress' in e.data) {
        if (onProgress) onProgress(e.data.progress);
        return;
      }
      cleanup();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    const onErr = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error('worker error'));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
  });
}

/**
 * Run `task` on every worker with a per-worker payload (data-parallel fan-out).
 * `payloads.length` must equal `size()`. Resolves to the array of worker results.
 * @param {string} task
 * @param {any[]} payloads
 * @returns {Promise<any[]>}
 */
export function runOnAll(task, payloads) {
  const p = getPool();
  if (!p) return Promise.reject(new Error('workers unavailable'));
  const reqId = ++reqCounter;
  return Promise.all(p.workers.map((w, i) => {
    const done = awaitWorker(w, reqId);
    w.postMessage({ reqId, task, payload: payloads[i] });
    return done;
  }));
}

/**
 * Run a single `task` on the next worker (round-robin). For future point tasks.
 *
 * `onProgress` receives the 0-100 values a long-running handler chooses to
 * report (see computeWorker.js — the handler is handed a `progress` callback);
 * handlers that never report simply never call it.
 *
 * @param {string} task
 * @param {any} payload
 * @param {Transferable[]} [transfer]
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<any>}
 */
export function run(task, payload, transfer, onProgress) {
  const p = getPool();
  if (!p) return Promise.reject(new Error('workers unavailable'));
  const w = p.workers[rr++ % p.n];
  const reqId = ++reqCounter;
  const done = awaitWorker(w, reqId, onProgress);
  w.postMessage({ reqId, task, payload }, transfer || []);
  return done;
}

// Pre-warm in the background once, after startup, when the main thread is idle — so the
// first real job finds warm workers. Guarded so it never blocks initial render.
if (available()) {
  const schedule = (typeof requestIdleCallback === 'function')
    ? (cb) => requestIdleCallback(cb, { timeout: 3000 })
    : (cb) => setTimeout(cb, 1);
  schedule(() => {
    try { warmUp(); } catch { /* best-effort */ }
  });
}
