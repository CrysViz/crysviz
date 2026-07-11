// Single-polyhedron distortion inspector: pick a polyhedron (or its centre
// atom) in the main 3D view and this shows its bond-length distortion index
// and bond-angle variance (CN4/CN6 only — see PolyhedraAnalysisModule.js),
// plus a small interactive 3D render of just that one polyhedron with every
// bond length and (non-trans) angle labelled directly on the geometry. Offered
// as both a floating panel and a split-view pane, mirroring the other
// AnalysisPanels — but unlike those, content here is selection-driven
// ('crysviz:polyhedron-selection-changed', dispatched by
// SelectAndHighlightModule.js) rather than a redraw-on-data-refresh chart.

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { openSplitView, closeSplitView, isSplitViewActive } from '../panels/SplitView.js';
import { activatePanelDisplay, deactivatePanelDisplay, activateSplitDisplay, deactivateSplitDisplay } from './histogramCoordinator.js';
import { createPolyhedronMiniRenderer } from './PolyhedronMiniRenderer.js';
import { computePolyhedronDetail } from '../../render/PolyhedraAnalysisModule.js';
import { subscribeToAtomSelection, getSelectedAtoms } from '../SelectAndHighlightModule.js';
import { fileBrowser, highlightHover, general } from '../../state/store.js';
import { updateVisualization } from '../../core/crystal-viewer.js';

const PANEL_ID = 'polyhedronInspector';

let floating = null; // { update() } while the floating panel is open
let split = null;    // { update() } while the split-view pane is open

// ---------------------------------------------------------------------------
// Force "Show Polyhedra" + "Complete Polyhedra" on while the inspector is
// open: the analysis (bond-length/angle metrics, and the bond half-colors
// mirrored into the mini render — see findBondHalfColors in
// PolyhedraAnalysisModule.js) needs the completed coordination shell, and
// gives wrong bond colors/metrics for an edge polyhedron whose shell is cut
// off at the unit-cell boundary when Complete Polyhedra is off. Reference-
// counted so having both the floating panel AND split view open at once
// still restores the user's own settings only once neither is open.
let forceRefCount = 0;
let priorPolyhedraSettings = null;
const REQUIRED_MSG = 'Required while the Polyhedron Inspector is open';

// checked always reflects the CURRENT general.* value (true while forced,
// the restored value once released) — never left stale from the forced state.
function setForcedControlsUI(forced) {
  for (const [id, stateKey] of [['showPolyhedra', 'showPolyhedra'], ['completePolyhedraToggle', 'completePolyhedra']]) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.disabled = forced;
    input.checked = general[stateKey];
    const row = input.closest('.toggle_row');
    if (row) {
      row.style.opacity = forced ? '0.5' : '';
      row.style.cursor = forced ? 'not-allowed' : '';
      row.title = forced ? REQUIRED_MSG : '';
    }
  }
}

