// Polyhedra type/composition histogram: one bar per polyhedron category (e.g.
// "SiO4", "AlO6", "O6 cage · CN 8" — the same categories as the Poly tab), in
// ONE ordinary panel window that defaults to the right dock, mirroring
// BondLengthHistogram.js / CoordinationHistogram.js. Clicking a bar highlights
// every atom (centre + vertices) belonging to a polyhedron of that category.
// The window stays open across structure switches — polyhedraAnalysisHub
// pushes fresh data after every polyhedra rebuild.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/RightDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
  togglePlotTheme,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { subscribePolyhedraAnalysis } from './polyhedraAnalysisHub.js';

const PANEL_ID = 'polyhedraTypeHistogram';
const PLOT_ID = 'polyhedraTypeHistogramPlot';

let typeGroups = [];
let view = null;

subscribePolyhedraAnalysis((data) => {
  typeGroups = data.typeGroups;
  view?.redraw();
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

export function removePolyhedraTypeHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Polyhedra window's "Type" button): opens the
 *  window — right-dock front tab by default, or wherever the user last
 *  dragged it — creating it on first use. */
export function addPolyhedraTypeHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Polyhedra Type Histogram',
    lifecycle: 'persistent',
    infoMd: './data/polyhedraTypeHistogramInfo.md',
    closable: true,
    onClose() { view = null; resizeObserver?.disconnect(); clearHistogramPlot(PLOT_ID); },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="polyhedra-type-histogram-item">
            <h4>Polyhedra Type Histogram</h4>
            <div id="${PLOT_ID}" class="split-item-body"></div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions">
              <button type="button" class="split-item-action-btn" data-split-action="theme" title="Toggle light/dark">🌓︎</button>
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
            </div>
          </div>
        </div>
      `;

      const onBarClick = makeClickHandler();
      let expanded = false;

      function redraw() {
        renderGroupedHistogram(PLOT_ID, { groups: computeGroups(), xTitle: 'Polyhedron type', yTitle: 'Count', isExpanded: expanded })
          .then(() => onHistogramBarClick(PLOT_ID, onBarClick));
      }

      body.addEventListener('click', (ev) => {
        const btn = /** @type {HTMLElement|null} */ (
          /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
        if (!btn) return;
        const action = btn.dataset.splitAction;
        if (action === 'theme') {
          togglePlotTheme(PLOT_ID);
          redraw();
        } else if (action === 'export') {
          exportHistogramPNG(PLOT_ID).catch((error) => console.error('Polyhedra type histogram export failed:', error));
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
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 10 },
    },
  });
  openPanel(PANEL_ID);
}
