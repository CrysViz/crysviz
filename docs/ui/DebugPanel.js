// Debug window ('debug'): memory per loaded trajectory, the frame being
// shown, and playback / render frame rates, as live time-series plots with
// event markers. Registered ONLY when the page was opened with `?debug`
// (debug/debugMode.js) — see registerDebugPanel() at the bottom.
//
// Built in the trajectory player's idiom on purpose: a transport row of
// round/square buttons and uppercase micro-labels (trajectoryPanel.css), the
// same Plotly plot cards (ui/TrajectoryPlot.js with its own ids/specs), and a
// mono tape-counter readout. The data comes from debug/debugSampler.js, which
// runs whether or not this window is open; the window replays the recorded
// history when it is (re)built and streams from there.

import { registerPanel, openPanel } from './panels/PanelManager.js';
import { createTrajectoryPlot } from './TrajectoryPlot.js';
import { downloadBlob } from './SavePanel.js';
import {
  startDebugSampler, onDebugSample, onDebugMarker, getDebugHistory,
  setDebugSamplerPaused, isDebugSamplerRunning, setDebugSamplerInterval,
  getDebugSamplerInterval, addDebugMarker, gcHint, debugHistoryToCsv,
  clearDebugHistory, DEFAULT_INTERVAL_MS,
} from '../debug/debugSampler.js';
import { formatBytes } from '../debug/memoryAccounting.js';
import { setRenderBenchmark, isRenderBenchmark } from '../render/index.js';

/** @typedef {import('../debug/debugSampler.js').DebugSample} DebugSample */

export const DEBUG_PANEL_ID = 'debug';

// Per-trajectory series colours, assigned by FIRST APPEARANCE of a container
// and never reassigned (the map outlives panel rebuilds), so a file keeps its
// colour when another is loaded or removed. Same hue family as the trajectory
// plot's series (dark canvas) with darkened twins for the light canvas; the
// legend and the table carry the names, so identity never rests on colour
// alone. Beyond eight, colours repeat — the legend still disambiguates. The
// order was checked for adjacent-pair separation under deutan/protan/tritan
// simulation (dataviz validator): worst adjacent pair ΔE 11.0.
const CONTAINER_COLORS = [
  { color: '#53c7ff', lightColor: '#0f77b8' },
  { color: '#ffb347', lightColor: '#c9720a' },
  { color: '#c39bff', lightColor: '#7c3fd1' },
  { color: '#7CFC9B', lightColor: '#1f9c46' },
  { color: '#ff7eb6', lightColor: '#c2185b' },
  { color: '#ffe066', lightColor: '#a68a00' },
  { color: '#5fd3bc', lightColor: '#0f8a73' },
  { color: '#ff9f6e', lightColor: '#c4551a' },
];
/** @type {Map<string, number>} container id -> colour slot */
const colorSlots = new Map();
/** @type {Map<string, string>} container id -> legend label */
const containerLabels = new Map();

