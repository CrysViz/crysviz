// Plotly charts for the phonon windows: the band structure (with an optional
// DOS side panel) and the mode-map energy curve. Same lazy Plotly loading and
// per-card light/dark toggle as eos/eosPlots.js — its theme/export/resize
// helpers are keyed by plot id and reused here rather than duplicated.

import { loadPlotly } from '../utils/plotlyLoader.js';
import { getPlotTheme } from '../eos/eosPlots.js';
import { prettyLabel } from './phononSession.js';

export { togglePlotTheme, getPlotTheme, exportPlotAsPNG, resizePlot, clearPlot } from '../eos/eosPlots.js';

// Chart colours encode data (band lines, imaginary branch, selection, fit),
// not chrome, so they are literals here like every other plot module's.
const COLORS = {
  BAND: '#2ec4b6',        // teal: real (positive) branches
  BAND_LIGHT: '#0f8f82',
  IMAGINARY: '#d97706',   // dark orange: branches with imaginary frequencies
  IMAGINARY_LIGHT: '#b45309',
  SELECTED: '#f472b6',
  DOS: '#7fb069',
  DATA: '#d62828',
  FIT: '#04c9b9',
  MINIMUM: '#ffb000',
};

function fontSizes(isExpanded) {
  return isExpanded
    ? { base: 20, tick: 17, title: 22, legend: 16, annotation: 16 }
    : { base: 11, tick: 11, title: 12, legend: 10, annotation: 10 };
}

function baseLayout(plotId, isExpanded) {
  const isLight = getPlotTheme(plotId) === 'light';
  const paperBg = isLight ? '#ffffff' : '#121212';
  const fontColor = isLight ? '#121212' : '#e0e0e0';
  const gridColor = isLight ? '#cccccc' : '#444444';
  const sizes = fontSizes(isExpanded);
  return {
    isLight,
    sizes,
    layout: {
      paper_bgcolor: paperBg,
      plot_bgcolor: paperBg,
      font: { color: fontColor, family: "'CrysViz Sans', 'CrysViz Sans Math', sans-serif", size: sizes.base },
      margin: isExpanded ? { t: 30, r: 30, b: 70, l: 90 } : { t: 16, r: 12, b: 36, l: 50 },
      showlegend: false,
      hovermode: 'closest',
      gridColor,
      fontColor,
    },
  };
}

// plotId -> handler, looked up at click time (see eosPlots.js for why the
// dispatcher is re-attached per render: newPlot drops the old listeners).
const clickHandlers = new Map();
const renderGeneration = new Map();
const wiredGeneration = new Map();

function wireClick(plotId) {
  const el = /** @type {any} */ (document.getElementById(plotId));
  if (!el || typeof el.on !== 'function') return;
  if (wiredGeneration.get(plotId) === renderGeneration.get(plotId)) return;
  wiredGeneration.set(plotId, renderGeneration.get(plotId));
  el.on('plotly_click', (ev) => {
    const handler = clickHandlers.get(plotId);
    const pt = ev.points?.[0];
    if (handler && pt && pt.customdata !== undefined) handler(pt.customdata, pt);
  });
}

/** Register a click handler: for the band plot it receives { iq, ib }, for the
 *  mode map the point index. */
export function onPhononPlotClick(plotId, handler) {
  if (handler) clickHandlers.set(plotId, handler);
  else clickHandlers.delete(plotId);
  wireClick(plotId);
}

async function renderInto(plotId, data, layout) {
  const Plotly = await loadPlotly();
  if (!document.getElementById(plotId)) return;
  await Plotly.newPlot(plotId, data, layout, { responsive: true, displayModeBar: false });
  renderGeneration.set(plotId, (renderGeneration.get(plotId) || 0) + 1);
  wireClick(plotId);
  requestAnimationFrame(() => Plotly.Plots.resize(plotId));
}

