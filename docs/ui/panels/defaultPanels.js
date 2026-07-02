// Default panel registrations: thin adapters that map the existing panel
// builders onto the unified panel/window system. All per-panel wiring for the
// migration is concentrated here; the builders themselves only need to build
// into the panel body they are given.

import { registerPanel } from './PanelManager.js';
import { handleStructurePanelToggle, setStructurePanelOpen } from '../StructureInfoPanel/General.js';
import { general, fileBrowser, structureShip } from '../../state/store.js';
import { updateForces, removeForces, updateSpins, removeSpins } from '../../render/index.js';
import { addCameraPanel } from '../CameraPanel.js';
import { addColorPanel } from '../ColorPanel.js';
import { collapseAllAtomExpansions } from '../WindowAndSceneControls.js';
import { addTrajectoryPlayer, removeTrajectoryPlayer } from '../TrajectoryPanel.js';
import { addCompPanel, removeCompPanel } from '../ComparisonPanel.js';
import { addForcePanel, removeForcePanel } from '../ForcePanel.js';
import { addSpinPanel, removeSpinPanel } from '../SpinPanel.js';
import { addFieldPanel } from '../FieldPanel.js';
import { addPlanesPanel, removePlanesPanel } from '../PlanesPanel.js';
import { addBondPanel, removeBondPanel } from '../BondPanel.js';
import { removeHistogramPanel } from '../AnalysisPanels/BondAnalysisPanel.js';
import { addLatticeAndSupercellPanel, removeLatticeAndSupercellPanel } from '../LatticeSupercellPanel.js';
import { addPolyhedraPanel, removePolyhedraPanel } from '../PolyhedraPanel.js';
import { addMoyoPanel } from '../BackendPanel/MoyoWASM.js';

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

const BOND_ROWS = ['showBonds', 'PBCBondToggle', 'bondWidth'];
const CELL_ROWS = ['showLattice', 'showAxes', 'showPeriodic'];
const POLYHEDRA_ROWS = ['showPolyhedra', 'completePolyhedraToggle'];

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
    // Base position is the far left of the screen; while the dock occupies
    // that column the window is displaced to sit just right of it, and it
    // returns to the very left whenever the dock is hidden.
    defaults: { docked: false, anchor: { left: 10, top: 20 }, collapsed: false },
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

  //
  // Feature panels are lifecycle 'rebuild': their content is built lazily on
  // first expand and rebuilt when the selected structure changes. Expanding
  // only shows the controls — heavy features are activated by explicit
  // controls inside each panel (Show Forces/Spins/Field toggles, the play
  // button, Add Plane, ...).

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
    available() { return (fileBrowser.selectedStructure?.forces?.length ?? 0) > 0; },
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
    available() { return (fileBrowser.selectedStructure?.spins?.length ?? 0) > 0; },
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
      return (fileBrowser.selectedStructure?.volumetricFields?.fields?.length ?? 0) > 0;
    },
    // Field meshes are managed by the Show Field toggle and the row/step
    // switch logic (FileBrowswerPanel), not by panel teardown.
    buildContent(body) { addFieldPanel(body.id); },
    defaults: { docked: true, order: 50, collapsed: true },
  });

  registerPanel({
    id: 'planes',
    title: 'Crystal Planes',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) { addPlanesPanel(body.id); },
    onDestroyContent() { removePlanesPanel(); },
    defaults: { docked: true, order: 60, collapsed: true },
  });

  registerPanel({
    id: 'bonds',
    title: 'Bonds',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) {
      addBondPanel(body.id);
      adoptStaticRows(body, BOND_ROWS);
    },
    onDestroyContent() {
      stashStaticRows(BOND_ROWS);
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
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) {
      addPolyhedraPanel(body.id);
      adoptStaticRows(body, POLYHEDRA_ROWS);
    },
    onDestroyContent() {
      stashStaticRows(POLYHEDRA_ROWS);
      removePolyhedraPanel();
    },
    defaults: { docked: true, order: 90, collapsed: true },
  });

  registerPanel({
    id: 'settings',
    title: 'Settings',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) {
      // Storage/share-URL options on top (with their info button), then atom
      // visibility/size, color-map settings and camera settings. Per-feature
      // toggles (bonds, cell, polyhedra) live in their feature windows.
      const info = document.getElementById('storageInfoButton');
      const infoWrap = info && info.closest('.info-button-panel');
      if (infoWrap) body.appendChild(infoWrap);
      const sw = document.getElementById('StorageOptionSwitch');
      if (sw) body.appendChild(sw);
      adoptStaticRows(body, ['showAtoms', 'atomSize'], false);
      addColorPanel(body.id);
      addCameraPanel(body.id);
    },
    defaults: { docked: true, order: 5, collapsed: false },
  });
}
