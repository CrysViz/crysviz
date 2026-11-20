// Shared Plotly bar-chart rendering for the analysis histograms
// (BondLengthHistogram.js, ForceHistogram.js, CoordinationHistogram.js, the
// polyhedra histograms). Each caller owns its own binning and highlight
// semantics; this module only owns the actual Plotly call, the responsive
// resize, PNG export, and the bar-click wiring. Category charts (coordination
// numbers, polyhedron types) keep Plotly's grouped bars; binned charts (bond
// length, |F|) are stacked histograms on a numeric axis — see `bins` below.

import { loadPlotly } from '../../utils/plotlyLoader.js';
import { downloadBlob } from '../SavePanel.js';
import { HISTOGRAM_COLORS, paletteColor } from './histogramColors.js';

export { HISTOGRAM_COLORS };

// Plot ids drawn as binned histograms -> what fitBinEdges needs to redraw
// their bin-edge lines after a resize.
const binnedPlots = new Map(); // plotId -> { bins, color }

// Plotly div elements that already carry a plotly_click listener — Plotly.react()
// reuses the same DOM node across redraws, so the listener must be attached
// once, not on every redraw (it would otherwise stack duplicate handlers).
const clickWired = new WeakSet();

// Per-plot light/dark toggle, same idiom as eos/eosPlots.js's plotThemes —
// each histogram window remembers its own choice independently.
const plotThemes = new Map(); // plotId -> 'dark' | 'light'
let exportInProgress = false;

export function getPlotTheme(plotId) {
  return plotThemes.get(plotId) || 'dark';
}

export function togglePlotTheme(plotId) {
  const next = getPlotTheme(plotId) === 'dark' ? 'light' : 'dark';
  plotThemes.set(plotId, next);
  return next;
}

/**
 * groups: [{ label, x, y: number[], customdata: any[], hovertext?: string[],
 * color?, legendgroup?, legendgrouptitle? }, ...] — one series per bond pair /
 * element / Wyckoff site. hovertext, when given, replaces the default
 * "series/x/y" hover line-for-line (e.g. the Bond Length Histogram's list of
 * actual bonds in that bin). `color` overrides the palette colour (the callers
 * give site series shades of their element's colour, histogramColors.js);
 * `legendgroup`/`legendgrouptitle` group the legend under element headings.
 *
 * Each plot id remembers its own light/dark choice (togglePlotTheme, the 🌓
 * on every chart card, the Bond Length Histogram's per-pair cards included);
 * `theme`, when given ('light'|'dark'), overrides it for a caller that wants
 * one setting for several plots. `compact`, for low-profile cards, skips the boundary-tick
 * dividers of a category chart and tightens the margins so a short chart div
 * isn't mostly whitespace.
 *
 * `bins`, when given ({ width, min, max }), draws a STACKED HISTOGRAM on a
 * numeric axis instead of grouped category bars: each group's `x` holds its
 * bins' centres, every bin is one full-width bar made of one segment per
 * series, and a faint line marks every bin edge (fewer when bins are only a
 * few pixels wide), so which bars belong to which bin is plain to see however
 * many series there are. The x ticks are a few round, horizontal values. A bin
 * spelled out as a "0.50–1.00" category label had to turn vertical once the
 * labels stopped fitting side by side, and in a short card ran into the axis
 * title and was cut off; the bin's range is in its hover text instead. Empty
 * segments are left out, so they get no hover of their own.
 *
 * `selected` ({ label, index }) outlines that series' bar in bin `index` — the
 * bar whose bonds/atoms are highlighted in 3D.
 *
 * The count axis only ever steps by whole numbers (no "0.5 bonds"), and its
 * step is picked from the chart's real height, so a short card gets two or
 * three labels rather than Plotly's minimum of five crammed together.
 */
