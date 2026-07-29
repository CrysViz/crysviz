// Bond-length histogram: one low-profile bar chart PER bond species pair
// (Y-O, Cu-O, Ba-O, ...) plus one "All Pairs" combined chart (every pair as
// its own series, legend, the old style), all living as cards in the SAME
// scrollable list — the panel body already scrolls the same way the
// Structure Info panel's bond-category list does (panelWindow.css's
// .cv-panel-body). Every card starts collapsed (just its header) so opening
// the window with many species pairs doesn't dump a wall of charts; click a
// card's ▾ to expand it, or "Collapse All"/"Expand All" for all of them at
// once. Renders through the shared Plotly helper (histogramPlotly.js).
//
// Per card: clicking a bar highlights the bonds it represents in the 3D
// viewer (click again to clear); hovering a bar lists the actual bonds in
// that bin; a compact dual-range slider under the chart lets THIS card's
// view window diverge from its own default range — a ↺ resets it. Bin width
// is the one control shared by every card. The top "Show distances" toggle,
// when on, also drops a floating Å label at each bond's midpoint
// (bondDistanceLabels.js) for whichever bar is currently selected. Every
// chart's bottom-right corner is a native resize handle (drag to make it
// taller).
//
// The window stays open across structure switches — BondsFracUpdateModule
// pushes fresh data via refreshBondLengthHistogram after every rebuildBonds.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/RightDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightBondIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { refreshBondHistogramData } from '../../render/BondsFracUpdateModule.js';
import { showBondDistanceLabels, clearBondDistanceLabels } from './bondDistanceLabels.js';
import { fileBrowser } from '../../state/store.js';

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

let data = {}; // pair -> [{ dist, instanceIds, srcIndices }, ...] — latest from BondsFracUpdateModule
let view = null; // { redraw() } while the window is open

/** True while the window is open — the producer skips its work when it is not. */
export function isBondLengthHistogramOpen() {
  return !!view;
}

export function refreshBondLengthHistogram(newData) {
  data = newData || {};
  view?.redraw();
}

function plotIdFor(key) {
  return `${PLOT_ID_PREFIX}__${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function cardIdFor(key) {
  return `blh-card__${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Short bond identity for the hover list: "Y13–O47". */
function bondLabel(srcIndices) {
  const els = fileBrowser.selectedStructure?.elements ?? [];
  const [a, b] = srcIndices;
  return `${els[a] ?? '?'}${a}–${els[b] ?? '?'}${b}`;
}

/** Every current card key, combined chart first. */
function allItemKeys() {
  return [ALL_PAIRS_KEY, ...Object.keys(data).sort()];
}

/** binWidth is fixed & shared by every card. [minVal, maxVal] is THIS card's
 *  own view window (its own dual-slider, or DEFAULT_MAX when not
 *  overridden). For a real pair this returns one series; for ALL_PAIRS_KEY it
 *  returns one series PER pair (the combined chart's legend), each binned
 *  over the same shared window. Which of the (potentially many) bins get an
 *  x-tick label is left entirely to Plotly's own automatic thinning
 *  (histogramPlotly.js's tickmode stays 'auto') — a hand-picked "nice round
 *  Å step" thinning used to run separately for compact cards and picked a
 *  different, coarser set of labels than the combined chart's own automatic
 *  choice at the same bin width, which read as the two not matching. */
function computeBins(key, binWidth, minVal, maxVal) {
  const pairs = key === ALL_PAIRS_KEY ? Object.keys(data).sort() : [key];
  const binCount = Math.max(1, Math.ceil((maxVal - minVal) / binWidth));
  const xLabels = Array.from({ length: binCount }, (_, i) => {
    const lo = minVal + i * binWidth;
    return `${lo.toFixed(2)}–${(lo + binWidth).toFixed(2)}`;
  });

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
      if (entry.srcIndices) bondLines[idx].push(`${bondLabel(entry.srcIndices)}: ${entry.dist.toFixed(3)} Å`);
    }
    const hovertext = bondLines.map((lines, i) => {
      if (!lines.length) return `${xLabels[i]}<br>0 bonds`;
      const shown = lines.slice(0, HOVER_LIST_CAP);
      const more = lines.length - shown.length;
      const list = shown.join('<br>') + (more > 0 ? `<br>+${more} more` : '');
      return `${xLabels[i]} (${lines.length} bond${lines.length === 1 ? '' : 's'})<br>${list}`;
    });
    return { label: pair, x: xLabels, y, customdata, hovertext };
  });

  return { groups };
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
 *  the window — right-dock front tab by default, or wherever the user last
 *  dragged it — creating it on first use. */
