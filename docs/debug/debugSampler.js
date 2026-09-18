/**
 * The Debug panel's data source: a periodic sampler of memory, playback and
 * render figures, kept in a bounded history with event markers.
 *
 * Runs independently of the panel DOM (started once at boot when ?debug is
 * present — ui/DebugPanel.js registers the panel and starts this), so a
 * memory step that happens while the panel is collapsed is still recorded.
 * Each tick:
 *   - accounts every loaded container (debug/memoryAccounting.js) and reports
 *     MB per container,
 *   - accounts the app-wide stores a frame switch touches but no container
 *     owns (the global id registry, bond-length/coordination tables, the
 *     wrapped periodic copy, measurements, selection/hover state),
 *   - sums the CPU-side buffers of everything in the three.js scene (geometry
 *     attributes, index, instance matrices/colours) and reads the renderer's
 *     own counts (live GL geometries / textures / programs, draw calls,
 *     triangles) plus the scene object count and the DOM node count,
 *   - differences the debugTrace counters into rates: frames applied to the
 *     scene per second (playback) and frames rendered per second,
 *   - reads the shown frame index of the selected row,
 *   - picks up performance.memory.usedJSHeapSize where the browser has it
 *     (Chromium only; NaN elsewhere) — readout only, the plots show the
 *     accounted figures the user asked for,
 *   - measures how long the accounting itself took and backs off the tick
 *     automatically when it gets expensive (an eager 2000-frame container is
 *     a lot of objects to walk every second).
 * Containers appearing / disappearing between ticks become event markers, as
 * do the trace events ordinary modules emit (play, pause, proper load, ...).
 *
 * Nothing here touches the DOM; the panel subscribes and draws.
 */

import {
  app, fileBrowser, structureShip, usedIDs, bondLengths, coordinationNumbers,
  periodic, measurements, highlightHover, atomSelection,
} from '../state/store.js';
import { getContainerId } from '../state/structures.js';
import { LruByteCache } from '../model/LruByteCache.js';
import { counters, onEvent, markEvent } from './debugTrace.js';
import { accountContainer, roughSizeOf, toMB } from './memoryAccounting.js';

/** History cap: an hour at the default 1 s tick. */
export const MAX_SAMPLES = 3600;
/** Ticks slower than this are not worth it; faster than this would dominate the profile. */
export const MIN_INTERVAL_MS = 250;
export const DEFAULT_INTERVAL_MS = 1000;
/** Accounting taking longer than this fraction of the tick doubles the tick. */
const BACKOFF_FRACTION = 0.25;

/**
 * @typedef {{
 *   id: string, label: string, mb: number, frames: number, materialized: number,
 *   isTrajectory: boolean, storeMB: number, recordMB: number, liveMB: number,
 *   structureMB: number, otherMB: number, renderRefs: number, truncated: boolean,
 *   stats: Record<string, number> | null,
 *   kind: string,
 * }} ContainerSample
 *
 * @typedef {{
 *   t: number,
 *   wall: number,
 *   frame: number,
 *   frames: number,
 *   playbackFps: number,
 *   fastFps: number,
 *   fullFps: number,
 *   renderFps: number,
 *   renderMs: number,
 *   renderCapacityFps: number,
 *   containersMB: number,
 *   appMB: number,
 *   sceneMB: number,
 *   totalMB: number,
 *   heapMB: number,
 *   ids: number,
 *   sceneObjects: number,
 *   sceneGeometries: number,
 *   sceneMaterials: number,
 *   glGeometries: number,
 *   glTextures: number,
 *   glPrograms: number,
 *   drawCalls: number,
 *   triangles: number,
 *   domNodes: number,
 *   accountMs: number,
 *   panelMs: number,
 *   containers: ContainerSample[],
 *   appStores: Record<string, {mb: number, entries: number}>,
 * }} DebugSample
 *
 * @typedef {{t: number, label: string}} DebugMarker
 */

/** @type {DebugSample[]} */
const samples = [];
/** @type {DebugMarker[]} */
const markers = [];
/** @type {Set<(sample: DebugSample) => void>} */
const sampleSubs = new Set();
/** @type {Set<(marker: DebugMarker) => void>} */
const markerSubs = new Set();

