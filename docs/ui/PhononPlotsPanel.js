// Phonon plots window ('phononPlots'): the band-structure/DOS card and the
// mode-map card in their own window, defaulting to the wide side dock. Opened
// by ui/PhononPanel.js whenever there is something to show (a phonopy file
// loaded, a mode map computed). closeMode:'hide' keeps the charts across
// close/reopen. The data lives in phonon/phononSession.js; this module owns
// the markup, the per-card buttons and the redraw plumbing.

import { plotBands, plotModeMap, togglePlotTheme, exportPlotAsPNG, resizePlot, onPhononPlotClick } from '../phonon/phononPlots.js';
import { expandSplitItem, closeExpandedSplitItem } from './panels/SideDock.js';
import { phononState, onPhononChange, selectMode, selectedFrequency } from '../phonon/phononSession.js';
import { isExperimentalMode } from '../debug/experimentalMode.js';

export const BAND_PLOT_ID = 'phonon-band-plot';
export const MODEMAP_PLOT_ID = 'phonon-modemap-plot';

let plotResizeObserver = null;
let unsubscribe = null;
let modeMapClickHandler = null;
// The mode-map card can be put away (its ✕); a new scan brings it back.
let modeMapCardHidden = false;

export function setModeMapCardHidden(hidden) {
  modeMapCardHidden = !!hidden;
  const wrapper = document.getElementById(`${MODEMAP_PLOT_ID}-wrapper`);
  if (wrapper) wrapper.hidden = modeMapCardHidden || !phononState.modeMap;
  if (!modeMapCardHidden) safeRedraw(MODEMAP_PLOT_ID);
  resizePlot(BAND_PLOT_ID);
}

/** ui/PhononPanel.js registers how a click on a mode-map point should be
 *  handled (select the scan's trajectory frame). */
export function setModeMapClickHandler(fn) {
  modeMapClickHandler = fn;
}

function isPlotExpanded(plotId) {
  return !!document.getElementById(`${plotId}-wrapper`)?.classList.contains('expanded');
}

export async function redrawPhononPlot(plotId) {
  if (!document.getElementById(plotId)) return;
  if (plotId === BAND_PLOT_ID) {
    if (!phononState.dataset) return;
    await plotBands(BAND_PLOT_ID, {
      dataset: phononState.dataset, dos: phononState.dos, selected: phononState.selected,
    }, isPlotExpanded(BAND_PLOT_ID));
    onPhononPlotClick(BAND_PLOT_ID, (custom) => {
      if (custom && Number.isInteger(custom.iq) && Number.isInteger(custom.ib)) selectMode(custom.iq, custom.ib);
    });
  } else if (plotId === MODEMAP_PLOT_ID) {
    const mm = phononState.modeMap;
    const wrapper = document.getElementById(`${MODEMAP_PLOT_ID}-wrapper`);
    if (wrapper) wrapper.hidden = !mm || modeMapCardHidden;
    if (!mm || modeMapCardHidden) return;
    const phonopyAxis = phononState.qConvention === 'phonopy' && mm.phonopyFactor > 0;
    const perAtom = phononState.energyPerAtom && mm.supercell?.natom > 0;
    await plotModeMap(MODEMAP_PLOT_ID, {
      Q: mm.Q, energies: mm.energies, fit: mm.fit, analysis: mm.analysis,
      reference: mm.reference, phononFreq: mm.phononFreq ?? selectedFrequency(),
      xScale: phonopyAxis ? mm.phonopyFactor : 1,
      xLabel: phonopyAxis ? 'phonopy MODULATION amplitude (amu<sup>½</sup>·Å)' : 'Q, normal-mode coordinate (amu<sup>½</sup>·Å)',
      yScale: perAtom ? 1 / mm.supercell.natom : 1,
      yLabel: perAtom ? 'ΔE (meV / atom)' : 'ΔE (meV / supercell)',
    }, isPlotExpanded(MODEMAP_PLOT_ID));
    onPhononPlotClick(MODEMAP_PLOT_ID, (index) => { modeMapClickHandler?.(Number(index)); });
  }
}

