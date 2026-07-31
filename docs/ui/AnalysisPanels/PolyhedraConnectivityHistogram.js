// Polyhedra connectivity analysis: how neighbouring polyhedra connect —
// corner/edge/face vertex-sharing, plus two "bond-bridged" categories for
// polyhedra that share no vertex at all but are chemically linked by real
// bonds (common in nitride-type networks): a direct bond between a vertex of
// each ("Bond-bridge"), or the same via one intermediate atom ("Trimer-bridge",
// vertex–bond–atom–bond–vertex). See render/PolyhedraAnalysisModule.js for the
// detection. Offered as a summary bar chart (grouped by sharing type x
// polyhedron-pair category) plus a drill-down list of the individual
// connections, in ONE ordinary panel window that defaults to the right dock,
// mirroring BondLengthHistogram.js. Clicking a bar or a list row highlights
// the LINK itself: for corner/edge/face sharing that's just the shared vertex
// atom(s) (the "corners"), not every atom of both polyhedra; for the two
// bond-bridge categories it's the actual connecting bond(s), not any atoms.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { expandSplitItem, closeExpandedSplitItem } from '../panels/RightDock.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
  togglePlotTheme,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, highlightBondIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { subscribePolyhedraAnalysis } from './polyhedraAnalysisHub.js';

const PANEL_ID = 'polyhedraConnectivityHistogram';
const PLOT_ID = 'polyhedraConnectivityPlot';

const SHARING_LABELS = {
  corner: 'Corner', edge: 'Edge', face: 'Face', bond1: 'Bond-bridge', bond2: 'Trimer-bridge',
};
const SHARING_KEYS = ['corner', 'edge', 'face', 'bond1', 'bond2'];
const BOND_SHARING = new Set(['bond1', 'bond2']);

let connections = []; // latest computePolyhedraConnectivity() rows
let view = null;

subscribePolyhedraAnalysis((data) => {
  connections = data.connectivity;
  view?.redraw();
});

function pairLabelOf(conn) {
  return [conn.labelA, conn.labelB].sort().join(' – ');
}

function highlightConnection(conn) {
  if (BOND_SHARING.has(conn.sharing)) highlightBondIn3D(conn.highlightBondInstanceIds ?? []);
  else highlightAtomsIn3D(conn.highlightAtomIndices ?? []);
}

function computeGroups() {
  const pairLabels = [...new Set(connections.map(pairLabelOf))].sort();
  const groups = SHARING_KEYS.map((sharing) => {
    const y = new Array(pairLabels.length).fill(0);
    const isBonds = BOND_SHARING.has(sharing);
    const ids = Array.from({ length: pairLabels.length }, () => []);
    for (const conn of connections) {
      if (conn.sharing !== sharing) continue;
      const idx = pairLabels.indexOf(pairLabelOf(conn));
      y[idx] += 1;
      ids[idx].push(...(isBonds ? (conn.highlightBondInstanceIds ?? []) : (conn.highlightAtomIndices ?? [])));
    }
    const customdata = ids.map((list) => ({ kind: isBonds ? 'bonds' : 'atoms', ids: list }));
    return { label: SHARING_LABELS[sharing], x: pairLabels, y, customdata };
  }).filter((g) => g.y.some((v) => v > 0));
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
    if (customdata?.ids?.length) {
      if (customdata.kind === 'bonds') highlightBondIn3D(customdata.ids);
      else highlightAtomsIn3D(customdata.ids);
      lastKey = key;
    }
  };
}

/** Scrollable drill-down list of individual connections, one row each. */
function buildPairList(container) {
  container.innerHTML = '';
  container.style.cssText = 'max-height:180px; overflow-y:auto; border:1px solid rgba(255,255,255,0.12); border-radius:6px; margin-top:8px; flex:0 0 auto;';

  if (!connections.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No polyhedra connections found.';
    empty.style.cssText = 'padding:8px; font-size:12px; color:#999; text-align:center;';
    container.appendChild(empty);
    return;
  }

  let lastRow = null;
  connections.forEach((conn) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 8px; font-size:11.5px; color:#ddd; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.06);';

    const label = document.createElement('span');
    label.textContent = pairLabelOf(conn);
    label.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

    const badge = document.createElement('span');
    badge.textContent = SHARING_LABELS[conn.sharing];
    badge.style.cssText = 'flex:0 0 auto; font-size:10.5px; padding:1px 6px; border-radius:8px; background:rgba(255,255,255,0.12); color:#ccc;';

    row.append(label, badge);
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.06)'; });
    row.addEventListener('mouseleave', () => { if (row !== lastRow) row.style.background = ''; });
    row.addEventListener('click', () => {
      if (lastRow === row) {
        clearAllHighlights();
        row.style.background = '';
        lastRow = null;
        return;
      }
      if (lastRow) lastRow.style.background = '';
      highlightConnection(conn);
      row.style.background = 'rgba(80,160,255,0.18)';
      lastRow = row;
    });
    container.appendChild(row);
  });
}

export function removePolyhedraConnectivityHistogramPanel() {
  view = null;
  removePanel(PANEL_ID);
}

/** The single entry point (the Polyhedra window's "Connectivity" button):
 *  opens the window — right-dock front tab by default, or wherever the user
 *  last dragged it — creating it on first use. */
export function addPolyhedraConnectivityHistogramPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Polyhedra Connectivity',
    lifecycle: 'persistent',
    infoMd: './data/polyhedraConnectivityHistogramInfo.md',
    closable: true,
    onClose() { view = null; resizeObserver?.disconnect(); clearHistogramPlot(PLOT_ID); },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="polyhedra-connectivity-histogram-item">
            <h4>Polyhedra Connectivity</h4>
            <div id="${PLOT_ID}" class="split-item-body"></div>
            <div id="pcList"></div>
            <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
            <div class="split-item-actions">
              <button type="button" class="split-item-action-btn" data-split-action="theme" title="Toggle light/dark">🌓</button>
              <button type="button" class="split-item-action-btn" data-split-action="export" title="Export PNG">📥</button>
              <button type="button" class="split-item-action-btn" data-split-action="expand" title="Expand">⛶</button>
            </div>
          </div>
        </div>
      `;

      const onBarClick = makeClickHandler();
      let expanded = false;

      function redraw() {
        renderGroupedHistogram(PLOT_ID, { groups: computeGroups(), xTitle: 'Polyhedron pair', yTitle: 'Connections', isExpanded: expanded })
          .then(() => onHistogramBarClick(PLOT_ID, onBarClick));
        buildPairList(body.querySelector('#pcList'));
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
          exportHistogramPNG(PLOT_ID).catch((error) => console.error('Polyhedra connectivity histogram export failed:', error));
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
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 40 },
    },
  });
  openPanel(PANEL_ID);
}
