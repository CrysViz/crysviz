// Polyhedra type/composition histogram: one bar per polyhedron category (e.g.
// "SiO4", "AlO6", "O6 cage · CN 8" — the same categories as the Poly tab),
// offered as both a floating panel and a split-view pane, mirroring
// BondLengthHistogram.js / CoordinationHistogram.js. Clicking a bar highlights
// every atom (centre + vertices) belonging to a polyhedron of that category.

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { openSplitView, closeSplitView, isSplitViewActive } from '../panels/SplitView.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { activatePanelDisplay, deactivatePanelDisplay, activateSplitDisplay, deactivateSplitDisplay } from './histogramCoordinator.js';
import { subscribePolyhedraAnalysis } from './polyhedraAnalysisHub.js';

const PANEL_ID = 'polyhedraTypeHistogram';
const FLOAT_PLOT_ID = 'polyhedraTypeHistogramPlot';
const SPLIT_PLOT_ID = 'polyhedraTypeHistogramSplitPlot';

let typeGroups = [];
let floating = null;
let split = null;

subscribePolyhedraAnalysis((data) => {
  typeGroups = data.typeGroups;
  floating?.redraw();
  split?.redraw();
});

function computeGroups() {
  return [{
    label: 'Polyhedra',
    x: typeGroups.map((g) => g.label),
    y: typeGroups.map((g) => g.count),
    customdata: typeGroups.map((g) => g.atomIndices),
  }];
}

function makeClickHandler() {
  let lastKey = null;
  return (customdata, point) => {
    const key = String(point.pointIndex);
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
// Floating / dockable panel
// ---------------------------------------------------------------------------

export function removePolyhedraTypeHistogramPanel() {
  floating = null;
  removePanel(PANEL_ID);
  deactivatePanelDisplay(removePolyhedraTypeHistogramPanel);
}

export function addPolyhedraTypeHistogramPanel() {
  removePolyhedraTypeHistogramPanel();
  activatePanelDisplay(removePolyhedraTypeHistogramPanel);

  const isMobile = window.innerWidth < 700;
  const panel = registerPanel({
    id: PANEL_ID,
    title: 'Polyhedra Type Histogram',
    lifecycle: 'persistent',
    infoMd: './data/polyhedraTypeHistogramInfo.md',
    closable: true,
    onClose() { floating = null; resizeObserver?.disconnect(); clearHistogramPlot(FLOAT_PLOT_ID); deactivatePanelDisplay(removePolyhedraTypeHistogramPanel); },
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
    renderGroupedHistogram(FLOAT_PLOT_ID, { groups: computeGroups(), xTitle: 'Polyhedron type', yTitle: 'Count' })
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
// Split view
// ---------------------------------------------------------------------------

function renderSplitContent(body) {
  body.innerHTML = `
    <div class="split-item" id="polyhedra-type-histogram-item">
      <h4>Polyhedra Type Histogram</h4>
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
    renderGroupedHistogram(SPLIT_PLOT_ID, { groups: computeGroups(), xTitle: 'Polyhedron type', yTitle: 'Count', isExpanded: expanded })
      .then(() => onHistogramBarClick(SPLIT_PLOT_ID, onBarClick));
  }

  split = {
    redraw,
    setExpanded(v) { expanded = v; redraw(); },
  };
  redraw();
}

function handleAction(action) {
  if (action === 'export') exportHistogramPNG(SPLIT_PLOT_ID).catch((error) => console.error('Polyhedra type histogram export failed:', error));
}

function handleExpandChange(itemId, isExpanded) {
  split?.setExpanded(!!isExpanded);
}

const splitOwner = {
  title: 'Polyhedra Type',
  render: renderSplitContent,
  onAction: handleAction,
  onExpandChange: handleExpandChange,
  onResize() { resizeHistogramPlot(SPLIT_PLOT_ID); },
  onClose() { split = null; clearHistogramPlot(SPLIT_PLOT_ID); deactivateSplitDisplay(closePolyhedraTypeHistogramSplitView); },
};

export function openPolyhedraTypeHistogramSplitView() {
  activateSplitDisplay(closePolyhedraTypeHistogramSplitView);
  openSplitView(splitOwner);
}

export function closePolyhedraTypeHistogramSplitView() {
  closeSplitView(splitOwner);
}

export function isPolyhedraTypeHistogramSplitViewActive() {
  return isSplitViewActive(splitOwner);
}
