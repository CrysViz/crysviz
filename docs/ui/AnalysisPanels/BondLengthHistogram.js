// Bond-length histogram: grouped bar chart (one series per bond pair) of the
// current structure's bond-length distribution, in ONE ordinary panel window
// that defaults to the right dock (drag its tab out to float, or into the
// left bar — docs/ui/panels/RightDock.js / PanelManager.js). Renders through
// the shared Plotly helper (histogramPlotly.js) and supports
// click-to-highlight: clicking a bar highlights the bonds that fall in that
// (pair, length-range) cell in the main 3D viewer (click again to clear).
// The window stays open across structure switches — BondsFracUpdateModule
// pushes fresh data via refreshBondLengthHistogram after every rebuildBonds.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/RightDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightBondIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';

const PANEL_ID = 'bondLengthHistogram';
const PLOT_ID = 'bondLengthHistogramPlot';

let data = {}; // pair -> [{ dist, instanceIds }, ...] — latest from BondsFracUpdateModule
let view = null; // { redraw() } while the window is open

/** Called by BondsFracUpdateModule after every rebuildBonds. */
export function refreshBondLengthHistogram(newData) {
  data = newData || {};
  view?.redraw();
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

/** Bar-click handler: toggles the 3D highlight for the clicked (pair, bin)
 *  cell's bonds. */
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

/** Control-row builder (bin count + max distance sliders). */
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
  registerPanel({
    id: PANEL_ID,
    title: 'Bond Length Histogram',
    lifecycle: 'persistent',
    infoMd: './data/bondLengthHistogramInfo.md',
    closable: true,
    onClose() { view = null; resizeObserver?.disconnect(); clearHistogramPlot(PLOT_ID); },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="bond-length-histogram-item">
            <h4>Bond Length Histogram</h4>
            <div id="blhControls"></div>
            <div id="${PLOT_ID}" class="split-item-body"></div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions">
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
            </div>
          </div>
        </div>
      `;

      const controls = buildControls(body.querySelector('#blhControls'), {
        binCount: 12, maxDist: 6, onChange: () => redraw(),
      });
      const onBarClick = makeClickHandler();
      let expanded = false;

      function redraw() {
        const { groups } = computeBins(controls.binCount, MIN_LENGTH, controls.maxDist);
        renderGroupedHistogram(PLOT_ID, { groups, xTitle: 'Bond length (Å)', yTitle: 'Count', isExpanded: expanded })
          .then(() => onHistogramBarClick(PLOT_ID, onBarClick));
      }

      body.addEventListener('click', (ev) => {
        const btn = /** @type {HTMLElement|null} */ (
          /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
        if (!btn) return;
        const action = btn.dataset.splitAction;
        if (action === 'export') {
          exportHistogramPNG(PLOT_ID).catch((error) => console.error('Bond length histogram export failed:', error));
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
