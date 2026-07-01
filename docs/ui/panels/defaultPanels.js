// Default panel registrations: thin adapters that map the existing panel
// builders onto the unified panel/window system. All per-panel wiring for the
// migration is concentrated here; the builders themselves only need to build
// into the panel body they are given.

import { registerPanel, getPanel } from './PanelManager.js';
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
    variant: 'formula',
    onCollapse() { collapseAllAtomExpansions(); },
    buildContent(body) {
      const el = document.getElementById('composition');
      if (el) body.appendChild(el);
    },
    defaults: { docked: false, anchor: { right: 20, bottom: 20 }, collapsed: true },
  });

  // A restored share URL may ask for the structure panel to start open
  // (utils/shareutils.js runs before the panels exist and leaves a marker).
  const comp = document.getElementById('composition');
  if (comp && comp.dataset.restoreOpen === '1') {
    delete comp.dataset.restoreOpen;
    const info = getPanel('info');
    if (info) info.expand();
  }

  // ---- docked panels ---------------------------------------------------------
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
