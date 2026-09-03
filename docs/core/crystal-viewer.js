// .........................................................................................................core
// store.js contains all state and default variables, e.g. three,js related, colors, default structure, etc.
//
//  This is currently necessary as classes are not yet fully adapter. structureData, originalStructureData,spinsData are global variables for now and should be replaced
//  with the proper classes. However, this already solved some problems with camera and controls getting redefined as a side effect of some functions of the viewing angle
//  control. The rest of the singletons should be preserved.
// .........................................................................................................

import { measurements,app,fileBrowser, general} from '../state/store.js';
import {defaultPOSCAR4} from '../defaults/structure_defaults.js'

// import from the old file structure that need to be combined and ported to the new structure
import { setupStructureInput } from '../ui/StructureInputModule.js';
import { showLoadErrorModal, showLoadWarningModal } from '../ui/LoadErrorModal.js';
// Side-effect import: AboutPanel wires the "about" trigger at module load.
// (Its named exports are unused, so keep it as a bare import.)
import '../ui/AboutPanel.js';

// ........................................................................................................
// Import Modules
//
// These modules should contain all the functions related to specific functionalities
//
// .........................................................................................................
import { createBackgroundControl } from '../ui/BackgroundPicker.js';
import { setupThemeSystem } from '../ui/ThemeManager.js';
import { setupMobileMenu } from '../ui/MobileMenu.js';
import { setupControlsWiring, sizeSliderToValue, ATOM_SIZE_RANGE, BOND_RADIUS_RANGE } from '../ui/ControlsWiring.js';
import { setupSceneInteraction } from '../ui/SceneInteraction.js';
import { setupMeasurementToolbar } from '../ui/MeasurementToolbar.js';
import { pauseRendering, resumeRendering,animation_update,requestRender,runPeriodicWrapped,
  applyRotationFromUI, captureSceneToPng } from '../render/index.js'; // animate function is not really an animation, but the function that runs the frames.
import { setActivePipelineFromController } from '../ui/ColorPanel.js';
import {createShareButton,loadSharedStructure,loadCrysvizFile} from '../ui/ShareModule.js';
import {loadFromFilePath} from '../io/index.js';
import {updateBonds,rebuildBonds,disposeBondsMesh} from '../render/index.js'
import {updateOverlayBonds,rebuildOverlayBonds} from '../render/index.js'
import { updateLattice,recomputeLatticeDirs} from '../render/index.js'
import { updatePolyhedra, notifyColorsChanged } from '../render/index.js'
import {rebuildAtoms,updateAtoms,deriveVisibleWrapped} from '../render/index.js';
import {rebuildOverlayAtoms,updateOverlayAtoms} from '../render/index.js';
import {updateHydrogenBonds} from '../render/index.js';


import {updateAllMeasurements,clearMeasureGraphics,clearMeasure} from '../render/MeasurementModule.js' // not all imports might be needed in this file


import {initAddStructureButton, initModifyStructureButton} from '../ui/addToStructureModule/AddStructureModule.js'
import {initCombineTrajectoriesButton, selectStructure} from '../ui/FileBrowswerPanel.js'
import {initPanelSystem, finishPanelRegistration, revealFeaturePanels, refreshActivePanels} from '../ui/panels/PanelManager.js'
import {registerDefaultPanels} from '../ui/panels/defaultPanels.js'
import {initFontScale} from '../ui/FontScaleModule.js'
import {initKeyboardShortcuts} from '../ui/KeyboardShortcuts.js'

import { updateField, parseCHGCARFile, parseCubeFile, parseWavecarFile, clearField, revealFieldPanelForCurrentStructure } from '../render/index.js';
import { updateGroundPlane } from '../render/index.js';

// .........................................................................................................
// Import Panels
//
// Panel files should contain all the functions related to a specific panels
//
// // .........................................................................................................
import {setupScene, setupCameraButtons,resizeRenderer, switchCameraType, recenterCamera
} from '../ui/WindowAndSceneControls.js'
import {initGizmoDrag} from '../ui/GizmoDrag.js'
import {renderComposition} from '../ui/StructureInfoPanel/General.js';
import {addBackendModeSwitch} from '../ui/BackendPanel/BackendSwitchPanel.js';