const MEM_SERIES = 'mem:';   // prefix: one series per container id
// The aggregates are neutral so the per-file hues stay the identity carriers:
// total (dashed), app-wide stores and scene buffers (solid greys), and the JS
// heap (dotted, Chromium only) — the one figure the browser measures itself.
const MEM_SPEC = {
  totalMB: { color: '#dddddd', lightColor: '#444444', dash: 'dash',    group: 'memory', label: 'total (accounted)', plot: true },
  appMB:   { color: '#9aa5b1', lightColor: '#556270', dash: 'solid',   group: 'memory', label: 'app state',   plot: true },
  sceneMB: { color: '#cfc4a8', lightColor: '#6f6650', dash: 'solid',   group: 'memory', label: 'scene buffers', plot: true },
  heapMB:  { color: '#ffffff', lightColor: '#111111', dash: 'dot',     group: 'memory', label: 'JS heap',     plot: true },
};
const MEM_GROUPS = {
  memory: { color: '#dddddd', lightColor: '#444444', title: 'MB' },
};
const PLAY_SPEC = {
  playbackFps: { color: '#7CFC9B', lightColor: '#1f9c46', dash: 'solid', group: 'rate',  label: 'shown f/s',  plot: true },
  renderFps:   { color: '#53c7ff', lightColor: '#0f77b8', dash: 'solid', group: 'rate',  label: 'render f/s', plot: true },
  frame:       { color: '#ffb347', lightColor: '#c9720a', dash: 'solid', group: 'frame', label: 'frame',      plot: true },
  renderMs:    { color: '#c39bff', lightColor: '#7c3fd1', dash: 'solid', group: 'ms',    label: 'render ms',  plot: true },
};
const PLAY_GROUPS = {
  rate:  { color: '#7CFC9B', lightColor: '#1f9c46', title: 'frames / s' },
  frame: { color: '#ffb347', lightColor: '#c9720a', title: 'frame #' },
  ms:    { color: '#c39bff', lightColor: '#7c3fd1', title: 'ms / frame' },
};
// Renderer / registry counts — the things that leak without moving a byte
// figure the model can see: GL objects the renderer still holds, objects in
// the scene graph, and ids in the global registry (second axis: it runs into
// the thousands).
const RENDER_SPEC = {
  glGeometries: { color: '#53c7ff', lightColor: '#0f77b8', dash: 'solid', group: 'count', label: 'GL geometries', plot: true },
  glTextures:   { color: '#ffb347', lightColor: '#c9720a', dash: 'solid', group: 'count', label: 'GL textures',   plot: true },
  glPrograms:   { color: '#c39bff', lightColor: '#7c3fd1', dash: 'solid', group: 'count', label: 'GL programs',   plot: true },
  sceneObjects: { color: '#7CFC9B', lightColor: '#1f9c46', dash: 'solid', group: 'count', label: 'scene objects', plot: true },
  ids:          { color: '#ff7eb6', lightColor: '#c2185b', dash: 'solid', group: 'ids',   label: 'ids registered', plot: true },
};
const RENDER_GROUPS = {
  count: { color: '#dddddd', lightColor: '#444444', title: 'count' },
  ids:   { color: '#ff7eb6', lightColor: '#c2185b', title: 'ids' },
};
// App-state breakdown: one series per app-wide store, so the aggregate's
// growth is attributed to a named store. Same hue order as the per-file
// palette; the stores are a fixed, known list so the order is stable.
const STORE_ORDER = ['usedIDs', 'bondLengths', 'coordinationNumbers', 'periodic',
  'measurements', 'highlightHover', 'atomSelection', 'overlayEntries'];
const STORE_LABELS = {
  usedIDs: 'id registry', bondLengths: 'bond lengths', coordinationNumbers: 'coordination',
  periodic: 'periodic copy', measurements: 'measurements', highlightHover: 'hover/highlight',
  atomSelection: 'selection', overlayEntries: 'overlay entries',
};
const STORE_SPEC = Object.fromEntries(STORE_ORDER.map((name, i) => [`store:${name}`, {
  ...CONTAINER_COLORS[i % CONTAINER_COLORS.length], dash: 'solid', group: 'store', label: STORE_LABELS[name], plot: true,
}]));
const STORE_GROUPS = {
  store: { color: '#dddddd', lightColor: '#444444', title: 'MB' },
};