export async function renderGroupedHistogram(plotId, {
  groups, xTitle, yTitle, isExpanded = false, theme = undefined, compact = false, bins = undefined,
  selected = undefined,
}) {
  let Plotly;
  try {
    Plotly = await loadPlotly();
  } catch (error) {
    const plot = document.getElementById(plotId);
    if (plot) plot.textContent = error.message;
    return false;
  }
  const plotEl = document.getElementById(plotId);
  if (!plotEl) return false;

  const isLight = (theme ?? getPlotTheme(plotId)) === 'light';
  const paperBg = isLight ? '#ffffff' : 'rgba(0,0,0,0)';
  const fontColor = isLight ? '#121212' : '#ddd';
  const gridColor = isLight ? '#cccccc' : '#444444';
  const dividerColor = isLight ? '#999999' : '#666666';
  const edgeColor = isLight ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.13)';
  const barLineColor = isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)';
  const sizes = isExpanded
    ? { tick: 16, title: 19, legend: 15 }
    : { tick: 13, title: 14, legend: 12 };

  const data = groups.map((g, i) => {
    const isSelected = (k) => selected?.label === g.label && selected.index === k;
    const outlined = g.y.some((_, k) => isSelected(k));
    return {
      type: 'bar',
      name: g.label,
      x: g.x,
      // A zero-height segment in a stack would still catch the hover.
      y: bins ? g.y.map((c) => c || null) : g.y,
      customdata: g.customdata,
      ...(g.hovertext
        ? { hovertext: g.hovertext, hovertemplate: '%{hovertext}<extra></extra>' }
        : { hovertemplate: `${g.label}<br>%{x}<br>%{y}<extra></extra>` }),
      ...(bins ? { width: bins.width * (1 - BIN_GAP) } : {}),
      ...(g.legendgroup ? { legendgroup: g.legendgroup, legendgrouptitle: { text: g.legendgrouptitle ?? g.legendgroup } } : {}),
      marker: {
        // Callers without their own colours (coordination, polyhedra) get the
        // palette spread over their series, as histogramColors.js does.
        color: g.color ?? paletteColor(i, groups.length),
        line: outlined
          ? { color: g.y.map((_, k) => (isSelected(k) ? fontColor : barLineColor)), width: g.y.map((_, k) => (isSelected(k) ? 2.5 : 1)) }
          : { color: barLineColor, width: 1 },
      },
    };
  });

  const xaxis = {
    title: { text: xTitle, font: { size: sizes.title } },
    tickfont: { size: sizes.tick },
    color: fontColor,
    type: 'category',
    automargin: true,
    ticks: 'outside',
  };
  if (bins) {
    // An explicit standoff makes automargin push the bottom margin far
    // enough for the title; Plotly's default squeezes the title against the
    // tick labels once a short card runs out of margin.
    xaxis.title.standoff = 8;
    Object.assign(xaxis, {
      type: 'linear',
      range: [bins.min, bins.max],
      showgrid: false,
      zeroline: false,
      tickangle: 0,
    });
  } else if (!compact) {
    // Boundary ticks tell which tick a group of category bars belongs to.
    Object.assign(xaxis, {
      tickson: 'boundaries',
      showdividers: true,
      dividercolor: dividerColor,
      dividerwidth: 1,
    });
  }

  // A compact card's bottom margin holds the tick labels (~30 px with their
  // tick marks and label padding), a gap and the axis title (~18 px) outright: in a 110 px
  // card automargin does not grow it, and the title ended up on the ticks.
  const margin = isExpanded
    ? { t: 20, r: 20, b: 70, l: 60 }
    : compact
      ? { t: 4, r: 4, b: 52, l: 44 }
      : { t: 10, r: 10, b: 55, l: 45 };
  const binCount = groups[0]?.y.length ?? 0;
  const maxCount = bins
    ? Math.max(0, ...Array.from({ length: binCount }, (_, k) => groups.reduce((sum, g) => sum + (g.y[k] || 0), 0)))
    : groups.reduce((m, g) => g.y.reduce((a, b) => Math.max(a, b), m), 0);
  const countStep = countTickStep(maxCount, plotEl.clientHeight - margin.t - margin.b);

  if (bins) binnedPlots.set(plotId, { bins, color: edgeColor });
  else binnedPlots.delete(plotId);

  const layout = {
    barmode: bins ? 'stack' : 'group',
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
      tick0: 0,
      dtick: countStep,
    },
    showlegend: groups.length > 1,
    legend: {
      font: { color: fontColor, size: sizes.legend },
      grouptitlefont: { color: fontColor, size: sizes.legend },
      bgcolor: isLight ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.3)',
      // Series order, as the cards list them — not Plotly's reversed order
      // for stacked bars.
      traceorder: groups.some((g) => g.legendgroup) ? 'grouped' : 'normal',
      tracegroupgap: 6,
    },
    margin,
    // A first guess at the plot width; fitBinEdges corrects it once Plotly
    // has laid the chart out.
    shapes: bins ? binEdgeShapes(bins, plotEl.clientWidth - margin.l - margin.r - 60, edgeColor) : [],
  };

  await Plotly.react(plotId, data, layout, { responsive: true, displayModeBar: false });
  fitBinEdges(Plotly, plotEl);
  // A frame later the card may have been collapsed, or the whole card list
  // rebuilt, so this has to re-check that the div is still there and still
  // displayed — see safeResize.
  requestAnimationFrame(() => safeResize(Plotly, plotId));
}

