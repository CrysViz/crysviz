// Bond-length histogram: grouped bar chart (one series per bond pair) of the
// current structure's bond-length distribution, offered two ways — a
// floating/dockable panel (docs/ui/panels/PanelManager.js) and a split-view
// pane (docs/ui/panels/SplitView.js, same mechanism EOS/Energy Landscape
// use). Both render the same data through the shared Plotly helper
// (histogramPlotly.js) and both support click-to-highlight: clicking a bar
// highlights the bonds that fall in that (pair, length-range) cell in the
// main 3D viewer (click again to clear).

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { openSplitView, closeSplitView, isSplitViewActive } from '../panels/SplitView.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightBondIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { activatePanelDisplay, deactivatePanelDisplay, activateSplitDisplay, deactivateSplitDisplay } from './histogramCoordinator.js';

const PANEL_ID = 'bondLengthHistogram';
const FLOAT_PLOT_ID = 'bondLengthHistogramPlot';
const SPLIT_PLOT_ID = 'bondLengthHistogramSplitPlot';

let data = {}; // pair -> [{ dist, instanceIds }, ...] — latest from BondsFracUpdateModule
let floating = null; // { redraw() } while the floating panel is open
let split = null;    // { redraw() } while the split-view pane is open

/** Called by BondsFracUpdateModule after every rebuildBonds. */
export function refreshBondLengthHistogram(newData) {
  data = newData || {};
  floating?.redraw();
  split?.redraw();
}

function computeBins(binCount, minVal, maxVal) {
  const pairs = Object.keys(data);
  const binWidth = (maxVal - minVal) / binCount;
  const xLabels = Array.from({ length: binCount }, (_, i) =>
    (minVal + i * binWidth).toFixed(2));

  const groups = pairs.map((pair) => {
    const y = new Array(binCount).fill(0);
    const customdata = Array.from({ length: binCount }, () => []);
    for (const entry of data[pair]) {
      let idx = Math.floor((entry.dist - minVal) / binWidth);
      idx = Math.max(0, Math.min(binCount - 1, idx));
      y[idx] += 1;
      if (entry.instanceIds?.length) customdata[idx].push(...entry.instanceIds);
    }
    return { label: pair, x: xLabels, y, customdata };
  });

  return { groups, binWidth };
}

/** One bar-click handler shared by both presentations: toggles the 3D
 *  highlight for the clicked (pair, bin) cell's bonds. */
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
      highlightBondIn3D(customdata);
      lastKey = key;
    }
  };
}

/** Shared control-row builder (bin count + max distance sliders) used by
 *  both the floating panel and the split-view pane. */
