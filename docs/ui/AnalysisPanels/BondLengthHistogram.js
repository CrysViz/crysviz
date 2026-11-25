// Bond-length histogram: one low-profile bar chart PER bond species pair
// (Y-O, Cu-O, Ba-O, ...) plus one "All Pairs" combined chart (every pair a
// segment of each bin's stacked bar, with a legend), all living as cards in the SAME
// scrollable list — the panel body already scrolls the same way the
// Structure Info panel's bond-category list does (panelWindow.css's
// .cv-panel-body). Every card starts collapsed (just its header) so opening
// the window with many species pairs doesn't dump a wall of charts; click a
// card's ▾ to expand it, or "Collapse All"/"Expand All" for all of them at
// once. Renders through the shared Plotly helper (histogramPlotly.js).
//
// Per card: clicking a bar (a pair's segment of a bin) highlights the bonds it
// represents in the 3D viewer and outlines that segment in every card showing
// it (click again to clear); hovering a bar lists the actual bonds in that
// bin, each with its standard uncertainty when the structure was read from a
// CIF with its errors (model/cifErrors.js) and "Show CIF Errors" is on —
// 1.9620(14) Å; a compact dual-range slider under the chart lets THIS card's
// view window diverge from its own default range — a ↺ resets it; its own light/dark button
// switches just that chart between light and dark (remembered per chart by
// histogramPlotly.js for the page's lifetime). Bin width is the one control
// shared by every card. The top "Show distances" toggle,
// when on, also drops a floating Å label at each bond's midpoint
// (bondDistanceLabels.js) for whichever bar is currently selected. Every
// chart's bottom-right corner is a native resize handle (drag to make it
// taller).
//
// The outline (and the distance labels) last only as long as the highlight:
// when something else clears it — a click on empty space in 3D, another
// selection — SelectAndHighlightModule's HIGHLIGHT_CLEARED drops them too.
//
// "Group by Wyckoff", enabled while the structure is in Wyckoff mode, splits
// the element pairs further by crystallographic site (wyckoffSites.js): one
// card per site pair, "Cu1 (1a) – O4 (2q)", instead of one per "Cu-O". The
// producer's data is unchanged — every entry carries its bond's two atom
// indices (srcIndices), and the regrouping happens here. Colours follow the
// element pair either way (histogramColors.js): the site pairs of Cu–O are
// shades of Cu–O's colour, and the legend groups them under "Cu-O".
//
// The window stays open across structure switches — BondsFracUpdateModule
// pushes fresh data via refreshBondLengthHistogram after every rebuildBonds.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/SideDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
  togglePlotTheme,
} from './histogramPlotly.js';
import { highlightBondIn3D, clearAllHighlights, HIGHLIGHT_CLEARED } from '../SelectAndHighlightModule.js';
import { refreshBondHistogramData } from '../../render/BondsFracUpdateModule.js';
import { showBondDistanceLabels, clearBondDistanceLabels } from './bondDistanceLabels.js';
import { fileBrowser, general, highlightHover } from '../../state/store.js';
import { formatWithSu } from '../../model/cifErrors.js';
import { wyckoffSites, hasWyckoffSites, SYMMETRY_MODE_CHANGED } from './wyckoffSites.js';
import { seriesColors } from './histogramColors.js';

const PANEL_ID = 'bondLengthHistogram';
const PLOT_ID_PREFIX = 'bondLengthHistogramPlot';
// A sentinel "pair" key for the combined chart — it rides along in the very
// same pairRanges/collapsedPairs/sliderHandles/... maps as a real pair would,
// which is what lets it reuse every bit of per-card machinery below instead
// of needing its own parallel code path. Doubles as its own display name.
const ALL_PAIRS_KEY = 'All Pairs';
const MIN_LENGTH = 0.5;
const DEFAULT_MAX = 6; // a card's un-overridden default upper bound (Å)
const ABS_MIN = 0;
const ABS_MAX = 10; // generous cap (Å) for a card's own custom range slider
const RANGE_THUMB = 12; // px — must match the CSS thumb diameter below
const HOVER_LIST_CAP = 8; // longest a bin's hover bond list gets before "+N more"

