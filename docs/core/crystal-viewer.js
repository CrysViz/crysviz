// .........................................................................................................
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
import { setupAtomTooltip } from '../ui/AtomTooltip.js';
import { setupControlsWiring } from '../ui/ControlsWiring.js';
import { setupSceneInteraction } from '../ui/SceneInteraction.js';
import { setupMeasurementToolbar } from '../ui/MeasurementToolbar.js';
import { pauseRendering, resumeRendering,animation_update} from '../render/index.js'; // animate function is not really an animation, but the function that runs the frames.
import {createShareButton,loadSharedStructure} from '../ui/ShareModule.js';
import {loadFromFilePath} from '../io/index.js';
import {updateBonds,rebuildBonds,disposeBondsMesh} from '../render/index.js'
import {updateSecondBonds,rebuildSecondBonds} from '../render/index.js'
import { updateLattice,recomputeLatticeDirs} from '../render/index.js'
import { updatePolyhedra} from '../render/index.js'
import {rebuildAtoms,updateAtoms} from '../render/index.js';
import {rebuildSecondAtoms,updateSecondAtoms} from '../render/index.js';


import {updateAllMeasurements,clearMeasureGraphics,clearMeasure} from '../render/MeasurementModule.js' // not all imports might be needed in this file


import {addAtomVacuumPanel} from '../ui/addToStructureModule/AddVacuumModule.js'
import {addCameraPanel} from '../ui/CameraPanel.js'
import {addColorPanel} from '../ui/ColorPanel.js'
import {addPanelToolbars} from '../ui/PanelToolbars.js'

import { updateField, parseCHGCARFile, parseCubeFile, clearField } from '../render/index.js';

// .........................................................................................................
// Import Panels
//
// Panel files should contain all the functions related to a specific panels
//
// // .........................................................................................................
import {setupScene, setupCameraButtons,resizeRenderer, switchCameraType
} from '../ui/WindowAndSceneControls.js'
import {renderComposition} from '../ui/StructureInfoPanel/General.js';
import {addControlPanelModeSwitch,addControlPanelSpinForceSwitch,addControlPanelAnalysisSwitch, updateControlSpinForcePanel} from '../ui/ControlPanel.js';
import {addBackendModeSwitch} from '../ui/BackendPanel/BackendSwitchPanel.js';

import {addSavePanel} from '../ui/SavePanel.js'
import {addAnalysisInfoPanel,addStorageInfoPanel,addBackendInfoPanel,addUploadInfoPanel} from '../ui/InfoPanel.js'

// NOTE: share-related import utils still need to move into the "share" module.



// file browser test
//
//


// Class Structure
//

// New imports (which go here, because they need initializations that happen above until things are refactored)
import { parse_any } from '../io/index.js';
import { initializeUIOnLoad } from '../ui/StructureInputModule.js';
import { fieldBrowser } from '../ui/FieldPanel.js';
import { resetMathBackend } from '../math/index.js';

// ........................................................................................................
//
// Some thing need to be globally defiend here. There should only be status variables left.
// Nothing should be defined here. Use store, classes, panels or modules for new definitions!
// ........................................................................................................

//console.log = () => {};
//console.warn = () => {};

const status = document.getElementById('status');
const setStatus = (s) => {
  if (status) status.textContent = s;
};

// ........................................................................................................
//
//These will not be kept as sson as classes and therefore trajectories are workgin
// ........................................................................................................



function updateOther() {
  // Rebuilds the Structure (composition/species/bonds) panel. Default updates
  // (structure load, frame change) reach here via reRenderOther=true and rely on
  // this to populate the panel. Callers that want the panel left *open* instead
  // pass reRenderComposition:"open" with reRenderOther:false, so the guarded call
  // in updateVisualization handles them and this one is skipped (no re-collapse).
  renderComposition();
  clearMeasureGraphics();

  measurements.measureLines.forEach(line => app.scene.add(line));
  measurements.measureLabels.forEach(label => app.scene.add(label));

  recomputeLatticeDirs();
  console.time("other:updateAllMeasurements");
  updateAllMeasurements();
  console.timeEnd("other:updateAllMeasurements");
  console.time("other:addAtomVacuumPanel");
  addAtomVacuumPanel();
  console.timeEnd("other:addAtomVacuumPanel");
}

