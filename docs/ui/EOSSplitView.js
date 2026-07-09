// EOS-specific content for the shared right-side split view (see
// docs/ui/panels/SplitView.js for the generic pane/handle/tab/overlay
// plumbing this builds on). Owns only the E-V/P-V plot markup and what the
// pane's buttons do — plot data comes from whichever redraw handler
// EOSPanel.js registers.

import { openSplitView, closeSplitView, isSplitViewActive } from './panels/SplitView.js';
import { togglePlotTheme, exportPlotAsPNG, resizePlot } from '../eos/eosPlots.js';

let redrawHandler = null; // (plotId) => Promise<void>
let showErrorPlots = true;

/** EOSPanel.js calls this once it has fit data, so the theme/export/expand
 *  buttons can trigger a real redraw with current data. */
export function setRedrawHandler(fn) {
  redrawHandler = fn;
}

/** Whether the "Show Error Plots" toggle is currently on — read by
 *  EOSPanel.js's redraw() when building the P-V plot's context. */
export function getShowErrorPlots() {
  return showErrorPlots;
}

/** Show/hide one plot's wrapper (e.g. the E-V plot when a dataset has no
 *  energy column) — the other plot grows to fill the freed space. */
export function setPlotVisible(plotId, visible) {
  const wrapper = document.getElementById(`${plotId}-wrapper`);
  if (wrapper) wrapper.hidden = !visible;
}

function safeRedraw(plotId) {
  Promise.resolve(redrawHandler?.(plotId)).catch((error) => console.error(error));
}

async function resizeVisiblePlots() {
  requestAnimationFrame(() => {
    resizePlot('ev-plot');
    resizePlot('pv-plot');
  });
}

function renderContent(body) {
  body.innerHTML = `
    <div class="split-item" id="ev-plot-wrapper">
      <h4>E vs V</h4>
      <div id="ev-plot" class="split-item-body"></div>
      <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
      <div class="split-item-actions">
        <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="ev-plot" title="Toggle light/dark">🌓</button>
        <button type="button" class="split-item-action-btn" data-split-action="export" data-split-item="ev-plot" title="Export PNG">📥</button>
        <button type="button" class="split-item-action-btn" data-split-action="expand" data-split-item="ev-plot" title="Expand">⛶</button>
      </div>
    </div>
    <div class="split-item" id="pv-plot-wrapper">
      <h4>P vs V</h4>
      <div id="pv-plot" class="split-item-body"></div>
      <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
      <div class="split-item-actions eos-plot-actions-split">
        <label class="eos-mini-toggle toggle_row toggle_container">
          <span class="toggle_switch">
            <input type="checkbox" id="eosErrorPlotsToggleMini" data-split-action="toggle-error-plots" ${showErrorPlots ? 'checked' : ''}>
            <span class="toggle_slider"></span>
          </span>
          <span class="toggle_text">Show Error Plots</span>
        </label>
        <div class="eos-plot-actions-right">
          <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="pv-plot" title="Toggle light/dark">🌓</button>
          <button type="button" class="split-item-action-btn" data-split-action="export" data-split-item="pv-plot" title="Export PNG">📥</button>
          <button type="button" class="split-item-action-btn" data-split-action="expand" data-split-item="pv-plot" title="Expand">⛶</button>
        </div>
      </div>
    </div>
  `;
}

function handleAction(action, itemId, btn) {
  if (action === 'theme') {
    togglePlotTheme(itemId);
    safeRedraw(itemId);
  } else if (action === 'export') {
    exportPlotAsPNG(itemId).catch((error) => console.error('EOS plot export failed:', error));
  } else if (action === 'toggle-error-plots') {
    showErrorPlots = btn.checked;
    safeRedraw('pv-plot');
  }
}

function handleExpandChange(itemId, expanded) {
  if (expanded) safeRedraw(itemId);
  else { safeRedraw('ev-plot'); safeRedraw('pv-plot'); }
}

const owner = {
  title: 'EOS Fit',
  panelId: 'eos', // lets the split-view tab's ✕ collapse this dock panel
  render: renderContent,
  onAction: handleAction,
  onExpandChange: handleExpandChange,
  onResize: resizeVisiblePlots,
};

export function openEOSSplitView() {
  openSplitView(owner);
}

export function closeEOSSplitView() {
  closeSplitView(owner);
}

export function isEOSSplitViewActive() {
  return isSplitViewActive(owner);
}
