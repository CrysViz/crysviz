// Standalone, reusable Plotly time-series plot for trajectory data (live MD
// runs, relaxations, loaded OUTCAR/extxyz trajectories). Renders into a
// caller-supplied host element and hands back a small imperative API. It does
// NOT register a panel.
//
// Backed by Plotly (shared, lazily-loaded — see utils/plotlyLoader.js), so it
// inherits Plotly's native niceties for free: click a legend entry to toggle a
// series (temperature / energy / force / pressure) on and off, box-zoom, pan,
// autoscale, and PNG/data export from the modebar — the same toolset the EOS
// plots use, for a consistent feel.
//
// Up to three quantity "groups" get their own y-axis so quantities on very
// different scales (temperature vs energy vs force/pressure) all read cleanly:
//   temperature (blue), energy (orange), force (green), pressure (violet).
// The first present group takes the left axis, the next two stack on the right.
//
// Performance: live streaming appends via Plotly.extendTraces (with a ring-buffer
// cap), never a full redraw; the playback cursor is a layout shape moved through
// a single rAF-coalesced relayout, so even a fast live feed can't thrash it.
//
// Reuse: the factory is parameterised (see createTrajectoryPlot's options) so
// the Debug panel (ui/DebugPanel.js) draws its memory / frame-rate time series
// with the SAME chrome, toolbar and streaming path — its own chart id, its own
// series/axis specs, wall-clock seconds on x, and vertical event markers.
// Every option defaults to the trajectory behaviour, so existing callers are
// unchanged.

import { loadPlotly } from '../utils/plotlyLoader.js';
import { expandSplitItem, closeExpandedSplitItem } from './panels/SideDock.js';
import { exportHistogramPNG } from './AnalysisPanels/histogramPlotly.js';

// Default id for the chart div — there is only ever one trajectory plot
// instance (see plotTheme below), so a fixed id is safe and is what lets
// exportHistogramPNG (shared with the analysis histograms) address it. Other
// users of the factory pass their own `id`.
const PLOT_ID = 'trajectoryPlotChart';

// Series metadata: colour, dash, autoscale group, legend label and whether the
// series is drawn (`plot`). Potential/kinetic energy are reported in the live
// stats line but not drawn (they would swamp the total-energy scale).
// Compact legend labels (units live on the y-axis titles/hover) so the
// horizontal legend fits the narrow panel without wrapping onto the plot.
// `lightColor` is the same hue darkened/saturated enough to stay readable on
// a white plot background — the plain `color` values are tuned for the dark
// canvas and read as washed-out pastels on white (see togglePlotTheme below).
const SERIES_SPEC = {
  temperatureK:       { color: '#53c7ff', lightColor: '#0f77b8', dash: 'solid', group: 'temperature', label: 'T',        plot: true },
  targetTemperatureK: { color: '#95efff', lightColor: '#4fa3cf', dash: 'dash',  group: 'temperature', label: 'T target', plot: true },
  etotEv:             { color: '#ffb347', lightColor: '#c9720a', dash: 'solid', group: 'energy',      label: 'E tot',    plot: true },
  epotEv:             { color: '#ffb347', lightColor: '#c9720a', dash: 'dot',   group: 'energy',      label: 'E pot',    plot: false },
  ekinEv:             { color: '#ffb347', lightColor: '#c9720a', dash: 'dashdot', group: 'energy',    label: 'E kin',    plot: false },
  meanForce:          { color: '#7CFC9B', lightColor: '#1f9c46', dash: 'solid', group: 'force',       label: 'mean |F|', plot: true },
  pressure:           { color: '#c39bff', lightColor: '#7c3fd1', dash: 'solid', group: 'pressure',    label: 'P',        plot: true },
};

// Per-group axis presentation (mirrors each group's primary series colour).
// Titles are short symbols (units live in the legend) so up to three axis
// labels fit without colliding.
const GROUP_META = {
  temperature: { color: '#53c7ff', lightColor: '#0f77b8', title: 'T (K)' },
  energy:      { color: '#ffb347', lightColor: '#c9720a', title: 'E (eV)' },
  force:       { color: '#7CFC9B', lightColor: '#1f9c46', title: '|F| (eV/Å)' },
  pressure:    { color: '#c39bff', lightColor: '#7c3fd1', title: 'P (GPa)' },
};