export function updateVisualization(options = {}) {
  const {
    // Main Structure
    atomsUpdate = true,
    reRenderAtoms = false,
    bondsUpdate = true,
    reRenderBonds = false,
    reRenderLattice = true,

    // Comparison Structure
    SecondAtomsUpdate = false,
    SecondReRenderAtoms = false,
    SecondBondsUpdate = false,
    SecondReRenderBonds = false,

    // Panels
    reRenderOther = true,
    reRenderComposition = false,

    sOpacity = general.compOpacity,
    mOpacity = general.mainOpacity,
    reRenderField = false
  } = options;


  if (!fileBrowser.selectedStructure) {
    return;
  }

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

  // Comparison Structure
  if (SecondReRenderAtoms) {
    console.warn("Calling rebuildSecondAtoms")
    rebuildSecondAtoms(fileBrowser.comparisonStructure, sOpacity);
  }
  if (!SecondReRenderAtoms && SecondAtomsUpdate) {
    console.warn("Calling updateSecondAtoms")
    updateSecondAtoms(fileBrowser.comparisonStructure, sOpacity);
  }

  if (SecondReRenderBonds) {
    console.warn("Calling rebuildSecondBonds")
    rebuildSecondBonds(fileBrowser.comparisonStructure,sOpacity)
  }

  if (!SecondReRenderBonds && SecondBondsUpdate) {
    console.warn("Calling updateSecondBonds")
    updateSecondBonds(fileBrowser.comparisonStructure,sOpacity)
  }

  // TODO: comparison-structure lattice re-render is not implemented
  // (updateSecondLattice does not exist). Left disabled rather than throwing.
  // if (SecondReRenderLattice) updateSecondLattice(general.secondLatticeColor);

  // Panels
  if (reRenderComposition != false) {
    renderComposition(reRenderComposition);
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
  if (general.showPolyhedra || general.completePolyhedra) updatePolyhedra();
  console.timeEnd("uv:updateOther");
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
}


export async function loadStructure(content, fileName = '', isDefault = false) {
  try {

    const lower = (fileName || '').toLowerCase();
    const contentString = typeof content === 'string' ? content : '';
    
    // Field files are handled directly; every other format is dispatched by
    // parse_any (which owns all the structure-format sniffing).
    const treatAsCube = lower.endsWith('.cube') ||
                       lower.includes('.cube');

    const treatAsCHGCAR = lower.includes('chgcar') ||
                         lower.endsWith('.chgcar');

    if (treatAsCube) {
      await parseCubeFile(contentString, fileName);
    }
    else if (treatAsCHGCAR) {
      await parseCHGCARFile(contentString, fileName);
    }

    // Everything else is a structure file and goes through the single pure
    // pipeline. parse_any picks the format (POSCAR is its fallback) and returns
    // a StructureContainer; registration happens once via initializeUIOnLoad.
    else {
        // Pass the raw `content` (not contentString): most formats are text, but
        // binary formats like ASE .traj arrive as an ArrayBuffer and parse_any
        // dispatches them by extension.
        const structureContainer = await parse_any(content, fileName);
        if (structureContainer && structureContainer.structures) initializeUIOnLoad(structureContainer);
    }

   document.getElementById('structureControls').style.display = 'block';
   document.getElementById('structureControls2').style.display = 'block';

    createShareButton();
    // NOTE: do not call updateVisualization() here. Every load path above funnels
    // through initializeUIOnLoad() -> selectLastAddedRow() -> updateStructureFromRowAndStep(),
    // which already performs a full atoms+bonds+field+other re-render. Re-rendering here
    // doubled the (expensive, O(n^2)) bond build on every load.
    updateControlSpinForcePanel();
    console.warn(fileBrowser.selectedStructure)
    // Rebuild camera with size/distance based on structure and zoom scale
    switchCameraType();
    clearMeasure();
    resizeRenderer(app.orthographicFrustumSize);



  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}


async function loadDefaultStructure() {
  // Don't load default structure if we've already loaded a shared structure
  if (general.sharedStructureLoaded) {
    return;
  }

  setStatus('Loading default NaCl structure...');
  loadStructure(defaultPOSCAR4, 'C3N4', true);
      // Create a new Structure instance

}

function init() {
  return initApp();
}

async function initApp() {
  await initializeMathBackend();
  setupScene();

  // Click Atom
  setupAtomTooltip();
  setupSceneInteraction();




  setupCameraButtons();

 setupStructureInput({
   onLoadStructure: async (content, name) => {
     setStatus('Loading structure...');
     try {
       // Wait for the structure to load
       await loadStructure(content, name);
       setStatus('Structure loaded!');
     } catch (error) {
       console.error('Error loading structure:', error);
       setStatus('Error loading structure.');
     }
   },
   setStatus,
 });


  setupControlsWiring();
  setupMeasurementToolbar();

  // Initialize atomSize from the UI slider so the initial view respects the slider value
  (function initAtomSizeFromSlider(){
    const slider = document.getElementById('atomSize');
    const span = document.getElementById('atomSizeValue');
    if (slider) {
      const v = parseFloat(slider.value);
      if (!isNaN(v)) {
        general.atomSize = v; // apply slider value to internal scale
        if (span) span.textContent = general.atomSize.toFixed(1);
      }
    }
  })();

  // Initialize bond width from slider
  (function initBondWidthFromSlider(){
    const slider = document.getElementById('bondWidth');
    const span = document.getElementById('bondWidthValue');
    if (slider) {
      const v = parseFloat(slider.value);
      if (!isNaN(v)) {
        general.bondRadius = v;
        if (span) span.textContent = general.bondRadius.toFixed(2);
      }
    }
  })();


  app.camera.position.set(20, 20, 20);
  app.controls.update();

  // Load default structure after everything is initialized
    loadSharedStructure();

  if (!general.sharedStructureLoaded) {
    console.log("loadFromFilePath...")
    loadFromFilePath()
    console.log("loaded:",fileBrowser.selectedStructure)
  }
  if (!general.sharedStructureLoaded) {
    loadDefaultStructure();
  }


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
  window.addEventListener('resize', () => resizeRenderer(app.orthographicFrustumSize));
  window.addEventListener('error', e => setStatus(`Error: ${e.message}`));
  window.addEventListener('unhandledrejection', e => setStatus(`Promise error: ${e.reason}`));

// Panel toggle functionality for all screen sizes
function initUIPanels() {
  createBackgroundControl();
  setupThemeSystem();
  addControlPanelModeSwitch();
  addControlPanelSpinForceSwitch();
  addBackendModeSwitch();
  addSavePanel();
  addCameraPanel();
  addColorPanel();
  addPanelToolbars();
  addAtomVacuumPanel();
  addControlPanelAnalysisSwitch();
  addStorageInfoPanel();
  addAnalysisInfoPanel();
  addUploadInfoPanel();
  addBackendInfoPanel();

  // Add viewport meta tag if not present for proper mobile scaling
  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1.0, user-scalable=no';
    document.head.appendChild(viewport);
  }
}

init()
  .then(() => {
    setupMobileMenu();
    initUIPanels();
  })
  .catch((error) => {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  });
