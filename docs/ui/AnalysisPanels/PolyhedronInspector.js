// Single-polyhedron distortion inspector: pick a polyhedron (or its centre
// atom) in the main 3D view and this shows its convex-hull volume, bond-length
// distortion index and bond-angle variance (that variance number is CN4/CN6
// only — see PolyhedraAnalysisModule.js), plus a small interactive 3D render of
// just that one polyhedron with every bond length and (non-trans) angle
// labelled directly on the geometry. ONE ordinary panel window that defaults to
// the right dock, mirroring the other AnalysisPanels — but unlike those,
// content here is selection-driven ('crysviz:polyhedron-selection-changed',
// dispatched by SelectAndHighlightModule.js) rather than a redraw-on-data-
// refresh chart. A selection of several atoms is the Selection Inspector's
// (SelectionInspector.js).
//
// Lengths/Angles switches hide a kind of label, a click hides one label, and
// "Show all labels" brings them back (inspectorLabels.js). Double-clicking
// the mini view glows the same polyhedron back in the main structure (without
// opening the Structure Info panel).

import { registerPanel, removePanel, getPanel, openPanel } from '../panels/PanelManager.js';
import { createPolyhedronMiniRenderer } from './PolyhedronMiniRenderer.js';
import { createLabelState, labelToolbarHtml, wireLabelToolbar } from './inspectorLabels.js';
import { computePolyhedronDetail, convexHullVolume, polyhedronDistortion } from '../../render/PolyhedraAnalysisModule.js';
import { placedAtomKey, bondLabelKey, angleLabelKey } from '../../render/SelectionAnalysisModule.js';
import { subscribeToAtomSelection, getSelectedAtoms, highlightPolyhedronByKey } from '../SelectAndHighlightModule.js';
import { fileBrowser, highlightHover, general } from '../../state/store.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { modelErrors, placedSu, formatWithSu } from '../../model/cifErrors.js';

const PANEL_ID = 'polyhedronInspector';

let view = null; // { update(opts), state() } while the window is open

// ---------------------------------------------------------------------------
// Force "Show Polyhedra" + "Complete Polyhedra" on while the inspector is
// open: the analysis (bond-length/angle metrics, and the bond half-colors
// mirrored into the mini render — see renderedBondLookup in
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

/** A polyhedron detail as a mini-view model: centre + vertices, centre–vertex
 *  bonds, the angles its metric is defined over (trans pairs, a near-constant
 *  180°, would only clutter), and the hull. Label keys are the same ones the
 *  Selection Inspector uses (render/SelectionAnalysisModule.js). */
function polyhedronModel(detail) {
  if (!detail) return null;
  const atoms = [];
  const bonds = [];
  const angles = [];
  const centred = !!detail.centerCart;
  if (centred) {
    atoms.push({
      key: placedAtomKey(detail.centerIndex, detail.centerCart), pos: detail.centerCart, srcIndex: detail.centerIndex,
      color: detail.centerColor, element: detail.centerElement, radius: detail.centerRadius,
    });
  }
  const off = atoms.length;
  detail.vertices.forEach((v) => {
    atoms.push({
      key: placedAtomKey(v.srcIndex ?? -1, v.pos), pos: v.pos, srcIndex: v.srcIndex,
      color: v.color, element: v.element, radius: v.radius,
    });
  });
  if (centred) {
    detail.vertices.forEach((v, i) => {
      bonds.push({
        key: bondLabelKey(atoms[0].key, atoms[off + i].key), a: 0, b: off + i,
        colorA: v.bondColorNear, colorB: v.bondColorFar, length: v.bondLength,
        trimA: v.bondTrimNear, trimB: v.bondTrimFar,
        // Toward the vertex, clear of the arc cluster at the centre.
        labelAt: 0.62,
      });
    });
    for (const a of detail.angles) {
      if (a.kind === 'trans') continue;
      angles.push({
        key: angleLabelKey(atoms[0].key, atoms[off + a.i].key, atoms[off + a.j].key),
        at: 0, i: off + a.i, j: off + a.j, angleDeg: a.angleDeg,
      });
    }
  }
  // The CIF errors of the lengths and angles (model/cifErrors.js), while
  // "Show CIF Errors" is on and the atoms are still the CIF's.
  const structure = fileBrowser.selectedStructure;
  const errors = general.showCifErrors !== false && structure?.cifErrors
    ? modelErrors(structure, atoms, bonds, angles) : null;
  return {
    atoms,
    bonds: bonds.map((b, k) => ({ ...b, lengthSu: errors?.bonds[k] ?? null })),
    angles: angles.map((g, k) => ({ ...g, angleSu: errors?.angles[k] ?? null })),
    hull: detail.vertices.length >= 4 ? {
      points: detail.vertices.map((v) => v.pos),
      faceColor: detail.faceColor, faceOpacity: detail.faceOpacity, edgeColor: detail.edgeColor,
    } : null,
  };
}