let rawData = {}; // element pair -> [{ dist, su, instanceIds, srcIndices }, ...] — latest from BondsFracUpdateModule
let data = {}; // card key -> entries: rawData itself, or regrouped by Wyckoff site pair (regroup)
let pairKeys = []; // data's keys in card order
let pairMeta = new Map(); // card key -> { family: its element pair, color }
let groupedBySite = false; // whether the last regroup split pairs by Wyckoff site
// The "Group by Wyckoff" choice. Kept for the page's lifetime, across window
// close/reopen and structure switches; it only takes effect while the current
// structure is in Wyckoff mode.
let groupByWyckoff = false;
let view = null; // { redraw() } while the window is open

/** True while the window is open — the producer skips its work when it is not. */
export function isBondLengthHistogramOpen() {
  return !!view;
}

export function refreshBondLengthHistogram(newData) {
  rawData = newData || {};
  regroup();
  view?.redraw();
}

/** Rebuilds `data`/`pairKeys`/`pairMeta` from rawData: the element pairs as
 *  they come, or — with "Group by Wyckoff" on and the structure in Wyckoff
 *  mode — one key per pair of Wyckoff sites, ordered by element pair and then
 *  like the Structure panel's Wyckoff tab (by element, then orbit number), so
 *  the site pairs of one element pair stay together. A bond whose atoms have
 *  no site falls back to its element pair. */
function regroup() {
  const sites = groupByWyckoff ? wyckoffSites(fileBrowser.selectedStructure) : null;
  const elementPairs = Object.keys(rawData).sort();
  groupedBySite = !!sites;
  const grouped = new Map(); // key -> { family, rank: [rankA, rankB], entries }
  for (const pair of elementPairs) {
    for (const entry of rawData[pair]) {
      let key = pair;
      let rank = [-1, -1];
      let [a, b] = entry.srcIndices ?? [];
      if (sites && sites.labels[a] != null && sites.labels[b] != null) {
        if (sites.ranks[a] > sites.ranks[b]
          || (sites.ranks[a] === sites.ranks[b] && sites.labels[a] > sites.labels[b])) [a, b] = [b, a];
        key = `${sites.labels[a]} – ${sites.labels[b]}`;
        rank = [sites.ranks[a], sites.ranks[b]];
      }
      if (!grouped.has(key)) grouped.set(key, { family: pair, rank, entries: [] });
      grouped.get(key).entries.push(entry);
    }
  }
  pairKeys = [...grouped.keys()].sort((k1, k2) => {
    const g1 = grouped.get(k1);
    const g2 = grouped.get(k2);
    return (elementPairs.indexOf(g1.family) - elementPairs.indexOf(g2.family))
      || (g1.rank[0] - g2.rank[0]) || (g1.rank[1] - g2.rank[1]) || (k1 < k2 ? -1 : k1 > k2 ? 1 : 0);
  });
  data = Object.fromEntries(pairKeys.map((key) => [key, grouped.get(key).entries]));
  const colors = seriesColors(pairKeys.map((key) => grouped.get(key).family), elementPairs);
  pairMeta = new Map(pairKeys.map((key, i) => [key, { family: grouped.get(key).family, color: colors[i] }]));
}

