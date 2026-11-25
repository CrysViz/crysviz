// Force histogram: grouped bar chart (one series per element) of the current
// structure's |F| distribution, plus a min/mean/max/RMS readout, in ONE
// ordinary panel window that defaults to the side dock — mirrors
// BondLengthHistogram.js / CoordinationHistogram.js. Clicking a bar
// highlights the atoms in that (element, |F|-range) cell in the 3D viewer
// (click again to clear).
//
// Data flows in via refreshForceHistogram(), pushed from
// render/ForceModule.js's updateForces() after every force (re)render (the
// same "push after the thing that owns the data changes" idiom
// BondsFracUpdateModule.js uses for the bond histograms) and also called
// directly on open/reopen so the panel is never stale the moment it's shown.
// recompute() is a no-op cost-wise unless the panel is actually open.
//
// "Group by Wyckoff", enabled while the structure is in Wyckoff mode, makes
// one series per Wyckoff site (wyckoffSites.js: "O2 (2q)") instead of one per
// element. Each bin is one stacked bar, a segment per series; colours follow
// the element either way (histogramColors.js), the sites of one element in
// shades of its colour, grouped under it in the legend.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/SideDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
  togglePlotTheme,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, clearAllHighlights, HIGHLIGHT_CLEARED } from '../SelectAndHighlightModule.js';
import { fileBrowser, highlightHover } from '../../state/store.js';
import { wyckoffSites, hasWyckoffSites, SYMMETRY_MODE_CHANGED } from './wyckoffSites.js';
import { seriesColors } from './histogramColors.js';

const PANEL_ID = 'forceHistogram';
const PLOT_ID = 'forceHistogramPlot';

/** @type {{ element: string, mag: number, index: number }[]} */
let data = [];
/** @type {{ n: number, min: number, max: number, mean: number, rms: number, maxIndex: number, maxElement: string } | null} */
let stats = null;
let dataStructure = null; // the structure `data` was computed from — its Wyckoff sites name the series
// The "Group by Wyckoff" choice, kept for the page's lifetime; it only takes
// effect while the structure is in Wyckoff mode.
let groupByWyckoff = false;
// The highlighted bar: its series and its bin's lower edge (eV/Å), so it can
// still be outlined after the bin width changes, if a bin still starts there.
let selectedBar = null; // { label, lo }
// The atom instances that bar lit, to tell when something else has cleared
// them (HIGHLIGHT_CLEARED), and whether this window is changing the highlight
// itself right now (highlightAtomsIn3D clears the old one first).
let selectedInstances = null;
let ownHighlight = false;
let view = null; // { redraw() } while the window is open

/** Cheap O(N) pass: |F| per atom + summary stats. */
function recompute(structure) {
  const forces = structure?.forces;
  const elements = structure?.elements ?? [];
  data = [];
  stats = null;
  if ((structure ?? null) !== dataStructure) { selectedBar = null; selectedInstances = null; } // another structure: its bar is gone
  dataStructure = structure ?? null;
  if (!forces?.length) return;

  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, maxIndex = -1;
  for (let i = 0; i < forces.length; i++) {
    const v = forces[i]?.vector;
    if (!v) continue;
    const mag = Math.hypot(v[0], v[1], v[2]) * (forces[i].scaling ?? 1.0);
    data.push({ element: elements[i] ?? '?', mag, index: i });
    if (mag < min) min = mag;
    if (mag > max) { max = mag; maxIndex = i; }
    sum += mag;
    sumSq += mag * mag;
  }
  const n = data.length;
  if (!n) return;
  stats = {
    n,
    min,
    max,
    mean: sum / n,
    rms: Math.sqrt(sumSq / n),
    maxIndex,
    maxElement: elements[maxIndex] ?? '?',
  };
}

/** Called by render/ForceModule.js's updateForces() after every force
 *  (re)render, and by addForceHistogramPanel() on open/reopen. No-op while
 *  the panel is closed — nothing to redraw, so nothing is computed. */
export function refreshForceHistogram(structure = fileBrowser.selectedStructure) {
  if (!view) return;
  recompute(structure);
  view.redraw();
}

/** Statistics of the last recompute (null when no forces / nothing open). */
export function getForceStats() {
  return stats;
}