let timer = 0;
let started = false;
let paused = false;
let intervalMs = DEFAULT_INTERVAL_MS;
let requestedIntervalMs = DEFAULT_INTERVAL_MS;
let t0 = 0;                    // performance.now() at start
let lastTickTime = 0;
let lastCounters = counters();
// The memory accounting is the expensive part of a tick (a walk over every
// loaded structure) while the rates are free. When the walk gets costly it is
// repeated only every ACCOUNT_BUDGET_FRACTION^-1 of its own duration — a 60 ms
// walk runs at most every 600 ms, i.e. every other 250 ms tick — and the
// previous memory figures are carried forward in between (the plot steps).
const ACCOUNT_BUDGET_FRACTION = 0.1;
let lastAccountAt = -Infinity;
let lastAccountMs = 0;
/** @type {null | {containers: ContainerSample[], appStores: Record<string, {mb: number, entries: number}>, appMB: number, sceneMB: number, scene: ReturnType<typeof accountScene>, ids: Set<string>}} */
let lastAccount = null;
/** @type {Set<string>} container ids present at the previous tick */
let knownIds = new Set();
let unsubscribeTrace = null;

/** Seconds since the sampler started, for a performance.now() timestamp. */
function toT(time) {
  return (time - t0) / 1000;
}

/** performance.memory is Chromium-only and untyped; read it defensively. */
function heapBytes() {
  const mem = /** @type {any} */ (performance).memory;
  const used = mem && mem.usedJSHeapSize;
  return Number.isFinite(used) ? used : NaN;
}

/**
 * CPU-side bytes held by the three.js scene: every unique geometry's
 * attribute arrays and index, plus per-mesh instance matrices/colours. These
 * live outside every StructureContainer (the render modules own them), so a
 * mesh that is rebuilt without being disposed shows up here and nowhere else.
 */
function accountScene() {
  const scene = app.scene;
  const out = { bytes: 0, objects: 0, geometries: 0, materials: 0 };
  if (!scene || typeof scene.traverse !== 'function') return out;
  const geoms = new Set();
  const mats = new Set();
  scene.traverse((obj) => {
    out.objects++;
    const g = obj.geometry;
    if (g && !geoms.has(g)) {
      geoms.add(g);
      for (const attr of Object.values(g.attributes || {})) {
        const arr = /** @type {any} */ (attr)?.array;
        if (arr && Number.isFinite(arr.byteLength)) out.bytes += arr.byteLength;
      }
      if (g.index?.array) out.bytes += g.index.array.byteLength;
    }
    for (const key of ['instanceMatrix', 'instanceColor']) {
      const arr = obj[key]?.array;
      if (arr && Number.isFinite(arr.byteLength)) out.bytes += arr.byteLength;
    }
    const m = obj.material;
    if (m) for (const mm of (Array.isArray(m) ? m : [m])) mats.add(mm);
  });
  out.geometries = geoms.size;
  out.materials = mats.size;
  return out;
}

/**
 * The app-wide stores a frame switch can touch but no container owns. A
 * function, not a constant: `fileBrowser.overlayEntries` is reassigned.
 */
function APP_STORES() {
  return {
    usedIDs,
    bondLengths,
    coordinationNumbers,
    periodic,
    measurements,
    highlightHover,
    atomSelection,
    overlayEntries: fileBrowser.overlayEntries,
  };
}

/** Top-level entry count of a store (Set/Map size, array length, key count,
 *  or the summed length of an object of arrays). */
function entryCount(store) {
  if (!store) return 0;
  if (store instanceof Set || store instanceof Map) return store.size;
  if (Array.isArray(store)) return store.length;
  if (typeof store === 'object') {
    let n = 0;
    for (const v of Object.values(store)) {
      if (Array.isArray(v)) n += v.length;
      else if (v instanceof Set || v instanceof Map) n += v.size;
      else if (v !== null && v !== undefined) n += 1;
    }
    return n;
  }
  return 0;
}

/** The renderer's own bookkeeping (three.js WebGLRenderer.info). */
function rendererInfo() {
  const info = app.renderer?.info;
  return {
    glGeometries: info?.memory?.geometries ?? NaN,
    glTextures: info?.memory?.textures ?? NaN,
    glPrograms: Array.isArray(info?.programs) ? info.programs.length : NaN,
    drawCalls: info?.render?.calls ?? NaN,
    triangles: info?.render?.triangles ?? NaN,
  };
}

function addMarker(label, time = performance.now()) {
  const marker = { t: toT(time), label: String(label) };
  markers.push(marker);
  if (markers.length > MAX_SAMPLES) markers.shift();
  for (const fn of markerSubs) {
    try { fn(marker); } catch (err) { console.error('debugSampler marker subscriber failed', err); }
  }
}

