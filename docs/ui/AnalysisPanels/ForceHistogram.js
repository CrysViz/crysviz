// Force histogram: grouped bar chart (one series per element) of the current
// structure's |F| distribution, plus a min/mean/max/RMS readout, in ONE
// ordinary panel window that defaults to the right dock — mirrors
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

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/RightDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { fileBrowser } from '../../state/store.js';

const PANEL_ID = 'forceHistogram';
const PLOT_ID = 'forceHistogramPlot';

/** @type {{ element: string, mag: number, index: number }[]} */
let data = [];
/** @type {{ n: number, min: number, max: number, mean: number, rms: number, maxIndex: number, maxElement: string } | null} */
let stats = null;
let view = null; // { redraw() } while the window is open

/** Cheap O(N) pass: |F| per atom + summary stats. */
function recompute(structure) {
  const forces = structure?.forces;
  const elements = structure?.elements ?? [];
  data = [];
  stats = null;
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

function computeBins(binCount, maxVal) {
  const minVal = 0;
  const span = Math.max(maxVal - minVal, 1e-6);
  const binWidth = span / binCount;
  const xLabels = Array.from({ length: binCount }, (_, i) => (minVal + i * binWidth).toPrecision(3));

  const byElement = new Map();
  for (const { element, mag, index } of data) {
    if (!byElement.has(element)) {
      byElement.set(element, {
        y: new Array(binCount).fill(0),
        customdata: Array.from({ length: binCount }, () => []),
      });
    }
    const series = byElement.get(element);
    let idx = Math.floor((mag - minVal) / binWidth);
    idx = Math.max(0, Math.min(binCount - 1, idx));
    series.y[idx] += 1;
    series.customdata[idx].push(index);
  }

  const groups = [...byElement.entries()].map(([label, s]) => ({
    label, x: xLabels, y: s.y, customdata: s.customdata,
  }));
  return { groups };
}

/** Bar-click handler: toggles the 3D highlight for the clicked (element,
 *  |F|-bin) cell's atoms. */
function makeClickHandler() {
  let lastKey = null;
  return (customdata, point) => {
    const key = `${point.data.name}|${point.pointIndex}`;
    if (key === lastKey) {
      clearAllHighlights();
      lastKey = null;
      return;
    }
    if (customdata?.length) {
      highlightAtomsIn3D(customdata);
      lastKey = key;
    }
  };
}

function statsHTML() {
  if (!stats) return '<span class="fh-stats-muted">No forces on this structure.</span>';
  const f = (v) => (v >= 0.01 ? v.toFixed(3) : v.toExponential(2));
  return `
    <span><b>N</b> ${stats.n}</span>
    <span><b>min</b> ${f(stats.min)}</span>
    <span><b>mean</b> ${f(stats.mean)}</span>
    <span><b>RMS</b> ${f(stats.rms)}</span>
    <span><b>max</b> ${f(stats.max)} <span class="fh-stats-muted">(${stats.maxElement} #${stats.maxIndex})</span></span>
    <span class="fh-stats-muted">eV/Å</span>
  `;
}

/** Control-row builder (bin count + max |F| sliders), same idiom as
 *  BondLengthHistogram's buildControls, plus a stats readout underneath. */
function buildControls(container, { binCount, maxVal, onChange }) {
  container.innerHTML = `
    <div class="fh-controls-row">
      <label>Bins
        <input type="range" min="4" max="40" value="${binCount}" class="fh-bin-slider">
        <span class="fh-bin-label">${binCount}</span>
      </label>
      <label>Max |F| (eV/Å)
        <input type="range" min="0.5" max="20" step="0.5" value="${maxVal}" class="fh-max-slider">
        <span class="fh-max-label">${maxVal}</span>
      </label>
    </div>
    <div class="fh-stats">${statsHTML()}</div>
  `;
  const binSlider = container.querySelector('.fh-bin-slider');
  const binLabel = container.querySelector('.fh-bin-label');
  const maxSlider = container.querySelector('.fh-max-slider');
  const maxLabel = container.querySelector('.fh-max-label');
  const statsEl = container.querySelector('.fh-stats');
  binSlider.addEventListener('input', () => {
    binLabel.textContent = binSlider.value;
    onChange();
  });
  maxSlider.addEventListener('input', () => {
    maxLabel.textContent = maxSlider.value;
    onChange();
  });
  return {
    get binCount() { return parseInt(binSlider.value, 10); },
    get maxVal() { return parseFloat(maxSlider.value); },
    syncStats() { statsEl.innerHTML = statsHTML(); },
  };
}

const DEFAULT_BINS = 20;
const DEFAULT_MAX = 2;

export function removeForceHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Forces window's "Force Histogram" button):
 *  opens the window — right-dock front tab by default, or wherever the user
 *  last dragged it — creating it on first use. */
export function addForceHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    refreshForceHistogram();
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Force Histogram',
    lifecycle: 'persistent',
    infoMd: './data/forceHistogramInfo.md',
    closable: true,
    onClose() { view = null; resizeObserver?.disconnect(); clearHistogramPlot(PLOT_ID); },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="force-histogram-item">
            <h4>Force Histogram</h4>
            <div id="fhControls"></div>
            <div id="${PLOT_ID}" class="split-item-body"></div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions">
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
            </div>
          </div>
        </div>
      `;

      // Bin the data before the controls are built: the max-|F| slider's
      // initial value is fitted to it.
      recompute(fileBrowser.selectedStructure);
      const initialMax = stats ? Math.max(0.5, Math.ceil(stats.max * 1.05 * 2) / 2) : DEFAULT_MAX;
      const controls = buildControls(body.querySelector('#fhControls'), {
        binCount: DEFAULT_BINS, maxVal: initialMax, onChange: () => redraw(),
      });
      const onBarClick = makeClickHandler();
      let expanded = false;

      function redraw() {
        controls.syncStats();
        const { groups } = computeBins(controls.binCount, controls.maxVal);
        renderGroupedHistogram(PLOT_ID, { groups, xTitle: '|F| (eV/Å)', yTitle: 'Atoms', isExpanded: expanded })
          .then(() => onHistogramBarClick(PLOT_ID, onBarClick));
      }

      body.addEventListener('click', (ev) => {
        const btn = /** @type {HTMLElement|null} */ (
          /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
        if (!btn) return;
        const action = btn.dataset.splitAction;
        if (action === 'export') {
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