import {addSavePanel} from '../ui/SavePanel.js'
import {initImageExportPanel} from '../ui/ImageExportPanel.js'
import {initRaytraceWarningModal} from '../ui/RaytraceWarningModal.js'

// NOTE: share-related import utils still need to move into the "share" module.



// file browser test
//
//


// Class Structure
//

// New imports (which go here, because they need initializations that happen above until things are refactored)
import { parse_any } from '../io/index.js';
import { FileSource, detectFormat, materialize, HEAD_BYTES } from '../io/index.js';
import { initializeUIOnLoad } from '../ui/StructureInputModule.js';
import { fieldBrowser } from '../ui/FieldPanel.js';
import { resetMathBackend } from '../math/index.js';
import { applyFrameFast } from '../render/FastFrameModule.js';
import { getActiveStructure, getContainerForStructure } from '../state/structures.js';

// ........................................................................................................
//
// Some thing need to be globally defiend here. There should only be status variables left.
// Nothing should be defined here. Use store, classes, panels or modules for new definitions!
// ........................................................................................................

//console.log = () => {};
//console.warn = () => {};

// Only the very first structure shown gets a fresh fit-to-structure camera
// (switchCameraType); every later load/switch re-centers on the new
// structure but keeps the user's chosen rotation and zoom (recenterCamera).
let cameraFitted = false;

const status = document.getElementById('status');
const setStatus = (s) => {
  if (status) status.textContent = s;
};

// ........................................................................................................
//
//These will not be kept as sson as classes and therefore trajectories are workgin
// ........................................................................................................



function updateOther() {
  clearMeasureGraphics();

  measurements.measureLines.forEach(line => app.scene.add(line));
  measurements.measureLabels.forEach(label => app.scene.add(label));

  recomputeLatticeDirs();
  console.time("other:updateAllMeasurements");
  updateAllMeasurements();
  console.timeEnd("other:updateAllMeasurements");
}