function tick() {
  const now = performance.now();
  const dt = Math.max(1e-3, (now - lastTickTime) / 1000);
  lastTickTime = now;

  const current = counters();
  const rate = (name) => ((current[name] || 0) - (lastCounters[name] || 0)) / dt;
  const playbackFps = rate('frameApplied');
  const fastFps = rate('playbackFast');   // frames that took the render fast path
  const fullFps = rate('playbackFull');   // frames that rebuilt atoms + bonds
  const renderFps = rate('render');
  // Wall time per rendered frame (CPU submit; GPU-inclusive in the Debug
  // window's Bench mode) and the frame rate the scene alone could sustain.
  const dRender = (current.render || 0) - (lastCounters.render || 0);
  const dRenderMs = (current.renderMs || 0) - (lastCounters.renderMs || 0);
  const renderMs = dRender > 0 ? dRenderMs / dRender : NaN;
  const renderCapacityFps = renderMs > 0 ? 1000 / renderMs : NaN;
  lastCounters = current;

  const list = structureShip.container;
  const accountDue = !lastAccount
    || now - lastAccountAt >= lastAccountMs / ACCOUNT_BUDGET_FRACTION
    || list.length !== lastAccount.containers.length
    || list.some((c) => !lastAccount.ids.has(getContainerId(c)));
  const accountStart = performance.now();
  /** @type {ContainerSample[]} */
  let containerSamples = [];
  const idsNow = new Set();
  let totalMB = 0;
  let appStores, appBytes = 0, scene;
  if (accountDue) {
  // Account every container with ONE shared seen-set (see memoryAccounting).
  const seen = new WeakSet();
  for (const container of list) {
    const id = getContainerId(container);
    idsNow.add(id);
    const acc = accountContainer(container, seen);
    const mb = toMB(acc.totalBytes);
    totalMB += mb;
    containerSamples.push({
      id,
      label: acc.label,
      mb,
      frames: acc.frames,
      materialized: acc.materialized,
      isTrajectory: acc.isTrajectory,
      storeMB: toMB(acc.storeBytes),
      recordMB: toMB(acc.recordBytes),
      liveMB: toMB(acc.liveBytes),
      structureMB: toMB(acc.structureBytes),
      otherMB: toMB(acc.otherBytes),
      renderRefs: acc.renderRefs,
      truncated: acc.truncated,
      stats: acc.stats,
      kind: acc.kind,
    });
  }
  // App-wide stores no container owns, with the SAME seen-set so anything a
  // container already claimed (a structure the hover state points at) is not
  // counted twice. usedIDs is the notable one: an id registry that only ever
  // grew until bond ids were released on rebuild (utils/UUIDModule.js).
  // Per store, so a growing one can be NAMED rather than inferred from the aggregate.
  appStores = {};
  for (const [name, store] of Object.entries(APP_STORES())) {
    const bytes = roughSizeOf(store, { seen }).bytes;
    appBytes += bytes;
    appStores[name] = { mb: toMB(bytes), entries: entryCount(store) };
  }
  scene = accountScene();
  lastAccountMs = performance.now() - accountStart;
  lastAccountAt = now;
  lastAccount = { containers: containerSamples, appStores, appMB: toMB(appBytes), sceneMB: toMB(scene.bytes), scene, ids: idsNow };
  } else {
    // Carry the previous walk forward; the rates below are still fresh.
    containerSamples = lastAccount.containers;
    for (const c of containerSamples) { idsNow.add(c.id); totalMB += c.mb; }
    appStores = lastAccount.appStores;
    scene = lastAccount.scene;
  }
  const gl = rendererInfo();
  const accountMs = accountDue ? lastAccountMs : 0;
  const containersMB = totalMB;
  const appMB = lastAccount.appMB;
  const sceneMB = lastAccount.sceneMB;
  totalMB = containersMB + appMB + sceneMB;

  // Containers that came or went since the last tick (knownIds is seeded at
  // start, so what was already loaded then gets no marker).
  for (const cs of containerSamples) {
    if (!knownIds.has(cs.id)) addMarker(`load ${cs.label}`, now);
  }
  for (const id of knownIds) {
    if (!idsNow.has(id)) addMarker('remove', now);
  }
  knownIds = idsNow;

  const selected = list[fileBrowser.selectedRowIndex];
  const sample = {
    t: toT(now),
    wall: Date.now(),
    frame: Number.isFinite(fileBrowser.stepInput) ? fileBrowser.stepInput : NaN,
    frames: selected ? selected.structures.length : 0,
    playbackFps,
    fastFps,
    fullFps,
    renderFps,
    renderMs,
    renderCapacityFps,
    containersMB,
    appMB,
    sceneMB,
    totalMB,
    heapMB: toMB(heapBytes()),
    ids: usedIDs.size,
    sceneObjects: scene.objects,
    sceneGeometries: scene.geometries,
    sceneMaterials: scene.materials,
    ...gl,
    domNodes: document.getElementsByTagName('*').length,
    accountMs,
    panelMs: NaN,
    containers: containerSamples,
    appStores,
  };
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();

  // Time the subscribers (the Debug window's plots and tables) too, so the
  // window can show its OWN cost next to the accounting's.
  const subStart = performance.now();
  for (const fn of sampleSubs) {
    try { fn(sample); } catch (err) { console.error('debugSampler subscriber failed', err); }
  }
  sample.panelMs = performance.now() - subStart;

  // Back off the whole tick only when a single walk exceeds the tick itself
  // (the accounting cadence above already keeps it under 10% of the time).
  let next = intervalMs;
  if (accountDue && lastAccountMs > BACKOFF_FRACTION * intervalMs * 4) next = Math.min(intervalMs * 2, 30_000);
  else if (intervalMs > requestedIntervalMs && lastAccountMs < BACKOFF_FRACTION * intervalMs) {
    next = Math.max(requestedIntervalMs, intervalMs / 2);
  }
  if (next !== intervalMs) {
    intervalMs = next;
    reschedule();
  }
}

