// Default panel registrations: thin adapters that map the existing panel
// builders onto the unified panel/window system. All per-panel wiring for the
// migration is concentrated here; the builders themselves only need to build
// into the panel body they are given.

import { registerPanel, resetAllPanels, refreshPanelAvailability, revealPanel, getPanelPref, setPanelPref } from './PanelManager.js';
import { handleStructurePanelToggle, setStructurePanelOpen } from '../StructureInfoPanel/General.js';
import { general, fileBrowser, structureShip } from '../../state/store.js';
import { updateForces, removeForces, updateSpins, removeSpins, updateField, toggleFieldVisibility, setPolyEdgeWidth, requestRender } from '../../render/index.js';
import { addCameraPanel } from '../CameraPanel.js';
import { addColorPanel } from '../ColorPanel.js';
import { collapseAllAtomExpansions } from '../WindowAndSceneControls.js';
import { updateForceSpinWarning } from '../ForceSpinWarningBanner.js';
import { addTrajectoryPlayer, removeTrajectoryPlayer } from '../TrajectoryPanel.js';
import { addComparisonOverlayPanel, removeComparisonOverlayPanel } from '../ComparisonOverlayPanel.js';
import { addForcePanel, removeForcePanel } from '../ForcePanel.js';
import { addSpinPanel, removeSpinPanel } from '../SpinPanel.js';
import { addFieldPanel, fieldBrowser } from '../FieldPanel.js';
import { addPlanesPanel, removePlanesPanel, setPlanesVisible, planesData } from '../PlanesPanel.js';
import { addBondPanel, removeBondPanel } from '../BondPanel.js';
import { addLatticeAndSupercellPanel, removeLatticeAndSupercellPanel } from '../LatticeSupercellPanel.js';
import { addPolyhedraPanel, removePolyhedraPanel } from '../PolyhedraPanel.js';
import { addMoyoPanel } from '../BackendPanel/MoyoWASM.js';
import { addEOSPanel, removeEOSPanel } from '../EOSPanel.js';
import { addEOSPlotsPanel, removeEOSPlotsPanel } from '../EOSPlotsPanel.js';
import { addDummySplitPanel, removeDummySplitPanel } from '../DummySplitPanel.js';
import { addLandscapePanel, removeLandscapePanel, addLandscapePlotsPanel, removeLandscapePlotsPanel } from '../LandscapePanel.js';
import { buildCustomUserSettingsPanel } from '../CustomUserSettingsPanel.js';
import { makeSectionHeadline } from './sectionHeadline.js';

import { getFontScale, setFontScale, FONT_SCALE_MIN, FONT_SCALE_MAX } from '../FontScaleModule.js';
import { setBackgroundDotVisible, isBackgroundDotVisible, createBackgroundSwatch } from '../BackgroundPicker.js';

// ---- static-row adoption ------------------------------------------------------
//
// The visibility toggles and size sliders are static <label> rows in the
// hidden #structureControls staging block, wired once by ControlsWiring.js.
// Feature windows adopt "their" rows into the top of their body; rebuild
// panels must stash them back before their body is cleared on rebuild, or the
// rows (and their listeners) would be destroyed.

/** Move the rows containing the given input ids into a .toggle_group at the
 *  top of the panel body (or appended, with atTop=false). Works for checkbox
 *  rows and bare slider labels. */
function adoptStaticRows(body, inputIds, atTop = true) {
  const group = document.createElement('div');
  group.className = 'toggle_group';
  for (const id of inputIds) {
    const input = document.getElementById(id);
    const row = input && input.closest('label');
    if (row) group.appendChild(row);
  }
  if (atTop) body.insertBefore(group, body.firstChild);
  else body.appendChild(group);
}

/** Adopt two static rows (a show-toggle and its width slider) onto ONE line. */
function makeAdoptedPairRow(toggleId, sliderId) {
  const pair = document.createElement('div');
  pair.className = 'control-row-pair';
  for (const id of [toggleId, sliderId]) {
    const input = document.getElementById(id);
    const row = input && input.closest('label');
    if (row) pair.appendChild(row);
  }
  return pair;
}

/** "Polyhedra Edge Width" slider row in the same idiom as the static size
 *  sliders (label text + live value span above a full-width range input). */