export function addBondLengthHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
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
          <button type="button" class="split-item-action-btn blh-theme-btn" title="Toggle light/dark">🌓</button>
          <button type="button" class="split-item-action-btn blh-collapseall-btn">▸ Expand All</button>
        </div>
        <div class="blh-pair-list" id="blhPairList"></div>
      `;

      const widthSlider = body.querySelector('.blh-width-slider');
      const widthLabel = body.querySelector('.blh-width-label');
      const distancesToggle = body.querySelector('.blh-distances-toggle');
      const themeBtn = body.querySelector('.blh-theme-btn');
      const collapseAllBtn = body.querySelector('.blh-collapseall-btn');
      const list = body.querySelector('#blhPairList');

      // key -> { min, max } override; absent = follow DEFAULT_MAX — same
      // lifetime as the window (reset on close/reopen, like
      // `expandedItem`/`isLight` below).
      const pairRanges = {};
      const collapsedItems = new Set(); // cards whose chart/slider/actions are hidden
      const everSeenKeys = new Set(); // every key rebuildCardsIfNeeded has ever built a card for — new ones default collapsed
      const sliderHandles = new Map(); // key -> { syncFromState, updateFill }
      const clickHandlers = new Map(); // key -> bar-click handler (created once per card)
      const itemThrottles = new Map(); // key -> throttled redrawItem, for slider drags
      let lastSignature = null;
      let isLight = false;
      let showDistances = false;
      let expandedItem = null;
      let activeSelection = null; // `${key}|${seriesName}|${pointIndex}` of the currently highlighted bar

      function effectiveRange(key) {
        return pairRanges[key] ?? { min: MIN_LENGTH, max: DEFAULT_MAX };
      }

      /** Watches one plot div's own size (the native resize-handle drag adds
       *  an inline height, independent of the body-width observer below) and
       *  tells Plotly to refit whenever it changes. */
      function watchPlotResize(plotEl, plotId) {
        let raf = 0;
        const ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => resizeHistogramPlot(plotId));
        });
        ro.observe(plotEl);
        return ro;
      }

      // One handler shape covers both a single-series pair card (its only
      // series is always named `key` itself) and the multi-series combined
      // card (`point.data.name` picks out which pair's bar was clicked) —
      // the selection key just always includes the series name too.
      function getClickHandler(key) {
        if (!clickHandlers.has(key)) {
          clickHandlers.set(key, (customdata, point) => {
            const selKey = `${key}|${point.data.name}|${point.pointIndex}`;
            if (activeSelection === selKey) {
              clearAllHighlights();
              clearBondDistanceLabels();
              activeSelection = null;
              return;
            }
            if (customdata?.length) {
              highlightBondIn3D(customdata);
              if (showDistances) showBondDistanceLabels(customdata);
              else clearBondDistanceLabels();
              activeSelection = selKey;
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
        const { groups } = computeBins(key, parseFloat(widthSlider.value), min, max);
        const isExpanded = expandedItem === key;
        const isCombined = key === ALL_PAIRS_KEY;
        renderGroupedHistogram(plotIdFor(key), {
          groups, xTitle: 'Bond length (Å)', yTitle: 'Count',
          isExpanded, compact: isCombined ? false : !isExpanded, theme: isLight ? 'light' : 'dark',
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
        if (!collapsed) redrawItem(key); // catch up if it was never rendered while collapsed
      }

      function wireRangeSlider(cardEl, key) {
        const minInput = cardEl.querySelector('.blh-range-min');
        const maxInput = cardEl.querySelector('.blh-range-max');
        const fill = cardEl.querySelector('.blh-range-fill');
        const label = cardEl.querySelector('.blh-range-label');
        const resetBtn = cardEl.querySelector('.blh-range-reset');
        const sliderEl = cardEl.querySelector('.blh-range-slider');

        function updateFill() {
          const width = sliderEl.clientWidth || 120;
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
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
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
          wireRangeSlider(cardEl, key);
          plotResizeObservers.set(key, watchPlotResize(cardEl.querySelector('.blh-pair-plot'), plotIdFor(key)));
        });
      }

      function redraw() {
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
      themeBtn.addEventListener('click', () => {
        isLight = !isLight;
        redrawAll();
      });
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