function reschedule() {
  if (timer) clearInterval(timer);
  timer = 0;
  if (!started || paused) return;
  timer = window.setInterval(tick, intervalMs);
}

/** Start sampling (idempotent). Called once when ?debug is present. */
export function startDebugSampler() {
  if (started) return;
  started = true;
  t0 = performance.now();
  lastTickTime = t0;
  lastCounters = counters();
  knownIds = new Set(structureShip.container.map(getContainerId));
  unsubscribeTrace = onEvent((event) => addMarker(event.label, event.time));
  reschedule();
}

/** Stop for good (tests / teardown). */
export function stopDebugSampler() {
  if (timer) clearInterval(timer);
  timer = 0;
  started = false;
  if (unsubscribeTrace) { unsubscribeTrace(); unsubscribeTrace = null; }
}

export function isDebugSamplerRunning() {
  return started && !paused;
}

/** Pause / resume without losing history. */
export function setDebugSamplerPaused(value) {
  paused = !!value;
  if (!paused) {
    // A long pause must not read as one giant dt with a near-zero rate.
    lastTickTime = performance.now();
    lastCounters = counters();
  }
  reschedule();
  addMarker(paused ? 'pause sampling' : 'resume sampling');
}

/** Requested tick in ms (the effective one may be longer under back-off). */
export function setDebugSamplerInterval(ms) {
  requestedIntervalMs = Math.max(MIN_INTERVAL_MS, Number(ms) || DEFAULT_INTERVAL_MS);
  intervalMs = requestedIntervalMs;
  reschedule();
}

export function getDebugSamplerInterval() {
  return { requestedMs: requestedIntervalMs, effectiveMs: intervalMs };
}

/** Subscribe to new samples. Returns the unsubscribe function. */
export function onDebugSample(fn) {
  sampleSubs.add(fn);
  return () => sampleSubs.delete(fn);
}

/** Subscribe to new markers. Returns the unsubscribe function. */
export function onDebugMarker(fn) {
  markerSubs.add(fn);
  return () => markerSubs.delete(fn);
}

/** The recorded history (live arrays — do not mutate). */
export function getDebugHistory() {
  return { samples, markers };
}

/** Drop the recorded history (the panel's "Clear" button). Sampling goes on. */
export function clearDebugHistory() {
  samples.length = 0;
  markers.length = 0;
  lastAccount = null; // next tick accounts afresh
}

/** Add a user marker (the panel's "Mark" button). */
export function addDebugMarker(label = 'mark') {
  addMarker(label);
}

/**
 * The "GC hint" action. Two things the page can legitimately do:
 *   1. call `gc()` when the browser exposes it (Chromium started with
 *      --js-flags=--expose-gc, or DevTools' "Collect garbage"),
 *   2. evict every UNPINNED entry from the LruByteCaches reachable from the
 *      loaded containers (volumetric-field grids the user is not looking at;
 *      pinned = on screen, kept), so cache churn can be told apart from a
 *      real leak.
 * Both are recorded as a marker. Returns what actually happened.
 * @returns {{gcCalled: boolean, cachesEvicted: number, bytesEvicted: number}}
 */
