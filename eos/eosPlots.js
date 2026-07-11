// Plotly rendering for the EOS panel's E-V and P-V charts. Plotly is heavy
// (~1MB) so it is only imported the first time a plot is actually drawn.
// Layout here assumes the charts are stacked vertically in a narrow pane
// (see docs/ui/EOSSplitView.js), not side by side.

import { birchMurnaghanPressure, birchMurnaghanEnergy } from './eosMath.js';
import { loadPlotly } from '../utils/plotlyLoader.js';

const COLORS = {
  DATA: '#d62828',
  PV_FIT: '#0f3ad4',
  EV_FIT: '#04c9b9',
  REFERENCE: '#ff6b6b',
  V_DIFF: '#00bcd4',
};

/** Marker/symbol sizes (and error-bar cap dimensions) scale up 50% in the
 *  expanded view — the fonts already do this, but symbols didn't, and at the
 *  expanded view's much larger area they read as too small next to the text. */
function markerScale(isExpanded) {
  return isExpanded ? 1.5 : 1;
}

// Vertical guide lines on the V(P) diff subplot, at +-1/2/5 % — the
// conventional "good/fair/poor agreement" bands for this kind of comparison.
const V_DIFF_GUIDES = [
  { level: 1, color: '#2ecc71' },
  { level: 2, color: '#e67e22' },
  { level: 5, color: '#e74c3c' },
];

const plotThemes = new Map(); // plotId -> 'dark' | 'light'

export function getPlotTheme(plotId) {
  return plotThemes.get(plotId) || 'dark';
}

export function togglePlotTheme(plotId) {
  const next = getPlotTheme(plotId) === 'dark' ? 'light' : 'dark';
  plotThemes.set(plotId, next);
  return next;
}

/** Font sizes scale up substantially in the fullscreen/expanded view, which
 *  has far more room than the narrow pane — plain proportional scaling reads
 *  as "barely readable" there. */
function fontSizes(isExpanded) {
  // The expanded view is roughly 2.5-3x the pane's area in each dimension,
  // so matching that in font size (not just a modest bump) is what actually
  // reads as "larger" rather than merely "less cramped". Dialed back one
  // notch from an earlier pass that read as too large for the tick/legend text.
  return isExpanded
    ? { base: 22, tick: 19, title: 26, legend: 18, annotation: 18 }
    : { base: 11, tick: 11, title: 12, legend: 10, annotation: 10 };
}

function axisTitle(text, size, standoff) {
  const t = { text, font: { size } };
  // Plotly's automatic gap between tick labels and an x-axis title scales
  // with tick font size; at the expanded view's larger fonts that automatic
  // gap grows enough to push the title past the fixed bottom margin (it
  // reads as "the label sits too low" / spills toward whatever is below the
  // plot). A fixed standoff keeps it just under the ticks regardless of font size.
  if (standoff !== undefined) t.standoff = standoff;
  return t;
}

function baseLayout(plotId, xLabel, yLabel, isExpanded) {
  const isLight = getPlotTheme(plotId) === 'light';
  const paperBg = isLight ? '#ffffff' : '#121212';
  const fontColor = isLight ? '#121212' : '#e0e0e0';
  const gridColor = isLight ? '#cccccc' : '#444444';
  const zeroLineColor = '#666666';
  const sizes = fontSizes(isExpanded);

  return {
    paper_bgcolor: paperBg,
    plot_bgcolor: paperBg,
    font: { color: fontColor, family: 'Arial, sans-serif', size: sizes.base },
    xaxis: {
      title: axisTitle(xLabel, sizes.title, isExpanded ? 15 : 6), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: zeroLineColor, showgrid: true,
    },
    yaxis: {
      title: axisTitle(yLabel, sizes.title), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: zeroLineColor, showgrid: true,
    },
    showlegend: true,
    legend: {
      bgcolor: isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.3)',
      bordercolor: '#666666',
      borderwidth: 1,
      font: { color: fontColor, size: sizes.legend },
      x: 0.98, y: 0.98, xanchor: 'right', yanchor: 'top',
    },
    margin: isExpanded ? { t: 40, r: 50, b: 125, l: 130 } : { t: 20, r: 20, b: 45, l: 55 },
  };
}

function fitCurve(vMin, vMax, fn, nPoints = 200) {
  const xs = [];
  const ys = [];
  for (let i = 0; i <= nPoints; i++) {
    const V = vMin + (i / nPoints) * (vMax - vMin);
    xs.push(V);
    ys.push(fn(V));
  }
  return { xs, ys };
}

async function renderInto(plotId, data, layout) {
  const Plotly = await loadPlotly();
  await Plotly.newPlot(plotId, data, layout, { responsive: true, displayModeBar: false });
  requestAnimationFrame(() => Plotly.Plots.resize(plotId));
}