/** Whether the series are Wyckoff sites right now: the toggle is on and the
 *  structure is in Wyckoff mode. */
function groupsByWyckoff() {
  return groupByWyckoff && hasWyckoffSites(dataStructure);
}

/** binWidth is fixed (user-chosen) — the bin COUNT adapts to it and to the
 *  chosen max-|F| bound, instead of the other way around (mirrors
 *  BondLengthHistogram.js's computeBins). One series per element in order of
 *  first appearance, or per Wyckoff site, ordered by element and then as the
 *  Wyckoff tab lists them. Bars sit on a numeric |F| axis (x = bin centre); a
 *  bin's range is in its hover. */
function computeBins(binWidth, maxVal) {
  const minVal = 0;
  const binCount = Math.max(1, Math.ceil(Math.max(maxVal - minVal, 1e-6) / binWidth));
  const xLabels = Array.from({ length: binCount }, (_, i) => {
    const lo = minVal + i * binWidth;
    return `${lo.toPrecision(3)}–${(lo + binWidth).toPrecision(3)} eV/Å`;
  });
  const xCentres = Array.from({ length: binCount }, (_, i) => minVal + (i + 0.5) * binWidth);
  const sites = groupsByWyckoff() ? wyckoffSites(dataStructure) : null;
  const elementOrder = [...new Set(data.map((d) => d.element))];

  const bySeries = new Map(); // label -> { element, rank, y, customdata }
  for (const { element, mag, index } of data) {
    const label = sites?.labels[index] ?? element;
    if (!bySeries.has(label)) {
      bySeries.set(label, {
        element,
        rank: sites?.ranks[index] ?? 0,
        y: new Array(binCount).fill(0),
        customdata: Array.from({ length: binCount }, () => []),
      });
    }
    const series = bySeries.get(label);
    let idx = Math.floor((mag - minVal) / binWidth);
    idx = Math.max(0, Math.min(binCount - 1, idx));
    series.y[idx] += 1;
    series.customdata[idx].push(index);
  }

  const ordered = [...bySeries.entries()].sort(([, a], [, b]) =>
    (elementOrder.indexOf(a.element) - elementOrder.indexOf(b.element)) || (a.rank - b.rank));
  const colors = seriesColors(ordered.map(([, s]) => s.element), elementOrder);
  const groups = ordered.map(([label, s], i) => ({
    label,
    x: xCentres,
    y: s.y,
    customdata: s.customdata,
    color: colors[i],
    ...(sites ? { legendgroup: s.element, legendgrouptitle: s.element } : {}),
    hovertext: s.y.map((n, k) => `${label}<br>${xLabels[k]}<br>${n} atom${n === 1 ? '' : 's'}`),
  }));
  return { groups, bins: { width: binWidth, min: minVal, max: minVal + binCount * binWidth } };
}

/** The bar to outline at the current bin width, if a bin still starts at the
 *  highlighted bar's lower edge. */
function selectedBarAt(binWidth, groups) {
  if (!selectedBar || !groups.some((g) => g.label === selectedBar.label)) return undefined;
  const index = Math.round(selectedBar.lo / binWidth);
  const binCount = groups[0]?.y.length ?? 0;
  if (index >= binCount || Math.abs(index * binWidth - selectedBar.lo) > 1e-9) return undefined;
  return { label: selectedBar.label, index };
}

/** Bar-click handler: toggles the 3D highlight for the clicked (element or
 *  site, |F|-bin) segment's atoms, and redraws so the segment is outlined. */
function makeClickHandler(getBinWidth, redraw) {
  return (customdata, point) => {
    const label = point.data.name;
    const lo = point.pointIndex * getBinWidth();
    if (selectedBar?.label === label && Math.abs(selectedBar.lo - lo) < 1e-9) {
      selectedBar = null;
      selectedInstances = null;
      clearAllHighlights();
      redraw();
      return;
    }
    if (customdata?.length) {
      ownHighlight = true;
      try {
        highlightAtomsIn3D(customdata);
      } finally {
        ownHighlight = false;
      }
      selectedBar = { label, lo };
      selectedInstances = [...(highlightHover.currentlyHighlightedAtomInstances ?? [])];
      redraw();
    }
  };
}