export function updateVisualization(options = {}) {
  const {
    // Main Structure
    atomsUpdate = true,
    reRenderAtoms = false,
    bondsUpdate = true,
    reRenderBonds = false,
    reRenderLattice = true,

    // Overlay structures (Structure Overlay module) — applies to every entry
    // in fileBrowser.overlayEntries, each rendered/updated with its own opacity
    // and bonds-visibility (no single shared "second" opacity/visibility anymore).
    SecondAtomsUpdate = false,
    SecondReRenderAtoms = false,
    SecondBondsUpdate = false,
    SecondReRenderBonds = false,

    // Panels
    reRenderOther = true,
    reRenderComposition = false,

    // Polyhedra are expensive (per-atom hull recompute). Default on to preserve
    // existing behavior for every panel/playback caller; the hot MD/relax paths
    // pass false so a fallback frame doesn't pay for a polyhedra rebuild every step.
    // Gated separately from reRenderOther because several reRenderOther:false
    // callers (lattice transform, cut planes, bond-length edits) DO move geometry
    // and rely on polyhedra refreshing.
    reRenderPolyhedra = true,

    mOpacity = general.mainOpacity,
    reRenderField = false
  } = options;


  if (!fileBrowser.selectedStructure) {
    return;
  }

  // Every instance-indexed consumer below reads periodic.visibleWrapped, which is
  // derived from periodic.wrapped. Callers that recompute .wrapped themselves
  // (runPeriodicWrapped in the MD/relax loops, AddonAPI, polyhedra) would otherwise
  // leave .visibleWrapped pointing at the previous frame's object, so the atoms
  // never move on the non-rebuild path. Re-derive here, once, for all of them.
  // Cheap: same-reference no-op unless an atom is actually hidden.
  deriveVisibleWrapped(fileBrowser.selectedStructure);

  // Main Structure
  if (reRenderAtoms) {
    console.warn("Calling rebuildAtoms")
    rebuildAtoms(mOpacity);
  }
  if (!reRenderAtoms && atomsUpdate) {
    console.warn("Calling updateAtoms with opacity")
    updateAtoms(mOpacity);
  }

  if (reRenderBonds) {
    if (general.showBonds) {
      console.warn("Calling rebuildBonds")
      rebuildBonds(mOpacity)
    } else {
      disposeBondsMesh(true);
    }
  }

  if (!reRenderBonds && bondsUpdate && general.showBonds) {
    console.warn("Calling updateBonds")
    updateBonds(mOpacity)
  }

  // Overlay structures — one rebuild/update pass per fileBrowser.overlayEntries
  // entry, each keeping its own opacity and bonds visibility.
  if (SecondReRenderAtoms || SecondAtomsUpdate || SecondReRenderBonds || SecondBondsUpdate) {
    for (const entry of fileBrowser.overlayEntries) {
      if (SecondReRenderAtoms) {
        console.warn("Calling rebuildOverlayAtoms")
        rebuildOverlayAtoms(entry.key, entry.structure, entry.opacity);
      } else if (SecondAtomsUpdate) {
        console.warn("Calling updateOverlayAtoms")
        updateOverlayAtoms(entry.key, entry.structure, entry.opacity);
      }

      if (SecondReRenderBonds) {
        console.warn("Calling rebuildOverlayBonds")
        rebuildOverlayBonds(entry.key, entry.structure, entry.opacity, entry.showBonds);
      } else if (SecondBondsUpdate) {
        console.warn("Calling updateOverlayBonds")
        updateOverlayBonds(entry.key, entry.structure, entry.opacity, entry.showBonds);
      }
    }
  }

  // TODO: overlay-structure lattice re-render is not implemented
  // (updateOverlayLattice does not exist). Left disabled rather than throwing.
  // if (SecondReRenderLattice) updateOverlayLattice(general.secondLatticeColor);

  // Panels
  if (reRenderComposition != false) {
    renderComposition(reRenderComposition);
    // #addButton is only (re)created when renderComposition() runs, so
    // (re)wire the Modify Structure panel here rather than on every
    // updateVisualization() call — avoids stacking duplicate click listeners
    // on the same live button node.
    initModifyStructureButton();
  }
  console.time("uv:updateLattice");
  if (reRenderLattice) updateLattice(general.currentLatticeColor);
  console.timeEnd("uv:updateLattice");
  console.time("uv:updateOther");
  if (reRenderOther) updateOther();
  // Polyhedra depend on atoms/bonds/lattice, so refresh them whenever the scene
  // re-renders and the feature is on (persists across structure & frame changes).
  // Also run when "Complete Polyhedra" is on (faces hidden) so the completing atoms are
  // computed and shown.
  if (reRenderPolyhedra && (general.showPolyhedra || general.completePolyhedra)) updatePolyhedra();
  console.timeEnd("uv:updateOther");
  // Broad safety net: every colour edit path (individual atom/bond/polyhedron,
  // element/category bulk edits, force/length colour-mode switches) ends up
  // calling updateVisualization() to make the change visible, even the ones
  // that don't separately call updatePolyhedraColors() — so anything that
  // needs to stay in sync with live colour edits (e.g. the Polyhedron
  // Inspector's mini render) can listen for this instead of tracking down
  // every individual call site.
  notifyColorsChanged();
  if (reRenderField) {
    if (fileBrowser.selectedStructure.volumetricFields && fieldBrowser.selectedField) {
      updateField();
    }
    else {
      clearField();
    }
  }

  if (measurements.measureLines.length > 0) {
    updateAllMeasurements();
  }

  // Dashed D-H...A hydrogen bonds track the same geometry as bonds/measurements:
  // recompute them here so they follow structure switches, trajectory steps,
  // periodic-image changes and slider edits. Cheap no-op when nothing eligible
  // is enabled (see HydrogenBondModule.computeHydrogenBonds).
  updateHydrogenBonds(fileBrowser.selectedStructure);

  // Reposition the raster ground disc to the (possibly new) structure bottom —
  // covers load/switch, supercell, cut planes, atom-size rebuilds, trajectory
  // steps. O(1) when the ground is off.
  updateGroundPlane();

  // Everything above mutated the scene; schedule a frame (rendering is on-demand).
  requestRender();
}

