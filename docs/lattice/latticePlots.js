// Plotly charts for the Lattice Analysis plots window: one card with the cell
// lengths a, b, c, one with the angles α, β, γ, and one card per angle. Every
// card plots the trajectory's frames along a shared x axis — the frame number
// by default, or the user's custom axis (a pressure series, ...). Same lazy
// Plotly loading and per-card light/dark toggle as eos/eosPlots.js — its
// theme/export/resize helpers are keyed by plot id and reused here.

import { loadPlotly } from '../utils/plotlyLoader.js';
import { getPlotTheme } from '../eos/eosPlots.js';

export { togglePlotTheme, getPlotTheme, exportPlotAsPNG, resizePlot, clearPlot } from '../eos/eosPlots.js';

// Series colours encode data (which cell parameter a line is), not chrome, so
// they are literals here like every other plot module's. The lengths follow
// the red/green/blue convention of the axes gizmo (a, b, c); the angles get
// three hues that read apart from those and from each other.
export const SERIES_COLORS = {
  a: '#e63946',
  b: '#2a9d8f',
  c: '#4361ee',
  alpha: '#f4a261',
  beta: '#b5179e',
  gamma: '#00b4d8',
};

function fontSizes(isExpanded) {
  return isExpanded
    ? { base: 20, tick: 17, title: 22, legend: 16 }
    : { base: 11, tick: 11, title: 12, legend: 10 };
}

/** Marker sizes scale with the fonts in the expanded view — otherwise the
 *  points read as specks on the much larger canvas. */
function markerScale(isExpanded) {
  return isExpanded ? 1.6 : 1;
}

function axisTitle(text, size, standoff) {
  const t = { text, font: { size } };
  if (standoff !== undefined) t.standoff = standoff;
  return t;
}

function baseLayout(plotId, xLabel, yLabel, isExpanded, showLegend) {
  const isLight = getPlotTheme(plotId) === 'light';
  const paperBg = isLight ? '#ffffff' : '#121212';
  const fontColor = isLight ? '#121212' : '#e0e0e0';
  const gridColor = isLight ? '#cccccc' : '#444444';
  const sizes = fontSizes(isExpanded);
  return {
    paper_bgcolor: paperBg,
    plot_bgcolor: paperBg,
    font: { color: fontColor, family: "'CrysViz Sans', 'CrysViz Sans Math', sans-serif", size: sizes.base },
    xaxis: {
      title: axisTitle(xLabel, sizes.title, isExpanded ? 15 : 6), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zeroline: false, showgrid: true,
    },
    yaxis: {
      title: axisTitle(yLabel, sizes.title), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zeroline: false, showgrid: true,
      // The lines are flat-ish series (a lattice constant barely moves), so
      // let Plotly fit the range to the data rather than pinning zero.
      autorange: true,
    },
    showlegend: showLegend,
    legend: {
      orientation: 'h', x: 0.5, y: 1.02, xanchor: 'center', yanchor: 'bottom',
      bgcolor: 'rgba(0,0,0,0)',
      font: { color: fontColor, size: sizes.legend },
    },
    hovermode: 'closest',
    margin: isExpanded
      ? { t: showLegend ? 70 : 30, r: 40, b: 110, l: 120 }
      : { t: showLegend ? 34 : 14, r: 14, b: 42, l: 58 },
  };
}

// plotId -> click handler, looked up at click time. The dispatcher is
// re-attached per render because Plotly.newPlot drops the div's previous
// listeners with the old plot (see eos/eosPlots.js for the full reasoning).
const clickHandlers = new Map();
const renderGeneration = new Map();
const wiredGeneration = new Map();

function wireClick(plotId) {
  const el = document.getElementById(plotId);
  if (!el || typeof el.on !== 'function') return;
  if (wiredGeneration.get(plotId) === renderGeneration.get(plotId)) return;
  wiredGeneration.set(plotId, renderGeneration.get(plotId));
  el.on('plotly_click', (ev) => {
    const handler = clickHandlers.get(plotId);
    const pt = ev.points?.[0];
    if (handler && pt && pt.customdata !== undefined && pt.customdata !== null) handler(pt.customdata, pt);
  });
}

/** Register (or, with null, unregister) the click handler for a lattice
 *  chart's data points. `handler(frameIndex, point)` receives the clicked
 *  point's customdata — the 0-based index of the trajectory frame it plots. */
export function onLatticePointClick(plotId, handler) {
  if (handler) clickHandlers.set(plotId, handler);
  else clickHandlers.delete(plotId);
  wireClick(plotId);
}