/** The strongest-force atom's element, or its Wyckoff site while grouping by site. */
function maxAtomName() {
  const site = groupsByWyckoff() ? wyckoffSites(dataStructure)?.labels[stats.maxIndex] : null;
  return site ?? stats.maxElement;
}

function statsHTML() {
  if (!stats) return '<span class="fh-stats-muted">No forces on this structure.</span>';
  const f = (v) => (v >= 0.01 ? v.toFixed(3) : v.toExponential(2));
  return `
    <span><b>N</b> ${stats.n}</span>
    <span><b>min</b> ${f(stats.min)}</span>
    <span><b>mean</b> ${f(stats.mean)}</span>
    <span><b>RMS</b> ${f(stats.rms)}</span>
    <span><b>max</b> ${f(stats.max)} <span class="fh-stats-muted">(${maxAtomName()} #${stats.maxIndex + 1})</span></span>
    <span class="fh-stats-muted">eV/Å</span>
  `;
}

/** Control-row builder (fixed bin width + max |F| sliders and the "Group by
 *  Wyckoff" toggle), same idiom as BondLengthHistogram's controls row, plus a
 *  stats readout underneath. */
function buildControls(container, { binWidth, maxVal, onChange }) {
  container.innerHTML = `
    <div class="fh-controls-row">
      <label class="eos-mini-toggle toggle_row toggle_container fh-wyckoff-row">
        <span class="toggle_switch">
          <input type="checkbox" class="fh-wyckoff-toggle">
          <span class="toggle_slider"></span>
        </span>
        <span class="toggle_text">Group by Wyckoff</span>
      </label>
      <label>Bin width (eV/Å)
        <input type="range" min="0.02" max="1" step="0.02" value="${binWidth}" class="fh-width-slider">
        <span class="fh-width-label">${binWidth}</span>
      </label>
      <label>Max |F| (eV/Å)
        <input type="range" min="0.5" max="20" step="0.5" value="${maxVal}" class="fh-max-slider">
        <span class="fh-max-label">${maxVal}</span>
      </label>
    </div>
    <div class="fh-stats">${statsHTML()}</div>
  `;
  const widthSlider = container.querySelector('.fh-width-slider');
  const widthLabel = container.querySelector('.fh-width-label');
  const maxSlider = container.querySelector('.fh-max-slider');
  const maxLabel = container.querySelector('.fh-max-label');
  const statsEl = container.querySelector('.fh-stats');
  const wyckoffRow = container.querySelector('.fh-wyckoff-row');
  const wyckoffToggle = /** @type {HTMLInputElement} */ (container.querySelector('.fh-wyckoff-toggle'));
  wyckoffToggle.addEventListener('change', () => {
    groupByWyckoff = wyckoffToggle.checked;
    selectedBar = null; // the highlighted bar's series may be gone
    selectedInstances = null;
    clearAllHighlights();
    onChange();
  });
  widthSlider.addEventListener('input', () => {
    widthLabel.textContent = widthSlider.value;
    onChange();
  });
  maxSlider.addEventListener('input', () => {
    maxLabel.textContent = maxSlider.value;
    onChange();
  });
  return {
    get binWidth() { return parseFloat(widthSlider.value); },
    get maxVal() { return parseFloat(maxSlider.value); },
    syncStats() { statsEl.innerHTML = statsHTML(); },
    /** Live only while the structure is in Wyckoff mode; outside it the
     *  toggle shows off and says why it is greyed out. */
    syncWyckoff() {
      const available = hasWyckoffSites(dataStructure);
      wyckoffToggle.disabled = !available;
      wyckoffToggle.checked = available && groupByWyckoff;
      wyckoffRow.classList.toggle('is-disabled', !available);
      wyckoffRow.title = available
        ? 'One series per Wyckoff site (element + orbit) instead of per element'
        : 'Activate Wyckoff mode to use this feature (Symmetry window → Enable Wyckoff Editor)';
    },
  };
}

const DEFAULT_BIN_WIDTH = 0.1;
const DEFAULT_MAX = 2;

export function removeForceHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Forces window's "Force Histogram" button):
 *  opens the window — side-dock front tab by default, or wherever the user
 *  last dragged it — creating it on first use. */