function shortLabel(label) {
  const s = String(label ?? '?');
  return s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-10)}` : s;
}

function containerSpec(name) {
  if (!name.startsWith(MEM_SERIES)) return null;
  const id = name.slice(MEM_SERIES.length);
  let slot = colorSlots.get(id);
  if (slot === undefined) { slot = colorSlots.size; colorSlots.set(id, slot); }
  const c = CONTAINER_COLORS[slot % CONTAINER_COLORS.length];
  return { ...c, dash: 'solid', group: 'memory', label: shortLabel(containerLabels.get(id) || id), plot: true };
}

function fmtRate(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '–';
}
function fmtMB(v, digits = 1) {
  return Number.isFinite(v) ? v.toFixed(digits) : '–';
}

// --- per-build state -------------------------------------------------------
let memPlot = null;
let playPlot = null;
let renderPlot = null;
let storePlot = null;
// Samples wait here and reach the plots in one extendTraces per plot every
// PLOT_REFRESH_MS (a redraw is ~30 ms of main thread; four plots per sample
// per second was a visible hitch during playback). Readout and tables still
// update on every sample — they are cheap DOM text.
const PLOT_REFRESH_MS = 2000;
/** @type {DebugSample[]} */
let pendingSamples = [];
let flushTimer = 0;
let panelBody = null;
/** First-sample MB per store since the window was built, for the Δ column. */
/** @type {Record<string, number>} */
let storeBaseline = {};
let unsubSample = null;
let unsubMarker = null;
/** @type {Record<string, HTMLElement>} */
let els = {};
let userMarkCount = 0;

/** The plot points for one sample (memory, playback and renderer plots). */
function pointsFor(sample) {
  /** @type {Record<string, number>} */
  const mem = { t: sample.t, totalMB: sample.totalMB, appMB: sample.appMB, sceneMB: sample.sceneMB };
  // The heap is left out of the point entirely where the browser has none,
  // so no empty series/legend entry appears outside Chromium.
  if (Number.isFinite(sample.heapMB)) mem.heapMB = sample.heapMB;
  for (const c of sample.containers) {
    containerLabels.set(c.id, c.label);
    mem[MEM_SERIES + c.id] = c.mb;
  }
  const play = {
    t: sample.t,
    playbackFps: sample.playbackFps,
    renderFps: sample.renderFps,
    frame: Number.isFinite(sample.frame) ? sample.frame + 1 : NaN,
    renderMs: sample.renderMs,
  };
  const render = {
    t: sample.t,
    glGeometries: sample.glGeometries,
    glTextures: sample.glTextures,
    glPrograms: sample.glPrograms,
    sceneObjects: sample.sceneObjects,
    ids: sample.ids,
  };
  /** @type {Record<string, number>} */
  const stores = { t: sample.t };
  for (const name of STORE_ORDER) stores[`store:${name}`] = sample.appStores?.[name]?.mb ?? NaN;
  return { mem, play, render, stores };
}

function renderStoreTable(sample) {
  const tbody = els.storeBody;
  if (!tbody || !sample.appStores) return;
  tbody.replaceChildren();
  for (const name of STORE_ORDER) {
    const st = sample.appStores[name];
    if (!st) continue;
    if (!(name in storeBaseline) && Number.isFinite(st.mb)) storeBaseline[name] = st.mb;
    const delta = st.mb - (storeBaseline[name] ?? st.mb);
    const tr = document.createElement('tr');
    const swatch = document.createElement('span');
    swatch.className = 'dbgSwatch';
    swatch.style.backgroundColor = STORE_SPEC[`store:${name}`].color;
    const cells = [
      { node: swatch, text: STORE_LABELS[name], cls: 'dbgName', title: `state/store.js ${name}` },
      { text: String(st.entries), cls: 'dbgNum', title: 'top-level entries' },
      { text: formatBytes(st.mb * 1024 * 1024), cls: 'dbgNum' },
      { text: `${delta >= 0 ? '+' : ''}${formatBytes(delta * 1024 * 1024)}`, cls: `dbgNum${delta > 0.05 ? ' dbgGrowing' : ''}`, title: 'change since this window was built' },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      if (cell.cls) td.className = cell.cls;
      if (cell.title) td.title = cell.title;
      if (cell.node) td.appendChild(cell.node);
      td.appendChild(document.createTextNode(cell.text));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function renderReadout(sample) {
  const { effectiveMs } = getDebugSamplerInterval();
  setText(els.frameCur, Number.isFinite(sample.frame) ? String(sample.frame + 1) : '–');
  setText(els.frameTot, String(sample.frames || 0));
  setText(els.playback, fmtRate(sample.playbackFps));
  setText(els.fast, fmtRate(sample.fastFps));
  setText(els.full, fmtRate(sample.fullFps));
  setText(els.render, fmtRate(sample.renderFps));
  setText(els.renderMs, Number.isFinite(sample.renderMs) ? sample.renderMs.toFixed(1) : '–');
  setText(els.capacity, Number.isFinite(sample.renderCapacityFps) ? sample.renderCapacityFps.toFixed(0) : '–');
  setText(els.total, fmtMB(sample.totalMB));
  if (els.heapItem) {
    els.heapItem.hidden = !Number.isFinite(sample.heapMB);
    setText(els.heap, fmtMB(sample.heapMB, 0));
  }
  setText(els.ids, Number.isFinite(sample.ids) ? String(sample.ids) : '–');
  setText(els.dom, Number.isFinite(sample.domNodes) ? String(sample.domNodes) : '–');
  setText(els.calls, Number.isFinite(sample.drawCalls) ? String(sample.drawCalls) : '–');
  setText(els.tris, Number.isFinite(sample.triangles) ? fmtCount(sample.triangles) : '–');
  // This sample's accounting cost (0 when the previous walk was carried
  // forward) and the PREVIOUS sample's subscriber cost — the window's own
  // plots/tables — which is only known once its handlers have run.
  const { samples } = getDebugHistory();
  const prev = samples.length > 1 ? samples[samples.length - 2] : null;
  const panelMs = prev && Number.isFinite(prev.panelMs) ? prev.panelMs : NaN;
  setText(els.cost, `${sample.accountMs.toFixed(0)}${Number.isFinite(panelMs) ? ` + ${panelMs.toFixed(0)}` : ''} ms`);
  setText(els.tick, `${(effectiveMs / 1000).toFixed(effectiveMs % 1000 ? 2 : 0)} s`);
}

function fmtCount(v) {
  if (!Number.isFinite(v)) return '–';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  return String(Math.round(v));
}

function renderTable(sample) {
  const tbody = els.tableBody;
  if (!tbody) return;
  tbody.replaceChildren();
  for (const c of sample.containers) {
    const tr = document.createElement('tr');
    const swatch = document.createElement('span');
    swatch.className = 'dbgSwatch';
    const spec = containerSpec(MEM_SERIES + c.id);
    swatch.style.backgroundColor = spec ? spec.color : '';
    const cells = [
      { node: swatch, text: c.label, cls: 'dbgName', title: c.label },
      { text: c.kind, title: 'trajectory: one system in motion, fast playback allowed; dataset: unrelated structures, full rebuild every frame; eager: all frames held as Structures' },
      { text: `${c.materialized} / ${c.frames}`, title: 'materialised frames / frames (a store-backed trajectory keeps 1)' },
      { text: formatBytes(c.mb * 1024 * 1024), cls: 'dbgNum' },
      { text: c.isTrajectory ? fmtMB(c.storeMB) : fmtMB(c.structureMB), cls: 'dbgNum' },
      { text: c.isTrajectory ? fmtMB(c.recordMB, 2) : '–', cls: 'dbgNum' },
      { text: c.isTrajectory ? fmtMB(c.liveMB, 2) : '–', cls: 'dbgNum' },
      { text: fmtMB(c.otherMB, 2), cls: 'dbgNum' },
      { text: c.stats ? `${c.stats.shown} / ${c.stats.reused} / ${c.stats.rebuilt} / ${c.stats.detached} / ${c.stats.pristine}` : '–',
        cls: 'dbgNum', title: 'shown / reused / rebuilt / detached / pristine' },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      if (cell.cls) td.className = cell.cls;
      if (cell.title) td.title = cell.title;
      if (cell.node) td.appendChild(cell.node);
      td.appendChild(document.createTextNode(cell.text));
      if (c.truncated) td.classList.add('dbgTruncated');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function plots() {
  return [memPlot, playPlot, renderPlot, storePlot].filter(Boolean);
}

function panelVisible() {
  return !!panelBody && panelBody.isConnected && !document.hidden && panelBody.getClientRects().length > 0;
}

function flushPlots() {
  flushTimer = 0;
  if (!pendingSamples.length) return;
  // Collapsed / behind another side-dock tab / page hidden: keep buffering,
  // the redraw is wasted work nobody sees. The buffer is bounded by the plots'
  // own ring cap.
  if (!panelVisible()) {
    if (pendingSamples.length > 3600) pendingSamples.splice(0, pendingSamples.length - 3600);
    flushTimer = window.setTimeout(flushPlots, PLOT_REFRESH_MS);
    return;
  }
  const batch = pendingSamples;
  pendingSamples = [];
  const points = batch.map(pointsFor);
  if (memPlot) memPlot.updateBatch(points.map((p) => p.mem));
  if (playPlot) playPlot.updateBatch(points.map((p) => p.play));
  if (renderPlot) renderPlot.updateBatch(points.map((p) => p.render));
  if (storePlot) storePlot.updateBatch(points.map((p) => p.stores));
}

function onSample(sample) {
  pendingSamples.push(sample);
  if (!flushTimer) flushTimer = window.setTimeout(flushPlots, PLOT_REFRESH_MS);
  renderReadout(sample);
  renderTable(sample);
  renderStoreTable(sample);
}

function onMarker(marker) {
  for (const p of plots()) p.addMarker({ x: marker.t, label: marker.label });
}

/** Seed both plots from the recorded history in ONE draw each. */
function replayHistory() {
  const { samples, markers } = getDebugHistory();
  if (!samples.length) return;
  const t = samples.map((s) => s.t);
  /** @type {Record<string, number[]>} */
  const mem = {
    t,
    totalMB: samples.map((s) => s.totalMB),
    appMB: samples.map((s) => s.appMB),
    sceneMB: samples.map((s) => s.sceneMB),
  };
  if (samples.some((s) => Number.isFinite(s.heapMB))) mem.heapMB = samples.map((s) => s.heapMB);
  const ids = new Set();
  for (const s of samples) for (const c of s.containers) { ids.add(c.id); containerLabels.set(c.id, c.label); }
  for (const id of ids) {
    mem[MEM_SERIES + id] = samples.map((s) => {
      const c = s.containers.find((x) => x.id === id);
      return c ? c.mb : NaN;
    });
  }
  memPlot.setSeries(mem);
  playPlot.setSeries({
    t,
    playbackFps: samples.map((s) => s.playbackFps),
    renderFps: samples.map((s) => s.renderFps),
    frame: samples.map((s) => (Number.isFinite(s.frame) ? s.frame + 1 : NaN)),
    renderMs: samples.map((s) => s.renderMs),
  });
  renderPlot.setSeries({
    t,
    glGeometries: samples.map((s) => s.glGeometries),
    glTextures: samples.map((s) => s.glTextures),
    glPrograms: samples.map((s) => s.glPrograms),
    sceneObjects: samples.map((s) => s.sceneObjects),
    ids: samples.map((s) => s.ids),
  });
  /** @type {Record<string, number[]>} */
  const stores = { t };
  for (const name of STORE_ORDER) stores[`store:${name}`] = samples.map((s) => s.appStores?.[name]?.mb ?? NaN);
  storePlot.setSeries(stores);
  for (const m of markers) onMarker(m);
  const last = samples[samples.length - 1];
  renderReadout(last);
  renderTable(last);
  renderStoreTable(last);
}

function updateRecordButton() {
  const running = isDebugSamplerRunning();
  if (!els.recordBtn) return;
  els.recordBtn.textContent = running ? '⏸' : '⏺';
  els.recordBtn.title = running ? 'Pause sampling' : 'Resume sampling';
  els.recordBtn.classList.toggle('is-recording', running);
}

/**
 * Build the window body. Idempotent per body element: called by the panel
 * system on first expand (persistent window registered closed) and again if
 * the body is rebuilt.
 * @param {string} target body element id
 */
export function addDebugPanel(target = `cvPanelBody-${DEBUG_PANEL_ID}`) {
  const body = document.getElementById(target);
  if (!body) return;
  removeDebugPanel();
  panelBody = body;

  const { requestedMs } = getDebugSamplerInterval();
  const intervals = [250, 500, 1000, 2000, 5000];
  const options = intervals.map((ms) => `<option value="${ms}"${ms === requestedMs ? ' selected' : ''}>${ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}</option>`).join('');

  body.innerHTML = `
    <div class="panelBody dbgBody">
      <div class="trajTransport dbgTransport">
        <button id="dbgRecordBtn" class="trajBtn dbgRecordBtn" type="button" title="Pause sampling">⏸</button>
        <label class="trajOpt">Sample
          <select id="dbgIntervalSelect">${options}</select>
        </label>
        <span class="dbgSpacer"></span>
        <input id="dbgMarkLabel" class="dbgMarkLabel" type="text" placeholder="marker label" maxlength="40" />
        <button id="dbgMarkBtn" class="trajBtn dbgTextBtn" type="button" title="Add an event marker to the plots">Mark</button>
        <button id="dbgGcBtn" class="trajBtn dbgTextBtn" type="button" title="Call gc() where the browser exposes it and evict unpinned field caches; adds a marker">GC hint</button>
        <button id="dbgCsvBtn" class="trajBtn dbgTextBtn" type="button" title="Download the recorded samples as CSV">CSV</button>
        <button id="dbgClearBtn" class="trajBtn dbgTextBtn" type="button" title="Drop the recorded history and empty the plots; sampling continues">Clear</button>
        <label class="trajOpt trajOptCheck" title="Render every animation frame, uncapped, and block on the GPU after each one: the render ms / capacity figures then measure what the whole scene can sustain rather than the on-demand rate">
          <input type="checkbox" id="dbgBenchToggle" />
          Bench render
        </label>
      </div>
      <div class="dbgReadout">
        <span class="dbgStat" title="Frame shown for the selected row / frames in it"><span class="dbgStatLabel">frame</span><span class="dbgStatValue" id="dbgFrameCur">–</span><span class="dbgStatUnit">/ <span id="dbgFrameTot">0</span></span></span>
        <span class="dbgStat" title="Frames applied to the scene per second (trajectory playback)"><span class="dbgStatLabel">shown</span><span class="dbgStatValue" id="dbgPlayback">–</span><span class="dbgStatUnit">f/s</span></span>
        <span class="dbgStat" title="Playback frames per second that took the render fast path (atoms/bonds moved in place) vs. a full atoms+bonds rebuild"><span class="dbgStatLabel">fast / full</span><span class="dbgStatValue" id="dbgFast">–</span><span class="dbgStatUnit">/ <span id="dbgFull">–</span> f/s</span></span>
        <span class="dbgStat" title="Frames rendered per second (on-demand render loop)"><span class="dbgStatLabel">render</span><span class="dbgStatValue" id="dbgRender">–</span><span class="dbgStatUnit">f/s</span></span>
        <span class="dbgStat" title="Wall time per rendered frame (CPU submit only, or GPU-inclusive with Bench render on) and the frame rate the scene alone could sustain"><span class="dbgStatLabel">scene</span><span class="dbgStatValue" id="dbgRenderMs">–</span><span class="dbgStatUnit">ms (≈ <span id="dbgCapacity">–</span> f/s)</span></span>
        <span class="dbgStat" title="Accounted bytes over all loaded structures/trajectories"><span class="dbgStatLabel">total</span><span class="dbgStatValue" id="dbgTotal">–</span><span class="dbgStatUnit">MB</span></span>
        <span class="dbgStat" id="dbgHeapItem" hidden title="performance.memory.usedJSHeapSize (Chromium only, whole page, quantised)"><span class="dbgStatLabel">JS heap</span><span class="dbgStatValue" id="dbgHeap">–</span><span class="dbgStatUnit">MB</span></span>
        <span class="dbgStat" title="Ids in the global registry (state/store.js usedIDs); must not climb during playback"><span class="dbgStatLabel">ids</span><span class="dbgStatValue" id="dbgIds">–</span></span>
        <span class="dbgStat" title="DOM nodes in the page"><span class="dbgStatLabel">dom</span><span class="dbgStatValue" id="dbgDom">–</span></span>
        <span class="dbgStat" title="Draw calls and triangles of the last rendered frame (renderer.info)"><span class="dbgStatLabel">draw</span><span class="dbgStatValue" id="dbgCalls">–</span><span class="dbgStatUnit">calls / <span id="dbgTris">–</span> tris</span></span>
        <span class="dbgStat" title="Accounting walk of this tick (0 when the previous walk was carried forward) + this window's own plots/tables on the previous tick, both main-thread ms"><span class="dbgStatLabel">cost</span><span class="dbgStatValue" id="dbgCost">–</span><span class="dbgStatUnit">@ <span id="dbgTick">–</span></span></span>
      </div>
      <div class="dbgPlots">
        <div class="dbgPlotTitle">Memory (MB)</div>
        <div id="dbgMemoryPlotHost" class="dbgPlotHost"></div>
        <div class="dbgPlotTitle">Playback</div>
        <div id="dbgPlaybackPlotHost" class="dbgPlotHost"></div>
        <div class="dbgPlotTitle">Renderer &amp; registries</div>
        <div id="dbgRendererPlotHost" class="dbgPlotHost"></div>
        <div class="dbgPlotTitle">App state by store (MB)</div>
        <div id="dbgStorePlotHost" class="dbgPlotHost"></div>
      </div>
      <div class="dbgTableWrap">
        <table class="dbgTable">
          <thead>
            <tr>
              <th>app store</th>
              <th title="top-level entries (Set/Map size, array length, keys)">entries</th>
              <th title="accounted size">size</th>
              <th title="change since this window was built">Δ</th>
            </tr>
          </thead>
          <tbody id="dbgStoreBody"></tbody>
        </table>
      </div>
      <div class="dbgTableWrap">
        <table class="dbgTable">
          <thead>
            <tr>
              <th>structure</th>
              <th title="trajectory (fast playback) / dataset (exact rebuild every frame) / eager">kind</th>
              <th title="materialised frames / frames">live / frames</th>
              <th title="accounted total">total</th>
              <th title="frame store (trajectory) or all Structures (eager) in MB">store</th>
              <th title="sparse per-frame style records, MB">records</th>
              <th title="the one live rendering Structure, MB">live</th>
              <th title="everything else on the container, MB">other</th>
              <th title="shown / reused / rebuilt / detached / pristine">switches</th>
            </tr>
          </thead>
          <tbody id="dbgTableBody"></tbody>
        </table>
      </div>
    </div>
  `;

  els = {
    recordBtn: body.querySelector('#dbgRecordBtn'),
    interval: body.querySelector('#dbgIntervalSelect'),
    markLabel: body.querySelector('#dbgMarkLabel'),
    markBtn: body.querySelector('#dbgMarkBtn'),
    gcBtn: body.querySelector('#dbgGcBtn'),
    csvBtn: body.querySelector('#dbgCsvBtn'),
    clearBtn: body.querySelector('#dbgClearBtn'),
    ids: body.querySelector('#dbgIds'),
    dom: body.querySelector('#dbgDom'),
    calls: body.querySelector('#dbgCalls'),
    tris: body.querySelector('#dbgTris'),
    frameCur: body.querySelector('#dbgFrameCur'),
    frameTot: body.querySelector('#dbgFrameTot'),
    playback: body.querySelector('#dbgPlayback'),
    fast: body.querySelector('#dbgFast'),
    full: body.querySelector('#dbgFull'),
    render: body.querySelector('#dbgRender'),
    renderMs: body.querySelector('#dbgRenderMs'),
    capacity: body.querySelector('#dbgCapacity'),
    benchToggle: body.querySelector('#dbgBenchToggle'),
    total: body.querySelector('#dbgTotal'),
    heapItem: body.querySelector('#dbgHeapItem'),
    heap: body.querySelector('#dbgHeap'),
    cost: body.querySelector('#dbgCost'),
    tick: body.querySelector('#dbgTick'),
    tableBody: body.querySelector('#dbgTableBody'),
    storeBody: body.querySelector('#dbgStoreBody'),
  };
  storeBaseline = {};

  const plotOpts = {
    maxPts: 3600,
    xKey: 't',
    xTitle: 'Time (s)',
    xTitleWithX: 'Time (s)',
    showComputeStats: false,
  };
  memPlot = createTrajectoryPlot(body.querySelector('#dbgMemoryPlotHost'), {
    ...plotOpts,
    id: 'debugMemoryPlot',
    seriesSpec: MEM_SPEC,
    groupMeta: MEM_GROUPS,
    groupOrder: ['memory'],
    specFor: containerSpec,
    acceptUnknown: true,
  });
  playPlot = createTrajectoryPlot(body.querySelector('#dbgPlaybackPlotHost'), {
    ...plotOpts,
    id: 'debugPlaybackPlot',
    seriesSpec: PLAY_SPEC,
    groupMeta: PLAY_GROUPS,
    groupOrder: ['rate', 'frame', 'ms'],
  });
  renderPlot = createTrajectoryPlot(body.querySelector('#dbgRendererPlotHost'), {
    ...plotOpts,
    id: 'debugRendererPlot',
    seriesSpec: RENDER_SPEC,
    groupMeta: RENDER_GROUPS,
    groupOrder: ['count', 'ids'],
  });
  storePlot = createTrajectoryPlot(body.querySelector('#dbgStorePlotHost'), {
    ...plotOpts,
    id: 'debugStorePlot',
    seriesSpec: STORE_SPEC,
    groupMeta: STORE_GROUPS,
    groupOrder: ['store'],
  });

  els.recordBtn.onclick = () => {
    setDebugSamplerPaused(isDebugSamplerRunning());
    updateRecordButton();
  };
  els.interval.onchange = () => {
    const value = (/** @type {HTMLSelectElement} */ (els.interval)).value;
    setDebugSamplerInterval(parseInt(value, 10) || DEFAULT_INTERVAL_MS);
  };
  const mark = () => {
    const label = (/** @type {HTMLInputElement} */ (els.markLabel)).value.trim();
    userMarkCount += 1;
    addDebugMarker(label || `mark ${userMarkCount}`);
    (/** @type {HTMLInputElement} */ (els.markLabel)).value = '';
  };
  els.markBtn.onclick = mark;
  els.markLabel.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); mark(); } };
  els.gcBtn.onclick = () => {
    const result = gcHint();
    if (!result.gcCalled) {
      els.gcBtn.title = 'gc() is not exposed by this browser (Chromium: --js-flags=--expose-gc, or DevTools ▸ Memory ▸ collect garbage); unpinned field caches were evicted';
    }
  };
  els.csvBtn.onclick = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(`crysviz-debug-${stamp}.csv`, new Blob([debugHistoryToCsv()], { type: 'text/csv' }));
  };
  els.clearBtn.onclick = () => {
    clearDebugHistory();
    pendingSamples = [];
    for (const p of plots()) p.clear();
  };
  (/** @type {HTMLInputElement} */ (els.benchToggle)).checked = isRenderBenchmark();
  els.benchToggle.onchange = () => {
    const on = (/** @type {HTMLInputElement} */ (els.benchToggle)).checked;
    setRenderBenchmark(on);
    addDebugMarker(on ? 'bench render on' : 'bench render off');
  };

  updateRecordButton();
  replayHistory();
  unsubSample = onDebugSample(onSample);
  unsubMarker = onDebugMarker(onMarker);
}

export function removeDebugPanel() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
  pendingSamples = [];
  panelBody = null;
  if (unsubSample) { unsubSample(); unsubSample = null; }
  if (unsubMarker) { unsubMarker(); unsubMarker = null; }
  if (memPlot) { memPlot.remove(); memPlot = null; }
  if (playPlot) { playPlot.remove(); playPlot = null; }
  if (renderPlot) { renderPlot.remove(); renderPlot = null; }
  if (storePlot) { storePlot.remove(); storePlot = null; }
  els = {};
}

/**
 * Register the window and start the sampler. Call only in debug mode; the
 * panel system tolerates a second call (registerPanel returns the existing
 * window). Placement: side dock by default, like the EOS plots window, with
 * `persist:false` so a debugging session leaves no trace in the remembered
 * layout of ordinary sessions.
 */
export function registerDebugPanel() {
  startDebugSampler();
  registerPanel({
    id: DEBUG_PANEL_ID,
    title: 'Debug',
    lifecycle: 'persistent',
    closable: true,
    closeMode: 'hide',
    persist: false,
    infoMd: './data/debugInfo.md',
    available() { return true; },
    buildContent(body) { addDebugPanel(body.id); },
    onDestroyContent() { removeDebugPanel(); },
    defaults: { dock: 'right', order: 96, closed: false, collapsed: false },
  });
}

/** Bring the window to the front of the side dock (after registration). */
export function openDebugPanel() {
  openPanel(DEBUG_PANEL_ID);
}