function makePolyEdgeSliderRow() {
  const label = document.createElement('label');
  label.append('Polyhedra Edge Width: ');
  const value = document.createElement('span');
  value.className = 'slider-value';
  value.textContent = String(general.polyEdgeWidth);
  label.appendChild(value);
  const input = document.createElement('input');
  input.type = 'range';
  input.id = 'polyEdgeWidth';
  input.min = '0'; // 0 = no edges
  input.max = '10';
  input.step = '0.5';
  input.value = String(general.polyEdgeWidth);
  input.addEventListener('input', () => {
    value.textContent = input.value;
    setPolyEdgeWidth(parseFloat(input.value));
    requestRender();
  });
  label.appendChild(input);
  return label;
}

/** A bordered box (styles.css .panel-section) grouping one section's
 *  headline + controls — currently only used by the Visual panel, whose
 *  several stacked sections otherwise read as one long undifferentiated
 *  list. `id`, if given, lets a sub-builder (addColorPanel/addCameraPanel)
 *  target this box directly instead of appending to the shared body. */
function makePanelSection(title, id) {
  const section = document.createElement('div');
  section.className = 'panel-section';
  if (id) section.id = id;
  section.appendChild(makeSectionHeadline(title));
  return section;
}

/** Return adopted rows to the staging block (called from onDestroyContent,
 *  before the panel body is cleared). */
function stashStaticRows(inputIds) {
  const staging = document.querySelector('#structureControls .toggle_group')
    || document.getElementById('structureControls');
  if (!staging) return;
  for (const id of inputIds) {
    const input = document.getElementById(id);
    const row = input && input.closest('label');
    if (row) staging.appendChild(row);
  }
}

// (The size sliders and the cell/axes visibility toggles live in the Visual
// window; feature windows keep only their feature-specific rows. The Neighbour
// Bonds toggle lives in the Features window, next to Show Bonds.)
const CELL_ROWS = ['showPeriodic'];

// ---- Features window toggle rows ---------------------------------------------

/** The static toggle row (label) containing the given input id, detached from
 *  the staging block. Returns null if absent. */
function detachStaticRow(inputId) {
  const input = document.getElementById(inputId);
  return input ? input.closest('label') : null;
}

/** Build a checkbox toggle row matching the static ones (toggle_styles.css). */
function makeToggleRow(id, labelText, checked, onChange) {
  const row = document.createElement('label');
  row.className = 'toggle_row toggle_container';
  const sw = document.createElement('span');
  sw.className = 'toggle_switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = id;
  cb.checked = checked;
  const slider = document.createElement('span');
  slider.className = 'toggle_slider';
  sw.appendChild(cb);
  sw.appendChild(slider);
  const text = document.createElement('span');
  text.className = 'toggle_text';
  text.textContent = labelText;
  row.appendChild(sw);
  row.appendChild(text);
  cb.addEventListener('change', () => onChange(cb.checked));
  return row;
}

/** Build the Features window body: master show-toggles for each feature, in a
 *  single toggle group. Static rows (atoms/bonds/polyhedra/complete) are moved
 *  from the staging block; the rest are new toggles driving the same state the
 *  in-panel toggles used to. */