export function addForceHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    refreshForceHistogram();
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  let onSymmetryModeChange = null;
  let onHighlightCleared = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Force Histogram',
    lifecycle: 'persistent',
    infoMd: './data/forceHistogramInfo.md',
    closable: true,
    onClose() {
      view = null;
      resizeObserver?.disconnect();
      if (onSymmetryModeChange) {
        document.removeEventListener(SYMMETRY_MODE_CHANGED, onSymmetryModeChange);
        document.removeEventListener('crysviz:atoms-changed', onSymmetryModeChange);
      }
      if (onHighlightCleared) document.removeEventListener(HIGHLIGHT_CLEARED, onHighlightCleared);
      clearHistogramPlot(PLOT_ID);
    },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="force-histogram-item">
            <h4>Force Histogram</h4>
            <div id="fhControls"></div>
            <div id="${PLOT_ID}" class="split-item-body"></div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions">
              <button type="button" class="split-item-action-btn" data-split-action="theme" title="Toggle light/dark"></button>
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG"></button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand"></button>
            </div>
          </div>
        </div>
      `;

      // Bin the data before the controls are built: the max-|F| slider's
      // initial value is fitted to it.
      recompute(fileBrowser.selectedStructure);
      const initialMax = stats ? Math.max(0.5, Math.ceil(stats.max * 1.05 * 2) / 2) : DEFAULT_MAX;
      const controls = buildControls(body.querySelector('#fhControls'), {
        binWidth: DEFAULT_BIN_WIDTH, maxVal: initialMax, onChange: () => redraw(),
      });
      let expanded = false;
      const onBarClick = makeClickHandler(() => controls.binWidth, () => redraw());

      function redraw() {
        controls.syncStats();
        controls.syncWyckoff();
        const { groups, bins } = computeBins(controls.binWidth, controls.maxVal);
        renderGroupedHistogram(PLOT_ID, {
          groups, bins, xTitle: '|F| (eV/Å)', yTitle: 'Atoms', isExpanded: expanded,
          selected: selectedBarAt(controls.binWidth, groups),
        }).then(() => onHistogramBarClick(PLOT_ID, onBarClick));
      }

      // Wyckoff mode switched on/off, or orbits/atoms edited (which can drop
      // the lock), with the window open: the series may be named differently.
      onSymmetryModeChange = () => refreshForceHistogram();
      document.addEventListener(SYMMETRY_MODE_CHANGED, onSymmetryModeChange);
      document.addEventListener('crysviz:atoms-changed', onSymmetryModeChange);
      // Our atoms are no longer the ones lit (a click on empty space in 3D,
      // another selection): drop the outline.
      onHighlightCleared = () => {
        if (ownHighlight || !selectedInstances) return;
        const lit = highlightHover.currentlyHighlightedAtomInstances ?? [];
        if (lit.length === selectedInstances.length && lit.every((id, i) => id === selectedInstances[i])) return;
        selectedBar = null;
        selectedInstances = null;
        redraw();
      };
      document.addEventListener(HIGHLIGHT_CLEARED, onHighlightCleared);

      body.addEventListener('click', (ev) => {
        const btn = /** @type {HTMLElement|null} */ (
          /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
        if (!btn) return;
        const action = btn.dataset.splitAction;
        if (action === 'theme') {
          togglePlotTheme(PLOT_ID);
          redraw();
        } else if (action === 'export') {
          exportHistogramPNG(PLOT_ID).catch((error) => console.error('Force histogram export failed:', error));
        } else if (action === 'expand') {
          expandSplitItem(btn.closest('.split-item'));
          expanded = true;
          redraw();
        } else if (action === 'close') {
          closeExpandedSplitItem();
          expanded = false;
          redraw();
        }
      });

      let lastWidth = body.clientWidth;
      resizeObserver = new ResizeObserver(() => {
        if (body.clientWidth === lastWidth || !body.clientWidth) return;
        lastWidth = body.clientWidth;
        resizeHistogramPlot(PLOT_ID);
      });
      resizeObserver.observe(body);

      view = { redraw };
      redraw();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 20 },
    },
  });
  openPanel(PANEL_ID);
}
