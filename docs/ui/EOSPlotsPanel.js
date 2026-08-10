// EOS plots window ('eosPlots'): the E-V / P-V plot cards in their own
// ordinary panel window, defaulting to the wide right dock. It is NOT opened
// by hand — EOSPanel.js (the controls window in the left dock) opens it
// whenever there is something to show (a dataset was loaded / re-fit) and
// closes it when the fit is reset. closeMode:'hide' keeps the built plots
// across close/reopen.
//
// Owns only the plot markup and what its buttons do — plot data comes from
// whichever redraw handler EOSPanel.js registers (setRedrawHandler), which
// keeps the import direction one-way (EOSPanel -> this module).

import { togglePlotTheme, exportPlotAsPNG, resizePlot } from '../eos/eosPlots.js';
import { expandSplitItem, closeExpandedSplitItem } from './panels/RightDock.js';

let redrawHandler = null; // (plotId) => Promise<void>
let showErrorPlots = true; // the P-V card's "Show Error Plots" mini toggle
let plotResizeObserver = null; // refits the Plotly charts to the plot stack

/** EOSPanel.js calls this once, so the theme/export/expand buttons can
 *  trigger a real redraw with current fit data. */
export function setRedrawHandler(fn) {
  redrawHandler = fn;
}

/** Whether the "Show Error Plots" toggle is currently on — read by
 *  EOSPanel.js's redraw() when building the P-V plot's context. */
export function getShowErrorPlots() {
  return showErrorPlots;
}

/** Show/hide one plot's card (e.g. the E-V plot when a dataset has no energy
 *  column) — the other plot grows to fill the freed space. */
export function setPlotVisible(plotId, visible) {
  const wrapper = document.getElementById(`${plotId}-wrapper`);
  if (wrapper) wrapper.hidden = !visible;
}

function safeRedraw(plotId) {
  Promise.resolve(redrawHandler?.(plotId)).catch((error) => console.error(error));
}

export function addEOSPlotsPanel(target = 'cvPanelBody-eosPlots') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="cv-plot-stack">
      <div class="split-item" id="ev-plot-wrapper">
        <h4>E vs V</h4>
        <div id="ev-plot" class="split-item-body"></div>
        <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
        <div class="split-item-actions">
          <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="ev-plot" title="Toggle light/dark">🌓︎</button>
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
            <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="pv-plot" title="Toggle light/dark">🌓︎</button>
            <button type="button" class="split-item-action-btn" data-split-action="export" data-split-item="pv-plot" title="Export PNG">📥</button>
            <button type="button" class="split-item-action-btn" data-split-action="expand" data-split-item="pv-plot" title="Expand">⛶</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // One delegated listener for every [data-split-action] button/toggle in the
  // plot cards — works the same right-docked, floating or left-docked.
  container.addEventListener('click', (ev) => {
    const btn = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
    if (!btn) return;
    const action = btn.dataset.splitAction;
    const itemId = btn.dataset.splitItem ?? null;
    if (action === 'theme') {
      togglePlotTheme(itemId);
      safeRedraw(itemId);
    } else if (action === 'export') {
      exportPlotAsPNG(itemId).catch((error) => console.error('EOS plot export failed:', error));
    } else if (action === 'toggle-error-plots') {
      showErrorPlots = /** @type {HTMLInputElement} */ (btn).checked;
      safeRedraw('pv-plot');
    } else if (action === 'expand') {
      expandSplitItem(btn.closest('.split-item'));
      safeRedraw(itemId);
    } else if (action === 'close') {
      closeExpandedSplitItem();
      safeRedraw('ev-plot');
      safeRedraw('pv-plot');
    }
  });

  // Refit the Plotly charts whenever the plot stack's size changes: right-dock
  // handle drags, tab switches (display none -> flex), floating-window growth,
  // browser resizes. rAF-debounced — ResizeObserver can fire in bursts.
  plotResizeObserver?.disconnect();
  let resizeRaf = 0;
  plotResizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizePlot('ev-plot');
      resizePlot('pv-plot');
    });
  });
  plotResizeObserver.observe(container.querySelector('.cv-plot-stack'));
}

export function removeEOSPlotsPanel() {
  // Plot/fit data lives in EOSPanel.js's module state; only the resize
  // observer refers to DOM that is about to go away.
  plotResizeObserver?.disconnect();
  plotResizeObserver = null;
}
