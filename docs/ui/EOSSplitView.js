// Right-side split view hosting the EOS fit plots, independent of the EOS
// control panel's own dock window. Opens (splitting #viewArea between the 3D
// #view and the plot pane) when the EOS panel is expanded, closes (giving
// #view back the full width) when it's collapsed. The pane itself can be
// independently collapsed to a thin pull-tab (button or drag), while the EOS
// panel stays expanded.
//
// Owns only layout/DOM plumbing for the pane; plot data comes from whichever
// redraw handler EOSPanel.js registers.

import { togglePlotTheme, exportPlotAsPNG, resizePlot } from '../eos/eosPlots.js';
import { setRightReserve } from './panels/PanelManager.js';
import { resizeRenderer } from './WindowAndSceneControls.js';
import { requestRender } from '../render/index.js';
import { app } from '../state/store.js';

const DEFAULT_PANE_FRACTION = 1 / 3;
const MIN_PANE_PX = 220; // dragged narrower than this -> snap collapsed

let active = false;
let collapsed = false;
let wired = false;
let redrawHandler = null; // (plotId) => Promise<void>
let paneFraction = DEFAULT_PANE_FRACTION;

function els() {
  return {
    viewArea: document.getElementById('viewArea'),
    view: document.getElementById('view'),
    pane: document.getElementById('eosPlotPane'),
    handle: document.getElementById('eosSplitHandle'),
    tab: document.getElementById('eosPlotTab'),
    overlay: document.getElementById('eosPlotOverlay'),
  };
}

/** EOSPanel.js calls this once it has fit data, so the theme/export/expand
 *  buttons can trigger a real redraw with current data. */
export function setRedrawHandler(fn) {
  redrawHandler = fn;
}

/** Show/hide one plot's wrapper (e.g. the E-V plot when a dataset has no
 *  energy column) — the other plot grows to fill the freed space. */
export function setPlotVisible(plotId, visible) {
  const wrapper = document.getElementById(`${plotId}-wrapper`);
  if (wrapper) wrapper.hidden = !visible;
}

function applyPaneWidth() {
  const { viewArea } = els();
  if (!viewArea) return;
  // Set on the root (not the pane) — #view and the handle are siblings of
  // the pane, not descendants, so they need it too (CSS vars only inherit
  // down the tree from where they're declared).
  document.documentElement.style.setProperty('--eos-pane-fraction', String(paneFraction));
  if (collapsed) viewArea.classList.add('eos-pane-collapsed');
  else viewArea.classList.remove('eos-pane-collapsed');
}

/**
 * Re-derive the space the EOS pane currently occupies to the right of #view
 * and push that out to everything that needs to stay clear of it: the 3D
 * renderer (resize + a fresh on-demand frame — #view's size can change here
 * without a window resize event ever firing), right-anchored floating panels
 * (Structure info, via PanelManager's right-reserve), and the background-dot
 * (a plain fixed div, via the --eos-reserve custom property).
 */
function syncSceneAndSidePanels() {
  const { view } = els();
  if (!view) return;
  const reservePx = Math.max(0, window.innerWidth - view.getBoundingClientRect().right);
  setRightReserve(reservePx);
  document.documentElement.style.setProperty('--eos-reserve', `${reservePx}px`);
  resizeRenderer(app.orthographicFrustumSize);
  requestRender();
}

async function resizeVisiblePlots() {
  requestAnimationFrame(() => {
    resizePlot('ev-plot');
    resizePlot('pv-plot');
  });
}

export function openEOSSplitView() {
  wireOnce();
  const { viewArea, pane, handle, tab } = els();
  if (!viewArea || !pane) return;
  active = true;
  viewArea.classList.add('eos-split-active');
  pane.hidden = false;
  if (handle) handle.hidden = false;
  if (tab) tab.hidden = false;
  applyPaneWidth();
  syncSceneAndSidePanels();
  resizeVisiblePlots();
}