/** Path-segment boundaries of a band dataset: x position and label of each. */
export function bandTicks(dataset) {
  const ticks = [];
  let start = 0;
  const { segments, labels, qpoints } = dataset;
  for (let s = 0; s < segments.length; s++) {
    const n = segments[s];
    const first = qpoints[start];
    const last = qpoints[start + n - 1];
    const [a, b] = labels?.[s] ?? ['', ''];
    const la = prettyLabel(a, { html: true });
    const lb = prettyLabel(b, { html: true });
    if (s === 0) ticks.push({ x: first.distance, label: la });
    else {
      const prev = ticks[ticks.length - 1];
      // A discontinuous path: the previous segment's end and this start share
      // an x position but carry two names ("X|K").
      if (Math.abs(prev.x - first.distance) < 1e-9) {
        if (la && prev.label && la !== prev.label) prev.label = `${prev.label}|${la}`;
        else if (la && !prev.label) prev.label = la;
      } else ticks.push({ x: first.distance, label: la });
    }
    ticks.push({ x: last.distance, label: lb });
    start += n;
  }
  return ticks;
}

/** The theme a plot is drawn with (colours, font sizes, margins), exposed so
 *  bandFigure() can be driven without a rendered plot. */
export function figureTheme(plotId, isExpanded = false) {
  return baseLayout(plotId, isExpanded);
}

/** Tick label for a dataset that has a single q-point: the path label when
 *  band.yaml carries one, else Γ for q = 0, else the reduced coordinates. */
function singlePointLabel(dataset) {
  const first = dataset.labels?.[0]?.[0];
  if (dataset.kind === 'band' && first) return prettyLabel(first, { html: true });
  const q = dataset.qpoints[0]?.q ?? [];
  if (q.length && q.every((v) => Math.abs(v) < 1e-6)) return 'Γ';
  return `(${q.map((v) => Math.round(v * 1e4) / 1e4).join(', ')})`;
}

/**
 * The band/DOS figure as plain Plotly data + layout, for plotBands() to
 * render and for tests to inspect without Plotly.
 *
 * ctx: { dataset, dos, selected: {iq, ib}|null }; theme: figureTheme().
 * Band datasets plot frequency vs path distance, one line per band; mesh /
 * qpoints datasets plot frequency vs q-point index as markers. A dataset
 * with a single q-point (a Γ-only calculation: one-point band.yaml, 1x1x1
 * mesh, a lone qpoint) has nothing to draw a line between and a zero-width
 * x range, so it was invisible — its modes are drawn instead as a ladder of
 * horizontal marks at x = 0 under the point's label. Every point carries
 * customdata { iq, ib } so a click selects that mode.
 */
