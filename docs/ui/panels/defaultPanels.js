// Default panel registrations: thin adapters that map the existing panel
// builders onto the unified panel/window system. All per-panel wiring for the
// migration is concentrated here; the builders themselves only need to build
// into the panel body they are given.

import { registerPanel, resetAllPanels, refreshPanelAvailability, revealPanel, getPanelPref, setPanelPref } from './PanelManager.js';
import { handleStructurePanelToggle, setStructurePanelOpen } from '../StructureInfoPanel/General.js';
import { general, fileBrowser, structureShip } from '../../state/store.js';
import { updateForces, removeForces, updateSpins, removeSpins, updateField, toggleFieldVisibility } from '../../render/index.js';
import { addCameraPanel } from '../CameraPanel.js';
import { addColorPanel } from '../ColorPanel.js';
import { collapseAllAtomExpansions } from '../WindowAndSceneControls.js';
import { addTrajectoryPlayer, removeTrajectoryPlayer } from '../TrajectoryPanel.js';
import { addCompPanel, removeCompPanel } from '../ComparisonPanel.js';
import { addForcePanel, removeForcePanel } from '../ForcePanel.js';
import { addSpinPanel, removeSpinPanel } from '../SpinPanel.js';
import { addFieldPanel, fieldBrowser } from '../FieldPanel.js';
import { addPlanesPanel, removePlanesPanel, setPlanesVisible, planesData } from '../PlanesPanel.js';
import { addBondPanel, removeBondPanel } from '../BondPanel.js';
import { removeHistogramPanel } from '../AnalysisPanels/BondAnalysisPanel.js';
import { addLatticeAndSupercellPanel, removeLatticeAndSupercellPanel } from '../LatticeSupercellPanel.js';
import { addPolyhedraPanel, removePolyhedraPanel } from '../PolyhedraPanel.js';
import { addMoyoPanel } from '../BackendPanel/MoyoWASM.js';
import { makeSectionHeadline } from './sectionHeadline.js';
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
  }));

  group.appendChild(makeToggleRow('showSpinsToggle', 'Show Spins', !!general.spinsActive, (on) => {
    general.spinsActive = on;
    if (on && fileBrowser.selectedStructure?.spins?.length) updateSpins(general.spinScale ?? 1.0);
    else removeSpins();
    onToggle('spins', on);
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
    buildContent(body) {
      // Reparent the statically-defined toolbar (wired earlier by
      // MeasurementToolbar.js; moving the nodes preserves listeners and ids).
      const el = document.getElementById('measurementTools');
      if (el) body.appendChild(el);
    },
    defaults: { docked: false, anchor: { right: 20, top: 20 }, collapsed: false },
  });

  registerPanel({
    id: 'view',
    title: 'View',
    lifecycle: 'persistent',
    buildContent(body) {
      const el = document.getElementById('cameraTools');
      if (el) body.appendChild(el);
    },
    // Base position (dock hidden) clears the dock-unhide menu button
    // (#mobileMenuToggle: left 12px + 44px wide) with the same 12px margin the
    // button keeps to the screen edge. While the dock occupies that column the
    // window is displaced to sit just right of it.
    defaults: { docked: false, anchor: { left: 68, top: 20 }, collapsed: false },
  });

  registerPanel({
    id: 'info',
    title: 'Structure',
    lifecycle: 'persistent',
    onCollapse() { collapseAllAtomExpansions(); },
    buildContent(body) {
      // Adopt the formula header box (+/− expandable) and the composition
      // details it controls; wire the header (the old inline-script behavior).
      const el = document.getElementById('structureInfoContent');
      if (!el) return;
      body.appendChild(el);
      const toggle = document.getElementById('structureToggle');
      if (toggle) {
        toggle.addEventListener('click', handleStructurePanelToggle);
        toggle.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleStructurePanelToggle();
          }
        });
      }
    },
    defaults: { docked: false, anchor: { right: 20, bottom: 20 }, collapsed: false },
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
    title: 'Backend',
    lifecycle: 'persistent',
    buildContent(body) {
      // Adopt the backend mode selector (Viz/Relax/MD), its info button and
      // the calc panel the modes build into. (#uploadSection starts inside
      // this group in the HTML but is adopted by the Files panel.)
      const group = document.getElementById('backendControlGroup');
      if (group) body.appendChild(group);
    },
    defaults: { docked: true, order: -10, collapsed: false, barCollapsed: true },
  });

  registerPanel({
    id: 'files',
    title: 'Files',
    lifecycle: 'persistent',
    buildContent(body) {
      // Adopt the statically-defined upload section (file/paste tabs) and the
      // structure table (moving preserves listeners and ids; the backend mode
      // switch keeps hiding #uploadSection by id in non-Viz modes).
      const upload = document.getElementById('uploadSection');
      if (upload) body.appendChild(upload);
      const table = document.getElementById('structureTablePanel');
      if (table) body.appendChild(table);
      // (The Share button lives in #uploadSection's action row and moves with
      // it; see ShareModule.createShareButton.)
    },
    defaults: { docked: true, order: 0, collapsed: false, barCollapsed: true },
  });

  registerPanel({
    id: 'features',
    title: 'Features',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent: buildFeaturesBody,
    defaults: { docked: true, order: 2, collapsed: false },
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
    available() {
      const container = structureShip.container[fileBrowser.selectedRowIndex];
      return !!container && container.structures.length > 1;
    },
    buildContent(body) { addTrajectoryPlayer(body.id); },
    onDestroyContent() { removeTrajectoryPlayer(); },
    defaults: { docked: true, order: 10, collapsed: true },
  });

  registerPanel({
    id: 'comparison',
    title: 'Comparison',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.comparisonStructure; },
    buildContent(body) { addCompPanel(body.id); },
    onDestroyContent() { removeCompPanel(); },
    defaults: { docked: true, order: 20, collapsed: true },
  });

  registerPanel({
    id: 'forces',
    title: 'Forces',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() {
      return (fileBrowser.selectedStructure?.forces?.length ?? 0) > 0 && !!general.forcesActive;
    },
    buildContent(body) {
      addForcePanel(body.id);
      // Re-apply the activation state after a rebuild (structure switch).
      if (general.forcesActive) {
        if (fileBrowser.selectedStructure?.forces?.length) updateForces(general.forceScale ?? 1.0);
        else removeForces();
      }
    },
    onDestroyContent() { removeForcePanel(); },
    defaults: { docked: true, order: 30, collapsed: true },
  });

  registerPanel({
    id: 'spins',
    title: 'Spins',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() {
      return (fileBrowser.selectedStructure?.spins?.length ?? 0) > 0 && !!general.spinsActive;
    },
    buildContent(body) {
      addSpinPanel(body.id);
      if (general.spinsActive) {
        if (fileBrowser.selectedStructure?.spins?.length) updateSpins(general.spinScale ?? 1.0);
        else removeSpins();
      }
    },
    onDestroyContent() { removeSpinPanel(); },
    defaults: { docked: true, order: 40, collapsed: true },
  });

  registerPanel({
    id: 'field',
    title: 'Volumetric Field',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() {
      return (fileBrowser.selectedStructure?.volumetricFields?.fields?.length ?? 0) > 0
        && general.fieldActive !== false;
    },
    // Field meshes are managed by the Features "Show Volumetric Field" toggle
    // and the row/step switch logic (FileBrowswerPanel), not by panel teardown.
    buildContent(body) { addFieldPanel(body.id); },
    defaults: { docked: true, order: 50, collapsed: true },
  });

  registerPanel({
    id: 'planes',
    title: 'Crystal Planes',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure && planesData.showPlanes !== false; },
    buildContent(body) { addPlanesPanel(body.id); },
    onDestroyContent() { removePlanesPanel(); },
    defaults: { docked: true, order: 60, collapsed: true },
  });

  registerPanel({
    id: 'bonds',
    title: 'Bonds',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure && general.showBonds !== false; },
    buildContent(body) {
      addBondPanel(body.id);
    },
    onDestroyContent() {
      removeBondPanel();
      removeHistogramPanel();
    },
    defaults: { docked: true, order: 70, collapsed: true },
  });

  registerPanel({
    id: 'cell',
    title: 'Cell & Supercell',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) {
      addLatticeAndSupercellPanel(body.id);
      adoptStaticRows(body, CELL_ROWS);
    },
    onDestroyContent() {
      stashStaticRows(CELL_ROWS);
      removeLatticeAndSupercellPanel();
    },
    defaults: { docked: true, order: 80, collapsed: true },
  });

  registerPanel({
    id: 'symmetry',
    title: 'Symmetry',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure; },
    // async builder: fills the body once the Moyo WASM module is ready.
    buildContent(body) { addMoyoPanel(body.id); },
    defaults: { docked: true, order: 85, collapsed: true },
  });

  registerPanel({
    id: 'polyhedra',
    title: 'Polyhedra',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure && general.showPolyhedra !== false; },
    buildContent(body) { addPolyhedraPanel(body.id); },
    onDestroyContent() { removePolyhedraPanel(); },
    defaults: { docked: true, order: 90, collapsed: true },
  });

  registerPanel({
    id: 'visual',
    title: 'Visual',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) {
      // All appearance settings in one window, grouped by concern. The
      // feature-specific controls stay in their feature windows.
      body.appendChild(makeSectionHeadline('Sizes'));
      adoptStaticRows(body, ['atomSize', 'bondWidth'], false);
      body.appendChild(makeSectionHeadline('Unit Cell'));
      adoptStaticRows(body, ['showLattice', 'latticeWidth', 'showAxes', 'axesWidth'], false);
      body.appendChild(makeSectionHeadline('Colors & Style'));
      // Background: toggle for the on-canvas picker dot, plus an in-panel
      // swatch opening the same picker (outside the toggle's label, so
      // clicking the swatch doesn't flip the checkbox).
      const bgGroup = document.createElement('div');
      bgGroup.className = 'toggle_group';
      const bgRow = document.createElement('div');
      bgRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const bgToggle = makeToggleRow('backgroundDotToggle', 'Background picker on canvas',
        isBackgroundDotVisible(), (on) => setBackgroundDotVisible(on));
      bgToggle.style.flex = '1';
      bgRow.appendChild(bgToggle);
      bgRow.appendChild(createBackgroundSwatch());
      bgGroup.appendChild(bgRow);
      body.appendChild(bgGroup);
      addColorPanel(body.id);
      body.appendChild(makeSectionHeadline('Camera'));
      addCameraPanel(body.id);
    },
    defaults: { docked: true, order: 5, collapsed: false },
  });

  registerPanel({
    id: 'settings',
    title: 'Settings',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) {
      // Storage/share-URL options (with their info button), then window drag
      // behavior. Visual settings live in the Visual window.
      const info = document.getElementById('storageInfoButton');
      const infoWrap = info && info.closest('.info-button-panel');
      if (infoWrap) body.appendChild(infoWrap);
      body.appendChild(makeSectionHeadline('Local storage'));
      const sw = document.getElementById('StorageOptionSwitch');
      if (sw) body.appendChild(sw);
      // Window drag behavior: dragging across the dock boundary docks/undocks.
      body.appendChild(makeSectionHeadline('Windows'));
      const dragGroup = document.createElement('div');
      dragGroup.className = 'toggle_group';
      dragGroup.appendChild(makeToggleRow('dragIntoDockToggle', 'Drag into dock',
        !!getPanelPref('dragIntoDock'), (on) => setPanelPref('dragIntoDock', on)));
      dragGroup.appendChild(makeToggleRow('dragOutOfDockToggle', 'Drag out of dock',
        !!getPanelPref('dragOutOfDock'), (on) => setPanelPref('dragOutOfDock', on)));
      body.appendChild(dragGroup);
      // Restore every window to its default placement.
      const resetBtn = document.createElement('button');
      resetBtn.id = 'resetUiButton';
      resetBtn.type = 'button';
      resetBtn.className = 'reset-btn';
      resetBtn.textContent = 'Reset UI';
      resetBtn.addEventListener('click', () => resetAllPanels());
      body.appendChild(resetBtn);
    },
    // The very last window in the dock.
    defaults: { docked: true, order: 100, collapsed: false },
  });
}