function buildControls(container, { binCount, maxDist, onChange }) {
  container.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:14px; align-items:center; margin-bottom:8px; font-size:12px; color:#ddd;">
      <label style="display:flex; align-items:center; gap:6px;">Bins
        <input type="range" min="2" max="30" value="${binCount}" class="bl-bin-slider" style="width:100px;">
        <span class="bl-bin-label">${binCount}</span>
      </label>
      <label style="display:flex; align-items:center; gap:6px;">Max length (Å)
        <input type="range" min="2" max="8" step="0.5" value="${maxDist}" class="bl-max-slider" style="width:100px;">
        <span class="bl-max-label">${maxDist}</span>
      </label>
    </div>
  `;
  const binSlider = container.querySelector('.bl-bin-slider');
  const binLabel = container.querySelector('.bl-bin-label');
  const maxSlider = container.querySelector('.bl-max-slider');
  const maxLabel = container.querySelector('.bl-max-label');
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
    get maxDist() { return parseFloat(maxSlider.value); },
  };
}

const MIN_LENGTH = 0.5;

// ---------------------------------------------------------------------------
// Floating / dockable panel (docs/ui/panels/PanelManager.js)
// ---------------------------------------------------------------------------

export function removeBondLengthHistogramPanel() {
  floating = null;
  removePanel(PANEL_ID);
  deactivatePanelDisplay(removeBondLengthHistogramPanel);
}

export function addBondLengthHistogramPanel() {
  removeBondLengthHistogramPanel();
  activatePanelDisplay(removeBondLengthHistogramPanel);

  const isMobile = window.innerWidth < 700;
  const panel = registerPanel({
    id: PANEL_ID,
    title: 'Bond Length Histogram',
    lifecycle: 'persistent',
    infoMd: './data/bondLengthHistogramInfo.md',
    closable: true,
    onClose() { floating = null; resizeObserver?.disconnect(); clearHistogramPlot(FLOAT_PLOT_ID); deactivatePanelDisplay(removeBondLengthHistogramPanel); },
    buildContent(body) {
      body.innerHTML = `
        <div style="padding:6px; box-sizing:border-box; width: min(90vw, 640px); max-width: 100%;">
          <div id="blhControls"></div>
          <div id="${FLOAT_PLOT_ID}" style="width:100%; height:340px;"></div>
        </div>
      `;
    },
    defaults: {
      docked: false, collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 20 },
    },
  });

  const body = panel.body;
  const controls = buildControls(body.querySelector('#blhControls'), {
    binCount: 12, maxDist: 6, onChange: () => redraw(),
  });
  const onBarClick = makeClickHandler();

  function redraw() {
    const { groups } = computeBins(controls.binCount, MIN_LENGTH, controls.maxDist);
    renderGroupedHistogram(FLOAT_PLOT_ID, { groups, xTitle: 'Bond length (Å)', yTitle: 'Count' })
      .then(() => onHistogramBarClick(FLOAT_PLOT_ID, onBarClick));
  }

  let lastWidth = body.clientWidth;
  const resizeObserver = new ResizeObserver(() => {
    if (body.clientWidth === lastWidth || !body.clientWidth) return;
    lastWidth = body.clientWidth;
    resizeHistogramPlot(FLOAT_PLOT_ID);
  });
  resizeObserver.observe(body);

  floating = { redraw };
  redraw();
}

// ---------------------------------------------------------------------------
// Split view (docs/ui/panels/SplitView.js)
// ---------------------------------------------------------------------------

function renderSplitContent(body) {
  body.innerHTML = `
    <div class="split-item" id="bond-length-histogram-item">
      <h4>Bond Length Histogram</h4>
      <div id="blhSplitControls"></div>
      <div id="${SPLIT_PLOT_ID}" class="split-item-body"></div>
      <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
      <div class="split-item-actions">
        <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
        <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
      </div>
    </div>
  `;

  const controls = buildControls(body.querySelector('#blhSplitControls'), {
    binCount: 12, maxDist: 6, onChange: () => redraw(),
  });
  const onBarClick = makeClickHandler();
  let expanded = false;

  function redraw() {
    const { groups } = computeBins(controls.binCount, MIN_LENGTH, controls.maxDist);
    renderGroupedHistogram(SPLIT_PLOT_ID, { groups, xTitle: 'Bond length (Å)', yTitle: 'Count', isExpanded: expanded })
      .then(() => onHistogramBarClick(SPLIT_PLOT_ID, onBarClick));
  }

  split = {
    redraw,
    setExpanded(v) { expanded = v; redraw(); },
  };
  redraw();
}

function handleAction(action) {
  if (action === 'export') exportHistogramPNG(SPLIT_PLOT_ID).catch((error) => console.error('Bond length histogram export failed:', error));
}

function handleExpandChange(itemId, isExpanded) {
  split?.setExpanded(!!isExpanded);
}

const splitOwner = {
  title: 'Bond Length Histogram',
  render: renderSplitContent,
  onAction: handleAction,
  onExpandChange: handleExpandChange,
  onResize() { resizeHistogramPlot(SPLIT_PLOT_ID); },
  onClose() { split = null; clearHistogramPlot(SPLIT_PLOT_ID); deactivateSplitDisplay(closeBondLengthHistogramSplitView); },
};

export function openBondLengthHistogramSplitView() {
  activateSplitDisplay(closeBondLengthHistogramSplitView);
  openSplitView(splitOwner);
}

export function closeBondLengthHistogramSplitView() {
  closeSplitView(splitOwner);
}

export function isBondLengthHistogramSplitViewActive() {
  return isSplitViewActive(splitOwner);
}
