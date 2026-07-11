// Shared Plotly grouped-bar-chart rendering for the analysis histograms
// (BondLengthHistogram.js, CoordinationHistogram.js). Each caller owns its
// own binning and highlight semantics; this module only owns the actual
// Plotly call, the responsive resize, PNG export, and the bar-click wiring —
// letting Plotly's own grouped-bar layout handle bar/group spacing and x-tick
// collision avoidance, which the old hand-rolled canvas version did not.

import { loadPlotly } from '../../utils/plotlyLoader.js';

export const HISTOGRAM_COLORS = [
  '#00202e', '#2c4875', '#8a508f', '#bc5090',
  '#ff6361', '#ff8531', '#ffa600', '#ffd380',
];

// Plotly div elements that already carry a plotly_click listener — Plotly.react()
// reuses the same DOM node across redraws, so the listener must be attached
// once, not on every redraw (it would otherwise stack duplicate handlers).
const clickWired = new WeakSet();

/**
 * groups: [{ label, x: string[], y: number[], customdata: any[] }, ...] — one
 * series per bond pair / element, bars grouped by shared x categories.
 */
export async function renderGroupedHistogram(plotId, { groups, xTitle, yTitle, isExpanded = false }) {
  const Plotly = await loadPlotly();
  if (!document.getElementById(plotId)) return;

  const fontColor = '#ddd';
  const sizes = isExpanded
    ? { tick: 15, title: 18, legend: 14 }
    : { tick: 11, title: 12, legend: 10 };

  const data = groups.map((g, i) => ({
    type: 'bar',
    name: g.label,
    x: g.x,
    y: g.y,
    customdata: g.customdata,
    marker: {
      color: HISTOGRAM_COLORS[i % HISTOGRAM_COLORS.length],
      line: { color: 'rgba(255,255,255,0.3)', width: 1 },
    },
  }));

  const layout = {
    barmode: 'group',
    bargap: 0.15,
    bargroupgap: 0.08,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: fontColor, size: sizes.tick },
    xaxis: {
      title: { text: xTitle, font: { size: sizes.title } },
      tickfont: { size: sizes.tick },
      color: fontColor,
      type: 'category',
    },
    yaxis: {
      title: { text: yTitle, font: { size: sizes.title } },
      tickfont: { size: sizes.tick },
      color: fontColor,
      gridcolor: '#444444',
      rangemode: 'tozero',
    },
    showlegend: groups.length > 1,
    legend: { font: { color: fontColor, size: sizes.legend }, bgcolor: 'rgba(0,0,0,0.3)' },
    margin: isExpanded ? { t: 20, r: 20, b: 70, l: 60 } : { t: 10, r: 10, b: 55, l: 45 },
  };

  await Plotly.react(plotId, data, layout, { responsive: true, displayModeBar: false });
  requestAnimationFrame(() => Plotly.Plots.resize(plotId));
}

/** Wire a bar-click handler onto a plot div (idempotent — safe to call after
 *  every render). `handler(customdata, point)` fires with the clicked bar's
 *  customdata payload (whatever the caller put there — bond instance ids,
 *  atom indices, ...). */
export function onHistogramBarClick(plotId, handler) {
  const el = document.getElementById(plotId);
  if (!el || clickWired.has(el)) return;
  clickWired.add(el);
  el.on('plotly_click', (ev) => {
    const pt = ev.points?.[0];
    if (pt) handler(pt.customdata, pt);
  });
}

export async function exportHistogramPNG(plotId) {
  const Plotly = await loadPlotly();
  const plotDiv = document.getElementById(plotId);
  const width = plotDiv?.offsetWidth || 900;
  const height = plotDiv?.offsetHeight || 500;
  await Plotly.downloadImage(plotId, { format: 'png', width, height, filename: plotId, scale: 3 });
}

/** Best-effort: called on layout changes (pane opened/resized) before any
 *  chart may exist yet, so failures here are swallowed rather than surfaced. */
export async function resizeHistogramPlot(plotId) {
  try {
    const Plotly = await loadPlotly();
    if (document.getElementById(plotId)) Plotly.Plots.resize(plotId);
  } catch {
    // No chart to resize yet, or Plotly failed to load — nothing to do.
  }
}

/** Wipes a chart back to empty — best-effort, since there may be no chart yet. */
export async function clearHistogramPlot(plotId) {
  try {
    const Plotly = await loadPlotly();
    if (document.getElementById(plotId)) await Plotly.purge(plotId);
  } catch {
    // No chart to clear, or Plotly failed to load — nothing to do.
  }
}