const GROUP_ORDER = ['temperature', 'energy', 'force', 'pressure'];
const AXIS_IDS = ['y', 'y2', 'y3'];      // left, right, outer-right

// After a failed Plotly load (offline), wait this long before trying again.
const PLOTLY_RETRY_MS = 15000;

const GENERIC_SPEC = { color: '#cccccc', lightColor: '#555555', dash: 'solid', group: null, label: null, plot: true };

// Light/dark toggle, module-level like eosPlots.js's plotThemes map — there is
// only ever one trajectory plot instance, and keeping it outside the factory
// lets the choice survive removeTrajectoryPlayer()/addTrajectoryPlayer()
// rebuilds (panel collapse/expand) rather than resetting to dark each time.
let plotTheme = 'dark';

function pickColor(spec, isLight) {
  return isLight ? spec.lightColor : spec.color;
}

function fmt(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

/**
 * Create a standalone trajectory time-series plot.
 *
 * @param {HTMLElement} hostEl
 * @param {object} [options]
 * @param {number} [options.maxPts=5000] - ring-buffer cap per streamed series.
 * @param {string} [options.id] - chart div id (default: the trajectory plot's).
 * @param {Record<string, object>} [options.seriesSpec] - per-series colour /
 *   dash / group / label / plot flags (default: the trajectory series).
 * @param {Record<string, object>} [options.groupMeta] - per-group axis colour
 *   and title (default: the trajectory groups).
 * @param {string[]} [options.groupOrder] - group -> axis assignment order.
 * @param {(name: string) => object | null} [options.specFor] - spec for a
 *   series name missing from seriesSpec (dynamic series, e.g. one per loaded
 *   trajectory). Default: a grey line in its own group named after the series.
 * @param {boolean} [options.acceptUnknown=false] - update() takes every key of
 *   the point (except the x key) as a series; default: only seriesSpec keys.
 * @param {string} [options.xKey='step'] - the point field carrying the x
 *   coordinate for update().
 * @param {string} [options.xTitle='Frame'] - x-axis title while no x values
 *   were supplied (1-based sample index).
 * @param {string} [options.xTitleWithX='Step'] - x-axis title once points
 *   carry an x coordinate.
 * @param {boolean} [options.showComputeStats=true] - keep the "Compute step
 *   stats" toolbar slot (hidden until setComputeStatsAvailable(true)).
 * @returns {{update, setSeries, clear, setCursor, onSeek, onComputeStats,
 *            setComputeStatsAvailable, addMarker, clearMarkers, getEl, remove}}
 */
export function createTrajectoryPlot(hostEl, options = {}) {
  const maxPts = Number.isFinite(options.maxPts) ? options.maxPts : 5000;
  const plotId = options.id || PLOT_ID;
  const seriesSpec = options.seriesSpec || SERIES_SPEC;
  const groupMeta = options.groupMeta || GROUP_META;
  const groupOrder = options.groupOrder || GROUP_ORDER;
  const knownNames = Object.keys(seriesSpec);
  const acceptUnknown = options.acceptUnknown === true;
  const xKey = options.xKey || 'step';
  const xTitleDefault = options.xTitle || 'Frame';
  const xTitleWithX = options.xTitleWithX || 'Step';
  const fallbackSpec = typeof options.specFor === 'function' ? options.specFor : null;

  // Spec lookup: the fixed table first, then the caller's resolver, then a
  // generic grey line in a group of its own (so it still gets an axis).
  const specCache = new Map();
  function specFor(name) {
    if (seriesSpec[name]) return seriesSpec[name];
    let spec = specCache.get(name);
    if (spec) return spec;
    spec = (fallbackSpec && fallbackSpec(name)) || null;
    spec = { ...GENERIC_SPEC, group: name, label: name, ...(spec || {}) };
    specCache.set(name, spec);
    return spec;
  }
  // Group order: the fixed list first, then any dynamic group in order of
  // first appearance — a dynamic-series plot still assigns axes stably.
  const dynamicGroups = [];
  function orderedGroups() {
    return dynamicGroups.length ? [...groupOrder, ...dynamicGroups] : groupOrder;
  }
  function noteGroup(g) {
    if (!groupOrder.includes(g) && !dynamicGroups.includes(g)) dynamicGroups.push(g);
  }

  // --- DOM scaffolding ----------------------------------------------------
  const root = document.createElement('div');
  root.className = 'trajPlot';

  // A slim toolbar above the chart hosts the light/dark toggle (always
  // available, same wording/icon as the EOS plots' per-card toggle) and the
  // "Compute step stats" action (shown only when there is data to crunch), so
  // both read as part of the plot chrome.
  const toolbar = document.createElement('div');
  toolbar.className = 'trajPlotToolbar';
  const themeBtn = document.createElement('button');
  themeBtn.type = 'button';
  themeBtn.className = 'trajPlotThemeBtn';
  themeBtn.title = 'Toggle light/dark';
  themeBtn.textContent = '\u{1F313}\uFE0E';
  themeBtn.onclick = () => {
    plotTheme = plotTheme === 'dark' ? 'light' : 'dark';
    drawFull();
  };
  toolbar.appendChild(themeBtn);
  const computeBtn = document.createElement('button');
  computeBtn.type = 'button';
  computeBtn.className = 'trajPlotComputeBtn';
  computeBtn.textContent = 'Compute step stats';
  computeBtn.style.display = 'none';
  if (options.showComputeStats !== false) toolbar.appendChild(computeBtn);
  // Export + expand, same icons/styling as the analysis histograms'
  // .split-item-action-btn corner buttons — reused directly (sideDock.css)
  // rather than re-styled, so this reads as the same chrome.
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'split-item-action-btn';
  exportBtn.title = 'Export PNG';
  exportBtn.textContent = '📥';
  exportBtn.onclick = () => {
    exportHistogramPNG(plotId).catch((error) => console.error('Trajectory plot export failed:', error));
  };
  toolbar.appendChild(exportBtn);
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'split-item-action-btn';
  expandBtn.title = 'Expand';
  expandBtn.textContent = '⛶';
  expandBtn.onclick = () => {
    expandSplitItem(root);
    isExpanded = true;
    drawFull();
  };
  toolbar.appendChild(expandBtn);
  root.appendChild(toolbar);

  // Fullscreen-only close button — same .split-item-close-btn SideDock.js's
  // expandSplitItem()/closeExpandedSplitItem() drive on the analysis
  // histograms and EOS plots (hidden unless `root` carries `.expanded`, see
  // trajectoryPanel.css's .trajPlot.expanded rule below).
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'split-item-close-btn';
  closeBtn.title = 'Close expanded view';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => {
    closeExpandedSplitItem();
    isExpanded = false;
    drawFull();
  };
  root.appendChild(closeBtn);

  const plotDiv = document.createElement('div');
  plotDiv.id = plotId;
  plotDiv.className = 'trajPlotChart';
  root.appendChild(plotDiv);

  const statsEl = document.createElement('div');
  statsEl.className = 'trajPlotStats';
  root.appendChild(statsEl);

  hostEl.appendChild(root);

  // --- state --------------------------------------------------------------
  /** @type {Map<string, number[]>} */
  const series = new Map();
  const seriesOrder = [];
  // x-coordinate per sample. For MD/relax this is the actual step number (a
  // multiple of the save stride, e.g. 2,4,…), not the 1-based frame index, so
  // the axis reads real steps. cursor/seek map between frame index and these.
  const xValues = [];
  let xTitle = xTitleDefault;
  let sampleCount = 0;       // longest series length == number of x samples
  let cursorIndex = null;
  // Vertical event markers ({x, label}) — a loaded file, play/pause, a GC
  // hint — drawn as dotted lines with a small rotated label. Pruned with the
  // ring buffer so they never outlive the samples they annotate.
  /** @type {{x: number, label: string}[]} */
  let markers = [];
  let seekCb = null;
  let computeCb = null;

  let Plotly = null;         // resolved module (once loaded)
  let plotlyRetryAt = 0;     // no load attempt before this time (see drawFull)
  let ready = false;         // Plotly.newPlot has run at least once
  // Plotly calls must not overlap: an extendTraces/relayout issued while a
  // react is still in flight, or a purge before its deferred auto-margin
  // redraw ran, ends in Plotly errors on a half-built or dead chart ("t.emit
  // is not a function", "_redrawFromAutoMarginCount of undefined"). One
  // react at a time; anything arriving meanwhile becomes ONE queued redraw
  // (the data is already in `series`), and the purge waits for the react.
  /** @type {Promise<any> | null} */
  let inFlight = null;
  let redrawQueued = false;
  let removed = false;
  let layoutSig = '';        // signature of the current trace/axis layout
  let isExpanded = false;    // fullscreen (⛶) — bigger fonts, see buildLayout

  function ensureSeries(name) {
    if (!series.has(name)) {
      // A series that appears mid-stream starts aligned with the samples
      // already recorded: NaN for every past sample, so its first real value
      // lands at the current x rather than being drawn from the first sample.
      series.set(name, new Array(sampleCount).fill(NaN));
      seriesOrder.push(name);
      noteGroup(specFor(name).group);
    }
    return series.get(name);
  }

  function recomputeSampleCount() {
    let n = 0;
    for (const arr of series.values()) n = Math.max(n, arr.length);
    sampleCount = n;
  }

  // Plotted series (finite data + spec.plot !== false), in group order, each
  // tagged with the y-axis its group maps to. Drives both traces and layout.
  function plottedSeries() {
    const present = [];
    for (const g of orderedGroups()) {
      for (const name of seriesOrder) {
        const spec = specFor(name);
        if (spec.group !== g || spec.plot === false) continue;
        const arr = series.get(name);
        if (arr && arr.some(Number.isFinite)) present.push({ name, spec, group: g });
      }
    }
    return present;
  }

  // Distinct groups present, in order — the first gets the left axis, the next
  // two the right axes.
  function groupAxisMap(plotted) {
    const groups = [];
    for (const p of plotted) if (!groups.includes(p.group)) groups.push(p.group);
    const map = {};
    groups.slice(0, AXIS_IDS.length).forEach((g, i) => { map[g] = AXIS_IDS[i]; });
    // Any groups beyond the third fold onto the last axis rather than vanish.
    for (const g of groups) if (!map[g]) map[g] = AXIS_IDS[AXIS_IDS.length - 1];
    return { groups, map };
  }

  const DASH = { solid: undefined, dash: 'dash', dot: 'dot', dashdot: 'dashdot' };

  // x-coordinates for the first n samples: the recorded step numbers where
  // known, falling back to a 1-based index for any not yet supplied.
  function currentX(n) {
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = i < xValues.length ? xValues[i] : i + 1;
    return x;
  }

  function buildTraces(plotted) {
    const n = sampleCount;
    const x = currentX(n);
    const isLight = plotTheme === 'light';
    return plotted.map(({ name, spec, group }) => ({
      type: 'scatter',
      mode: 'lines',
      name: spec.label,
      x: x.slice(),
      y: (series.get(name) || []).slice(0, n),
      yaxis: groupAxisMap(plotted).map[group],
      line: { color: pickColor(spec, isLight), width: 1.8, dash: DASH[spec.dash] },
      connectgaps: false,
      // Value only; the "x unified" hover header already shows the step/frame.
      hovertemplate: `%{y}<extra>${spec.label}</extra>`,
    }));
  }

  function buildLayout(plotted) {
    const { groups, map } = groupAxisMap(plotted);
    const nRight = Math.max(0, groups.length - 1);
    // Shrink the plotting area from the right to make room for stacked right
    // axes, and pad the right margin so the outer axis's tick labels aren't
    // clipped by the container edge.
    const rightDomain = nRight >= 2 ? 0.84 : 1;
    const marginR = nRight >= 2 ? 52 : (nRight === 1 ? 44 : 14);
    const isLight = plotTheme === 'light';
    const fontColor = isLight ? '#1a1a1a' : '#ddd';
    const gridColor = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)';
    // Bigger fonts/margins in the fullscreen (⛶) view, same idiom as the
    // histograms' isExpanded sizing — the compact panel's tuned sizes read as
    // tiny once stretched across a 90vw/90vh fullscreen canvas.
    const sizes = isExpanded
      ? { base: 15, legend: 14, xTitle: 15, yTitle: 16, tick: 14 }
      : { base: 11, legend: 10, xTitle: 11, yTitle: 12, tick: 10 };
    const marginScale = isExpanded ? 1.5 : 1;

    const layout = {
      // Dark stays transparent (the surrounding .trajPlot div already paints
      // the dark chrome via CSS); light needs an opaque canvas since axes/text
      // switch to dark-on-white and would otherwise sit on that dark CSS bg.
      paper_bgcolor: isLight ? '#ffffff' : 'rgba(0,0,0,0)',
      plot_bgcolor: isLight ? '#ffffff' : 'rgba(0,0,0,0)',
      font: { color: fontColor, size: sizes.base },
      // Extra top room so the (possibly two-row) horizontal legend sits fully
      // above the plot frame instead of overlapping the traces.
      margin: {
        t: Math.round(42 * marginScale),
        r: Math.round(marginR * marginScale),
        b: Math.round(38 * marginScale),
        l: Math.round(52 * marginScale),
      },
      showlegend: true,
      legend: {
        orientation: 'h', x: 0.5, y: 1.02, xanchor: 'center', yanchor: 'bottom',
        font: { color: fontColor, size: sizes.legend }, bgcolor: 'rgba(0,0,0,0)',
        tracegroupgap: 8,
      },
      hovermode: 'x unified',
      // Opaque hover box, readable against either canvas colour.
      hoverlabel: isLight
        ? { bgcolor: 'rgba(255,255,255,0.96)', bordercolor: '#bbbbbb', font: { color: '#1a1a1a', size: sizes.base } }
        : { bgcolor: 'rgba(24,24,27,0.96)', bordercolor: '#5a5a5e', font: { color: '#f2f2f2', size: sizes.base } },
      xaxis: {
        title: { text: xTitle, font: { size: sizes.xTitle }, standoff: 6 },
        tickfont: { size: sizes.tick },
        color: fontColor, gridcolor: gridColor,
        zeroline: false, domain: [0, rightDomain],
      },
      shapes: [...markerShapes(), ...cursorShapes()],
      annotations: markerAnnotations(),
    };

    groups.forEach((g, i) => {
      const axisId = map[g];
      const key = axisId === 'y' ? 'yaxis' : `yaxis${axisId.slice(1)}`;
      // A dynamic group (no fixed meta) takes its first series' colour and
      // is titled by that series' label.
      const meta = groupMeta[g] || (() => {
        const first = plotted.find((p) => p.group === g);
        return first ? { color: first.spec.color, lightColor: first.spec.lightColor, title: first.spec.label } : GENERIC_SPEC;
      })();
      const axColor = pickColor(meta, isLight);
      const ax = {
        title: { text: meta.title, font: { color: axColor, size: sizes.yTitle } },
        color: axColor,
        tickfont: { color: axColor, size: sizes.tick },
        zeroline: false,
      };
      if (i === 0) {
        ax.gridcolor = gridColor;
      } else {
        ax.overlaying = 'y';
        ax.side = 'right';
        ax.showgrid = false;
        // Second right axis floats just outside the shrunk plot area, at the
        // right edge of the paper so its labels live in the padded margin.
        if (i >= 2) { ax.anchor = 'free'; ax.position = 1; }
      }
      layout[key] = ax;
    });

    return layout;
  }

  function cursorShapes() {
    if (!Number.isFinite(cursorIndex) || sampleCount < 1) return [];
    const i = Math.max(0, Math.min(sampleCount - 1, cursorIndex));
    const x = i < xValues.length ? xValues[i] : i + 1; // step at this frame
    const isLight = plotTheme === 'light';
    return [{
      type: 'line', xref: 'x', yref: 'paper',
      x0: x, x1: x, y0: 0, y1: 1,
      line: { color: isLight ? 'rgba(20,20,20,0.55)' : 'rgba(255,255,255,0.7)', width: 1, dash: 'solid' },
      layer: 'above',
    }];
  }

  // Marker line + label colours for either canvas.
  function markerColor() {
    return plotTheme === 'light' ? 'rgba(20,20,20,0.45)' : 'rgba(255,255,255,0.45)';
  }

  function markerShapes() {
    if (!markers.length) return [];
    const color = markerColor();
    return markers.map((m) => ({
      type: 'line', xref: 'x', yref: 'paper',
      x0: m.x, x1: m.x, y0: 0, y1: 1,
      line: { color, width: 1, dash: 'dot' },
      layer: 'below',
    }));
  }

  function markerAnnotations() {
    if (!markers.length) return [];
    const color = markerColor();
    const size = isExpanded ? 12 : 9;
    return markers.map((m) => ({
      x: m.x, y: 1, xref: 'x', yref: 'paper',
      text: m.label, showarrow: false, textangle: -90,
      xanchor: 'left', yanchor: 'top', xshift: 2,
      font: { size, color },
    }));
  }

  // Drop markers that fell out of the ring buffer.
  function pruneMarkers() {
    if (!markers.length || !xValues.length) return;
    const oldest = xValues[0];
    if (markers[0].x < oldest) markers = markers.filter((m) => m.x >= oldest);
  }

  const config = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d'],
    toImageButtonOptions: { format: 'png', filename: 'trajectory', scale: 3 },
  };

  function sigOf(plotted) {
    const { map } = groupAxisMap(plotted);
    return plotted.map((p) => `${p.name}:${map[p.group]}`).join('|');
  }

  // Full (re)draw — used on first render, on setSeries/clear, and whenever the
  // set of plotted series or their axis assignment changes.
  async function drawFull() {
    if (removed) return;
    if (!Plotly) {
      // Offline, the loader rejects and forgets its promise so a later attempt
      // can succeed; a streaming caller (live MD, the debug sampler) calls
      // drawFull() on every point, so hold the retry for a while rather than
      // re-fetching once per sample.
      if (performance.now() < plotlyRetryAt) return;
      try {
        Plotly = await loadPlotly();
      } catch (error) {
        plotDiv.textContent = error.message;
        ready = false;
        plotlyRetryAt = performance.now() + PLOTLY_RETRY_MS;
        return;
      }
    }
    if (removed || !document.body.contains(plotDiv)) return;
    if (inFlight) { redrawQueued = true; return; }
    const plotted = plottedSeries();
    layoutSig = sigOf(plotted);
    inFlight = Plotly.react(plotDiv, buildTraces(plotted), buildLayout(plotted), config);
    try {
      await inFlight;
    } catch (error) {
      console.error('Trajectory plot draw failed:', error);
    } finally {
      inFlight = null;
    }
    if (removed) return;
    ready = true;
    wireClickSeek();
    startResizeObserver();
    requestAnimationFrame(() => { if (!removed && !inFlight) Plotly.Plots.resize(plotDiv); });
    if (redrawQueued) {
      redrawQueued = false;
      drawFull();
    }
  }

  // Plotly's responsive:true only tracks window resizes; the panel is
  // user-resizable (drag + CSS resize handle), so observe the container and
  // resize the chart to fill it — otherwise it only caught up on an autoscale
  // ("Home") click. rAF-coalesced so a drag doesn't fire a resize per pixel.
  let ro = null;
  let resizeRAF = 0;
  function startResizeObserver() {
    if (ro || typeof ResizeObserver === 'undefined') return;
    ro = new ResizeObserver(() => {
      if (resizeRAF) return;
      resizeRAF = requestAnimationFrame(() => {
        resizeRAF = 0;
        if (ready && !removed && Plotly) Plotly.Plots.resize(plotDiv);
      });
    });
    ro.observe(plotDiv);
  }

  // --- live cursor (throttled single relayout) -----------------------------
  // A Plotly.relayout costs ~10-15 ms of main thread. Playback moves the cursor
  // on EVERY frame, so a per-frame (rAF-coalesced) relayout at 60 frames/s
  // spent most of the frame budget on the plot and made playback stutter in
  // bursts. The cursor is a UI nicety: redraw it at most every CURSOR_MIN_MS,
  // always landing the latest position (trailing call).
  const CURSOR_MIN_MS = 250;
  let cursorTimer = 0;
  let cursorLastAt = -Infinity;
  function scheduleCursor() {
    if (cursorTimer) return;
    const wait = Math.max(0, CURSOR_MIN_MS - (performance.now() - cursorLastAt));
    cursorTimer = window.setTimeout(() => {
      cursorTimer = 0;
      cursorLastAt = performance.now();
      if (!ready || removed) return;
      if (inFlight) { scheduleCursor(); return; } // after the redraw lands
      Plotly.relayout(plotDiv, {
        shapes: [...markerShapes(), ...cursorShapes()],
        annotations: markerAnnotations(),
      });
    }, wait);
  }

  // --- click / drag to seek ----------------------------------------------
  let clickWired = false;
  function wireClickSeek() {
    if (clickWired) return;
    clickWired = true;
    // A single click (no drag) seeks; a drag is Plotly's own box-zoom. Map the
    // click x-pixel to a frame via the live x-axis, so it works anywhere on the
    // plotting area, not only on a data point.
    plotDiv.addEventListener('click', (e) => {
      if (!ready || typeof seekCb !== 'function') return;
      const fl = /** @type {any} */ (plotDiv)._fullLayout;
      const xa = fl && fl.xaxis;
      if (!xa || typeof xa.p2d !== 'function') return;
      const rect = plotDiv.getBoundingClientRect();
      const px = e.clientX - rect.left - (xa._offset || 0);
      if (px < 0 || px > (xa._length || 0)) return; // outside the plotting area
      const dataX = xa.p2d(px);
      if (!Number.isFinite(dataX)) return;
      // Map the clicked x back to the nearest FRAME INDEX. x may be step numbers
      // (non-unit spacing), so find the closest recorded step rather than assume
      // x == frame index.
      let frame;
      if (xValues.length) {
        let best = 0; let bestD = Infinity;
        for (let i = 0; i < xValues.length; i++) {
          const d = Math.abs(xValues[i] - dataX);
          if (d < bestD) { bestD = d; best = i; }
        }
        frame = best;
      } else {
        frame = Math.round(dataX) - 1;
      }
      seekCb(Math.max(0, Math.min(sampleCount - 1, frame)));
    });
  }

  // --- live stats line ----------------------------------------------------
  function updateStatsLine(point) {
    const { step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv, meanForce, pressure } = point;
    const parts = [];
    if (step !== undefined) parts.push(`step=${step}`);
    if (Number.isFinite(temperatureK)) parts.push(`T=${fmt(temperatureK, 1)} K`);
    if (Number.isFinite(targetTemperatureK)) parts.push(`Ttarget=${fmt(targetTemperatureK, 1)} K`);
    if (Number.isFinite(etotEv)) parts.push(`Etot=${fmt(etotEv, 4)} eV`);
    if (Number.isFinite(epotEv)) parts.push(`Epot=${fmt(epotEv, 4)} eV`);
    if (Number.isFinite(ekinEv)) parts.push(`Ekin=${fmt(ekinEv, 4)} eV`);
    if (Number.isFinite(meanForce)) parts.push(`Fmean=${fmt(meanForce, 4)} eV/Å`);
    if (Number.isFinite(pressure)) parts.push(`P=${fmt(pressure, 4)}`);
    statsEl.textContent = parts.join('  |  ');
  }

  // --- public API ---------------------------------------------------------
  const api = {
    // Append one live step. Uses the fast extendTraces path when the plotted
    // set/axes are unchanged; falls back to a full redraw when a new series or
    // axis appears (e.g. the first pressure sample).
    update(point = {}) {
      api.updateBatch([point]);
    },

    // Append several points with ONE Plotly call (or one full redraw when the
    // plotted set / axes changed) — the Debug window buffers its samples and
    // flushes them at a lower cadence than it records them, because every
    // extendTraces is a ~30 ms redraw on the main thread.
    updateBatch(points) {
      if (!points.length) return;
      const before = sigOf(plottedSeries());
      /** @type {number[]} */
      const newX = [];
      for (const point of points) {
        const fields = acceptUnknown
          ? Object.keys(point).filter((k) => k !== xKey)
          : knownNames.filter((k) => k in point);
        for (const field of fields) {
          if (seriesSpec[field] && seriesSpec[field].plot === false) continue; // stats-only
          const arr = ensureSeries(field);
          const v = point[field];
          arr.push(Number.isFinite(v) ? v : NaN);
        }
        // Every series absent from this point gets a NaN so all series stay
        // 1:1 with xValues (a gap in the line, thanks to connectgaps:false).
        const target = xValues.length + 1;
        for (const arr of series.values()) while (arr.length < target) arr.push(NaN);
        // x-coordinate for this sample: the real step number / time when
        // present, else the next running index.
        const px = point[xKey];
        const stepX = Number.isFinite(px)
          ? px
          : (xValues.length ? xValues[xValues.length - 1] + 1 : 1);
        xValues.push(stepX);
        newX.push(stepX);
        if (Number.isFinite(px) && xTitle !== xTitleWithX) xTitle = xTitleWithX;
        if (!acceptUnknown) updateStatsLine(point);
      }
      // Trim everything to the ring cap.
      for (const arr of series.values()) while (arr.length > maxPts) arr.shift();
      while (xValues.length > maxPts) xValues.shift();
      pruneMarkers();
      recomputeSampleCount();

      const plotted = plottedSeries();
      const after = sigOf(plotted);
      if (!ready || inFlight || after !== before || after !== layoutSig) {
        drawFull();
        return;
      }
      // Fast path: append the new x values + each trace's latest k values.
      const k = newX.length;
      const xUpdate = plotted.map(() => newX.slice());
      const yUpdate = plotted.map(({ name }) => {
        const arr = series.get(name) || [];
        return arr.slice(Math.max(0, arr.length - k));
      });
      const idxs = plotted.map((_, i) => i);
      Plotly.extendTraces(plotDiv, { x: xUpdate, y: yUpdate }, idxs, maxPts);
      scheduleCursor();
    },

    // Replace all series from arrays (replay / compute-stats path). A reserved
    // `step` key on the object (or opts.steps) supplies the per-frame step
    // numbers for the x-axis; without it the x-axis falls back to 1-based frames.
    setSeries(seriesObj = {}, opts = {}) {
      series.clear();
      seriesOrder.length = 0;
      for (const [name, arr] of Object.entries(seriesObj)) {
        if (name === xKey) continue; // reserved: x-axis values, not a plotted series
        if (seriesSpec[name] && seriesSpec[name].plot === false) continue;
        series.set(name, Array.isArray(arr) ? arr.slice() : []);
        seriesOrder.push(name);
        noteGroup(specFor(name).group);
      }
      recomputeSampleCount();

      xValues.length = 0;
      const steps = Array.isArray(opts.steps) ? opts.steps
        : (Array.isArray(seriesObj[xKey]) ? seriesObj[xKey] : null);
      if (steps) {
        for (let i = 0; i < sampleCount; i++) {
          xValues.push(Number.isFinite(steps[i]) ? steps[i] : i + 1);
        }
        xTitle = xTitleWithX;
      } else {
        xTitle = xTitleDefault;
      }

      statsEl.textContent = '';
      drawFull();
    },

    clear() {
      series.clear();
      seriesOrder.length = 0;
      xValues.length = 0;
      xTitle = xTitleDefault;
      sampleCount = 0;
      cursorIndex = null;
      markers = [];
      statsEl.textContent = '';
      drawFull();
    },

    // Add a vertical event marker at x (in the plot's x units) with a short
    // label. Drawn on the next cursor relayout (rAF-coalesced), so a burst of
    // markers costs one relayout.
    addMarker({ x, label }) {
      if (!Number.isFinite(x)) return;
      markers.push({ x, label: String(label ?? '') });
      scheduleCursor();
    },

    clearMarkers() {
      markers = [];
      scheduleCursor();
    },

    setCursor(frameIndex) {
      cursorIndex = Number.isFinite(frameIndex) ? frameIndex : null;
      scheduleCursor();
    },

    onSeek(cb) { seekCb = cb; },

    onComputeStats(cb) {
      computeCb = cb;
      computeBtn.onclick = () => { if (typeof computeCb === 'function') computeCb(); };
    },

    setComputeStatsAvailable(available) {
      computeBtn.style.display = available ? '' : 'none';
    },

    getEl() { return root; },

    remove() {
      removed = true;
      if (cursorTimer) clearTimeout(cursorTimer);
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      if (ro) { ro.disconnect(); ro = null; }
      if (isExpanded) { closeExpandedSplitItem(); isExpanded = false; }
      root.remove();
      // Purge only once no react is in flight (see inFlight above); the div is
      // already out of the DOM, so nothing is visible in between.
      const purge = () => { try { if (Plotly && plotDiv) Plotly.purge(plotDiv); } catch { /* nothing drawn yet */ } };
      if (inFlight) inFlight.then(purge, purge);
      else purge();
    },
  };

  // Kick off the (async) first draw so an empty, correctly-themed chart shows
  // immediately even before any data arrives.
  drawFull();
  return api;
}
