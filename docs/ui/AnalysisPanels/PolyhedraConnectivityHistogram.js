// Polyhedra connectivity analysis: how neighbouring polyhedra connect —
// corner/edge/face vertex-sharing, plus two "bond-bridged" categories for
// polyhedra that share no vertex at all but are chemically linked by real
// bonds (common in nitride-type networks): a direct bond between a vertex of
// each ("Bond-bridge"), or the same via one intermediate atom ("Trimer-bridge",
// vertex–bond–atom–bond–vertex). See render/PolyhedraAnalysisModule.js for the
// detection. Offered as a summary bar chart (grouped by sharing type x
// polyhedron-pair category) plus a drill-down list of the individual
// connections, both as a floating panel and a split-view pane, mirroring
// BondLengthHistogram.js. Clicking a bar or a list row highlights the LINK
// itself: for corner/edge/face sharing that's just the shared vertex atom(s)
// (the "corners"), not every atom of both polyhedra; for the two bond-bridge
// categories it's the actual connecting bond(s), not any atoms.

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { openSplitView, closeSplitView, isSplitViewActive } from '../panels/SplitView.js';
import {
  renderGroupedHistogram, onHistogramBarClick, exportHistogramPNG, resizeHistogramPlot, clearHistogramPlot,
} from './histogramPlotly.js';
import { highlightAtomsIn3D, highlightBondIn3D, clearAllHighlights } from '../SelectAndHighlightModule.js';
import { activatePanelDisplay, deactivatePanelDisplay, activateSplitDisplay, deactivateSplitDisplay } from './histogramCoordinator.js';
import { subscribePolyhedraAnalysis } from './polyhedraAnalysisHub.js';

const PANEL_ID = 'polyhedraConnectivityHistogram';
const FLOAT_PLOT_ID = 'polyhedraConnectivityPlot';
const SPLIT_PLOT_ID = 'polyhedraConnectivitySplitPlot';

const SHARING_LABELS = {
  corner: 'Corner', edge: 'Edge', face: 'Face', bond1: 'Bond-bridge', bond2: 'Trimer-bridge',
};
const SHARING_KEYS = ['corner', 'edge', 'face', 'bond1', 'bond2'];
const BOND_SHARING = new Set(['bond1', 'bond2']);

let connections = []; // latest computePolyhedraConnectivity() rows
let floating = null;
let split = null;

subscribePolyhedraAnalysis((data) => {
  connections = data.connectivity;
  floating?.redraw();
  split?.redraw();
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
  container.style.cssText = 'max-height:180px; overflow-y:auto; border:1px solid rgba(255,255,255,0.12); border-radius:6px; margin-top:8px;';

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

// ---------------------------------------------------------------------------
// Floating / dockable panel
// ---------------------------------------------------------------------------

export function removePolyhedraConnectivityHistogramPanel() {
  floating = null;
  removePanel(PANEL_ID);
  deactivatePanelDisplay(removePolyhedraConnectivityHistogramPanel);
}

export function addPolyhedraConnectivityHistogramPanel() {
  removePolyhedraConnectivityHistogramPanel();
  activatePanelDisplay(removePolyhedraConnectivityHistogramPanel);

  const isMobile = window.innerWidth < 700;
  const panel = registerPanel({
    id: PANEL_ID,
    title: 'Polyhedra Connectivity',
    lifecycle: 'persistent',
    infoMd: './data/polyhedraConnectivityHistogramInfo.md',
    closable: true,
    onClose() { floating = null; resizeObserver?.disconnect(); clearHistogramPlot(FLOAT_PLOT_ID); deactivatePanelDisplay(removePolyhedraConnectivityHistogramPanel); },
    buildContent(body) {
      body.innerHTML = `
        <div style="padding:6px; box-sizing:border-box; width: min(90vw, 640px); max-width: 100%;">
          <div id="${FLOAT_PLOT_ID}" style="width:100%; height:300px;"></div>
          <div id="pcFloatList"></div>
        </div>
      `;
    },
    defaults: {
      docked: false, collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 40 },
    },
  });

  const onBarClick = makeClickHandler();

  function redraw() {
    renderGroupedHistogram(FLOAT_PLOT_ID, { groups: computeGroups(), xTitle: 'Polyhedron pair', yTitle: 'Connections' })
      .then(() => onHistogramBarClick(FLOAT_PLOT_ID, onBarClick));
    buildPairList(panel.body.querySelector('#pcFloatList'));
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
    <div class="split-item" id="polyhedra-connectivity-histogram-item">
      <h4>Polyhedra Connectivity</h4>
      <div id="${SPLIT_PLOT_ID}" class="split-item-body"></div>
      <div id="pcSplitList"></div>
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
    renderGroupedHistogram(SPLIT_PLOT_ID, { groups: computeGroups(), xTitle: 'Polyhedron pair', yTitle: 'Connections', isExpanded: expanded })
      .then(() => onHistogramBarClick(SPLIT_PLOT_ID, onBarClick));
    buildPairList(body.querySelector('#pcSplitList'));
  }

  split = {
    redraw,
    setExpanded(v) { expanded = v; redraw(); },
  };
  redraw();
}

function handleAction(action) {
  if (action === 'export') exportHistogramPNG(SPLIT_PLOT_ID).catch((error) => console.error('Polyhedra connectivity histogram export failed:', error));
}

function handleExpandChange(itemId, isExpanded) {
  split?.setExpanded(!!isExpanded);
}

const splitOwner = {
  title: 'Polyhedra Connectivity',
  render: renderSplitContent,
  onAction: handleAction,
  onExpandChange: handleExpandChange,
  onResize() { resizeHistogramPlot(SPLIT_PLOT_ID); },
  onClose() { split = null; clearHistogramPlot(SPLIT_PLOT_ID); deactivateSplitDisplay(closePolyhedraConnectivityHistogramSplitView); },
};

export function openPolyhedraConnectivityHistogramSplitView() {
  activateSplitDisplay(closePolyhedraConnectivityHistogramSplitView);
  openSplitView(splitOwner);
}

export function closePolyhedraConnectivityHistogramSplitView() {
  closeSplitView(splitOwner);
}

export function isPolyhedraConnectivityHistogramSplitViewActive() {
  return isSplitViewActive(splitOwner);
}