// Local polyhedron-face opacity for the mini render only — independent of the
// main structure's polyhedra opacity setting, persisted across selections and
// across closing/reopening the window (picking a different polyhedron keeps
// whatever opacity you dialed in here).
let localFaceOpacity = 0.4;

// The label switches and the clicked-away labels, persisted the same way.
const labels = createLabelState();

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

/**
 * The CIF errors of the summary's numbers (model/cifErrors.js), each through
 * the same function that computes it: the volume of the vertices' hull, and
 * the distortion index and angle variance of centre + vertices. Null while
 * "Show CIF Errors" is off or the structure has none.
 */
function summaryErrors(detail) {
  const structure = fileBrowser.selectedStructure;
  if (!detail || general.showCifErrors === false || !structure?.cifErrors) return null;
  const vertices = detail.vertices.map((v) => ({ srcIndex: v.srcIndex, pos: v.pos }));
  const volume = detail.volume != null ? placedSu(structure, vertices, (P) => convexHullVolume(P)) : null;
  let bld = null, angleVariance = null;
  if (detail.centerCart) {
    const placed = [{ srcIndex: detail.centerIndex, pos: detail.centerCart }, ...vertices];
    const metric = (key) => placedSu(structure, placed, (P) => polyhedronDistortion(P[0], P.slice(1), detail.angles)[key]);
    if (detail.bld != null) bld = metric('bld');
    if (detail.angleVariance != null) angleVariance = metric('angleVariance');
  }
  return { volume, bld, angleVariance };
}