function plotIdFor(key) {
  return `${PLOT_ID_PREFIX}__${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function cardIdFor(key) {
  return `blh-card__${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** A bond's length for the hover list: with its standard uncertainty when
 *  the structure has read CIF errors and "Show CIF Errors" is on, else to
 *  three decimals as before. */
function lengthText(entry) {
  const su = general.showCifErrors !== false ? entry.su : null;
  return `${formatWithSu(entry.dist, su, 3)} Å`;
}

/** Short bond identity for the hover list: "Y 13–O 47", the atoms numbered
 *  from 1 as the selection bar and the Atoms tab rows number them (it read
 *  from 0: "Y12–O46"). */
function bondLabel(srcIndices) {
  const els = fileBrowser.selectedStructure?.elements ?? [];
  const [a, b] = srcIndices;
  return `${els[a] ?? '?'} ${a + 1}–${els[b] ?? '?'} ${b + 1}`;
}

/** Every current card key, combined chart first. */
function allItemKeys() {
  return [ALL_PAIRS_KEY, ...pairKeys];
}

/** binWidth is fixed & shared by every card. [minVal, maxVal] is THIS card's
 *  own view window (its own dual-slider, or DEFAULT_MAX when not
 *  overridden). For a real pair this returns one series; for ALL_PAIRS_KEY it
 *  returns one series PER pair (the combined chart's stack segments and
 *  legend), each binned over the same shared window. The bars sit on a
 *  numeric Å axis (x = bin centre, see histogramPlotly.js's `bins`), so every
 *  card labels the same round lengths; the "1.50–2.00" range of a bin is in
 *  its hover text. */
function computeBins(key, binWidth, minVal, maxVal) {
  const pairs = key === ALL_PAIRS_KEY ? pairKeys : [key];
  const binCount = Math.max(1, Math.ceil((maxVal - minVal) / binWidth));
  const xLabels = Array.from({ length: binCount }, (_, i) => {
    const lo = minVal + i * binWidth;
    return `${lo.toFixed(2)}–${(lo + binWidth).toFixed(2)} Å`;
  });
  const xCentres = Array.from({ length: binCount }, (_, i) => minVal + (i + 0.5) * binWidth);

  const groups = pairs.map((pair) => {
    const entries = data[pair] ?? [];
    const y = new Array(binCount).fill(0);
    const customdata = Array.from({ length: binCount }, () => []);
    const bondLines = Array.from({ length: binCount }, () => []);
    for (const entry of entries) {
      let idx = Math.floor((entry.dist - minVal) / binWidth);
      idx = Math.max(0, Math.min(binCount - 1, idx));
      y[idx] += 1;
      if (entry.instanceIds?.length) customdata[idx].push(...entry.instanceIds);
      if (entry.srcIndices) bondLines[idx].push(`${bondLabel(entry.srcIndices)}: ${lengthText(entry)}`);
    }
    // Led by the pair's name: in the combined chart the colours are the only
    // other clue to which pair a bar is, and past eight pairs they repeat.
    const hovertext = bondLines.map((lines, i) => {
      if (!lines.length) return `${pair}<br>${xLabels[i]}<br>0 bonds`;
      const shown = lines.slice(0, HOVER_LIST_CAP);
      const more = lines.length - shown.length;
      const list = shown.join('<br>') + (more > 0 ? `<br>+${more} more` : '');
      return `${pair}<br>${xLabels[i]} (${lines.length} bond${lines.length === 1 ? '' : 's'})<br>${list}`;
    });
    const meta = pairMeta.get(pair);
    return {
      label: pair, x: xCentres, y, customdata, hovertext, color: meta?.color,
      // Site pairs sit under their element pair's heading in the legend.
      ...(groupedBySite && meta ? { legendgroup: meta.family, legendgrouptitle: meta.family } : {}),
    };
  });

  return { groups, bins: { width: binWidth, min: minVal, max: minVal + binCount * binWidth } };
}

/** Throttles `fn` to at most once per `delay` ms, with a trailing call so the
 *  final value always lands — unlike a debounce, this keeps firing DURING a
 *  continuous drag instead of only once the user stops/releases, while still
 *  collapsing the flood of 'input' events a mouse drag produces (many more
 *  per second than Plotly can actually finish a re-render for) down to a
 *  rate it can keep up with, which is what a plain per-event redraw was
 *  showing up as chart flicker. */
function makeThrottled(fn, delay = 60) {
  let lastRun = 0;
  let timer = null;
  return () => {
    const now = performance.now();
    const elapsed = now - lastRun;
    if (elapsed >= delay) {
      lastRun = now;
      clearTimeout(timer);
      timer = null;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        lastRun = performance.now();
        timer = null;
        fn();
      }, delay - elapsed);
    }
  };
}

/** Pixel offset of a range input's thumb CENTER for value `v` in [lo, hi],
 *  within a track of the given (actual, current) pixel `width` — a native
 *  range thumb can never center past its own edge, so the fill track has to
 *  be inset by half the thumb width on each side (mirrors
 *  ui/BondLengthPanel.js's bondSliderThumbPos). */
function rangeThumbPos(v, lo, hi, width) {
  const inset = RANGE_THUMB / 2;
  const frac = (v - lo) / (hi - lo);
  return inset + frac * (width - 2 * inset);
}