function buildFeaturesBody(body) {
  const group = document.createElement('div');
  group.className = 'toggle_group';

  const showAtoms = detachStaticRow('showAtoms');
  if (showAtoms) group.appendChild(showAtoms);

  const showBonds = detachStaticRow('showBonds');
  if (showBonds) group.appendChild(showBonds);

  const neighbourBonds = detachStaticRow('PBCBondToggle');
  if (neighbourBonds) group.appendChild(neighbourBonds);

  // Turning a master toggle on re-greys/un-greys its feature panel; on ON it
  // also reveals that panel (restores a shrunk title bar + expands the body)
  // so the feature reappears rather than lingering as a greyed handle.
  const onToggle = (panelId, on) => {
    refreshPanelAvailability();
    if (on) revealPanel(panelId);
  };

  group.appendChild(makeToggleRow('showForcesToggle', 'Show Forces', !!general.forcesActive, (on) => {
    general.forcesActive = on;
    if (on && fileBrowser.selectedStructure?.forces?.length) updateForces(general.forceScale ?? 1.0);
    else removeForces();
    onToggle('forces', on);
    updateForceSpinWarning();
  }));

  group.appendChild(makeToggleRow('showSpinsToggle', 'Show Spins', !!general.spinsActive, (on) => {
    general.spinsActive = on;
    if (on && fileBrowser.selectedStructure?.spins?.length) updateSpins(general.spinScale ?? 1.0);
    else removeSpins();
    onToggle('spins', on);
    updateForceSpinWarning();
  }));

  const showPolyhedra = detachStaticRow('showPolyhedra');
  if (showPolyhedra) group.appendChild(showPolyhedra);

  const completePolyhedra = detachStaticRow('completePolyhedraToggle');
  if (completePolyhedra) group.appendChild(completePolyhedra);

  group.appendChild(makeToggleRow('showFieldToggle', 'Show Volumetric Field', general.fieldActive !== false, (on) => {
    general.fieldActive = on;
    if (fieldBrowser.selectedField) {
      fieldBrowser.selectedField.isVisible = on;
      toggleFieldVisibility(on);
      updateField();
    }
    onToggle('field', on);
  }));

  group.appendChild(makeToggleRow('showPlanesMasterToggle', 'Show Planes', planesData.showPlanes !== false, (on) => {
    setPlanesVisible(on);
    onToggle('planes', on);
  }));

  body.appendChild(group);

  // The moved static toggles (Show Bonds / Show Polyhedra) also grey/reveal
  // their feature panel; a second listener runs alongside ControlsWiring's own
  // onchange handler (which does the scene update).
  for (const [id, panelId] of [['showBonds', 'bonds'], ['showPolyhedra', 'polyhedra']]) {
    const cb = document.getElementById(id);
    if (cb) cb.addEventListener('change', () => onToggle(panelId, cb.checked));
  }
}