/** Fills the small text summary above the mini render. */
function renderSummary(container, detail, errors = null) {
  if (!detail) {
    container.innerHTML = '<div class="pi-summary-empty">Click a polyhedron (or its centre atom) in the 3D view to inspect it.</div>';
    return;
  }
  const rows = [
    ['Category', detail.catLabel ?? '—'],
    ['Coordination number', String(detail.cn)],
    ['Volume', detail.volume != null ? `${formatWithSu(detail.volume, errors?.volume, 3)} Å³` : 'n/a (degenerate hull)'],
    ['Bond-length distortion', detail.bld != null ? formatWithSu(detail.bld, errors?.bld, 4) : 'n/a (cage — no centre)'],
    [detail.angleLabel ? `${detail.angleLabel} (angle variance, °²)` : 'Angle variance',
      detail.angleVariance != null ? formatWithSu(detail.angleVariance, errors?.angleVariance, 2) : 'n/a (only CN4/CN6)'],
  ];
  // Say where the numbers in parentheses come from, once any are shown.
  if (errors && Object.values(errors).some((v) => v > 0)) rows.push(['Errors', 's.u. from the CIF']);
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

/** The current inspection, for tests and the console. */
export function getInspectorState() {
  return view?.state() ?? null;
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
            <div class="pi-controls">${labelToolbarHtml('pi', labels)}</div>
            <div class="pi-hint" id="piHint"></div>
            <div id="piSummary"></div>
            <div id="piViewport" class="split-item-body pi-viewport"></div>
            <div id="piOpacityControl"></div>
          </div>
        </div>
      `;

      const viewport = body.querySelector('#piViewport');
      const summaryEl = body.querySelector('#piSummary');
      const hintEl = body.querySelector('#piHint');
      mini = createPolyhedronMiniRenderer(viewport);
      const POLY_HINT = 'Point at a label (tap, on touch) and press its × to hide it. Double-click the polyhedron to highlight it in the structure.';
      let hintShown = false;
      const setHint = () => {
        hintEl.textContent = !hintShown ? ''
          : labels.placing ? 'Drag a label to place it. Press Move labels again to rotate the view.' : POLY_HINT;
      };
      const labelBar = wireLabelToolbar(body, 'pi', labels, mini, undefined, setHint);
      mini.resize();
      mini.start();
      buildOpacityControl(body.querySelector('#piOpacityControl'), mini);

      // Double-click the mini viewport → glow this polyhedron in the main 3D
      // view (no Structure panel opened). The inspector only ever shows one
      // polyhedron, so any double-click means "this one".
      viewport.addEventListener('dblclick', () => {
        const poly = resolveInspectedPoly();
        if (poly?.key) highlightPolyhedronByKey(poly.key, poly.catKey);
      });

      function update(opts = {}) {
        const poly = resolveInspectedPoly();
        const detail = poly ? computePolyhedronDetail(fileBrowser.selectedStructure, poly) : null;
        shownPolyKey = detail?.key ?? null;
        renderSummary(summaryEl, detail, summaryErrors(detail));
        hintShown = !!detail;
        setHint();
        mini.setModel(polyhedronModel(detail), { faceOpacity: localFaceOpacity, keepCamera: opts.keepCamera });
        labelBar.refresh();
      }

      resizeObserver = new ResizeObserver(() => mini?.resize());
      resizeObserver.observe(viewport);

      view = {
        update,
        state: () => ({
          polyKey: shownPolyKey,
          summary: summaryEl.textContent,
          hiddenLabels: [...labels.hidden],
          labels: mini?.getLabels() ?? [],
          atomScreen: mini?.getAtomScreenPositions() ?? [],
          viewport: (({ left, top, right, bottom }) => ({ left, top, right, bottom }))(viewport.getBoundingClientRect()),
        }),
      };
      update();
    },
    defaults: {
      dock: 'right', collapsed: false, barCollapsed: false,
      anchor: isMobile ? { left: 4, top: 10 } : { left: 20, top: 30 },
    },
  });
  openPanel(PANEL_ID);
}

function refreshAll(opts = {}) {
  view?.update(opts);
}

// The key of the polyhedron currently shown in the mini viewport — lets a
// selection-changed event that resolves to the SAME polyhedron (e.g. the
// inspector's own double-click highlighting it in the main view) refresh
// without snapping the user's mini-view orbit/zoom back to the framed angle.
let shownPolyKey = null;

document.addEventListener('crysviz:polyhedron-selection-changed', (ev) => {
  const key = /** @type {CustomEvent} */ (ev).detail?.key ?? null;
  refreshAll({ keepCamera: key != null && key === shownPolyKey });
});
// Selecting the central atom (rather than the polyhedron body) inspects the
// same polyhedron — driven off the atom-selection subscription instead.
subscribeToAtomSelection(() => refreshAll());
// A rebuild can shift the selected polyhedron's exact geometry (or drop it
// entirely) without a selection-change event firing — refresh either way.
// keepCamera:true: most rebuilds (e.g. an Element Color Map switch, which
// goes through updateVisualization()'s reRenderPolyhedra default) don't
// actually move this polyhedron's geometry, so don't snap the mini
// viewport's camera back to the auto-framed view for those. setModel()
// still resets the camera on its own if the polyhedron was dropped by the
// rebuild and a later one brings it back (hasFramed resets to false when
// the model goes empty), so a genuine reappearance still reframes correctly.
document.addEventListener('crysviz:polyhedra-rebuilt', () => refreshAll({ keepCamera: true }));
// Recolouring an atom or a polyhedron (individually or by element/category)
// doesn't touch geometry or selection, so neither event above fires — but
// computePolyhedronDetail() resolves colours fresh every call, so a plain
// refresh is enough to pick the new colour up. keepCamera:true so a pure
// colour change doesn't reset the orbit/zoom the user has dialed into this
// mini viewport.
document.addEventListener('crysviz:colors-changed', () => refreshAll({ keepCamera: true }));
// "Show CIF Errors" switched, or a CIF's errors were read.
document.addEventListener('crysviz:cif-errors-changed', () => refreshAll({ keepCamera: true }));
