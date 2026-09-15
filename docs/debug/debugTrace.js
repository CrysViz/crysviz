// Trace hooks for the Debug panel — the ONLY thing ordinary app modules import
// from debug/. Dependency-free on purpose (no store, no DOM), so a module deep
// in the render or model layer can call these without creating an import
// cycle, and they cost one branch when nobody is listening.
//
// Two kinds of trace:
//   markEvent(label)   a point in time worth a vertical marker on the debug
//                      plots ("play", "pause", "frame 12 loaded", ...).
//   count(name)        a monotonic counter the sampler differences into a
//                      rate (frames shown per second, renders per second).
//
// The sampler (debug/debugSampler.js) subscribes with onEvent() and reads the
// counters with counters(); nothing here buffers events when no listener is
// attached, so a page without ?debug pays nothing beyond the function call.

/** @type {Set<(event: {label: string, time: number}) => void>} */
const listeners = new Set();

/** @type {Record<string, number>} */
const counterValues = Object.create(null);

/**
 * Record a point-in-time event. `time` is performance.now() unless given.
 * @param {string} label
 * @param {number} [time]
 */
export function markEvent(label, time = performance.now()) {
  if (!listeners.size) return;
  const event = { label: String(label), time };
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error('debugTrace listener failed', err); }
  }
}

/**
 * Bump a monotonic counter by `by` (default 1). Always cheap.
 * @param {string} name
 * @param {number} [by]
 */
export function count(name, by = 1) {
  counterValues[name] = (counterValues[name] || 0) + by;
}

/** Snapshot of every counter — a fresh plain object each call. */
export function counters() {
  return { ...counterValues };
}

/**
 * Listen for events. Returns the unsubscribe function.
 * @param {(event: {label: string, time: number}) => void} fn
 */
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether anything is listening — lets a caller skip building a label. */
export function isTracing() {
  return listeners.size > 0;
}