export function removeBondLengthHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Bonds window's "Bond Length" button): opens
 *  the window — side-dock front tab by default, or wherever the user last
 *  dragged it — creating it on first use. */
export function addBondLengthHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  let onSymmetryModeChange = null;
  let onCifErrorsChange = null;
  let onHighlightCleared = null;
  const plotResizeObservers = new Map(); // key -> ResizeObserver, shared with buildContent so onClose can disconnect them

  registerPanel({
    id: PANEL_ID,
    title: 'Bond Length Histogram',
    lifecycle: 'persistent',
    infoMd: './data/bondLengthHistogramInfo.md',
    closable: true,
    onClose() {
      view = null;
      resizeObserver?.disconnect();
      if (onSymmetryModeChange) document.removeEventListener(SYMMETRY_MODE_CHANGED, onSymmetryModeChange);
      if (onCifErrorsChange) document.removeEventListener('crysviz:cif-errors-changed', onCifErrorsChange);
      if (onHighlightCleared) document.removeEventListener(HIGHLIGHT_CLEARED, onHighlightCleared);
      plotResizeObservers.forEach((ro) => ro.disconnect());
      plotResizeObservers.clear();
      clearBondDistanceLabels();
      clearHistogramPlot(plotIdFor(ALL_PAIRS_KEY));
      Object.keys(data).forEach((pair) => clearHistogramPlot(plotIdFor(pair)));
    },
    buildContent(body) {
      body.innerHTML = `
        <div class="blh-controls-row">
          <label><span class="blh-ctrl-text">Bin width</span>
            <input type="range" min="0.05" max="1" step="0.05" value="0.5" class="blh-width-slider">
            <span class="blh-width-label">0.5 Å</span>
          </label>
          <label class="eos-mini-toggle toggle_row toggle_container">
            <span class="toggle_switch">
              <input type="checkbox" class="blh-distances-toggle">
              <span class="toggle_slider"></span>
            </span>
            <span class="toggle_text">Show distances</span>
          </label>
          <label class="eos-mini-toggle toggle_row toggle_container blh-wyckoff-row">
            <span class="toggle_switch">
              <input type="checkbox" class="blh-wyckoff-toggle">
              <span class="toggle_slider"></span>
            </span>
            <span class="toggle_text">Group by Wyckoff</span>
          </label>
          <button type="button" class="split-item-action-btn blh-collapseall-btn">▸ Expand All</button>
        </div>
        <div class="blh-pair-list" id="blhPairList"></div>
      `;

      const widthSlider = body.querySelector('.blh-width-slider');
      const widthLabel = body.querySelector('.blh-width-label');
      const distancesToggle = body.querySelector('.blh-distances-toggle');
      const wyckoffRow = body.querySelector('.blh-wyckoff-row');
      const wyckoffToggle = /** @type {HTMLInputElement} */ (body.querySelector('.blh-wyckoff-toggle'));
      const collapseAllBtn = body.querySelector('.blh-collapseall-btn');
      const list = body.querySelector('#blhPairList');

      // key -> { min, max } override; absent = follow DEFAULT_MAX — same
      // lifetime as the window (reset on close/reopen, like
      // `expandedItem` below).
      const pairRanges = {};
      const collapsedItems = new Set(); // cards whose chart/slider/actions are hidden
      const everSeenKeys = new Set(); // every key rebuildCardsIfNeeded has ever built a card for — new ones default collapsed
      const sliderHandles = new Map(); // key -> { syncFromState, updateFill }
      const clickHandlers = new Map(); // key -> bar-click handler (created once per card)
      const itemThrottles = new Map(); // key -> throttled redrawItem, for slider drags
      let lastSignature = null;
      let showDistances = false;
      let expandedItem = null;
      // The highlighted bar: its series (pair) and its bin's lower edge — not a
      // bar index, since each card bins over its own range — plus the bond
      // instance ids, to rewrite the distance labels when the CIF errors are
      // switched on or off.
      let activeSelection = null; // { label, lo }
      let activeIds = null;
      // True while this window itself changes the highlight: highlightBondIn3D
      // clears the old one first, which must not read as "someone else
      // cleared ours".
      let ownHighlight = false;

      function clearSelection() {
        activeSelection = null;
        activeIds = null;
        clearAllHighlights();
        clearBondDistanceLabels();
      }

      /** The bar to outline in a card binning from `min` in `binCount` bins,
       *  if the highlighted bar is one of its bars. */
      function selectedBarFor(key, min, binWidth, binCount) {
        if (!activeSelection) return undefined;
        const labels = key === ALL_PAIRS_KEY ? pairKeys : [key];
        if (!labels.includes(activeSelection.label)) return undefined;
        const index = Math.round((activeSelection.lo - min) / binWidth);
        if (index < 0 || index >= binCount || Math.abs(min + index * binWidth - activeSelection.lo) > 1e-6) return undefined;
        return { label: activeSelection.label, index };
      }

      function effectiveRange(key) {
        return pairRanges[key] ?? { min: MIN_LENGTH, max: DEFAULT_MAX };
      }

      /** Watches one card's plot div and range slider for their own size
       *  changes — the native resize-handle drag (an inline height on the
       *  plot div), the card un-collapsing (display:none -> laid out), the
       *  fullscreen expand — and refits Plotly / repaints the slider's fill.
       *  The body-width observer below cannot see any of these: none of them
       *  changes the body's width. The fill used to be painted once at wire
       *  time, while every card was still collapsed and the slider measured
       *  0 px wide, so it kept a made-up 120 px geometry (too short) until
       *  something happened to resize the whole window. */
      function watchCardResize(cardEl, key) {
        let raf = 0;
        const ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            resizeHistogramPlot(plotIdFor(key));
            sliderHandles.get(key)?.updateFill();
          });
        });
        ro.observe(cardEl.querySelector('.blh-pair-plot'));
        ro.observe(cardEl.querySelector('.blh-range-slider'));
        return ro;
      }

      // One handler shape covers both a single-series pair card (its only
      // series is always named `key` itself) and the multi-series combined
      // card (`point.data.name` picks out which pair's segment was clicked).
      // A bar is identified by pair + bin edge, so clicking the same bar in
      // the combined chart and in its pair's own card toggles the same
      // highlight, and both cards outline it.
      function getClickHandler(key) {
        if (!clickHandlers.has(key)) {
          clickHandlers.set(key, (customdata, point) => {
            const label = point.data.name;
            const lo = effectiveRange(key).min + point.pointIndex * parseFloat(widthSlider.value);
            if (activeSelection?.label === label && Math.abs(activeSelection.lo - lo) < 1e-6) {
              clearSelection();
              redrawAll();
              return;
            }
            if (customdata?.length) {
              ownHighlight = true;
              try {
                highlightBondIn3D(customdata);
              } finally {
                ownHighlight = false;
              }
              if (showDistances) showBondDistanceLabels(customdata);
              else clearBondDistanceLabels();
              activeSelection = { label, lo };
              activeIds = customdata;
              redrawAll();
            }
          });
        }
        return clickHandlers.get(key);
      }

      /** compact styling (no boundary dividers) suits a single-series
       *  low-profile card; the combined card has multiple series and earns
       *  back the dividers/legend regardless of whether it's
       *  collapsed/expanded — axis titles and tick thinning are otherwise
       *  identical between the two. */
      function redrawItem(key) {
        if (collapsedItems.has(key)) return; // hidden — redraw when it's expanded again instead
        const { min, max } = effectiveRange(key);
        const binWidth = parseFloat(widthSlider.value);
        const { groups, bins } = computeBins(key, binWidth, min, max);
        const isExpanded = expandedItem === key;
        const isCombined = key === ALL_PAIRS_KEY;
        renderGroupedHistogram(plotIdFor(key), {
          groups, bins, xTitle: 'Bond length (Å)', yTitle: 'Count',
          selected: selectedBarFor(key, min, binWidth, groups[0]?.y.length ?? 0),
          isExpanded, compact: isCombined ? false : !isExpanded,
        }).then(() => onHistogramBarClick(plotIdFor(key), getClickHandler(key)));
      }

      function redrawAll() {
        allItemKeys().forEach(redrawItem);
      }

      function getThrottledItem(key) {
        if (!itemThrottles.has(key)) itemThrottles.set(key, makeThrottled(() => redrawItem(key)));
        return itemThrottles.get(key);
      }

      /** Live slider feedback: throttled (not debounced) so a continuous drag
       *  keeps updating the chart every ~60ms instead of only once the user
       *  releases, while still collapsing the 'input' flood down to a rate
       *  Plotly can keep up with (see makeThrottled). */
      function scheduleRedrawAll() {
        allItemKeys().forEach((key) => getThrottledItem(key)());
      }

      function setItemCollapsed(key, collapsed) {
        const card = list.querySelector(`#${cardIdFor(key)}`);
        const toggleBtn = card?.querySelector('.blh-collapse-toggle');
        if (collapsed) collapsedItems.add(key);
        else collapsedItems.delete(key);
        card?.classList.toggle('collapsed', collapsed);
        if (toggleBtn) toggleBtn.textContent = collapsed ? '▸' : '▾';
        if (!collapsed) {
          redrawItem(key); // catch up if it was never rendered while collapsed
          sliderHandles.get(key)?.updateFill();
        }
      }

      function wireRangeSlider(cardEl, key) {
        const minInput = cardEl.querySelector('.blh-range-min');
        const maxInput = cardEl.querySelector('.blh-range-max');
        const fill = cardEl.querySelector('.blh-range-fill');
        const label = cardEl.querySelector('.blh-range-label');
        const resetBtn = cardEl.querySelector('.blh-range-reset');
        const sliderEl = cardEl.querySelector('.blh-range-slider');

        function updateFill() {
          // Not laid out yet (collapsed card, hidden tab): leave the fill for
          // the card's ResizeObserver, which fires the moment it has a width.
          const width = sliderEl.clientWidth;
          if (!width) return;
          const minPx = rangeThumbPos(parseFloat(minInput.value), ABS_MIN, ABS_MAX, width);
          const maxPx = rangeThumbPos(parseFloat(maxInput.value), ABS_MIN, ABS_MAX, width);
          fill.style.left = `${minPx}px`;
          fill.style.width = `${Math.max(0, maxPx - minPx)}px`;
        }

        function syncFromState() {
          const { min, max } = effectiveRange(key);
          minInput.value = String(min);
          maxInput.value = String(max);
          label.textContent = `${min.toFixed(2)}–${max.toFixed(2)} Å`;
          resetBtn.disabled = !pairRanges[key];
          updateFill();
        }

        minInput.addEventListener('input', () => {
          const v = Math.min(parseFloat(minInput.value), parseFloat(maxInput.value) - 0.05);
          minInput.value = String(v);
          pairRanges[key] = { min: v, max: parseFloat(maxInput.value) };
          syncFromState();
          getThrottledItem(key)();
        });
        maxInput.addEventListener('input', () => {
          const v = Math.max(parseFloat(maxInput.value), parseFloat(minInput.value) + 0.05);
          maxInput.value = String(v);
          pairRanges[key] = { min: parseFloat(minInput.value), max: v };
          syncFromState();
          getThrottledItem(key)();
        });
        resetBtn.addEventListener('click', () => {
          delete pairRanges[key];
          syncFromState();
          redrawItem(key);
        });

        syncFromState();
        sliderHandles.set(key, { syncFromState, updateFill });
      }

      function cardHTML(key) {
        const isCombined = key === ALL_PAIRS_KEY;
        const count = isCombined
          ? Object.values(data).reduce((sum, entries) => sum + entries.length, 0)
          : (data[key]?.length ?? 0);
        const collapsed = collapsedItems.has(key);
        const plotClass = `split-item-body blh-pair-plot${isCombined ? ' blh-combined-item' : ''}`;
        return `
          <div class="split-item blh-pair-card${collapsed ? ' collapsed' : ''}" id="${cardIdFor(key)}" data-pair="${key}">
            <h4>
              <button type="button" class="blh-collapse-toggle" data-split-action="toggle-collapse" title="Collapse/expand">${collapsed ? '▸' : '▾'}</button>
              ${isCombined ? '' : '<span class="blh-pair-swatch"></span>'}
              <span class="blh-pair-name">${key}</span>
              <span class="blh-pair-count">${count} bond${count === 1 ? '' : 's'}</span>
            </h4>
            <div id="${plotIdFor(key)}" class="${plotClass}"></div>
            <div class="blh-range-row">
              <div class="blh-range-slider">
                <div class="blh-range-bg"></div>
                <div class="blh-range-fill"></div>
                <input type="range" min="${ABS_MIN}" max="${ABS_MAX}" step="0.05" class="blh-range-min">
                <input type="range" min="${ABS_MIN}" max="${ABS_MAX}" step="0.05" class="blh-range-max">
              </div>
              <span class="blh-range-label"></span>
              <button type="button" class="blh-range-reset" title="Reset to default range">↺</button>
            </div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions blh-pair-actions">
              <button type="button" class="split-item-action-btn" data-split-action="theme" title="Toggle light/dark for this chart"></button>
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG"></button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand"></button>
            </div>
          </div>
        `;
      }

      /** Rebuilds the card DOM only when the SET of keys changed (structure
       *  switch / bond rebuild with different composition, ALL_PAIRS_KEY is
       *  always present) — everyday redraws (bin width, slider drags,
       *  theme, ...) just re-render each existing chart via Plotly.react,
       *  which is far cheaper and keeps click/slider listeners (and their
       *  per-card state) alive. Any key seen for the first time starts
       *  collapsed — opening the window (or a structure switch adding a new
       *  species pair) shouldn't dump a wall of expanded charts. */
      function rebuildCardsIfNeeded(keys) {
        const signature = keys.join('|');
        if (signature === lastSignature) return;
        lastSignature = signature;

        const keySet = new Set(keys);
        const trackedKeys = new Set([
          ...clickHandlers.keys(), ...sliderHandles.keys(), ...collapsedItems, ...Object.keys(pairRanges),
          ...itemThrottles.keys(), ...everSeenKeys,
        ]);
        for (const key of trackedKeys) {
          if (!keySet.has(key)) {
            clickHandlers.delete(key);
            sliderHandles.delete(key);
            delete pairRanges[key];
            collapsedItems.delete(key);
            itemThrottles.delete(key);
            everSeenKeys.delete(key);
          }
        }
        if (expandedItem && !keySet.has(expandedItem)) expandedItem = null;

        keys.forEach((key) => {
          if (!everSeenKeys.has(key)) {
            everSeenKeys.add(key);
            collapsedItems.add(key); // minimized by default
          }
        });

        // Every plot div is a brand new DOM node after this — any previous
        // per-card resize observer is now watching a detached element.
        plotResizeObservers.forEach((ro) => ro.disconnect());
        plotResizeObservers.clear();

        list.innerHTML = keys.map(cardHTML).join('');
        keys.forEach((key) => {
          const cardEl = list.querySelector(`#${cardIdFor(key)}`);
          // The pair's own chart colour (data-driven, so set here rather than
          // in the stylesheet).
          const swatch = /** @type {HTMLElement|null} */ (cardEl.querySelector('.blh-pair-swatch'));
          if (swatch) swatch.style.background = pairMeta.get(key)?.color ?? '';
          wireRangeSlider(cardEl, key);
          plotResizeObservers.set(key, watchCardResize(cardEl, key));
        });
      }

      /** The toggle is live only while the structure is in Wyckoff mode;
       *  outside it, it shows off (the remembered choice comes back with the
       *  mode) and its tooltip says why it is greyed out. */
      function syncWyckoffToggle() {
        const available = hasWyckoffSites(fileBrowser.selectedStructure);
        wyckoffToggle.disabled = !available;
        wyckoffToggle.checked = available && groupByWyckoff;
        wyckoffRow.classList.toggle('is-disabled', !available);
        wyckoffRow.title = available
          ? 'One chart per pair of Wyckoff sites (element + orbit) instead of per element pair'
          : 'Activate Wyckoff mode to use this feature (Symmetry window → Enable Wyckoff Editor)';
      }

      function redraw() {
        syncWyckoffToggle();
        // A pair that is gone (new structure, other grouping) takes its
        // outline with it.
        if (activeSelection && !pairKeys.includes(activeSelection.label)) {
          activeSelection = null;
          activeIds = null;
        }
        rebuildCardsIfNeeded(allItemKeys());
        redrawAll();
      }

      widthSlider.addEventListener('input', () => {
        widthLabel.textContent = `${widthSlider.value} Å`;
        scheduleRedrawAll();
      });
      // Purely forward-looking: it only affects what a FUTURE bar click does
      // (see getClickHandler). It must never itself conjure labels for
      // whatever was selected before — the prior selection can go stale
      // (e.g. the 3D highlight was cleared by something outside this panel)
      // with no way for this closure to know, so treating "toggle on" as
      // "re-show the last selection" was exactly what showed distances with
      // nothing currently selected.
      distancesToggle.addEventListener('change', () => {
        showDistances = distancesToggle.checked;
        if (!showDistances) clearBondDistanceLabels();
      });
      wyckoffToggle.addEventListener('change', () => {
        groupByWyckoff = wyckoffToggle.checked;
        // The highlighted bar belonged to a card that may no longer exist.
        clearSelection();
        regroup();
        redraw();
      });
      // "Show CIF Errors" flipped, or a CIF's errors were just read: recompute
      // the bonds' s.u.s (the producer only works them out while errors are
      // read) and rewrite the open distance labels.
      onCifErrorsChange = () => {
        refreshBondHistogramData();
        if (showDistances && activeIds) showBondDistanceLabels(activeIds);
      };
      document.addEventListener('crysviz:cif-errors-changed', onCifErrorsChange);
      // Our bonds are no longer the ones lit: drop the outline and labels.
      onHighlightCleared = () => {
        if (ownHighlight || !activeIds) return;
        const lit = highlightHover.currentlyHighlightedBondInstances ?? [];
        if (lit.length === activeIds.length && lit.every((id, i) => id === activeIds[i])) return;
        activeSelection = null;
        activeIds = null;
        clearBondDistanceLabels();
        redrawAll();
      };
      document.addEventListener(HIGHLIGHT_CLEARED, onHighlightCleared);
      // Wyckoff mode switched on/off with the window open: the bonds are the
      // same, only their grouping (and whether the toggle applies) changes.
      onSymmetryModeChange = () => {
        regroup();
        redraw();
      };
      document.addEventListener(SYMMETRY_MODE_CHANGED, onSymmetryModeChange);
      collapseAllBtn.addEventListener('click', () => {
        const keys = allItemKeys();
        const shouldCollapse = collapsedItems.size < keys.length;
        keys.forEach((key) => setItemCollapsed(key, shouldCollapse));
        collapseAllBtn.textContent = shouldCollapse ? '▸ Expand All' : '▾ Collapse All';
      });

      list.addEventListener('click', (ev) => {
        const btn = /** @type {HTMLElement|null} */ (
          /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
        if (!btn) return;
        const card = btn.closest('.blh-pair-card');
        const key = card?.dataset.pair;
        const action = btn.dataset.splitAction;
        if (action === 'export') {
          exportHistogramPNG(plotIdFor(key)).catch((error) => console.error('Bond length histogram export failed:', error));
        } else if (action === 'expand') {
          expandSplitItem(card);
          expandedItem = key;
          redrawItem(key);
        } else if (action === 'close') {
          closeExpandedSplitItem();
          expandedItem = null;
          redrawItem(key);
        } else if (action === 'toggle-collapse') {
          setItemCollapsed(key, !collapsedItems.has(key));
        } else if (action === 'theme') {
          togglePlotTheme(plotIdFor(key));
          redrawItem(key);
        }
      });

      let lastWidth = body.clientWidth;
      resizeObserver = new ResizeObserver(() => {
        if (body.clientWidth === lastWidth || !body.clientWidth) return;
        lastWidth = body.clientWidth;
        allItemKeys().forEach((key) => {
          resizeHistogramPlot(plotIdFor(key));
          sliderHandles.get(key)?.updateFill();
        });
      });
      resizeObserver.observe(body);

      view = { redraw };
      // The producer skips computing histogram data while every window is
      // closed, so this window has to ask for it on the way in.
      refreshBondHistogramData();
      redraw();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 20 },
    },
  });
  openPanel(PANEL_ID);
}
