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
import { addEOSPanel, removeEOSPanel } from '../EOSPanel.js';
import { openEOSSplitView, closeEOSSplitView } from '../EOSSplitView.js';
import { addDummySplitPanel, removeDummySplitPanel, openDummySplitView, closeDummySplitView } from '../DummySplitPanel.js';
import { addLandscapePanel, removeLandscapePanel, openLandscapeSplitView, closeLandscapeSplitView } from '../LandscapeSplitView.js';
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
    defaults: { docked: false, anchor: { right: 20, top: 20 }, collapsed: false },
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
    defaults: { docked: false, anchor: { left: 68, top: 20 }, collapsed: false },
  });

  registerPanel({
    id: 'info',
    title: 'Structure',
    lifecycle: 'persistent',
    infoMd: './data/structureInfo.md',
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
    defaults: { docked: true, order: -10, collapsed: true },
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
    defaults: { docked: true, order: -20, collapsed: false, barCollapsed: true },
  });

  registerPanel({
    id: 'features',
    title: 'Features',
    lifecycle: 'persistent',
    hiddenUntilStructure: true,
    infoMd: './data/analysisInfo.md',
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
    infoMd: './data/trajectoryInfo.md',
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
    infoMd: './data/comparisonInfo.md',
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
    defaults: { docked: true, order: 30, collapsed: true },
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
    defaults: { docked: true, order: 40, collapsed: true },
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
    defaults: { docked: true, order: 50, collapsed: true },
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
    defaults: { docked: true, order: 60, collapsed: true },
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
    defaults: { docked: true, order: 80, collapsed: true },
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
    defaults: { docked: true, order: 85, collapsed: true },
  });

  registerPanel({
    id: 'polyhedra',
    title: 'Polyhedra',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/polyhedraInfo.md',
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
    infoMd: './data/visualInfo.md',
    buildContent(body) {
      // All appearance settings in one window, grouped by concern (Sizes /
      // Scene / Rendering / Colors / Camera). The feature-specific controls
      // stay in their feature windows.
      body.appendChild(makeSectionHeadline('Sizes'));
      adoptStaticRows(body, ['atomSize', 'bondWidth'], false);
      // Polyhedra edge thickness belongs with the other size controls: since
      // the fat-lines change it applies in every render style, not only to
      // the cel hull-outline substitute it was introduced as.
      body.lastElementChild.appendChild(makePolyEdgeSliderRow());

      // Scene furniture: unit cell, cell axes (each show-toggle sharing a row
      // with its width slider) and the background picker.
      body.appendChild(makeSectionHeadline('Scene'));
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
      body.appendChild(sceneGroup);

      body.appendChild(makeSectionHeadline('Rendering'));
      addColorPanel(body.id); // rendering rows + its own 'Colors' section
      body.appendChild(makeSectionHeadline('Camera'));
      addCameraPanel(body.id);
    },
    defaults: { docked: true, order: 5, collapsed: false },
  });

  registerPanel({
    id: 'eos',
    title: 'EOS Fitting',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    infoMd: './data/eosInfo.md',
    available() { return true; },
    buildContent(body) { addEOSPanel(body.id); },
    onDestroyContent() { removeEOSPanel(); },
    // The fit plots live in a split view on the right of the 3D scene, not in
    // this docked window — it opens/closes with this panel's expand state.
    onExpand() { openEOSSplitView(); },
    onCollapse() { closeEOSSplitView(); },
    defaults: { docked: true, order: 92, collapsed: true },
  });

  registerPanel({
    id: 'splitDemo',
    title: 'Split View Demo',
    lifecycle: 'rebuild',
    infoMd: './data/splitDemoInfo.md',
    available() { return true; },
    buildContent(body) { addDummySplitPanel(body.id); },
    onDestroyContent() { removeDummySplitPanel(); },
    // Minimal example of a second feature reusing the same split view the EOS
    // panel uses (docs/ui/panels/SplitView.js) for its own, unrelated content.
    onExpand() { openDummySplitView(); },
    onCollapse() { closeDummySplitView(); },
    defaults: { docked: true, order: 93, collapsed: true },
  });

  registerPanel({
    id: 'landscape',
    title: 'Energy Landscape',
    lifecycle: 'rebuild',
    infoMd: './data/landscapeInfo.md',
    available() { return true; },
    buildContent(body) { addLandscapePanel(body.id); },
    onDestroyContent() { removeLandscapePanel(); },
    onExpand() { openLandscapeSplitView(); },
    onCollapse() { closeLandscapeSplitView(); },
    defaults: { docked: true, order: 94, collapsed: true },
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
    defaults: { docked: true, order: 100, collapsed: false },
  });
}