/** ctx: { volumes, energies, evParams: [E0,V0,K0,K0Prime] } */
export async function plotEV(plotId, ctx, isExpanded = false) {
  const { volumes, energies, evParams } = ctx;
  const vMin = Math.min(...volumes);
  const vMax = Math.max(...volumes);
  const { xs, ys } = fitCurve(vMin, vMax, (V) => birchMurnaghanEnergy(V, ...evParams));

  const layout = baseLayout(plotId, 'Volume (Å³)', 'Energy (eV)', isExpanded);
  const [, V0, K0, K0Prime] = evParams;
  const sizes = fontSizes(isExpanded);
  layout.annotations = [{
    text: `V₀ = ${V0.toFixed(2)} Å³<br>K₀ = ${K0.toFixed(2)} GPa<br>K₀′ = ${K0Prime.toFixed(2)}`,
    xref: 'paper', yref: 'paper', x: 0.5, y: 0.98, xanchor: 'center', yanchor: 'top',
    showarrow: false, bgcolor: layout.legend.bgcolor, bordercolor: layout.legend.bordercolor,
    borderwidth: 1, font: { color: layout.font.color, size: sizes.annotation },
  }];

  const mScale = markerScale(isExpanded);
  const data = [
    { x: volumes, y: energies, mode: 'markers', type: 'scatter', name: 'Data', marker: { color: COLORS.DATA, size: 6 * mScale } },
    { x: xs, y: ys, mode: 'lines', type: 'scatter', name: 'Fit', line: { color: COLORS.EV_FIT, width: 2 } },
  ];

  await renderInto(plotId, data, layout);
}

/**
 * ctx: {
 *   volumes, pressures, pvParams: [V0,K0,K0Prime], evParams: [E0,V0,K0,K0Prime],
 *   referenceData: {volumes,pressures,errors} | null,
 *   referenceFit: {params:[V0,K0,K0Prime]} | null,
 *   showErrorPlots: boolean,
 * }
 */
