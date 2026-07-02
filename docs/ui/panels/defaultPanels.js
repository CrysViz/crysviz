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
    defaults: {
      docked: false,
      anchor: { left: 'var(--camera-tools-left)', top: 20 },
      collapsed: false,
    },
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
      const save = document.getElementById('saveButton');
      if (save) body.appendChild(save);
    },
    defaults: { docked: true, order: 0, collapsed: false, barCollapsed: true },
  });

  registerPanel({
    id: 'storage',
    title: 'Storage',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) {
      const info = document.getElementById('storageInfoButton');
      const infoWrap = info && info.closest('.info-button-panel');
      if (infoWrap) body.appendChild(infoWrap);
      const sw = document.getElementById('StorageOptionSwitch');
      if (sw) body.appendChild(sw);
      // The Share button may already exist (created on the first structure
      // load, before the panels); adopt it, otherwise createShareButton()
      // targets this body directly.
      const shareBtn = document.getElementById('shareBtn');
      if (shareBtn) body.appendChild(shareBtn);
    },
    defaults: { docked: true, order: 95, collapsed: false },
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
    title: 'Bond Analysis',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    available() { return !!fileBrowser.selectedStructure; },
    buildContent(body) { addBondPanel(body.id); },
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
    buildContent(body) { addLatticeAndSupercellPanel(body.id); },
    onDestroyContent() { removeLatticeAndSupercellPanel(); },
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
    buildContent(body) { addPolyhedraPanel(body.id); },
    onDestroyContent() { removePolyhedraPanel(); },
    defaults: { docked: true, order: 90, collapsed: true },
  });

  registerPanel({
    id: 'display',
    title: 'Display',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) {
      // Reparent the statically-defined visibility toggles and size sliders
      // (wired by ControlsWiring.js before the panels are built; moving the
      // nodes preserves their listeners and ids).
      const toggles = document.querySelector('#structureControls .toggle_group');
      if (toggles) body.appendChild(toggles);
      for (const sliderId of ['atomSize', 'bondWidth']) {
        const slider = document.getElementById(sliderId);
        const label = slider && slider.closest('label');
        if (label) body.appendChild(label);
      }
    },
    defaults: { docked: true, order: 5, collapsed: false },
  });

  registerPanel({
    id: 'color',
    title: 'Color Map Settings',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) { addColorPanel(body.id); },
    defaults: { docked: true, order: 100, collapsed: true },
  });

  registerPanel({
    id: 'cameraSettings',
    title: 'Camera Settings',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    buildContent(body) { addCameraPanel(body.id); },
    defaults: { docked: true, order: 110, collapsed: true },
  });
}