async function renderInto(plotId, data, layout) {
  const Plotly = await loadPlotly();
  // The plots window may close while Plotly is loading; newPlot throws when
  // its target is gone, so treat that as a cancelled draw.
  if (!document.getElementById(plotId)) return;
  await Plotly.newPlot(plotId, data, layout, { responsive: true, displayModeBar: false });
  renderGeneration.set(plotId, (renderGeneration.get(plotId) || 0) + 1);
  wireClick(plotId);
  requestAnimationFrame(() => {
    if (document.getElementById(plotId)) Plotly.Plots.resize(plotId);
  });
}

/** A usable x: a finite number, or a non-empty string (a categorical axis of
 *  structure names). */
function usableX(v) {
  return typeof v === 'string' ? v.length > 0 : Number.isFinite(v);
}

/**
 * Point order for drawing: by x when asked (a pressure series need not be
 * monotonic in frame order, and a line through the points in file order
 * would zigzag), else the points' own order. Numbers sort numerically,
 * strings alphabetically (numeric-aware, so "step 2" precedes "step 10").
 * Stable, so equal x keep their order. Points without a usable x are dropped.
 * @param {(number | string)[]} x
 * @param {boolean} sortByX
 * @returns {number[]} point indices in drawing order
 */
export function drawOrder(x, sortByX) {
  const order = [];
  for (let i = 0; i < x.length; i++) if (usableX(x[i])) order.push(i);
  if (sortByX) {
    const cmp = (u, v) => (typeof u === 'string' || typeof v === 'string'
      ? String(u).localeCompare(String(v), undefined, { numeric: true, sensitivity: 'base' })
      : u - v);
    order.sort((i, j) => cmp(x[i], x[j]) || i - j);
  }
  return order;
}

/**
 * Draw one lattice card.
 * ctx: {
 *   x: (number | string)[] (one per point; strings make a categorical axis),
 *   xTitle: string, sortByX: boolean,
 *   labels: string[] (one per point, for the hover: "frame 3", a file name),
 *   series: {key, label, values: number[], unit: string}[],
 *   yTitle: string,
 *   currentIndex: number | null  (point shown in the viewer, highlighted)
 * }
 */
export async function plotLatticeSeries(plotId, ctx, isExpanded = false) {
  const { x, xTitle, sortByX, series, yTitle, currentIndex } = ctx;
  const labels = ctx.labels ?? x.map((_, i) => `frame ${i + 1}`);
  const order = drawOrder(x, !!sortByX);
  const showLegend = series.length > 1;
  const layout = baseLayout(plotId, xTitle, yTitle, isExpanded, showLegend);
  const mScale = markerScale(isExpanded);
  const isLight = getPlotTheme(plotId) === 'light';

  /** @type {any[]} */
  const data = [];
  for (const s of series) {
    const color = SERIES_COLORS[s.key] || '#cccccc';
    data.push({
      type: 'scatter', mode: 'lines+markers', name: s.label,
      x: order.map((i) => x[i]),
      y: order.map((i) => s.values[i]),
      // customdata = the 0-based point index, for onLatticePointClick
      // consumers; the hover shows the caller's label (the 1-based frame
      // number people see in the Files table, or the structure's name).
      customdata: order.slice(),
      text: order.map((i) => labels[i]),
      line: { color, width: 1.8 },
      marker: { color, size: 6 * mScale },
      connectgaps: false,
      hovertemplate: `${s.label} = %{y:.4f} ${s.unit}<br>${xTitle}: %{x}<br>%{text}<extra></extra>`,
    });
  }

  // The frame on screen: a hollow ring around its point on every series and a
  // vertical guide, so it is findable even when the lines overlap.
  const hasCurrent = Number.isInteger(currentIndex) && currentIndex >= 0
    && currentIndex < x.length && usableX(x[currentIndex]);
  if (hasCurrent) {
    for (const s of series) {
      if (!Number.isFinite(s.values[currentIndex])) continue;
      data.push({
        type: 'scatter', mode: 'markers', name: `${s.label} (shown)`, showlegend: false,
        x: [x[currentIndex]], y: [s.values[currentIndex]], customdata: [currentIndex],
        marker: {
          color: 'rgba(0,0,0,0)', size: 13 * mScale,
          line: { color: isLight ? '#121212' : '#ffffff', width: 2 * mScale },
        },
        hoverinfo: 'skip',
      });
    }
    layout.shapes = [{
      type: 'line', xref: 'x', yref: 'paper',
      x0: x[currentIndex], x1: x[currentIndex], y0: 0, y1: 1,
      line: { color: isLight ? 'rgba(20,20,20,0.45)' : 'rgba(255,255,255,0.45)', width: 1, dash: 'dot' },
      layer: 'below',
    }];
  }

  await renderInto(plotId, data, layout);
}