function safeRedraw(plotId) {
  redrawPhononPlot(plotId).catch((error) => {
    // Offline (Plotly comes from a CDN, utils/plotlyLoader.js): the card
    // shows the message in place of the chart; that is a condition, not a
    // defect, so it does not go to console.error.
    const offline = /unavailable offline/.test(error?.message || '');
    if (!offline) console.error(error);
    const el = document.getElementById(plotId);
    if (el && !el.querySelector('.js-plotly-plot')) el.textContent = error.message || String(error);
  });
}

export function addPhononPlotsPanel(target = 'cvPanelBody-phononPlots') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="cv-plot-stack phonon-plot-stack">
      <div class="split-item" id="${BAND_PLOT_ID}-wrapper">
        <h4>Phonon bands — click a point to animate that mode</h4>
        <div id="${BAND_PLOT_ID}" class="split-item-body"></div>
        <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
        <div class="split-item-actions">
          <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="${BAND_PLOT_ID}" title="Toggle light/dark">🌓︎</button>
          <button type="button" class="split-item-action-btn" data-split-action="export" data-split-item="${BAND_PLOT_ID}" title="Export PNG">📥</button>
          <button type="button" class="split-item-action-btn" data-split-action="expand" data-split-item="${BAND_PLOT_ID}" title="Expand">⛶</button>
        </div>
      </div>
      ${isExperimentalMode() ? `
      <div class="split-item" id="${MODEMAP_PLOT_ID}-wrapper" hidden>
        <h4>Mode map — energy along the frozen mode</h4>
        <div id="${MODEMAP_PLOT_ID}" class="split-item-body"></div>
        <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
        <button type="button" class="ph-card-hide" data-split-action="hide-modemap" title="Put this card away (a new scan or Show plots brings it back)">✕</button>
        <div class="split-item-actions">
          <button type="button" class="split-item-action-btn" data-split-action="theme" data-split-item="${MODEMAP_PLOT_ID}" title="Toggle light/dark">🌓︎</button>
          <button type="button" class="split-item-action-btn" data-split-action="export" data-split-item="${MODEMAP_PLOT_ID}" title="Export PNG">📥</button>
          <button type="button" class="split-item-action-btn" data-split-action="expand" data-split-item="${MODEMAP_PLOT_ID}" title="Expand">⛶</button>
        </div>
      </div>
      ` : ''}
    </div>
  `;

  container.addEventListener('click', (ev) => {
    const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (ev.target).closest('[data-split-action]'));
    if (!btn) return;
    const action = btn.dataset.splitAction;
    const itemId = btn.dataset.splitItem ?? null;
    if (action === 'theme') {
      togglePlotTheme(itemId);
      safeRedraw(itemId);
    } else if (action === 'export') {
      exportPlotAsPNG(itemId).catch((error) => console.error('Phonon plot export failed:', error));
    } else if (action === 'expand') {
      expandSplitItem(btn.closest('.split-item'));
      safeRedraw(itemId);
    } else if (action === 'close') {
      closeExpandedSplitItem();
      safeRedraw(BAND_PLOT_ID);
      safeRedraw(MODEMAP_PLOT_ID);
    } else if (action === 'hide-modemap') {
      if (btn.closest('.split-item')?.classList.contains('expanded')) closeExpandedSplitItem();
      setModeMapCardHidden(true);
    }
  });

  plotResizeObserver?.disconnect();
  let resizeRaf = 0;
  plotResizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizePlot(BAND_PLOT_ID);
      resizePlot(MODEMAP_PLOT_ID);
    });
  });
  plotResizeObserver.observe(container.querySelector('.cv-plot-stack'));

  unsubscribe?.();
  unsubscribe = onPhononChange((event) => {
    if (event === 'dataset' || event === 'dos' || event === 'mode') safeRedraw(BAND_PLOT_ID);
    if (event === 'modemap') modeMapCardHidden = false;
    if (event === 'dataset' || event === 'modemap' || event === 'convention') safeRedraw(MODEMAP_PLOT_ID);
  });

  safeRedraw(BAND_PLOT_ID);
  safeRedraw(MODEMAP_PLOT_ID);
}

export function removePhononPlotsPanel() {
  plotResizeObserver?.disconnect();
  plotResizeObserver = null;
  unsubscribe?.();
  unsubscribe = null;
}