export function bandFigure(ctx, theme, isExpanded = false) {
  const { dataset, dos, selected } = ctx;
  const { layout, sizes, isLight } = theme;
  const isBand = dataset.kind === 'band';
  const nq = dataset.qpoints.length;
  const pathXs = dataset.qpoints.map((qp, i) => (isBand ? qp.distance : i));
  const single = nq === 1 || (isBand && Math.abs(pathXs[nq - 1] - pathXs[0]) < 1e-9);
  const xs = single ? pathXs.map(() => 0) : pathXs;
  const asLines = isBand && !single;
  /** @type {any[]} */
  const data = [];
  const bandColor = isLight ? COLORS.BAND_LIGHT : COLORS.BAND;
  const imagColor = isLight ? COLORS.IMAGINARY_LIGHT : COLORS.IMAGINARY;
  for (let ib = 0; ib < dataset.nbands; ib++) {
    const ys = new Array(nq);
    const custom = new Array(nq);
    let anyImag = false;
    for (let iq = 0; iq < nq; iq++) {
      const f = dataset.qpoints[iq].freqs[ib];
      ys[iq] = f;
      if (f < -0.05) anyImag = true;
      custom[iq] = { iq, ib };
    }
    // Segment breaks in a band path: insert null gaps so lines do not join
    // across discontinuous paths.
    let x = xs;
    let y = ys;
    let cd = custom;
    if (asLines && dataset.segments.length > 1) {
      x = []; y = []; cd = [];
      let start = 0;
      for (let s = 0; s < dataset.segments.length; s++) {
        const n = dataset.segments[s];
        for (let k = start; k < start + n; k++) { x.push(xs[k]); y.push(ys[k]); cd.push(custom[k]); }
        if (s < dataset.segments.length - 1) { x.push(null); y.push(null); cd.push(null); }
        start += n;
      }
    }
    const color = anyImag ? imagColor : bandColor;
    data.push({
      x, y, customdata: cd,
      type: 'scatter',
      mode: asLines ? 'lines' : 'markers',
      line: { color, width: isExpanded ? 1.6 : 1 },
      // Single q-point: a horizontal dash per mode (Plotly's open 'line-ew'
      // symbol is drawn with marker.line), long enough to read as a level.
      marker: single
        ? { color, symbol: 'line-ew', size: isExpanded ? 28 : 18, line: { color, width: isExpanded ? 3 : 2 } }
        : { color, size: isExpanded ? 6 : 3.5 },
      hovertemplate: `band ${ib + 1}<br>%{y:.3f} THz<extra></extra>`,
      name: `band ${ib + 1}`,
      connectgaps: false,
    });
  }
  if (selected && dataset.qpoints[selected.iq]) {
    data.push({
      x: [xs[selected.iq]],
      y: [dataset.qpoints[selected.iq].freqs[selected.ib]],
      customdata: [{ iq: selected.iq, ib: selected.ib }],
      type: 'scatter', mode: 'markers', name: 'selected',
      marker: { color: COLORS.SELECTED, size: isExpanded ? 16 : 10, symbol: 'circle', line: { color: layout.fontColor, width: 1 } },
      hovertemplate: `selected: band ${selected.ib + 1}<br>%{y:.3f} THz<extra></extra>`,
    });
  }

  const hasDos = !!(dos && dos.frequencies?.length);
  /** @type {any} */
  const xaxis = {
    color: layout.fontColor, gridcolor: layout.gridColor, zeroline: false, showgrid: false,
    tickfont: { size: sizes.tick }, domain: hasDos ? [0, 0.74] : [0, 1],
  };
  const shapes = [];
  if (single) {
    xaxis.tickmode = 'array';
    xaxis.tickvals = [0];
    xaxis.ticktext = [singlePointLabel(dataset)];
    xaxis.range = [-1, 1];
    shapes.push({ type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper', line: { color: layout.gridColor, width: 1 } });
  } else if (isBand) {
    const ticks = bandTicks(dataset);
    xaxis.tickmode = 'array';
    xaxis.tickvals = ticks.map((t) => t.x);
    xaxis.ticktext = ticks.map((t) => t.label || '');
    xaxis.range = [xs[0], xs[nq - 1]];
    for (const t of ticks) {
      shapes.push({ type: 'line', x0: t.x, x1: t.x, y0: 0, y1: 1, yref: 'paper', line: { color: layout.gridColor, width: 1 } });
    }
  } else {
    xaxis.title = { text: 'q-point index', font: { size: sizes.title } };
  }
  shapes.push({ type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: layout.gridColor, width: 1, dash: 'dot' } });
  const yaxis = {
    title: { text: 'Frequency (THz)', font: { size: sizes.title } },
    color: layout.fontColor, gridcolor: layout.gridColor, zerolinecolor: layout.gridColor,
    tickfont: { size: sizes.tick }, showgrid: true,
  };
  /** @type {any} */
  const full = {
    ...layout, xaxis, yaxis, shapes,
    title: undefined,
  };
  if (hasDos) {
    data.push({
      x: dos.total, y: dos.frequencies, xaxis: 'x2', yaxis: 'y',
      type: 'scatter', mode: 'lines', fill: 'tozerox', name: 'DOS',
      line: { color: COLORS.DOS, width: 1.5 }, fillcolor: 'rgba(127,176,105,0.25)',
      hovertemplate: 'DOS %{x:.3f}<br>%{y:.3f} THz<extra></extra>',
    });
    full.xaxis2 = {
      domain: [0.77, 1], color: layout.fontColor, gridcolor: layout.gridColor, showgrid: false,
      tickfont: { size: sizes.tick }, showticklabels: false, title: { text: 'DOS', font: { size: sizes.title } },
      rangemode: 'tozero',
    };
  }
  delete full.gridColor;
  delete full.fontColor;
  return { data, layout: full };
}

/** Render the band/DOS figure (bandFigure) into the card `plotId`. */
export async function plotBands(plotId, ctx, isExpanded = false) {
  const { data, layout } = bandFigure(ctx, figureTheme(plotId, isExpanded), isExpanded);
  await renderInto(plotId, data, layout);
}

/**
 * ctx: { Q, energies, fit: PolyFit|null, analysis, reference: number (E at Q=0), phononFreq }
 * Energies are plotted relative to `reference` (the Q = 0 energy) in meV.
 */
export async function plotModeMap(plotId, ctx, isExpanded = false) {
  const { Q, energies, fit, analysis, reference = 0, xScale = 1, yScale = 1 } = ctx;
  const xLabel = ctx.xLabel || 'Q (amu<sup>½</sup>·Å)';
  const yLabel = ctx.yLabel || 'ΔE (meV / supercell)';
  const { layout, sizes } = baseLayout(plotId, isExpanded);
  const toMeV = (e) => (e - reference) * 1000 * yScale;
  const X = Q.map((q) => q * xScale);
  /** @type {any[]} */
  const data = [{
    x: X, y: energies.map(toMeV), customdata: Q.map((_, i) => i),
    type: 'scatter', mode: 'markers', name: 'potential',
    marker: { color: COLORS.DATA, size: isExpanded ? 9 : 6 },
    hovertemplate: 'Q = %{x:.3f}<br>ΔE = %{y:.2f} meV<extra></extra>',
  }];
  const annotations = [];
  if (fit) {
    const qMin = Math.min(...Q);
    const qMax = Math.max(...Q);
    const xs = [];
    const ys = [];
    for (let i = 0; i <= 200; i++) {
      const q = qMin + ((qMax - qMin) * i) / 200;
      xs.push(q * xScale);
      ys.push(toMeV(fit.evaluate(q)));
    }
    data.push({ x: xs, y: ys, type: 'scatter', mode: 'lines', name: 'fit', line: { color: COLORS.FIT, width: 2 }, hoverinfo: 'skip' });
    if (analysis?.minima?.length) {
      const mins = analysis.minima.filter((m) => m.depth > 1e-9);
      if (mins.length) {
        data.push({
          x: mins.map((m) => m.Q * xScale), y: mins.map((m) => toMeV(m.energy)),
          type: 'scatter', mode: 'markers', name: 'minimum',
          marker: { color: COLORS.MINIMUM, size: isExpanded ? 13 : 9, symbol: 'diamond' },
          hovertemplate: 'minimum<br>Q = %{x:.3f}<br>ΔE = %{y:.2f} meV<extra></extra>',
        });
      }
    }
    if (analysis) {
      const lines = [`ω<sub>fit</sub> = ${analysis.frequencyTHz.toFixed(3)} THz`];
      if (Number.isFinite(ctx.phononFreq)) lines.push(`ω<sub>phonopy</sub> = ${ctx.phononFreq.toFixed(3)} THz`);
      if (analysis.isDoubleWell) lines.push(`well depth = ${(analysis.barrier * 1000 * yScale).toFixed(2)} meV${yScale !== 1 ? ' / atom' : ''}`);
      annotations.push({
        text: lines.join('<br>'), xref: 'paper', yref: 'paper', x: 0.5, y: 0.98, xanchor: 'center', yanchor: 'top',
        showarrow: false, bgcolor: layout.isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.3)', bordercolor: '#666666',
        borderwidth: 1, font: { color: layout.fontColor, size: sizes.annotation },
      });
    }
  }
  const full = {
    ...layout,
    xaxis: {
      title: { text: xLabel, font: { size: sizes.title }, standoff: isExpanded ? 15 : 6 },
      color: layout.fontColor, gridcolor: layout.gridColor, zerolinecolor: layout.gridColor,
      tickfont: { size: sizes.tick }, showgrid: true,
    },
    yaxis: {
      title: { text: yLabel, font: { size: sizes.title } },
      color: layout.fontColor, gridcolor: layout.gridColor, zerolinecolor: layout.gridColor,
      tickfont: { size: sizes.tick }, showgrid: true,
    },
    annotations,
  };
  delete full.gridColor;
  delete full.fontColor;
  await renderInto(plotId, data, full);
}