function acquireForcedPolyhedraSettings() {
  forceRefCount += 1;
  if (forceRefCount > 1) return; // already forced by the other view
  priorPolyhedraSettings = {
    showPolyhedra: general.showPolyhedra,
    completePolyhedra: general.completePolyhedra,
  };
  general.showPolyhedra = true;
  general.completePolyhedra = true;
  setForcedControlsUI(true);
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

function releaseForcedPolyhedraSettings() {
  forceRefCount = Math.max(0, forceRefCount - 1);
  if (forceRefCount > 0) return; // still open elsewhere
  if (priorPolyhedraSettings) {
    general.showPolyhedra = priorPolyhedraSettings.showPolyhedra;
    general.completePolyhedra = priorPolyhedraSettings.completePolyhedra;
    priorPolyhedraSettings = null;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  }
  setForcedControlsUI(false);
}

// Idempotent per-view guards: the floating panel has two independent close
// paths (the exported removePolyhedronInspectorPanel() and the panel's own
// onClose callback) that don't call each other, so acquire/release must be
// safe to call more than once per logical open/close without double-counting
// the shared forceRefCount above.
let floatingForced = false;
let splitForced = false;
function acquireFloatingForce() {
  if (floatingForced) return;
  floatingForced = true;
  acquireForcedPolyhedraSettings();
}
function releaseFloatingForce() {
  if (!floatingForced) return;
  floatingForced = false;
  releaseForcedPolyhedraSettings();
}
function acquireSplitForce() {
  if (splitForced) return;
  splitForced = true;
  acquireForcedPolyhedraSettings();
}
function releaseSplitForce() {
  if (!splitForced) return;
  splitForced = false;
  releaseForcedPolyhedraSettings();
}

const FORCED_NOTICE_HTML = `
  <div style="font-size:10.5px; color:#cfe6ff; background:rgba(35,139,230,0.15); border:1px solid rgba(91,168,255,0.4); border-radius:6px; padding:6px 8px; margin-bottom:6px;">
    Show Polyhedra and Complete Polyhedra are turned on and locked while this inspector is open — an incomplete coordination shell gives wrong bond colors/metrics here.
  </div>
`;

/** The polyhedron currently being inspected, resolved from EITHER a directly
 *  selected polyhedron (face/mesh pick) OR a single selected ATOM that happens
 *  to be a polyhedron's centre — so clicking the central atom inspects its
 *  coordination polyhedron too, not only clicking the polyhedron body. */
function resolveInspectedPoly() {
  const polys = fileBrowser.selectedStructure?.polyhedra?.polyhedra ?? [];
  if (!polys.length) return null;

  const key = highlightHover.currentlyHighlightedPolyhedron?.key ?? null;
  if (key) {
    const byKey = polys.find((p) => p.key === key);
    if (byKey) return byKey;
  }

  const selected = getSelectedAtoms();
  if (selected.length === 1) {
    const src = selected[0].sourceIndex;
    const byCenter = polys.find((p) => p.type === 'centered' && p.centerIndex === src);
    if (byCenter) return byCenter;
  }
  return null;
}

function currentDetail() {
  const structure = fileBrowser.selectedStructure;
  const poly = resolveInspectedPoly();
  return poly ? computePolyhedronDetail(structure, poly) : null;
}

function refreshAll(opts = {}) {
  floating?.update(opts);
  split?.update(opts);
}

document.addEventListener('crysviz:polyhedron-selection-changed', () => refreshAll());
// Selecting the central atom (rather than the polyhedron body) inspects the
// same polyhedron — driven off the atom-selection subscription instead.
subscribeToAtomSelection(() => refreshAll());
// A rebuild can shift the selected polyhedron's exact geometry (or drop it
// entirely) without a selection-change event firing — refresh either way.
// keepCamera:true: most rebuilds (e.g. an Element Color Map switch, which
// goes through updateVisualization()'s reRenderPolyhedra default) don't
// actually move this polyhedron's geometry, so don't snap the mini
// viewport's camera back to the auto-framed view for those. setDetail()
// still resets the camera on its own if the polyhedron was dropped by the
// rebuild and a later one brings it back (hasFramed resets to false when
// detail goes null), so a genuine reappearance still reframes correctly.
document.addEventListener('crysviz:polyhedra-rebuilt', () => refreshAll({ keepCamera: true }));
// Recolouring an atom or a polyhedron (individually or by element/category)
// doesn't touch geometry or selection, so neither event above fires — but
// currentDetail() resolves colours fresh every call, so a plain refresh is
// enough to pick the new colour up. keepCamera:true so a pure colour change
// doesn't reset the orbit/zoom the user has dialed into this mini viewport.
document.addEventListener('crysviz:colors-changed', () => refreshAll({ keepCamera: true }));

function fmt(n, digits = 4) { return Number.isFinite(n) ? n.toFixed(digits) : '—'; }

// Local polyhedron-face opacity for the mini render only — independent of the
// main structure's polyhedra opacity setting, shared across Panel/Split View
// and persisted across selections (picking a different polyhedron keeps
// whatever opacity you dialed in here).
let localFaceOpacity = 0.4;

/** Slider controlling just the mini view's polyhedron face opacity. */
function buildOpacityControl(container, mini) {
  container.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; padding:2px 8px 8px; font-size:11.5px; color:#ccc;">
      <span style="flex:0 0 auto;">Polyhedron opacity</span>
      <input type="range" min="0" max="100" value="${Math.round(localFaceOpacity * 100)}" class="pi-opacity-slider" style="flex:1;">
      <span class="pi-opacity-label" style="width:34px; text-align:right; font-family:monospace;">${Math.round(localFaceOpacity * 100)}%</span>
    </div>
  `;
  const slider = container.querySelector('.pi-opacity-slider');
  const label = container.querySelector('.pi-opacity-label');
  slider.addEventListener('input', () => {
    localFaceOpacity = parseInt(slider.value, 10) / 100;
    label.textContent = `${slider.value}%`;
    mini.setFaceOpacity(localFaceOpacity);
  });
}

/** Fills the small text summary above/below the mini render. */
function renderSummary(container, detail) {
  if (!detail) {
    container.innerHTML = '<div style="padding:10px; font-size:12px; color:#999; text-align:center;">Click a polyhedron (or its centre atom) in the 3D view to inspect it.</div>';
    return;
  }
  const rows = [
    ['Category', detail.catLabel ?? '—'],
    ['Coordination number', String(detail.cn)],
    ['Bond-length distortion', detail.bld != null ? fmt(detail.bld, 4) : 'n/a (cage — no centre)'],
    [detail.angleLabel ? `${detail.angleLabel} (angle variance, °²)` : 'Angle variance',
      detail.angleVariance != null ? fmt(detail.angleVariance, 2) : 'n/a (only CN4/CN6)'],
  ];
  container.innerHTML = `
    <div style="font-size:11.5px; color:#ddd; display:grid; grid-template-columns:auto 1fr; gap:2px 10px; padding:6px 8px;">
      ${rows.map(([k, v]) => `<span style="color:#999;">${k}</span><span style="text-align:right; font-family:monospace;">${v}</span>`).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Floating / dockable panel
// ---------------------------------------------------------------------------

export function removePolyhedronInspectorPanel() {
  floating = null;
  removePanel(PANEL_ID);
  deactivatePanelDisplay(removePolyhedronInspectorPanel);
  releaseFloatingForce();
}

export function addPolyhedronInspectorPanel() {
  removePolyhedronInspectorPanel();
  activatePanelDisplay(removePolyhedronInspectorPanel);
  acquireFloatingForce();

  const isMobile = window.innerWidth < 700;
  const panel = registerPanel({
    id: PANEL_ID,
    title: 'Polyhedron Inspector',
    lifecycle: 'persistent',
    infoMd: './data/polyhedronInspectorInfo.md',
    closable: true,
    onClose() {
      mini?.dispose();
      floating = null;
      resizeObserver?.disconnect();
      deactivatePanelDisplay(removePolyhedronInspectorPanel);
      releaseFloatingForce();
    },
    buildContent(body) {
      body.innerHTML = `
        <div style="padding:6px; box-sizing:border-box; width: min(90vw, 560px); max-width: 100%;">
          ${FORCED_NOTICE_HTML}
          <div id="piSummary"></div>
          <div id="piViewport" style="width:100%; height:320px; border-radius:6px; overflow:hidden; background:rgba(255,255,255,0.03);"></div>
          <div id="piOpacityControl"></div>
        </div>
      `;
    },
    defaults: {
      docked: false, collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 30 },
    },
  });

  const body = panel.body;
  const viewport = body.querySelector('#piViewport');
  const summaryEl = body.querySelector('#piSummary');
  const mini = createPolyhedronMiniRenderer(viewport);
  mini.resize();
  mini.start();
  buildOpacityControl(body.querySelector('#piOpacityControl'), mini);

  function update(opts = {}) {
    const detail = currentDetail();
    renderSummary(summaryEl, detail);
    mini.setDetail(detail, { faceOpacity: localFaceOpacity, keepCamera: opts.keepCamera });
  }

  const resizeObserver = new ResizeObserver(() => mini.resize());
  resizeObserver.observe(viewport);

  floating = { update };
  update();
}

// ---------------------------------------------------------------------------
// Split view
// ---------------------------------------------------------------------------

let splitMini = null;

function renderSplitContent(body) {
  body.innerHTML = `
    <div class="split-item" id="polyhedron-inspector-item">
      <h4>Polyhedron Inspector</h4>
      ${FORCED_NOTICE_HTML}
      <div id="piSplitSummary"></div>
      <div id="piSplitViewport" class="split-item-body"></div>
      <div id="piSplitOpacityControl"></div>
      <button type="button" class="split-item-close-btn" data-split-action="close" title="Close expanded view">✕</button>
    </div>
  `;

  const viewport = body.querySelector('#piSplitViewport');
  const summaryEl = body.querySelector('#piSplitSummary');
  splitMini = createPolyhedronMiniRenderer(viewport);
  splitMini.resize();
  splitMini.start();
  buildOpacityControl(body.querySelector('#piSplitOpacityControl'), splitMini);

  function update(opts = {}) {
    const detail = currentDetail();
    renderSummary(summaryEl, detail);
    splitMini.setDetail(detail, { faceOpacity: localFaceOpacity, keepCamera: opts.keepCamera });
  }

  split = { update };
  update();
}

const splitOwner = {
  title: 'Polyhedron Inspector',
  render: renderSplitContent,
  onResize() { splitMini?.resize(); },
  onClose() {
    splitMini?.dispose();
    splitMini = null;
    split = null;
    deactivateSplitDisplay(closePolyhedronInspectorSplitView);
    releaseSplitForce();
  },
};

export function openPolyhedronInspectorSplitView() {
  activateSplitDisplay(closePolyhedronInspectorSplitView);
  acquireSplitForce();
  openSplitView(splitOwner);
}

export function closePolyhedronInspectorSplitView() {
  closeSplitView(splitOwner);
}

export function isPolyhedronInspectorSplitViewActive() {
  return isSplitViewActive(splitOwner);
}