export function closeEOSSplitView() {
  const { viewArea, pane, handle, tab } = els();
  active = false;
  if (viewArea) viewArea.classList.remove('eos-split-active', 'eos-pane-collapsed');
  if (pane) pane.hidden = true;
  if (handle) handle.hidden = true;
  if (tab) tab.hidden = true;
  closeExpandedPlot();
  syncSceneAndSidePanels();
}

export function isEOSSplitViewActive() {
  return active;
}

function setCollapsed(next) {
  collapsed = next;
  applyPaneWidth();
  syncSceneAndSidePanels();
  if (!collapsed) resizeVisiblePlots();
}

function safeRedraw(plotId) {
  Promise.resolve(redrawHandler?.(plotId)).catch((error) => console.error(error));
}

function expandPlot(plotId) {
  const wrapper = document.getElementById(`${plotId}-wrapper`);
  const { viewArea, overlay } = els();
  if (!wrapper) return;
  wrapper.classList.add('expanded');
  overlay?.classList.add('active');
  // Hide the resize handle while a plot is fullscreen — it otherwise floats
  // on top of the expanded plot (it's z-ordered above the ordinary pane).
  viewArea?.classList.add('eos-plot-expanded');
  safeRedraw(plotId);
}

function closeExpandedPlot() {
  const { viewArea, overlay } = els();
  document.querySelectorAll('.eos-plot-wrapper.expanded').forEach((w) => w.classList.remove('expanded'));
  overlay?.classList.remove('active');
  viewArea?.classList.remove('eos-plot-expanded');
  safeRedraw('ev-plot');
  safeRedraw('pv-plot');
}

function wireOnce() {
  if (wired) return;
  wired = true;
  const { pane, handle, tab, overlay } = els();

  const collapseBtn = document.getElementById('eosPaneCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setCollapsed(true));
  if (tab) tab.addEventListener('click', () => setCollapsed(false));

  // Drag the splitter: resize while open, snap to the collapsed tab if
  // dragged past most of the pane's width.
  if (handle) {
    handle.addEventListener('pointerdown', (startEv) => {
      if (collapsed) return;
      startEv.preventDefault();
      handle.setPointerCapture(startEv.pointerId);

      // The pane's CSS width is a vw-based fraction of the whole viewport
      // (it's viewport-fixed, not a flex child of #viewArea) — the fraction
      // must be computed against the same basis, not #viewArea's narrower
      // width (which excludes the #ui dock), or the drag and the rendered
      // width disagree.
      const onMove = (ev) => {
        const paneWidthPx = Math.max(0, window.innerWidth - ev.clientX);
        if (paneWidthPx < MIN_PANE_PX) {
          setCollapsed(true);
          return;
        }
        paneFraction = Math.min(0.8, paneWidthPx / window.innerWidth);
        collapsed = false;
        applyPaneWidth();
        syncSceneAndSidePanels();
      };
      const onUp = () => {
        handle.releasePointerCapture(startEv.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        syncSceneAndSidePanels();
        resizeVisiblePlots();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  if (pane) {
    pane.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-plot-action]');
      if (!btn) return;
      const plotId = btn.dataset.plotId;
      const action = btn.dataset.plotAction;
      if (action === 'theme') {
        togglePlotTheme(plotId);
        safeRedraw(plotId);
      } else if (action === 'export') {
        exportPlotAsPNG(plotId).catch((error) => console.error('EOS plot export failed:', error));
      } else if (action === 'expand') {
        expandPlot(plotId);
      } else if (action === 'close') {
        closeExpandedPlot();
      }
    });
  }

  if (overlay) {
    overlay.addEventListener('click', () => closeExpandedPlot());
  }

  // A plain browser window resize changes #view's pixel size too (the pane's
  // width is a fraction of the viewport) — keep the reserve/dot/renderer in
  // sync without waiting for the next pane interaction.
  window.addEventListener('resize', () => { if (active) syncSceneAndSidePanels(); });
}