function commitHostPositions() {
  const structure = getActiveStructure();
  if (!structure) return false;
  const frac = structure.atoms.map((atom) => atom.position);
  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);
  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true,
    reRenderOther: false,
    reRenderComposition: false,
    reRenderPolyhedra: general.showPolyhedra || general.completePolyhedra,
  });
  return true;
}

async function updateHostLattice(lattice) {
  const structure = getActiveStructure();
  if (!structure) return false;
  structure.lattice = lattice.map((row) => [...row]);
  structure.periodic = { hash: null, wrapped: null };
  const frac = structure.atoms.map((atom) => atom.position);
  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);
  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true,
    reRenderOther: true,
    reRenderComposition: false,
    reRenderPolyhedra: false,
  });
  if (general.showPolyhedra || general.completePolyhedra) {
    await updatePolyhedra();
    requestRender();
  }
  return true;
}

export async function loadStructure(content, fileName = '', isDefault = false, format = '') {
  try {

    const parserFileName = format && !String(fileName).toLowerCase().endsWith(`.${String(format).toLowerCase()}`)
      ? `${fileName}.${format}`
      : fileName;
    let structureContainer = null;

    // `content` may be a string, an ArrayBuffer, a Blob/File, or an io/FileSource.
    // Wrapping it here means nothing below has to care, and crucially means a
    // format can decline to be read in full — which is the only way a multi-GB
    // WAVECAR can be opened at all.
    const source = FileSource.from(content);

    // Format detection lives in io/formats.js and goes by the file's contents
    // first: the first HEAD_BYTES are read for every file (one cheap slice,
    // even for a multi-GB WAVECAR) and the name is only the tiebreak/fallback.
    const head = await source.readHead(HEAD_BYTES);
    const descriptor = detectFormat({ fileName: parserFileName, head });

    // Text formats get the whole file as a string exactly as before; .traj gets
    // an ArrayBuffer; WAVECAR gets the FileSource itself and reads byte ranges.
    const payload = await materialize(source, descriptor);

    switch (descriptor.id) {
      case 'crysviz':
        // A saved CrysViz session: structure + full visual state (ShareModule).
        // Loads its own structure via parsePOSCAR -> initializeUIOnLoad.
        structureContainer = await loadCrysvizFile(payload, fileName);
        break;

      case 'wavecar':
        // A proxy over the file rather than a parse of it: only the headers are
        // read now, and individual bands are expanded on demand. This may open a
        // dialog when the cell does not match the selected structure.
        // `materialize` returns the FileSource itself for a random-access format;
        // the cast tells the checker which arm of its union this branch is in.
        structureContainer = await parseWavecarFile(
          /** @type {import('../io/index.js').FileSource} */ (payload), fileName);
        break;

      case 'cube':
        structureContainer = await parseCubeFile(payload, fileName);
        break;

      case 'chgcar':
      case 'elfcar':
        structureContainer = await parseCHGCARFile(
          payload, fileName, descriptor.id === 'elfcar' ? 'ELFCAR' : 'CHGCAR');
        break;

      // Everything else is a structure file and goes through the single pure
      // pipeline. parse_any picks the format (POSCAR is its fallback) and
      // returns a StructureContainer; registration happens once via
      // initializeUIOnLoad.
      default:
        structureContainer = await parse_any(payload, parserFileName);
        // The parser filename may carry a format suffix, but the browser must
        // display the manifest/addon supplied name verbatim.
        if (structureContainer) structureContainer.fileName = fileName;
        // A parser that returns an empty container (no structures, or a
        // structure with no atoms) "loaded" nothing — treat it as a failure so
        // it reaches the warning modal instead of silently doing nothing.
        if (!structureContainer?.structures?.length
            || !structureContainer.structures.some((s) => s?.atoms?.length)) {
          throw new Error('No atoms or structures were found in this file.');
        }
        initializeUIOnLoad(structureContainer);
        break;
    }

    // A WAVECAR whose dialog was cancelled deliberately loads nothing. That is a
    // user decision, not a failure, so return quietly instead of falling into
    // the "loader returned no container" error below.
    if (structureContainer === null && descriptor.id === 'wavecar') {
      setStatus('Load cancelled.');
      return { ok: false, cancelled: true, name: fileName, format: format || undefined };
    }

    if (!structureContainer) throw new Error('Structure loader returned no structure container');

   revealFeaturePanels();

    // A file that carried volumetric data is opened for that data, so bring the
    // Volumetric Field window up rather than leaving it collapsed in the dock.
    // No-op for a plain structure file.
    revealFieldPanelForCurrentStructure();

    createShareButton();
    // NOTE: do not call updateVisualization() here. Every load path above funnels
    // through initializeUIOnLoad() -> selectLastAddedRow() -> updateStructureFromRowAndStep(),
    // which already performs a full atoms+bonds+field+other re-render. Re-rendering here
    // doubled the (expensive, O(n^2)) bond build on every load.
    console.warn(fileBrowser.selectedStructure)
    // .crysviz restores its camera asynchronously as part of the session;
    // that saved pose is authoritative and must not be overwritten here.
    if (descriptor.id !== 'crysviz') {
      // The first structure ever shown gets a fresh fit-to-structure camera;
      // later loads/switches keep the user's rotation and zoom, only
      // re-centering on the new structure (see `cameraFitted`).
      if (!cameraFitted) {
        switchCameraType();
        cameraFitted = true;
      } else {
        recenterCamera();
      }
      clearMeasure();
    }
    resizeRenderer(app.orthographicFrustumSize);

    // Soft warnings a parser attached for data it loaded WITHOUT (e.g. an
    // aims.out that is spin-polarised but whose per-atom moments we couldn't
    // read). The structure loaded fine; this just tells the user what dropped.
    const warnings = structureContainer.loadWarnings;
    if (Array.isArray(warnings) && warnings.length) {
      showLoadWarningModal({ fileName, message: warnings[0] });
    }

    return { ok: true, container: structureContainer, name: fileName, format: format || undefined };
  } catch (error) {
    // Single choke point for every load path and every format: surface a
    // visible warning instead of failing silently. The status line is kept as
    // a secondary, non-blocking trace.
    setStatus(`Error: ${error.message}`);
    console.error(error);
    showLoadErrorModal({ fileName, message: error?.message });
    throw error;
  }
}