// Share of each bin left empty between neighbouring bars.
const BIN_GAP = 0.14;
// Closest two bin-edge lines may be drawn, in px: narrower bins get a line
// every few bins instead of a grey wash.
const MIN_EDGE_SPACING_PX = 6;

/** Vertical lines at the bin edges of `bins` for a plot area `plotPx` wide. */
function binEdgeShapes(bins, plotPx, color) {
  const binCount = Math.round((bins.max - bins.min) / bins.width);
  const binPx = Math.max(plotPx, 1) / Math.max(binCount, 1);
  const every = Math.max(1, Math.ceil(MIN_EDGE_SPACING_PX / binPx));
  const shapes = [];
  for (let i = 0; i <= binCount; i += every) {
    const x = bins.min + i * bins.width;
    shapes.push({
      type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, layer: 'below',
      line: { color, width: 1 },
    });
  }
  return shapes;
}

/** Redraws a binned plot's edge lines for its real plot-area width (after a
 *  render or a resize), only when the thinning changed. */
function fitBinEdges(Plotly, el) {
  const meta = binnedPlots.get(el?.id);
  const plotPx = el?._fullLayout?.xaxis?._length;
  if (!meta || !plotPx) return;
  const shapes = binEdgeShapes(meta.bins, plotPx, meta.color);
  if (shapes.length === (el.layout?.shapes?.length ?? 0)) return;
  Plotly.relayout(el, { shapes }).catch(() => {});
}

/** Step between count-axis ticks: whole numbers only, from the 1-2-5 series,
 *  with labels at least ~24 px apart on an axis `axisPx` tall. Plotly's own
 *  choice asks for at least five labels however short the axis, and goes to
 *  0.5 steps when the counts are small. */
function countTickStep(maxCount, axisPx) {
  const labels = Math.max(2, Math.min(10, Math.floor((axisPx > 0 ? axisPx : 200) / 24)));
  const rough = Math.max(1, maxCount / labels);
  const decade = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * decade).find((step) => step >= rough);
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
    fitBinEdges(Plotly, el);
  } catch {
    // Raced with a collapse or a rebuild — the next render resizes it anyway.
  }
}

/** Wire a bar-click handler onto a plot div (idempotent — safe to call after
 *  every render). `handler(customdata, point)` fires with the clicked bar's
 *  customdata payload (whatever the caller put there — bond instance ids,
 *  atom indices, ...). */
export function onHistogramBarClick(plotId, handler) {
  const el = /** @type {any} */ (document.getElementById(plotId));
  // No .on() when Plotly failed to load: the div then holds the error text.
  if (!el || typeof el.on !== 'function' || clickWired.has(el)) return;
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
  // Plotly.downloadImage rejected overlap; toImage does not, so serialize font changes.
  if (exportInProgress) return;
  exportInProgress = true;
  try {
    const Plotly = await loadPlotly();
    const plotDiv = document.getElementById(plotId);
    // Export at real print-quality dimensions regardless of the on-screen
    // widget's box — toImage re-renders the chart at these dimensions
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
      const dataUrl = await Plotly.toImage(plotId, { format: 'png', width, height, scale: 3 });
      const blob = await (await fetch(dataUrl)).blob();
      downloadBlob(plotId + '.png', blob);
    } finally {
      if (paths.length) await Plotly.relayout(plotId, original);
    }
  } finally {
    exportInProgress = false;
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
    binnedPlots.delete(plotId);
    const Plotly = await loadPlotly();
    if (document.getElementById(plotId)) await Plotly.purge(plotId);
  } catch {
    // No chart to clear, or Plotly failed to load — nothing to do.
  }
}
