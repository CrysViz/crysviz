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

// Per-plot light/dark toggle, same idiom as eos/eosPlots.js's plotThemes —
// each histogram window remembers its own choice independently.
const plotThemes = new Map(); // plotId -> 'dark' | 'light'

export function getPlotTheme(plotId) {
  return plotThemes.get(plotId) || 'dark';
}

export function togglePlotTheme(plotId) {
  const next = getPlotTheme(plotId) === 'dark' ? 'light' : 'dark';
  plotThemes.set(plotId, next);
  return next;
}

/**
 * groups: [{ label, x: string[], y: number[], customdata: any[], hovertext?:
 * string[] }, ...] — one series per bond pair / element, bars grouped by
 * shared x categories. hovertext, when given, replaces the default
 * "series/x/y" hover line-for-line (e.g. the Bond Length Histogram's list of
 * actual bonds in that bin).
 *
 * `theme`, when given ('light'|'dark'), overrides the plotId's own
 * remembered theme — for a window driving many plot ids off ONE toggle (the
 * per-pair Bond Length Histogram cards) rather than each plot remembering its
 * own. `compact`, for the same low-profile-card case, skips the boundary-tick
 * dividers (only useful for disambiguating multi-series grouped bars) and
 * tightens the margins so a short chart div isn't mostly whitespace — axis
 * titles still show either way, and which ticks actually get labeled is left
 * to Plotly's own automatic category-axis thinning in BOTH modes (a separate
 * hand-picked "nice round number" thinning for compact used to pick a
 * different, coarser set of labels than the non-compact charts' automatic
 * one, which is what read as the two "not matching").
 */
export async function renderGroupedHistogram(plotId, {
  groups, xTitle, yTitle, isExpanded = false, theme = undefined, compact = false,
}) {
  const Plotly = await loadPlotly();
  if (!document.getElementById(plotId)) return;

  const isLight = (theme ?? getPlotTheme(plotId)) === 'light';
  const paperBg = isLight ? '#ffffff' : 'rgba(0,0,0,0)';
  const fontColor = isLight ? '#121212' : '#ddd';
  const gridColor = isLight ? '#cccccc' : '#444444';
  const dividerColor = isLight ? '#999999' : '#666666';
  const barLineColor = isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)';
  const sizes = isExpanded
    ? { tick: 16, title: 19, legend: 15 }
    : { tick: 13, title: 14, legend: 12 };

  const data = groups.map((g, i) => ({
    type: 'bar',
    name: g.label,
    x: g.x,
    y: g.y,
    customdata: g.customdata,
    ...(g.hovertext
      ? { hovertext: g.hovertext, hovertemplate: '%{hovertext}<extra></extra>' }
      : { hovertemplate: `${g.label}<br>%{x}<br>%{y}<extra></extra>` }),
    marker: {
      color: HISTOGRAM_COLORS[i % HISTOGRAM_COLORS.length],
      line: { color: barLineColor, width: 1 },
    },
  }));

  // Boundary ticks/dividers disambiguate MULTI-series grouped bars (which
  // tick a bar-group belongs to) — a compact single-series card has no such
  // ambiguity (one bar per tick already), so skip them there: they read as
  // visual clutter, not signal, on a short chart. Which ticks get a LABEL is
  // otherwise left to Plotly's own automatic thinning either way (tickmode
  // stays 'auto') — so a compact card's labeled ticks always match the same
  // density/spacing the non-compact combined chart already picks for itself,
  // rather than two different algorithms disagreeing on which bins to show.
  const xaxis = {
    title: { text: xTitle, font: { size: sizes.title } },
    tickfont: { size: sizes.tick },
    color: fontColor,
    type: 'category',
    automargin: true,
    ticks: 'outside',
  };
  if (!compact) {
    Object.assign(xaxis, {
      tickson: 'boundaries',
      showdividers: true,
      dividercolor: dividerColor,
      dividerwidth: 1,
    });
  }

  const layout = {
    barmode: 'group',
    bargap: 0.15,
    bargroupgap: 0.08,
    paper_bgcolor: paperBg,
    plot_bgcolor: paperBg,
    font: { color: fontColor, size: sizes.tick },
    xaxis,
    yaxis: {
      title: { text: yTitle, font: { size: sizes.title } },
      tickfont: { size: sizes.tick },
      color: fontColor,
      gridcolor: gridColor,
      rangemode: 'tozero',
      automargin: true,
    },
    showlegend: groups.length > 1,
    legend: {
      font: { color: fontColor, size: sizes.legend },
      bgcolor: isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.3)',
    },
    margin: isExpanded
      ? { t: 20, r: 20, b: 70, l: 60 }
      : compact
        ? { t: 4, r: 4, b: 34, l: 44 }
        : { t: 10, r: 10, b: 55, l: 45 },
  };

  await Plotly.react(plotId, data, layout, { responsive: true, displayModeBar: false });
  // A frame later the card may have been collapsed, or the whole card list
  // rebuilt, so this has to re-check that the div is still there and still
  // displayed — see safeResize.
  requestAnimationFrame(() => safeResize(Plotly, plotId));
}

