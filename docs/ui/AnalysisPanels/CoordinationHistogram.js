// Coordination-number histogram: grouped bar chart (one series per element)
// of how many bonds start or end on each atom, in ONE ordinary panel window
// that defaults to the side dock — see BondLengthHistogram.js, which this
// mirrors. Coordination number is a small discrete count (unlike bond
// length), so there's no bin/max-range control: one bar per distinct value
// actually present. Clicking a bar highlights every atom of that element
// with that coordination number (click again to clear).

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/SideDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
  togglePlotTheme,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { refreshBondHistogramData } from '../../render/BondsFracUpdateModule.js';

const PANEL_ID = 'coordinationHistogram';
const PLOT_ID = 'coordinationHistogramPlot';

let data = {}; // element -> [{ cn, atomIndex }, ...] — latest from BondsFracUpdateModule
let view = null;

/** Called by BondsFracUpdateModule after every rebuildBonds. */
/** True while the window is open — the producer skips its work when it is not. */
export function isCoordinationHistogramOpen() {
  return !!view;
}

export function refreshCoordinationHistogram(newData) {
  data = newData || {};
  view?.redraw();
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

export function removeCoordinationHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Bonds window's "Coordination Number" button):
 *  opens the window — side-dock front tab by default, or wherever the user
 *  last dragged it — creating it on first use. */
export function addCoordinationHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Coordination Number Histogram',
    lifecycle: 'persistent',
    infoMd: './data/coordinationHistogramInfo.md',
    closable: true,
    onClose() { view = null; resizeObserver?.disconnect(); clearHistogramPlot(PLOT_ID); },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="coordination-histogram-item">
            <h4>Coordination Number Histogram</h4>
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
        const groups = computeGroups();
        renderGroupedHistogram(PLOT_ID, { groups, xTitle: 'Coordination number', yTitle: 'Atom count', isExpanded: expanded })
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
          exportHistogramPNG(PLOT_ID).catch((error) => console.error('Coordination histogram export failed:', error));
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
      // The producer skips computing histogram data while every window is
      // closed, so this window has to ask for it on the way in.
      refreshBondHistogramData();
      redraw();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 10 },
    },
  });
  openPanel(PANEL_ID);
}
