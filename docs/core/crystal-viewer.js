import * as THREE from '../external/three/three.module.js';
// .........................................................................................................
// store.js contains all state and default variables, e.g. three,js related, colors, default structure, etc.
//
//  This is currently necessary as classes are not yet fully adapter. structureData, originalStructureData,spinsData are global variables for now and should be replaced
//  with the proper classes. However, this already solved some problems with camera and controls getting redefined as a side effect of some functions of the viewing angle
//  control. The rest of the singletons should be preserved.
// .........................................................................................................

import {structureShip, measurements,app, groups,fileBrowser, general, mode, highlightHover} from '../state/store.js';
import {defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../defaults/color_texture_defaults.js'
import {defaultPOSCAR,defaultPOSCAR2,defaultPOSCAR3,defaultPOSCAR4} from '../defaults/structure_defaults.js'


//this needs to life somewhere else! only for testing
const tableBody = document.querySelector("#objectTable tbody");


// import from the old file structure that need to be combined and ported to the new structure
import { setupSecondStructureInput } from '../ui/SecondStructureModule.js';
import { parseOUTCAR} from '../io/index.js';
import { parsePWSCFout} from '../io/index.js';
import { parsePWSCFin} from '../io/index.js';
import {parseXYZFile} from '../io/index.js';
import { setupStructureInput, parsePOSCAR} from '../ui/StructureInputModule.js';

// ........................................................................................................
// Import Modules
//
// These modules should contain all the functions related to specific functionalities
//
// .........................................................................................................
import { updateAngleDisplays, setupAxisControls} from '../render/index.js';
import { createBackgroundControl } from '../ui/BackgroundPicker.js';
import { setupMobileMenu } from '../ui/MobileMenu.js';
import { setupAtomTooltip } from '../ui/AtomTooltip.js';
import { setupControlsWiring } from '../ui/ControlsWiring.js';
import { setupSceneInteraction } from '../ui/SceneInteraction.js';
import { setupMeasurementToolbar } from '../ui/MeasurementToolbar.js';
import { pauseRendering, resumeRendering,animation_update} from '../render/index.js'; // animate function is not really an animation, but the function that runs the frames.
import { shareStructure,createShareButton,loadSharedStructure} from '../ui/ShareModule.js';
import {loadFromFilePath} from '../io/index.js';
import {updateBonds,rebuildBonds,buildBondObjects,updateSingleBondDiameter,disposeBondsMesh} from '../render/index.js'
import {updateSecondBonds,rebuildSecondBonds,buildSecondBondObjects,updateSecondSingleBondDiameter} from '../render/index.js'
import { periodicWrapped, updateLattice,recomputeLatticeDirs,latticeDirsNorm,fracToCart,cartToFrac,latticeDirs} from '../render/index.js'
import {updatePolyhedra} from '../render/index.js'
import {rebuildAtoms,updateAtoms,updateSingleAtomDiameter} from '../render/index.js';
import {rebuildSecondAtoms,updateSecondAtoms,updateSecondSingleAtomDiameter} from '../render/index.js';


import {createSupercell} from '../ui/SuperCellModule.js';
import {updateAllMeasurements, addAngleMeasurement, clearAllMeasurements,drawMeasureGraphics,
        addDistanceMeasurement, updateMeasurementMarkers,clearMeasureGraphics,clearMeasure} from '../ui/MeasurementModule.js' // not all imports might be needed in this file

import {highlightBondInfoInStructurePanel,clearHighlightAtom,highlightBondIn3D,highlightAtomIn3D,clearAllHighlights,highlightAtomInStructurePanel } from '../ui/SelectAndHighlightModule.js';

import {addAtomVacuumPanel} from '../ui/addToStructureModule/AddVacuumModule.js'
import {addCameraPanel} from '../ui/CameraPanel.js'
import {addColorPanel} from '../ui/ColorPanel.js'

import { updateField, parseCHGCARFile, parseCubeFile, clearField } from '../render/index.js';
//import {addAtomPanel} from '../modules/addToStructureModule/addAtomPanel.js'

// .........................................................................................................
// Import Panels
//
// Panel files should contain all the functions related to a specific panels
//
// // .........................................................................................................
import {setupScene, setupCameraButtons, initCamera, initRenderer, initLabelRenderer,initControls,resizeRenderer,
  initAxesGizmo, disposeGroup, switchCameraType, setViewDirection,resetView,collapseAllAtomExpansions
} from '../ui/WindowAndSceneControls.js'
import {loadAboutContent, openAboutPanel, closeAboutPanel} from '../ui/AboutPanel.js';
import {addSpinPanel} from '../ui/SpinPanel.js';
import {resetBondLengths, createBondLengthControls} from '../ui/BondLengthPanel.js';
import {renderComposition} from '../ui/StructureInfoPanel/General.js';
import {addTrajectoryPlayer} from '../ui/TrajectoryPanel.js';
import {addControlPanelModeSwitch,addControlPanelSpinForceSwitch,addControlPanelAnalysisSwitch, updateControlSpinForcePanel} from '../ui/ControlPanel.js';
import {addHistogramPanel} from  '../ui/AnalysisPanels/BondAnalysisPanel.js';
import {addBackendModeSwitch} from '../ui/BackendPanel/BackendSwitchPanel.js';

import {addSavePanel} from '../ui/SavePanel.js'
import {addAnalysisInfoPanel,addStorageInfoPanel,addBackendInfoPanel,addUploadInfoPanel} from '../ui/InfoPanel.js'

// .........................................................................................................
// import utils needs to moce to the "share" functionality. This is currently broken.
// .........................................................................................................
import {
  captureCompleteState,
  createCompleteShareableURL,
  createLegacyShareableURL,
  restoreCompleteState,
  generatePOSCARString,
} from '../utils/index.js';

// file browser test
//
//
import {createRow} from '../ui/FileBrowswerPanel.js'


// Class Structure
//
import {Structure} from '../model/index.js'

// New imports (which go here, because they need initializations that happen above until things are refactored)
import { parse_any, isLikelyCIFContent, isLikelymagCIFContent } from '../io/index.js';
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

const view = document.getElementById('view');
const status = document.getElementById('status');
const setStatus = (s) => {
  if (status) status.textContent = s;
};

// ........................................................................................................
//
//These will not be kept as sson as classes and therefore trajectories are workgin
// ........................................................................................................



function updateOther() {
  renderComposition();
  clearMeasureGraphics();

  measurements.measureLines.forEach(line => app.scene.add(line));
  measurements.measureLabels.forEach(label => app.scene.add(label));

  recomputeLatticeDirs();
  updateAllMeasurements();
  addAtomVacuumPanel();
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
    SecondReRenderLattice = false,

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

  if (SecondReRenderLattice) updateSecondLattice(general.secondLatticeColor);

  // Panels
  if (reRenderComposition != false) {
    renderComposition(reRenderComposition);
  }
  if (reRenderLattice) updateLattice(general.currentLatticeColor);
  if (reRenderOther) updateOther();
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
    
    // Add these new file type detections
    const treatAsCube = lower.endsWith('.cube') ||
                       lower.includes('.cube');
                       
    const treatAsCHGCAR = lower.includes('chgcar') ||
                         lower.endsWith('.chgcar');

    const treatAsCIF = lower.endsWith('.cif') ||
                      lower.includes('.cif') ||
                      /(^|\W)cif(\W|$)/.test(lower) ||
          isLikelyCIFContent(contentString);
    const treatAsmagCIF = lower.endsWith('.mcif') ||
        lower.includes('.mcif') ||
      /(^|\W)mcif(\W|$)/.test(lower) ||
          isLikelymagCIFContent(contentString);

    const treatAsOUTCAR = lower.endsWith('.vasp.out') ||
                      lower.includes('.vasp.out') ||
                      lower.includes('outcar');

    const treatAsPWSCFout = lower.endsWith(".scf.out") ||
                            lower.endsWith(".scf.in.out") ||
                            lower.endsWith(".vcrx.out") ||
                            lower.endsWith(".vcrx.in.out") ||
                            lower.includes('.scf.out') ||
                            lower.includes('.scf.in.out') ||
                            lower.includes(".vcrx.out") ||
                            lower.includes(".vcrx.in.out");


     const treatAsPWSCFin = lower.endsWith(".scf.in") ||
                            lower.endsWith(".vcrx.in");

     const treatAsEXZY = lower.endsWith(".xyz") ||
                          lower.endsWith(".exyz");  

    if (treatAsEXZY){
      await parseXYZFile(content, fileName)
    }

    else if (treatAsCube) {
      await parseCubeFile(contentString, fileName);
    }
    else if (treatAsCHGCAR) {
      await parseCHGCARFile(contentString, fileName);
    }

    else if (treatAsCIF || treatAsmagCIF) {
        const structureContainer = await parse_any(contentString,fileName);
        initializeUIOnLoad(structureContainer);
    }

   else if (treatAsPWSCFin) {
        parsePWSCFin(content,fileName);
    }

    else if (treatAsPWSCFout) {
        parsePWSCFout(content,fileName);
    }

    else if (treatAsOUTCAR){
        await parseOUTCAR(contentString,fileName);
    }
    else {
      parsePOSCAR(contentString,fileName);

    }

  // Ensure the fields exist and are the right typed arrays
    //



    //loadColorOverrides();
    //loadIndividualAtomColors();

   document.getElementById('structureControls').style.display = 'block';
   document.getElementById('structureControls2').style.display = 'block';

    //createBondLengthControls();
    createShareButton();
    updateVisualization({reRenderAtoms:true,reRenderBonds:true,updateOther:true,reRenderField:true});
    updateControlSpinForcePanel();
    console.warn(fileBrowser.selectedStructure)
    // Rebuild camera with size/distance based on structure and zoom scale
    switchCameraType();
    //resetView();
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
  addControlPanelModeSwitch();
  addControlPanelSpinForceSwitch();
  addBackendModeSwitch();
  addSavePanel();
  addCameraPanel();
  addColorPanel();
  addAtomVacuumPanel();
  addControlPanelAnalysisSwitch();
  addStorageInfoPanel();
  addAnalysisInfoPanel();
  addUploadInfoPanel();
  addBackendInfoPanel();
  //addAtomPanel();
  const errorPanel = document.getElementById("errorPanel");

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