export function registerDefaultPanels() {
  // ---- floating trio: measure / view / structure info -----------------------

  registerPanel({
    id: 'measure',
    title: 'Measure',
    lifecycle: 'persistent',
    infoMd: './data/measureInfo.md',
    compactIcon: './data/icons/tool-icon.svg',
    compactLabel: 'Toggle Measurement Tools',
    compactAnchor: { right: 20, top: 20 }, // fixed anchor: top of the compact stack
    buildContent(body) {
      // Reparent the statically-defined toolbar (wired earlier by
      // MeasurementToolbar.js; moving the nodes preserves listeners and ids).
      const el = document.getElementById('measurementTools');
      if (el) body.appendChild(el);
    },
    defaults: { dock: false, anchor: { right: 20, top: 20 }, collapsed: false },
  });

  registerPanel({
    id: 'view',
    title: 'View',
    lifecycle: 'persistent',
    infoMd: './data/viewInfo.md',
    compactIcon: './data/icons/camera-icon.svg',
    compactLabel: 'Toggle Camera Tools',
    compactStackAfter: 'measure', // dynamic anchor: pinned below Measure's live height
    buildContent(body) {
      const el = document.getElementById('cameraTools');
      if (el) body.appendChild(el);
    },
    // Base position (dock hidden) clears the dock-unhide menu button
    // (#mobileMenuToggle: left 12px + 44px wide) with the same 12px margin the
    // button keeps to the screen edge. While the dock occupies that column the
    // window is displaced to sit just right of it.
    defaults: { dock: false, anchor: { left: 68, top: 20 }, collapsed: false },
  });

  registerPanel({
    id: 'info',
    title: 'Structure',
    lifecycle: 'persistent',
    infoMd: './data/structureInfo.md',
    onCollapse() { collapseAllAtomExpansions(); },
    buildContent(body) {
      // Fixed width regardless of which tab (Atoms/Bonds/Poly/Wyckoff) is
      // active — without this the floating panel shrink-wraps to whichever
      // tab's content is currently widest, so it visibly resizes every time
      // the user switches tabs. Still shrinks on narrow viewports.
      // 300px (not the old 340px): the Bonds tab's double-range slider row no
      // longer carries its own redundant min/max labels (the combined "min -
      // max Å" label above the slider already shows them), so the row needs
      // much less width than before.
      body.style.width = 'min(300px, calc(100vw - 16px))';

      // Adopt the formula header box (+/− expandable) and the composition
      // details it controls; wire the header (the old inline-script behavior).
      const el = document.getElementById('structureInfoContent');
      if (!el) return;
      body.appendChild(el);
      const toggle = document.getElementById('structureToggle');
      if (toggle) {
        toggle.addEventListener('click', handleStructurePanelToggle);
        toggle.addEventListener('keydown', (e) => {
          // Space is reserved globally as a keyboard-shortcut modifier
          // (ui/KeyboardShortcuts.js) — Enter alone toggles the formula box.
          if (e.key === 'Enter') {
            e.preventDefault();
            handleStructurePanelToggle();
          }
        });
      }
    },
    defaults: { dock: false, anchor: { right: 20, bottom: 20 }, collapsed: false },
  });

  // A restored share URL may ask for the formula box to start open
  // (utils/shareutils.js runs before the panels exist and leaves a marker).
  const comp = document.getElementById('composition');
  if (comp && comp.dataset.restoreOpen === '1') {
    delete comp.dataset.restoreOpen;
    setStructurePanelOpen(true);
  }

  // ---- docked panels ---------------------------------------------------------

  registerPanel({
    id: 'backend',
    title: 'Atomistic',
    lifecycle: 'persistent',
    infoMd: './data/backendInfo.md',
    buildContent(body) {
      // Adopt the backend mode selector (Relax/MD) and the calc panel the
      // modes build into. (#uploadSection starts inside this group in the
      // HTML but is adopted by the Files panel.)
      const group = document.getElementById('backendControlGroup');
      if (group) body.appendChild(group);
    },
    defaults: { dock: 'left', order: -10, collapsed: true },
  });

  registerPanel({
    id: 'files',
    title: 'Files',
    lifecycle: 'persistent',
    infoMd: './data/uploadInfo.md',
    buildContent(body) {
      // Adopt the statically-defined upload section (file/paste tabs) and the
      // structure table (moving preserves listeners and ids). The upload
      // section stays visible in every mode (upload/paste/download are always
      // available from the Files panel).
      const upload = document.getElementById('uploadSection');
      if (upload) body.appendChild(upload);
      const table = document.getElementById('structureTablePanel');
      if (table) body.appendChild(table);
      // (The Share button lives in #uploadSection's action row and moves with
      // it; see ShareModule.createShareButton.)
    },
    defaults: { dock: 'left', order: -20, collapsed: false, barCollapsed: true },
  });

  registerPanel({
    id: 'features',
    title: 'Features',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    infoMd: './data/analysisInfo.md',
    buildContent: buildFeaturesBody,
    defaults: { dock: 'left', order: 2, collapsed: false },
  });

  //
  // Feature panels are lifecycle 'rebuild': their content is built lazily on
  // first expand and rebuilt when the selected structure changes. Each is
  // greyed out (available()=false) when its structure lacks the data OR its
  // "Show ..." master toggle in the Features window is off.

  registerPanel({
    id: 'trajectory',
    title: 'Trajectory',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/trajectoryInfo.md',
    available() {
      const container = structureShip.container[fileBrowser.selectedRowIndex];
      return !!container && container.structures.length > 1;
    },
    buildContent(body) { addTrajectoryPlayer(body.id); },
    onDestroyContent() { removeTrajectoryPlayer(); },
    defaults: { dock: 'left', order: 10, collapsed: true },
  });

  registerPanel({
    id: 'comparison',
    title: 'Structure Overlay & Comparison',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/overlayInfo.md',
    // Available as soon as a structure is loaded (not gated on a comparison/
    // overlay structure already being chosen) — the panel hosts its own
    // "Enable ___" toggle and "please select a structure" error per tab.
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) { addComparisonOverlayPanel(body); },
    onDestroyContent() { removeComparisonOverlayPanel(); },
    defaults: { dock: 'left', order: 20, collapsed: true },
  });

  registerPanel({
    id: 'forces',
    title: 'Forces',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/forcesInfo.md',
    // Stays available even without force data: the window is where the user
    // enters/enables forces, so it must not grey out when a structure has none.
    available() { return true; },
    buildContent(body) {
      addForcePanel(body.id);
      // Re-apply the activation state after a rebuild (structure switch).
      if (general.forcesActive) {
        if (fileBrowser.selectedStructure?.forces?.length) updateForces(general.forceScale ?? 1.0);
        else removeForces();
      }
    },
    onDestroyContent() { removeForcePanel(); },
    defaults: { dock: 'left', order: 30, collapsed: true },
  });

  registerPanel({
    id: 'spins',
    title: 'Spins',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/spinsInfo.md',
    // Stays available even without spin data: the window is where the user
    // enters/enables spins, so it must not grey out when a structure has none.
    available() { return true; },
    buildContent(body) {
      addSpinPanel(body.id);
      if (general.spinsActive) {
        if (fileBrowser.selectedStructure?.spins?.length) updateSpins(general.spinScale ?? 1.0);
        else removeSpins();
      }
    },
    onDestroyContent() { removeSpinPanel(); },
    defaults: { dock: 'left', order: 40, collapsed: true },
  });

  registerPanel({
    id: 'field',
    title: 'Volumetric Field',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/fieldInfo.md',
    available() {
      return (fileBrowser.selectedStructure?.volumetricFields?.fields?.length ?? 0) > 0
        && general.fieldActive !== false;
    },
    // Field meshes are managed by the Features "Show Volumetric Field" toggle
    // and the row/step switch logic (FileBrowswerPanel), not by panel teardown.
    buildContent(body) { addFieldPanel(body.id); },
    defaults: { dock: 'left', order: 50, collapsed: true },
  });

  registerPanel({
    id: 'planes',
    title: 'Crystal Planes',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/planesInfo.md',
    available() { return !!fileBrowser.selectedStructure && planesData.showPlanes !== false; },
    buildContent(body) { addPlanesPanel(body.id); },
    onDestroyContent() { removePlanesPanel(); },
    defaults: { dock: 'left', order: 60, collapsed: true },
  });

  registerPanel({
    id: 'bonds',
    title: 'Bonds',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/bondsInfo.md',
    available() { return !!fileBrowser.selectedStructure && general.showBonds !== false; },
    buildContent(body) {
      addBondPanel(body.id);
    },
    // The histogram windows (Bond Length / Coordination Number —
    // AnalysisPanels/*.js) are deliberately NOT torn down here: they are
    // independent windows kept live across structure switches by
    // refreshBondLengthHistogram/refreshCoordinationHistogram after every
    // rebuildBonds.
    onDestroyContent() { removeBondPanel(); },
    defaults: { dock: 'left', order: 70, collapsed: true },
  });

  registerPanel({
    id: 'cell',
    title: 'Cell & Supercell',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/cellInfo.md',
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) {
      addLatticeAndSupercellPanel(body.id);
      adoptStaticRows(body, CELL_ROWS);
    },
    onDestroyContent() {
      stashStaticRows(CELL_ROWS);
      removeLatticeAndSupercellPanel();
    },
    defaults: { dock: 'left', order: 80, collapsed: true },
  });

  registerPanel({
    id: 'symmetry',
    title: 'Symmetry',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/symmetryInfo.md',
    available() { return !!fileBrowser.selectedStructure; },
    // async builder: fills the body once the Moyo WASM module is ready.
    buildContent(body) { addMoyoPanel(body.id); },
    defaults: { dock: 'left', order: 85, collapsed: true },
  });

  registerPanel({
    id: 'polyhedra',
    title: 'Polyhedra',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/polyhedraInfo.md',
    available() { return !!fileBrowser.selectedStructure && general.showPolyhedra !== false; },
    buildContent(body) { addPolyhedraPanel(body.id); },
    // The polyhedra analysis windows (Type/Inspector/Connectivity —
    // AnalysisPanels/*.js) are deliberately NOT torn down here: they are
    // independent windows kept live across structure switches by
    // polyhedraAnalysisHub's re-analysis fan-out.
    onDestroyContent() { removePolyhedraPanel(); },
    defaults: { dock: 'left', order: 90, collapsed: true },
  });

  registerPanel({
    id: 'visual',
    title: 'Visual',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    infoMd: './data/visualInfo.md',
    buildContent(body) {
      // All appearance settings in one window, grouped by concern (Sizes /
      // Scene / Rendering+Colors / Camera), each in its own bordered
      // .panel-section box so the stacked sections read as distinct groups
      // rather than one long flat list. The feature-specific controls stay
      // in their feature windows.
      const sizesSection = makePanelSection('Sizes');
      body.appendChild(sizesSection);
      adoptStaticRows(sizesSection, ['atomSize', 'bondWidth'], false);
      // Polyhedra edge thickness belongs with the other size controls: since
      // the fat-lines change it applies in every render style, not only to
      // the cel hull-outline substitute it was introduced as.
      sizesSection.lastElementChild.appendChild(makePolyEdgeSliderRow());

      // Scene furniture: unit cell, cell axes (each show-toggle sharing a row
      // with its width slider) and the background picker.
      const sceneSection = makePanelSection('Scene');
      body.appendChild(sceneSection);
      const sceneGroup = document.createElement('div');
      sceneGroup.className = 'toggle_group';
      sceneGroup.appendChild(makeAdoptedPairRow('showLattice', 'latticeWidth'));
      sceneGroup.appendChild(makeAdoptedPairRow('showAxes', 'axesWidth'));
      // Background: toggle for the on-canvas picker dot, plus an in-panel
      // swatch opening the same picker (outside the toggle's label, so
      // clicking the swatch doesn't flip the checkbox).
      const bgRow = document.createElement('div');
      bgRow.className = 'control-row-pair';
      const bgToggle = makeToggleRow('backgroundDotToggle', 'Background picker on canvas',
        isBackgroundDotVisible(), (on) => setBackgroundDotVisible(on));
      bgToggle.style.flex = '1';
      bgRow.appendChild(bgToggle);
      bgRow.appendChild(createBackgroundSwatch());
      sceneGroup.appendChild(bgRow);
      sceneSection.appendChild(sceneGroup);

      // Rendering and Colors share one box: addColorPanel appends its own
      // internal 'Colors' sub-heading right after the rendering rows, into
      // this same section, rather than getting a second frame of its own.
      const renderingSection = makePanelSection('Rendering', 'visualRenderingSection');
      body.appendChild(renderingSection);
      addColorPanel(renderingSection.id);

      const cameraSection = makePanelSection('Camera', 'visualCameraSection');
      body.appendChild(cameraSection);
      addCameraPanel(cameraSection.id);
    },
    defaults: { dock: 'left', order: 5, collapsed: false },
  });

  // ---- controls + plots window pairs (EOS, Energy Landscape) -----------------
  //
  // Each feature is TWO ordinary windows: a controls window in the left dock
  // (like any feature window) and a plots window that DEFAULTS to the wide
  // right dock (ui/panels/RightDock.js) and starts closed. The plots window
  // is never opened by hand — the feature opens it when there is something
  // to show (EOSPanel.js on dataset load/re-fit, LandscapePanel.js when a
  // landscape JSON loads) — and, like any window, it can be dragged out to
  // float or into the left dock. Plots windows are 'persistent' +
  // closeMode:'hide': their content (fit data / loaded JSON) is independent
  // of the selected structure and survives both structure switches and
  // close/reopen; the build is simply deferred to first open.

  registerPanel({
    id: 'eos',
    title: 'EOS Fitting',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/eosInfo.md',
    available() { return true; },
    buildContent(body) { addEOSPanel(body.id); },
    onDestroyContent() { removeEOSPanel(); },
    defaults: { dock: 'left', order: 92, collapsed: true },
  });

  registerPanel({
    id: 'eosPlots',
    title: 'EOS Fit',
    lifecycle: 'persistent',
    closable: true,
    closeMode: 'hide',
    infoMd: './data/eosInfo.md',
    available() { return true; },
    buildContent(body) { addEOSPlotsPanel(body.id); },
    onDestroyContent() { removeEOSPlotsPanel(); },
    defaults: { dock: 'right', closed: true, order: 92 },
  });

  registerPanel({
    id: 'splitDemo',
    title: 'Right Dock Demo',
    lifecycle: 'persistent',
    closable: true,
    closeMode: 'hide',
    infoMd: './data/splitDemoInfo.md',
    available() { return true; },
    buildContent(body) { addDummySplitPanel(body.id); },
    onDestroyContent() { removeDummySplitPanel(); },
    // Minimal reference example of a right-dock-by-default window (open it
    // from the console/tests via openPanel('splitDemo')).
    defaults: { dock: 'right', closed: true, order: 93 },
  });

  registerPanel({
    id: 'landscape',
    title: 'Energy Landscape',
    lifecycle: 'persistent',
    infoMd: './data/landscapeInfo.md',
    available() { return true; },
    buildContent(body) { addLandscapePanel(body.id); },
    onDestroyContent() { removeLandscapePanel(); },
    defaults: { dock: 'left', order: 94, collapsed: true },
  });

  registerPanel({
    id: 'landscapePlots',
    title: 'Landscape Plots',
    lifecycle: 'persistent',
    closable: true,
    closeMode: 'hide',
    infoMd: './data/landscapeInfo.md',
    available() { return true; },
    buildContent(body) { addLandscapePlotsPanel(body.id); },
    onDestroyContent() { removeLandscapePlotsPanel(); },
    defaults: { dock: 'right', closed: true, order: 94 },
  });

  registerPanel({
    id: 'customSettings',
    title: 'Custom User Settings',
    lifecycle: 'persistent',
    infoMd: './data/customUserSettingsInfo.md',
    buildContent(body) { buildCustomUserSettingsPanel(body); },
    defaults: { docked: true, order: 96, collapsed: true },
  });

  registerPanel({
    id: 'settings',
    title: 'Settings',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    infoMd: './data/storageInfo.md',
    buildContent(body) {
      // Storage/share-URL options, then window drag behavior. Visual
      // settings live in the Visual window.
      // The None/Minimal/All-Settings storage-granularity toggle
      // (#StorageOptionSwitch in index.html) is hidden for now — it has no
      // wiring. Left in the DOM, just not adopted here, so it can return later.
      // Window drag behavior: dragging across the dock boundary docks/undocks.
      body.appendChild(makeSectionHeadline('Windows'));
      const dragGroup = document.createElement('div');
      dragGroup.className = 'toggle_group';
      dragGroup.appendChild(makeToggleRow('dragIntoDockToggle', 'Drag into dock',
        !!getPanelPref('dragIntoDock'), (on) => setPanelPref('dragIntoDock', on)));
      dragGroup.appendChild(makeToggleRow('dragOutOfDockToggle', 'Drag out of dock',
        !!getPanelPref('dragOutOfDock'), (on) => setPanelPref('dragOutOfDock', on)));
      dragGroup.appendChild(makeToggleRow('dragByHandleToggle', 'Only drag windows by handle',
        !!getPanelPref('dragByHandleOnly'), (on) => setPanelPref('dragByHandleOnly', on)));
      body.appendChild(dragGroup);
      // Warnings: the ray/path-tracing performance modal (shown on every
      // raster -> tracer switch unless suppressed). Unchecking re-enables it.
      body.appendChild(makeSectionHeadline('Warnings'));
      const warnGroup = document.createElement('div');
      warnGroup.className = 'toggle_group';
      warnGroup.appendChild(makeToggleRow('disableRaytraceWarningToggle',
        'Disable raytracing warning', !!getPanelPref('hideRaytraceWarning'),
        (on) => setPanelPref('hideRaytraceWarning', on)));
      body.appendChild(warnGroup);
      // Overall font scale: multiplies the window fonts (title bars, headlines,
      // labels) live via --cv-font-scale; persisted across sessions.
      body.appendChild(makeSectionHeadline('Text'));
      const fsRow = document.createElement('label');
      fsRow.className = 'toggle_row toggle_container';
      fsRow.style.gap = '8px';
      const fsText = document.createElement('span');
      fsText.className = 'toggle_text';
      fsText.textContent = 'Overall font scale';
      const fsSlider = document.createElement('input');
      fsSlider.type = 'range';
      fsSlider.id = 'fontScaleSlider';
      fsSlider.min = String(FONT_SCALE_MIN);
      fsSlider.max = String(FONT_SCALE_MAX);
      fsSlider.step = '0.05';
      fsSlider.value = String(getFontScale());
      fsSlider.style.flex = '1';
      fsSlider.addEventListener('input', () => setFontScale(parseFloat(fsSlider.value)));
      fsRow.appendChild(fsText);
      fsRow.appendChild(fsSlider);
      body.appendChild(fsRow);
      // Restore every window to its default placement.
      const resetRow = document.createElement('div');
      resetRow.style.display = 'flex';
      resetRow.style.gap = '8px';
      const resetBtn = document.createElement('button');
      resetBtn.id = 'resetUiButton';
      resetBtn.type = 'button';
      resetBtn.className = 'reset-btn';
      resetBtn.textContent = 'Reset UI';
      resetBtn.addEventListener('click', () => resetAllPanels());
      resetRow.appendChild(resetBtn);
      // Wipe every localStorage key the app uses (layout, prefs, theme, colors,
      // export prefs, font scale). No reload — changes take effect next load.
      const clearBtn = document.createElement('button');
      clearBtn.id = 'clearLocalDataButton';
      clearBtn.type = 'button';
      clearBtn.className = 'reset-btn reset-btn-danger';
      clearBtn.textContent = 'Clear local data';
      clearBtn.addEventListener('click', () => {
        if (confirm('Clear all saved local data?')) localStorage.clear();
      });
      resetRow.appendChild(clearBtn);
      body.appendChild(resetRow);
    },
    // The very last window in the dock.
    defaults: { dock: 'left', order: 100, collapsed: false },
  });
}