/** Plotly.Plots.resize throws "Resize must be passed a displayed plot div
 *  element" for a div that is hidden or was never plotted, and every caller
 *  here resizes speculatively: a collapsed bond-length card keeps its plot div
 *  in the DOM but display:none, and the panel's ResizeObserver fires for every
 *  card including those. So the div is checked for being plotted (_fullLayout
 *  is Plotly's own marker) and actually laid out before asking. */
function safeResize(Plotly, plotId) {
  const el = /** @type {(HTMLElement & {_fullLayout?: unknown}) | null} */ (document.getElementById(plotId));
  if (!el || !el._fullLayout || !el.offsetParent || !el.clientWidth) return;
  try {
    Plotly.Plots.resize(el);
  } catch {
    // Raced with a collapse or a rebuild — the next render resizes it anyway.
  }
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

// "Slightly bigger" for the export specifically: the on-screen layout's font
// sizes are tuned for a small on-screen card, and scale (below) keeps the
// PNG sharp but doesn't fix the proportion — stretched across the much
// larger export canvas, that same absolute size reads smaller than it did
// on screen.
const EXPORT_FONT_BUMP = 1.35;

/** Every font-size path worth bumping for export: the base font, the legend,
 *  and each tick/title font for EVERY x/y axis actually present — scanned
 *  dynamically (xaxis, xaxis2, ..., yaxis, yaxis2, yaxis3, ...) rather than a
 *  fixed xaxis/yaxis pair, since some layouts (the trajectory plot's
 *  temperature/energy/force/pressure multi-axis view) have more than one of
 *  each. */
function fontSizePaths(layout) {
  const paths = [];
  if (layout?.font?.size != null) paths.push('font.size');
  if (layout?.legend?.font?.size != null) paths.push('legend.font.size');
  for (const key of Object.keys(layout ?? {})) {
    if (!/^[xy]axis\d*$/.test(key)) continue;
    if (layout[key]?.tickfont?.size != null) paths.push(`${key}.tickfont.size`);
    if (layout[key]?.title?.font?.size != null) paths.push(`${key}.title.font.size`);
  }
  return paths;
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

export async function exportHistogramPNG(plotId) {
  const Plotly = await loadPlotly();
  const plotDiv = document.getElementById(plotId);
  // Export at real print-quality dimensions regardless of the on-screen
  // widget's box — downloadImage re-renders the chart at these dimensions
  // rather than screenshotting the tiny on-screen version, so a 900x500
  // floor (not just a fallback for when the div is 0x0) plus scale keeps the
  // image sharp even for a compact ~66px-tall card.
  const width = Math.max(plotDiv?.offsetWidth || 0, 900);
  const height = Math.max(plotDiv?.offsetHeight || 0, 500);

  // Bump every font size up just for the export, then put the live chart
  // back exactly as it was — relayout (not react) so nothing else about the
  // chart's data/traces is touched.
  const paths = fontSizePaths(plotDiv?.layout);
  const original = Object.fromEntries(paths.map((p) => [p, getByPath(plotDiv.layout, p)]));
  const bumped = Object.fromEntries(paths.map((p) => [p, original[p] * EXPORT_FONT_BUMP]));

  if (paths.length) await Plotly.relayout(plotId, bumped);
  try {
    await Plotly.downloadImage(plotId, { format: 'png', width, height, filename: plotId, scale: 3 });
  } finally {
    if (paths.length) await Plotly.relayout(plotId, original);
  }
}

/** Best-effort: called on layout changes (pane opened/resized) before any
 *  chart may exist yet, so failures here are swallowed rather than surfaced. */
export async function resizeHistogramPlot(plotId) {
  try {
    safeResize(await loadPlotly(), plotId);
  } catch {
    // Plotly failed to load — nothing to resize.
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
