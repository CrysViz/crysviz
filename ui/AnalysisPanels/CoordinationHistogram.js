// Coordination-number histogram: grouped bar chart (one series per element)
// of how many bonds start or end on each atom, offered as both a floating
// panel and a split-view pane — see BondLengthHistogram.js, which this
// mirrors. Coordination number is a small discrete count (unlike bond
// length), so there's no bin/max-range control: one bar per distinct value
// actually present. Clicking a bar highlights every atom of that element
// with that coordination number (click again to clear).

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { openSplitView, closeSplitView, isSplitViewActive } from '../panels/SplitView.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { activatePanelDisplay, deactivatePanelDisplay, activateSplitDisplay, deactivateSplitDisplay } from './histogramCoordinator.js';

const PANEL_ID = 'coordinationHistogram';
const FLOAT_PLOT_ID = 'coordinationHistogramPlot';
const SPLIT_PLOT_ID = 'coordinationHistogramSplitPlot';

let data = {}; // element -> [{ cn, atomIndex }, ...] — latest from BondsFracUpdateModule
let floating = null;
let split = null;

/** Called by BondsFracUpdateModule after every rebuildBonds. */
export function refreshCoordinationHistogram(newData) {
  data = newData || {};
  floating?.redraw();
  split?.redraw();
}

function computeGroups() {
  const elements = Object.keys(data);
  const cnValues = [...new Set(elements.flatMap((el) => data[el].map((d) => d.cn)))].sort((a, b) => a - b);
  const xLabels = cnValues.map(String);

  const groups = elements.map((el) => {
    const y = new Array(cnValues.length).fill(0);
    const customdata = Array.from({ length: cnValues.length }, () => []);
    for (const entry of data[el]) {
      const idx = cnValues.indexOf(entry.cn);
      y[idx] += 1;
      customdata[idx].push(entry.atomIndex);
    }
    return { label: el, x: xLabels, y, customdata };
  });

  return groups;
}

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

// ---------------------------------------------------------------------------
// Floating / dockable panel (docs/ui/panels/PanelManager.js)
// ---------------------------------------------------------------------------

export function removeCoordinationHistogramPanel() {
  floating = null;
  removePanel(PANEL_ID);
  deactivatePanelDisplay(removeCoordinationHistogramPanel);
}

export function addCoordinationHistogramPanel() {
  removeCoordinationHistogramPanel();
  activatePanelDisplay(removeCoordinationHistogramPanel);

  const isMobile = window.innerWidth < 700;
  const panel = registerPanel({
    id: PANEL_ID,
    title: 'Coordination Number Histogram',
    lifecycle: 'persistent',
    infoMd: './data/coordinationHistogramInfo.md',
    closable: true,
    onClose() { floating = null; resizeObserver?.disconnect(); clearHistogramPlot(FLOAT_PLOT_ID); deactivatePanelDisplay(removeCoordinationHistogramPanel); },
    buildContent(body) {
      body.innerHTML = `
        <div style="padding:6px; box-sizing:border-box; width: min(90vw, 640px); max-width: 100%;">
          <div id="${FLOAT_PLOT_ID}" style="width:100%; height:340px;"></div>
        </div>
      `;
    },
    defaults: {
      docked: false, collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 10 },
    },
  });

  const onBarClick = makeClickHandler();

  function redraw() {
    const groups = computeGroups();
    renderGroupedHistogram(FLOAT_PLOT_ID, { groups, xTitle: 'Coordination number', yTitle: 'Atom count' })
      .then(() => onHistogramBarClick(FLOAT_PLOT_ID, onBarClick));
  }

  const body = panel.body;
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
    <div class="split-item" id="coordination-histogram-item">
      <h4>Coordination Number Histogram</h4>
      <div id="${SPLIT_PLOT_ID}" class="split-item-body"></div>
      <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
      <div class="split-item-actions">
        <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
        <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
      </div>
    </div>
  `;

  const onBarClick = makeClickHandler();
  let expanded = false;

  function redraw() {
    const groups = computeGroups();
    renderGroupedHistogram(SPLIT_PLOT_ID, { groups, xTitle: 'Coordination number', yTitle: 'Atom count', isExpanded: expanded })
      .then(() => onHistogramBarClick(SPLIT_PLOT_ID, onBarClick));
  }

  split = {
    redraw,
    setExpanded(v) { expanded = v; redraw(); },
  };
  redraw();
}

function handleAction(action) {
  if (action === 'export') exportHistogramPNG(SPLIT_PLOT_ID).catch((error) => console.error('Coordination histogram export failed:', error));
}

function handleExpandChange(itemId, isExpanded) {
  split?.setExpanded(!!isExpanded);
}

const splitOwner = {
  title: 'Coordination #',
  render: renderSplitContent,
  onAction: handleAction,
  onExpandChange: handleExpandChange,
  onResize() { resizeHistogramPlot(SPLIT_PLOT_ID); },
  onClose() { split = null; clearHistogramPlot(SPLIT_PLOT_ID); deactivateSplitDisplay(closeCoordinationHistogramSplitView); },
};

export function openCoordinationHistogramSplitView() {
  activateSplitDisplay(closeCoordinationHistogramSplitView);
  openSplitView(splitOwner);
}

export function closeCoordinationHistogramSplitView() {
  closeSplitView(splitOwner);
}

export function isCoordinationHistogramSplitViewActive() {
  return isSplitViewActive(splitOwner);
}