async function loadDefaultStructure() {
  setStatus('Loading default structure...');
  await loadStructure(defaultPOSCAR4, 'oP28-C3N4', true);
}

export async function initializeCore(browserHostController) {
  browserHostController.configure({
    loadStructure,
    selectStructure,
    applyFrameFast,
    commitPositions: commitHostPositions,
    updateLattice: updateHostLattice,
    recenterCamera,
    rotateCamera: (angle, axis) => { applyRotationFromUI(angle, axis); requestRender(); },
    setRenderPipeline: setActivePipelineFromController,
    captureSceneToPng,
  });
  await initApp();
  setupMobileMenu();
  await initUIPanels();
  return {
    loadShared: async () => {
      const result = await loadSharedStructure();
      if (result) browserHostController.emitLoaded(getContainerForStructure(getActiveStructure()));
      return result;
    },
    loadHash: async () => {
      const result = await loadFromFilePath();
      if (result) browserHostController.emitLoaded(getContainerForStructure(getActiveStructure()));
      return result;
    },
    loadDefault: async () => {
      await loadDefaultStructure();
      browserHostController.emitLoaded(getContainerForStructure(getActiveStructure()));
    },
  };
}

async function initApp() {
  await initializeMathBackend();
  setupScene();
  initGizmoDrag();

  // Click Atom
  setupSceneInteraction();




  setupCameraButtons();

 setupStructureInput({
   onLoadStructure: async (content, name) => {
     setStatus('Loading structure...');
     await loadStructure(content, name);
     setStatus('Structure loaded!');
   },
   setStatus,
 });


  setupControlsWiring();
  setupMeasurementToolbar();

  // Initialize atomSize from the UI slider so the initial view respects the
  // slider value. The sliders hold [0,1] positions with a quadratic mapping
  // into the value range (ui/ControlsWiring.js).
  (function initAtomSizeFromSlider(){
    const slider = document.getElementById('atomSize');
    const span = document.getElementById('atomSizeValue');
    if (slider) {
      const pos = parseFloat(slider.value);
      if (!isNaN(pos)) {
        general.atomSize = sizeSliderToValue(pos, ATOM_SIZE_RANGE);
        if (span) span.textContent = general.atomSize.toFixed(2);
      }
    }
  })();

  // Initialize bond width from slider
  (function initBondWidthFromSlider(){
    const slider = document.getElementById('bondWidth');
    const span = document.getElementById('bondWidthValue');
    if (slider) {
      const pos = parseFloat(slider.value);
      if (!isNaN(pos)) {
        general.bondRadius = sizeSliderToValue(pos, BOND_RADIUS_RANGE);
        if (span) span.textContent = general.bondRadius.toFixed(2);
      }
    }
  })();


  app.camera.position.set(20, 20, 20);
  app.controls.update();

  function handleVisibilityChange() {
  if (document.hidden) pauseRendering();
    else resumeRendering();
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('blur', pauseRendering);
  window.addEventListener('focus', resumeRendering);

  animation_update();
}

async function initializeMathBackend() {
  if (!general.useWasmMath) {
    resetMathBackend();
    return;
  }

  try {
    const { initMathWasmBackend, installMathWasmBackend } = await import('../math/backend-wasm.js');
    const backend = await initMathWasmBackend(new URL('../compiled/math_backend.wasm', import.meta.url));
    installMathWasmBackend(backend);
  } catch (error) {
    resetMathBackend();
    general.useWasmMath = false;
    console.warn('[math] Failed to initialize WASM backend, falling back to JavaScript backend', error);
  }
}
  // rAF-coalesced: a window drag-resize fires 'resize' many times per second,
  // and resizeRenderer() does real GPU work (renderer/pipeline/label/gizmo
  // setSize, a full polyhedra-group traversal). Calling all of that
  // synchronously on every raw event — outside the on-demand render loop's
  // own rAF tick — let the browser paint the just-cleared (WebGL clears its
  // drawing buffer on any canvas resize) but not-yet-redrawn canvas in
  // between, which showed up as the scene background flickering during any
  // resize. Coalescing into a single rAF callback per frame lands the resize
  // and the redraw it triggers in the same frame instead.
  let rendererResizePending = false;
  window.addEventListener('resize', () => {
    if (rendererResizePending) return;
    rendererResizePending = true;
    requestAnimationFrame(() => {
      rendererResizePending = false;
      resizeRenderer(app.orthographicFrustumSize);
    });
  });
  window.addEventListener('error', e => setStatus(`Error: ${e.message}`));
  window.addEventListener('unhandledrejection', e => setStatus(`Promise error: ${e.reason}`));

// Panel toggle functionality for all screen sizes
async function initUIPanels() {
  initFontScale();
  createBackgroundControl();
  await setupThemeSystem();
  initPanelSystem();
  registerDefaultPanels();
  finishPanelRegistration();
  // Apply availability (grey-out) once now that panels exist. On first load the
  // default structure is loaded before panels are registered, so its own
  // revealFeaturePanels() refresh ran against no panels; this makes the initial
  // greyed/available state match what a file-selector click would produce.
  refreshActivePanels();
  addBackendModeSwitch();
  addSavePanel();
  initImageExportPanel();
  initRaytraceWarningModal();
  initModifyStructureButton();
  initAddStructureButton();
  initCombineTrajectoriesButton();
  initKeyboardShortcuts();

  // Add viewport meta tag if not present for proper mobile scaling
  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1.0, user-scalable=no';
    document.head.appendChild(viewport);
  }
}