export async function plotPV(plotId, ctx, isExpanded = false) {
  const { volumes, pressures, pvParams, evParams, referenceData, referenceFit, showErrorPlots } = ctx;
  const vMin = Math.min(...volumes);
  const vMax = Math.max(...volumes);
  const hasEvCurve = Array.isArray(evParams) && evParams.length === 4;
  const showPDiff = hasEvCurve && showErrorPlots;
  const showVDiff = !!(referenceData && referenceFit && showErrorPlots);
  const sizes = fontSizes(isExpanded);
  const mScale = markerScale(isExpanded);

  const pv = fitCurve(vMin, vMax, (V) => birchMurnaghanPressure(V, ...pvParams));
  const ev = hasEvCurve ? fitCurve(vMin, vMax, (V) => birchMurnaghanPressure(V, evParams[1], evParams[2], evParams[3])) : null;

  const isLight = getPlotTheme(plotId) === 'light';
  const fontColor = isLight ? '#121212' : '#e0e0e0';
  const gridColor = isLight ? '#cccccc' : '#444444';

  // Vertical split, top to bottom: main P-V row, then P-diff spanning below
  // it. The V(P) reference diff does NOT get its own row — it sits beside
  // the main plot within the main row (matching the original standalone
  // tool's layout).
  const rows = [{ key: 'main', frac: 1 }];
  if (showPDiff) rows.push({ key: 'pdiff', frac: 0.3 });
  const gap = 0.08;
  const totalFrac = rows.reduce((s, r) => s + r.frac, 0) + gap * (rows.length - 1);
  let cursor = 1;
  const domains = {};
  for (const row of rows) {
    const h = row.frac / totalFrac;
    domains[row.key] = [Math.max(0, cursor - h), cursor];
    cursor -= h + gap / totalFrac;
  }

  // Horizontal split within the main row: main P-V plot, and (if present)
  // the V(P) reference-diff column to its right.
  const mainXDomain = showVDiff ? [0, 0.62] : [0, 1];
  const vDiffXDomain = [0.72, 1];

  // The legend only actually collides with plotted content when the V-diff
  // column is present (it shares the main row's plotting area) — P-diff
  // alone sits in its own row below, out of the legend's way. Rather than
  // float the legend inside that shared area (it kept overlapping the V-diff
  // scatter/axis title no matter which corner), reserve real space for it in
  // the right margin so it sits fully outside every subplot's domain.
  const legendOutside = showVDiff;
  const legendMarginR = legendOutside ? (isExpanded ? 210 : 80) : 0;
  const legendPos = legendOutside
    ? { x: 1.02, y: 1, xanchor: 'left', yanchor: 'top' }
    : { x: 0.98, y: domains.main[1], xanchor: 'right', yanchor: 'top' };

  const baseMarginR = isExpanded ? 50 : 20;

  const layout = {
    paper_bgcolor: isLight ? '#ffffff' : '#121212',
    plot_bgcolor: isLight ? '#ffffff' : '#121212',
    font: { color: fontColor, family: 'Arial, sans-serif', size: sizes.base },
    showlegend: true,
    legend: {
      bgcolor: isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.3)',
      bordercolor: '#666666', borderwidth: 1,
      font: { color: fontColor, size: sizes.legend },
      ...legendPos,
    },
    margin: isExpanded
      ? { t: 40, r: baseMarginR + legendMarginR, b: 125, l: 130 }
      : { t: 20, r: baseMarginR + legendMarginR, b: 45, l: 55 },
    xaxis: {
      // When the P-diff row is shown below, its own x-axis carries the
      // "Volume" title instead — showing it here too just duplicates it in
      // the middle of the stack. Its range stays locked to that axis (see
      // xaxis2.matches below) so dropping the title doesn't lose the tie.
      ...(showPDiff ? {} : { title: axisTitle('Volume (Å³)', sizes.title, isExpanded ? 15 : 6) }),
      tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: '#666666',
      showgrid: true, domain: mainXDomain, anchor: 'y',
    },
    yaxis: {
      title: axisTitle('Pressure (GPa)', sizes.title), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: '#666666',
      showgrid: true, domain: domains.main, anchor: 'x',
    },
  };

  /** @type {any[]} */
  const data = [
    { x: volumes, y: pressures, mode: 'markers', type: 'scatter', name: 'Data', marker: { color: COLORS.DATA, size: 6 * mScale }, xaxis: 'x', yaxis: 'y' },
    { x: pv.xs, y: pv.ys, mode: 'lines', type: 'scatter', name: 'P-V Fit', line: { color: COLORS.PV_FIT, width: 2 }, xaxis: 'x', yaxis: 'y' },
  ];
  if (ev) {
    data.push({ x: ev.xs, y: ev.ys, mode: 'lines', type: 'scatter', name: 'P from E-V', line: { color: COLORS.EV_FIT, width: 2, dash: 'dash' }, xaxis: 'x', yaxis: 'y' });
  }

  const mainAnnoX = (mainXDomain[0] + mainXDomain[1]) / 2;
  layout.annotations = [{
    text: `V₀ = ${pvParams[0].toFixed(2)} Å³<br>K₀ = ${pvParams[1].toFixed(2)} GPa<br>K₀′ = ${pvParams[2].toFixed(2)}`,
    xref: 'paper', yref: 'paper', x: mainAnnoX, y: domains.main[1], xanchor: 'center', yanchor: 'top',
    showarrow: false, bgcolor: layout.legend.bgcolor, bordercolor: '#666666', borderwidth: 1,
    font: { color: fontColor, size: sizes.annotation },
  }];

  layout.shapes = [];

  if (showPDiff) {
    const diff = fitCurve(vMin, vMax, (V) => {
      const pPv = birchMurnaghanPressure(V, ...pvParams);
      const pEv = birchMurnaghanPressure(V, evParams[1], evParams[2], evParams[3]);
      return pEv - pPv;
    });
    layout.xaxis2 = {
      title: axisTitle('Volume (Å³)', sizes.title, isExpanded ? 15 : 6), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: '#666666', showgrid: true, domain: mainXDomain,
      anchor: 'y2', matches: 'x',
    };
    layout.yaxis2 = {
      title: axisTitle('P<sub>E-V</sub>−P<sub>P-V</sub> (GPa)', sizes.title), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: '#666666', showgrid: false, domain: domains.pdiff, anchor: 'x2',
    };
    data.push({ x: diff.xs, y: diff.ys, mode: 'lines', type: 'scatter', name: 'P Diff', line: { color: '#ff6b6b', width: 2 }, xaxis: 'x2', yaxis: 'y2' });
  }

  if (showVDiff) {
    const [V0ev, K0ev, K0Primeev] = [evParams[1], evParams[2], evParams[3]];
    const vFineMin = vMin * 0.95, vFineMax = vMax * 1.05;
    const nFine = 1000;
    const fineV = [], fineP = [];
    for (let i = 0; i <= nFine; i++) {
      const V = vFineMin + (i / nFine) * (vFineMax - vFineMin);
      fineV.push(V);
      fineP.push(birchMurnaghanPressure(V, V0ev, K0ev, K0Primeev));
    }
    const closestV = (targetP) => {
      let bestIdx = 0, bestDiff = Infinity;
      for (let j = 0; j < fineP.length; j++) {
        const d = Math.abs(fineP[j] - targetP);
        if (d < bestDiff) { bestDiff = d; bestIdx = j; }
      }
      return fineV[bestIdx];
    };

    const diffPercent = [], diffPressure = [], diffError = [];
    for (let i = 0; i < referenceData.pressures.length; i++) {
      const pRef = referenceData.pressures[i];
      const vRef = referenceData.volumes[i];
      const err = referenceData.errors[i] || 0;
      const vFit = closestV(pRef);
      const vPlus = closestV(pRef + err);
      const vMinus = closestV(pRef - err);
      const pct = vRef !== 0 ? 100 * (vRef - vFit) / Math.abs(vRef) : 0;
      const pctPlus = vRef !== 0 ? 100 * (vRef - vPlus) / Math.abs(vRef) : 0;
      const pctMinus = vRef !== 0 ? 100 * (vRef - vMinus) / Math.abs(vRef) : 0;
      diffPercent.push(pct);
      diffPressure.push(pRef);
      diffError.push(Math.max(Math.abs(pct - pctPlus), Math.abs(pct - pctMinus)));
    }

    // Symmetric x-range around 0, wide enough to include every point (with
    // its error bar) and the widest (+-5%) guide line.
    const maxGuide = V_DIFF_GUIDES[V_DIFF_GUIDES.length - 1].level;
    const dataExtent = diffPercent.reduce((m, p, i) => Math.max(m, Math.abs(p) + (diffError[i] || 0)), 0);
    const bound = Math.max(maxGuide, dataExtent) * 1.15;

    layout.xaxis3 = {
      title: axisTitle('(V<sub>Exp</sub>−V<sub>Fit</sub>)/V<sub>Exp</sub> (%)', sizes.title), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: '#666666', showgrid: true,
      domain: vDiffXDomain, anchor: 'y3', range: [-bound, bound],
    };
    layout.yaxis3 = {
      title: axisTitle('Pressure (GPa)', sizes.title), tickfont: { size: sizes.tick },
      color: fontColor, gridcolor: gridColor, zerolinecolor: '#666666', showgrid: true,
      domain: domains.main, anchor: 'x3', matches: 'y',
    };
    data.push({
      x: diffPercent, y: diffPressure,
      error_x: { type: 'data', array: diffError, visible: true, color: COLORS.V_DIFF, thickness: 2 * mScale, width: 6 * mScale },
      mode: 'markers', type: 'scatter', name: 'V Diff', marker: { color: COLORS.V_DIFF, size: 7 * mScale },
      xaxis: 'x3', yaxis: 'y3',
    });

    for (const { level, color } of V_DIFF_GUIDES) {
      for (const sign of [1, -1]) {
        layout.shapes.push({
          type: 'line', xref: 'x3', yref: 'y3 domain',
          x0: sign * level, x1: sign * level, y0: 0, y1: 1,
          line: { color, width: 1.5, dash: 'dot' },
        });
      }
    }
  }

  if (referenceData) {
    data.push({
      x: referenceData.volumes, y: referenceData.pressures,
      error_y: { type: 'data', array: referenceData.errors, visible: true, color: COLORS.REFERENCE, thickness: 1 * mScale, width: 4 * mScale },
      mode: 'markers', type: 'scatter', name: 'Reference', marker: { color: COLORS.REFERENCE, size: 8 * mScale, symbol: 'x', line: { width: 2 * mScale } },
      xaxis: 'x', yaxis: 'y',
    });
    if (referenceFit) {
      const refCurve = fitCurve(vMin, vMax, (V) => birchMurnaghanPressure(V, ...referenceFit.params));
      data.push({
        x: refCurve.xs, y: refCurve.ys, mode: 'lines', type: 'scatter', name: 'Reference Fit',
        line: { color: COLORS.REFERENCE, width: 2, dash: 'dash' }, xaxis: 'x', yaxis: 'y',
      });
    }
  }

  await renderInto(plotId, data, layout);
}

export async function exportPlotAsPNG(plotId) {
  const Plotly = await loadPlotly();
  const plotDiv = document.getElementById(plotId);
  const width = plotDiv?.offsetWidth || 1200;
  const height = plotDiv?.offsetHeight || 900;
  await Plotly.downloadImage(plotId, { format: 'png', width, height, filename: plotId, scale: 3 });
}

/** Wipes a chart back to empty (e.g. resetting the overall fit) — best-effort,
 *  since there may be no chart yet to purge. */
export async function clearPlot(plotId) {
  try {
    const Plotly = await loadPlotly();
    if (document.getElementById(plotId)) await Plotly.purge(plotId);
  } catch {
    // No chart to clear, or Plotly failed to load — nothing to do.
  }
}

/** Best-effort: called on layout changes (pane opened/resized) before any
 *  chart may exist yet, so failures here are swallowed rather than surfaced. */
export async function resizePlot(plotId) {
  try {
    const Plotly = await loadPlotly();
    if (document.getElementById(plotId)) Plotly.Plots.resize(plotId);
  } catch {
    // No chart to resize yet, or Plotly failed to load — nothing to do.
  }
}
