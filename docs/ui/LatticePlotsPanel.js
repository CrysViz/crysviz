// Lattice Analysis plots window ('latticePlots'): five plot cards — the cell
// lengths a, b, c; the angles α, β, γ; and one card per angle — in their own
// ordinary panel window, defaulting to the wide side dock. Opened from the
// "Show plots" button of LatticeAnalysisPanel.js (the controls window in the
// main dock); both windows go unavailable (the plots close out of the dock)
// when nothing supplies points, and the plots come back with the next
// trajectory or checked set. closeMode:'hide' keeps the built charts across
// close/reopen. Each chart's height can be dragged at its bottom-right
// corner (the same native CSS resize handle the Bond Length Histogram cards
// use) and is remembered in the panel prefs.
//
// Owns only the plot markup and what its buttons do — plot data comes from
// the redraw handler LatticeAnalysisPanel.js registers (setRedrawHandler),
// which keeps the import direction one-way (LatticeAnalysisPanel -> here).

import { togglePlotTheme, exportPlotAsPNG, resizePlot } from '../lattice/latticePlots.js';
import { expandSplitItem, closeExpandedSplitItem } from './panels/SideDock.js';
import { getPanelPref, setPanelPref } from './panels/PanelManager.js';

/** The plot cards, in stack order. `series` names the lattice series each
 *  card draws (keys of latticeSeries.js's LatticeSeries). */
export const LATTICE_PLOT_CARDS = /** @type {const} */ ([
  { id: 'lattice-abc-plot', title: 'Cell lengths a, b, c', series: ['a', 'b', 'c'], yTitle: 'Length (Å)' },
  { id: 'lattice-angles-plot', title: 'Cell angles α, β, γ', series: ['alpha', 'beta', 'gamma'], yTitle: 'Angle (°)' },
  { id: 'lattice-alpha-plot', title: 'α', series: ['alpha'], yTitle: 'α (°)' },
  { id: 'lattice-beta-plot', title: 'β', series: ['beta'], yTitle: 'β (°)' },
  { id: 'lattice-gamma-plot', title: 'γ', series: ['gamma'], yTitle: 'γ (°)' },
]);

export const LATTICE_PLOT_IDS = LATTICE_PLOT_CARDS.map((card) => card.id);

let redrawHandler = null; // (plotId) => Promise<void>
let plotResizeObserver = null; // refits the Plotly charts to their cards

// Chart heights the user dragged (px), by plot id — a panel pref so they
// survive reloads. The drag is the browser's own `resize: vertical` handle
// on the plot div (styles/latticeAnalysisPanel.css .la-plot), which writes
// an INLINE height; a chart without a stored height keeps the stylesheet's.
const HEIGHTS_PREF = 'latticePlotHeights';

function storedHeights() {
  const stored = getPanelPref(HEIGHTS_PREF);
  return stored && typeof stored === 'object' ? { ...stored } : {};
}

/** The chart's dragged (inline) height in px, or null — read by tests. */
export function plotHeight(plotId) {
  const el = document.getElementById(plotId);
  const h = el ? parseFloat(el.style.height) : NaN;
  return Number.isFinite(h) ? h : null;
}

/** Remember a chart's dragged height once the drag has settled (the observer
 *  fires per pixel; the pref write is debounced). Skipped while the card is
 *  expanded — its !important fullscreen height is not a user choice. */
let persistTimer = 0;
function persistHeight(plotId) {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const el = document.getElementById(plotId);
    if (!el || el.closest('.split-item')?.classList.contains('expanded')) return;
    const h = plotHeight(plotId);
    const heights = storedHeights();
    if (h === null) delete heights[plotId];
    else heights[plotId] = Math.round(h);
    setPanelPref(HEIGHTS_PREF, heights);
  }, 300);
}

/** LatticeAnalysisPanel.js calls this once, so the theme/expand buttons can
 *  trigger a real redraw with the current trajectory's data. */
export function setRedrawHandler(fn) {
  redrawHandler = fn;
}

function safeRedraw(plotId) {
  Promise.resolve(redrawHandler?.(plotId)).catch((error) => {
    // Offline (Plotly comes from a CDN, utils/plotlyLoader.js): the card
    // shows the message in place of the chart; that is a condition, not a
    // defect, so it does not go to console.error.
    const offline = /unavailable offline/.test(error?.message || '');
    if (!offline) console.error(error);
    const el = document.getElementById(plotId);
    if (el && !el.querySelector('.js-plotly-plot')) el.textContent = error.message || String(error);
  });
}

function cardMarkup(card) {
  const hint = card.series.length > 1 ? ' — click a point to show that frame' : '';
  return `
      <div class="split-item" id="${card.id}-wrapper">
        <h4>${card.title}${hint}</h4>
        <div id="${card.id}" class="split-item-body la-plot" title="Drag the bottom-right corner to change this plot's height"></div>
        <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
        <div class="split-item-actions">
          <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="${card.id}" title="Toggle light/dark">🌓︎</button>
          <button type="button" class="split-item-action-btn" data-split-action="export" data-split-item="${card.id}" title="Export PNG">📥</button>
          <button type="button" class="split-item-action-btn" data-split-action="expand" data-split-item="${card.id}" title="Expand">⛶</button>
        </div>
      </div>`;
}

export function addLatticePlotsPanel(target = 'cvPanelBody-latticePlots') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="cv-plot-stack lattice-plot-stack">
      ${LATTICE_PLOT_CARDS.map(cardMarkup).join('')}
    </div>
  `;

  // One delegated listener for every [data-split-action] button in the plot
  // cards — works the same side-docked, floating or main-docked.
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
      exportPlotAsPNG(itemId).catch((error) => console.error('Lattice plot export failed:', error));
    } else if (action === 'expand') {
      expandSplitItem(btn.closest('.split-item'));
      safeRedraw(itemId);
    } else if (action === 'close') {
      closeExpandedSplitItem();
      for (const id of LATTICE_PLOT_IDS) safeRedraw(id);
    }
  });

  // Restore dragged chart heights.
  const heights = storedHeights();
  for (const id of LATTICE_PLOT_IDS) {
    const el = container.querySelector(`#${id}`);
    if (el && Number.isFinite(heights[id])) el.style.height = `${heights[id]}px`;
  }

  // Refit a Plotly chart whenever its div's size changes: its own resize
  // handle, side-dock handle drags, tab switches (display none -> flex),
  // floating-window growth, browser resizes. One observer over every plot
  // div; the entries name which ones moved. rAF-debounced — ResizeObserver
  // can fire in bursts.
  plotResizeObserver?.disconnect();
  let resizeRaf = 0;
  const pending = new Set();
  plotResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) pending.add(/** @type {HTMLElement} */ (entry.target).id);
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      for (const id of pending) {
        resizePlot(id);
        persistHeight(id);
      }
      pending.clear();
    });
  });
  for (const id of LATTICE_PLOT_IDS) {
    const el = container.querySelector(`#${id}`);
    if (el) plotResizeObserver.observe(el);
  }

  // Draw whatever the controls window already holds (reopen after a close,
  // or a plots window built before its data arrived): the handler no-ops
  // while there is nothing to show.
  for (const id of LATTICE_PLOT_IDS) safeRedraw(id);
}

export function removeLatticePlotsPanel() {
  // The series live in LatticeAnalysisPanel.js's module state; only the
  // resize observer refers to DOM that is about to go away.
  plotResizeObserver?.disconnect();
  plotResizeObserver = null;
}
