// Single-polyhedron distortion inspector: pick a polyhedron (or its centre
// atom) in the main 3D view and this shows its bond-length distortion index
// and bond-angle variance (CN4/CN6 only — see PolyhedraAnalysisModule.js),
// plus a small interactive 3D render of just that one polyhedron with every
// bond length and (non-trans) angle labelled directly on the geometry. ONE
// ordinary panel window that defaults to the side dock, mirroring the other
// AnalysisPanels — but unlike those, content here is selection-driven
// ('crysviz:polyhedron-selection-changed', dispatched by
// SelectAndHighlightModule.js) rather than a redraw-on-data-refresh chart.

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { createPolyhedronMiniRenderer } from './PolyhedronMiniRenderer.js';
import { computePolyhedronDetail } from '../../render/PolyhedraAnalysisModule.js';
import { subscribeToAtomSelection, getSelectedAtoms } from '../SelectAndHighlightModule.js';
import { fileBrowser, highlightHover, general } from '../../state/store.js';
import { updateVisualization } from '../../core/crystal-viewer.js';

const PANEL_ID = 'polyhedronInspector';

let view = null; // { update(opts) } while the window is open

// ---------------------------------------------------------------------------
// Force "Show Polyhedra" + "Complete Polyhedra" on while the inspector is
// open: the analysis (bond-length/angle metrics, and the bond half-colors
// mirrored into the mini render — see findBondHalfColors in
// PolyhedraAnalysisModule.js) needs the completed coordination shell, and
// gives wrong bond colors/metrics for an edge polyhedron whose shell is cut
// off at the unit-cell boundary when Complete Polyhedra is off.
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
      row.classList.toggle('is-forced-disabled', forced);
      row.title = forced ? REQUIRED_MSG : '';
    }
  }
}

// Idempotent: the window has two independent close paths (the exported
// removePolyhedronInspectorPanel() and the panel's own onClose callback)
// that don't call each other, so acquire/release must be safe to call more
// than once per logical open/close.
let forced = false;
function acquireForcedPolyhedraSettings() {
  if (forced) return;
  forced = true;
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
  if (!forced) return;
  forced = false;
  if (priorPolyhedraSettings) {
    general.showPolyhedra = priorPolyhedraSettings.showPolyhedra;
    general.completePolyhedra = priorPolyhedraSettings.completePolyhedra;
    priorPolyhedraSettings = null;
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  }
  setForcedControlsUI(false);
}

const FORCED_NOTICE_HTML = `
  <div class="pi-forced-notice">
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
  view?.update(opts);
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
// main structure's polyhedra opacity setting, persisted across selections and
// across closing/reopening the window (picking a different polyhedron keeps
// whatever opacity you dialed in here).
let localFaceOpacity = 0.4;

/** Slider controlling just the mini view's polyhedron face opacity. */
function buildOpacityControl(container, mini) {
  container.innerHTML = `
    <div class="pi-opacity-row">
      <span class="pi-opacity-text">Polyhedron opacity</span>
      <input type="range" min="0" max="100" value="${Math.round(localFaceOpacity * 100)}" class="pi-opacity-slider">
      <span class="pi-opacity-label">${Math.round(localFaceOpacity * 100)}%</span>
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
    container.innerHTML = '<div class="pi-summary-empty">Click a polyhedron (or its centre atom) in the 3D view to inspect it.</div>';
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
    <div class="pi-summary-grid">
      ${rows.map(([k, v]) => `<span class="pi-summary-key">${k}</span><span class="pi-summary-val">${v}</span>`).join('')}
    </div>
  `;
}

export function removePolyhedronInspectorPanel() {
  view = null;
  removePanel(PANEL_ID);
  releaseForcedPolyhedraSettings();
}

/** The single entry point (the Polyhedra window's "Inspector" button): opens
 *  the window — side-dock front tab by default, or wherever the user last
 *  dragged it — creating it on first use. */
export function addPolyhedronInspectorPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  acquireForcedPolyhedraSettings();

  const isMobile = window.innerWidth < 700;
  let resizeObserver = null;
  let mini = null;
  registerPanel({
    id: PANEL_ID,
    title: 'Polyhedron Inspector',
    lifecycle: 'persistent',
    infoMd: './data/polyhedronInspectorInfo.md',
    closable: true,
    onClose() {
      mini?.dispose();
      mini = null;
      view = null;
      resizeObserver?.disconnect();
      releaseForcedPolyhedraSettings();
    },
    buildContent(body) {
      body.innerHTML = `
        <div class="cv-plot-stack">
          <div class="split-item" id="polyhedron-inspector-item">
            <h4>Polyhedron Inspector</h4>
            ${FORCED_NOTICE_HTML}
            <div id="piSummary"></div>
            <div id="piViewport" class="split-item-body pi-viewport"></div>
            <div id="piOpacityControl"></div>
          </div>
        </div>
      `;

      const viewport = body.querySelector('#piViewport');
      const summaryEl = body.querySelector('#piSummary');
      mini = createPolyhedronMiniRenderer(viewport);
      mini.resize();
      mini.start();
      buildOpacityControl(body.querySelector('#piOpacityControl'), mini);

      function update(opts = {}) {
        const detail = currentDetail();
        renderSummary(summaryEl, detail);
        mini.setDetail(detail, { faceOpacity: localFaceOpacity, keepCamera: opts.keepCamera });
      }

      resizeObserver = new ResizeObserver(() => mini?.resize());
      resizeObserver.observe(viewport);

      view = { update };
      update();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 30 },
    },
  });
  openPanel(PANEL_ID);
}