export function gcHint() {
  let gcCalled = false;
  const g = /** @type {any} */ (globalThis).gc;
  if (typeof g === 'function') {
    try { g(); gcCalled = true; } catch { /* not permitted */ }
  }

  /** @type {Set<LruByteCache>} */
  const caches = new Set();
  const seen = new WeakSet();
  for (const container of structureShip.container) {
    accountContainer(container, seen, {
      visit: (obj) => { if (obj instanceof LruByteCache) caches.add(obj); },
    });
  }
  let bytesEvicted = 0;
  for (const cache of caches) {
    const before = cache.bytes;
    const budget = cache.budgetBytes;
    cache.setBudget(0);       // evicts everything unpinned, stops at pinned
    cache.setBudget(budget);  // restore
    bytesEvicted += before - cache.bytes;
  }
  const parts = [gcCalled ? 'gc()' : 'no gc()'];
  if (caches.size) parts.push(`${caches.size} cache${caches.size === 1 ? '' : 's'} evicted`);
  markEvent(`GC hint: ${parts.join(', ')}`);
  return { gcCalled, cachesEvicted: caches.size, bytesEvicted };
}

/**
 * The whole history as CSV: one row per sample, the fixed columns first,
 * then one MB column per container ever seen (by label, id-suffixed when two
 * files share a name), and an `event` column carrying the markers that fell
 * between the previous sample and this one, ';'-joined.
 * @returns {string}
 */
export function debugHistoryToCsv() {
  /** @type {Map<string, string>} id -> column header */
  const columns = new Map();
  const labelCount = new Map();
  for (const s of samples) {
    for (const c of s.containers) {
      if (columns.has(c.id)) continue;
      const n = (labelCount.get(c.label) || 0) + 1;
      labelCount.set(c.label, n);
      columns.set(c.id, n === 1 ? `${c.label}_MB` : `${c.label}#${n}_MB`);
    }
  }
  const esc = (v) => {
    const str = String(v ?? '');
    return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const num = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : '');
  const storeNames = Object.keys(APP_STORES());
  const header = ['t_s', 'wall_iso', 'frame', 'frames', 'playback_fps', 'fast_fps', 'full_fps', 'render_fps',
    'render_ms', 'render_capacity_fps',
    'total_MB', 'containers_MB', 'app_MB', 'scene_MB', 'heap_MB', 'ids', 'scene_objects',
    'gl_geometries', 'gl_textures', 'gl_programs', 'draw_calls', 'triangles', 'dom_nodes',
    'accounting_ms', ...storeNames.map((n) => `app_${n}_MB`), ...storeNames.map((n) => `app_${n}_n`),
    ...[...columns.values()].map(esc), 'event'];
  const rows = [header.join(',')];
  let mi = 0;
  let prevT = -Infinity;
  for (const s of samples) {
    const events = [];
    while (mi < markers.length && markers[mi].t <= s.t) {
      if (markers[mi].t > prevT) events.push(markers[mi].label);
      mi++;
    }
    prevT = s.t;
    const byId = new Map(s.containers.map((c) => [c.id, c.mb]));
    const row = [
      num(s.t), new Date(s.wall).toISOString(), Number.isFinite(s.frame) ? s.frame + 1 : '',
      s.frames, num(s.playbackFps, 2), num(s.fastFps, 2), num(s.fullFps, 2), num(s.renderFps, 2),
      num(s.renderMs, 2), num(s.renderCapacityFps, 1), num(s.totalMB),
      num(s.containersMB), num(s.appMB), num(s.sceneMB), num(s.heapMB),
      num(s.ids, 0), num(s.sceneObjects, 0), num(s.glGeometries, 0), num(s.glTextures, 0),
      num(s.glPrograms, 0), num(s.drawCalls, 0), num(s.triangles, 0), num(s.domNodes, 0),
      num(s.accountMs, 1),
      ...storeNames.map((n) => num(s.appStores?.[n]?.mb, 4)),
      ...storeNames.map((n) => num(s.appStores?.[n]?.entries, 0)),
      ...[...columns.keys()].map((id) => num(byId.get(id))),
      esc(events.join('; ')),
    ];
    rows.push(row.join(','));
  }
  return rows.join('\n') + '\n';
}
