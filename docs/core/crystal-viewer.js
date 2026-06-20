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
import {setupScene, initCamera, initRenderer, initLabelRenderer,initControls,resizeRenderer,
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

  let raycaster = new THREE.Raycaster();
  let mouse = new THREE.Vector2();

  setupAtomTooltip();

  function onClickPick(event){
    // Only handle clicks if a mode is enabled
    if (mode.measureMode === 'none') return;

    // Prevent default behavior to avoid conflicts with pan/zoom
    event.preventDefault();
    event.stopPropagation();

    // Note: Double-click detection is handled by separate onDoubleClickAtom function

    // Handle both mouse and touch events with better error checking
    let clientX, clientY;

    if (event.type === 'touchend' || event.type === 'touchstart') {
      // For touch events, use the appropriate touch list
      const touchList = event.type === 'touchstart' ? event.touches : event.changedTouches;
      if (touchList && touchList.length > 0) {
        clientX = touchList[0].clientX;
        clientY = touchList[0].clientY;
      } else {
        console.warn('Touch event without touch coordinates');
        return;
      }
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    if (clientX === undefined || clientY === undefined) {
      console.warn('Could not get event coordinates');
      return;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    mouse.set(x, y);
    raycaster.setFromCamera(mouse, app.camera);
    if (!groups.atomsMesh) return;

    const hits = raycaster.intersectObject(groups.atomsMesh);
    if (!hits.length) {
      // Clicked on empty space - reset selection
      measurements.selectedAtoms.forEach(a => clearHighlightAtom(a));
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      return;
    }

    const rawHit = hits[0];
    const instanceId = rawHit.instanceId;
    const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
    if (!wrapped) return;
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[instanceId] : instanceId;
    const element = groups.atomsMesh.userData.elementNames?.[instanceId] || wrapped.elements?.[instanceId] || '?';
    const hit = {
      position: new THREE.Vector3(...wrapped.cart[instanceId]),
      userData: {
        atomIndex: srcIdx,
        element,
        instanceId,
        wrappedFrac: wrapped.frac?.[instanceId] ? [...wrapped.frac[instanceId]] : null,
      }
    };

    // Allow selecting the same source atom through a different periodic image,
    // but avoid double-picking the exact same rendered instance.
    if (measurements.selectedAtoms.some(a => a.userData.instanceId === instanceId)) return;

    // Add atom to selection and highlight it
    measurements.selectedAtoms.push(hit);
    highlightAtomIn3D(instanceId);

    // Handle actions based on mode
    if (mode.measureMode === 'distance' && measurements.selectedAtoms.length === 2) {
      // Distance measurement complete
      addDistanceMeasurement(measurements.selectedAtoms[0], measurements.selectedAtoms[1]);

      // Clear selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      resetControlsTouch();
    } else if (mode.measureMode === 'angle' && measurements.selectedAtoms.length === 3) {
      // Angle measurement complete
      addAngleMeasurement(measurements.selectedAtoms[0], measurements.selectedAtoms[1], measurements.selectedAtoms[2]);

      // Clear selection
      measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      measurements.selectedAtoms = [];
      clearMeasureGraphics();
      resetControlsTouch();
    } else if (mode.measureMode === 'delete') {
      const idx = hit.userData.sourceIndex;
      let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
      if (idx !== undefined && idx >= 0 && idx < positions.length) {
        // Remove atom from structure
        positions.splice(idx, 1);
        elements.splice(idx, 1);
        // Clean selections and graphics
        measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
        measurements.selectedAtoms = [];
        clearMeasureGraphics();
        // Rebuild controls and view
        createBondLengthControls();
        createSpinControls();
        updateVisualization();
      }
      return; // nothing else to do in delete mode
    }

    drawMeasureGraphics();
  }

  // Double-click handler for atom highlighting feature
  function onDoubleClickAtom(event) {
  // Don't open info panel while measuring — two measurement clicks look like a dblclick
  if (mode.measureMode !== 'none') return;
  event.preventDefault();
  event.stopPropagation();

  // Handle both mouse and touch events
  let clientX, clientY;
  if (event.changedTouches && event.changedTouches.length > 0) {
    clientX = event.changedTouches[0].clientX;
    clientY = event.changedTouches[0].clientY;
  } else {
    clientX = event.clientX;
    clientY = event.clientY;
  }

  const rect = app.renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  // Raycast for atoms
  raycaster.setFromCamera(mouse, app.camera);

  // Raycast against InstancedMesh objects
  const atomHits = raycaster.intersectObject(groups.atomsMesh);
  const bondHits = raycaster.intersectObject(groups.bondsMesh);

  let hit = null;

  // Handle atom hits
  if (atomHits.length > 0) {
    hit = atomHits[0];
    // You can now use hit.instanceId to identify the specific atom
  }

  // Handle atom hits
  if (bondHits.length > 0) {
    hit = bondHits[0];
    // You can now use hit.instanceId to identify the specific atom
  }    



  // Raycast for bonds
  //const bondHits = raycaster.intersectObjects(groups.bondsGroup.children, true);

  if (atomHits.length > 0) {
    hit = atomHits[0];
    const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
    const instanceId = hit.instanceId;
    const sourceIndex = wrapped?.srcIndex ? wrapped.srcIndex[instanceId] : instanceId;
    const elementName = wrapped?.elements?.[instanceId]
      || groups.atomsMesh.userData.elementNames?.[instanceId]
      || fileBrowser.selectedStructure?.elements?.[sourceIndex]
      || '?';

    highlightAtomInStructurePanel(elementName, sourceIndex);
    highlightAtomIn3D(instanceId);

  } else if (bondHits.length > 0) {
    let id2;
    if (hit.instanceId%2 == 0){
      id2 = hit.instanceId+1
    }
    else{
      id2 = hit.instanceId-1
    }
    //highlightBondInStructurePanel(bondIndex);
    highlightBondIn3D([hit.instanceId,id2]);
    //highlightBondInfoInStructurePanel()


  }
  else  {
     clearAllHighlights();
  }


}


  // Add double-click listener for atom highlighting feature
  app.renderer.domElement.addEventListener('dblclick', onDoubleClickAtom);




// --- Event setup for Three.js renderer element ---
const el = app.renderer.domElement;

// Prevent browser gestures (zoom, scroll, long-press menu)
el.style.touchAction = 'none';

// Long-press config
let longPressTimer = null;
let longPressFired = false;
let pointerDownPos = null;
let moved = false;
const LONG_PRESS_MS = 700;        // adjust to preference
const MOVE_THRESHOLD_PX = 10;

// Debounce to suppress synthetic click after touch
let lastTouchTime = 0;
const GHOST_CLICK_DELAY = 400;    // ms window to ignore duplicate clicks

// Desktop: keep double-click
el.addEventListener('dblclick', onDoubleClickAtom);

// Desktop: keep normal click
el.addEventListener('click', (e) => {
  const now = Date.now();
  if (now - lastTouchTime < GHOST_CLICK_DELAY) {
    // Ignore the synthetic click that follows a touch
    return;
  }
  onClickPick(e);
});

// Pointer events handle touch + pen + mouse consistently
el.addEventListener('pointerdown', onPointerDown);
el.addEventListener('pointermove', onPointerMove);
el.addEventListener('pointerup', onPointerUp);
el.addEventListener('pointercancel', onPointerCancel);

function onPointerDown(e) {
  // Track touch separately for long-press
  if (e.pointerType === 'touch') {
    clearLongPress(); // always clear any pending timer before starting a new one
    longPressFired = false;
    moved = false;
    pointerDownPos = { x: e.clientX, y: e.clientY };

    longPressTimer = setTimeout(() => {
      longPressFired = true;
      onDoubleClickAtom(e);   // use same logic as double-click
      lastTouchTime = Date.now(); // prevent follow-up ghost click
    }, LONG_PRESS_MS);
  }

  try { e.target.setPointerCapture(e.pointerId); } catch {}
}

function onPointerMove(e) {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
    moved = true;
    clearLongPress();
  }
}

function onPointerUp(e) {
  clearLongPress();
  try { e.target.releasePointerCapture(e.pointerId); } catch {}

  if (e.pointerType === 'touch') {
    // If the long-press already triggered, skip normal tap
    if (longPressFired) {
      longPressFired = false;
      pointerDownPos = null;
      return;
    }

    // Ignore small drags
    if (moved) {
      pointerDownPos = null;
      moved = false;
      return;
    }

    // Normal tap on touch → behave like click
    lastTouchTime = Date.now();
    e.preventDefault(); // prevent synthetic mouse click
    onClickPick(e);
  }

  pointerDownPos = null;
}

function onPointerCancel() {
  clearLongPress();
  pointerDownPos = null;
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

// After a touch-based measurement completes, TrackballControls may have stale
// pointer state that causes 1-finger drag to zoom instead of rotate.
// Dispatching pointercancel flushes its internal pointer list.
function resetControlsTouch() {
  try {
    const cancel = new PointerEvent('pointercancel', { bubbles: true, cancelable: false, pointerId: 1 });
    el.dispatchEvent(cancel);
  } catch {}
}



  document.getElementById('viewX').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 1., 0., 0.))};
  document.getElementById('viewY').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 1., 0.))};
  document.getElementById('viewZ').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 0., 1.))};


  document.getElementById('viewA').onclick = () => {app.controls.reset(); const {a} = latticeDirs(); setViewDirection(a); };
  document.getElementById('viewB').onclick = () => {app.controls.reset(); const {b} = latticeDirs(); setViewDirection(b); };
  document.getElementById('viewC').onclick = () => {app.controls.reset(); const {c} = latticeDirs(); setViewDirection(c); };
  document.getElementById('resetView').onclick = () => resetView();

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


  // Control handlers
  document.getElementById('showAtoms').onchange = (e) => {
    general.showAtoms = e.target.checked;
    if (groups.atomsMesh) groups.atomsMesh.visible = general.showAtoms;
  };

  // Control handlers
  document.getElementById('showBonds').onchange = (e) => {
    general.showBonds = e.target.checked;
    updateVisualization({
      reRenderAtoms: !!general.showPBCBonds,
      reRenderBonds: true,
      bondsUpdate: false
    });
  };

    // Control handlers
  document.getElementById('showPolyhedra').onchange = (e) => {
    general.showPolyhedra = e.target.checked;
    updatePolyhedra();
  };

  document.getElementById('showLattice').onchange = (e) => {
    general.showLattice = e.target.checked;
    updateVisualization();
  };


  const PBCBondToggle = document.getElementById('PBCBondToggle');
  if (PBCBondToggle) {
      PBCBondToggle.onchange = (e) => {
      general.showPBCBonds = e.target.checked;
      updateVisualization({reRenderAtoms:true, reRenderBonds:true});  
    };
  }

  const showPeriodicToggle = document.getElementById('showPeriodic');
  if (showPeriodicToggle) {
    showPeriodicToggle.onchange = (e) => {
      general.showPeriodic = e.target.checked;
      updateVisualization({reRenderAtoms:true, reRenderBonds:true});
    };
  }

  document.getElementById('atomSize').oninput = (e) => {
    general.atomSize = parseFloat(e.target.value);
    document.getElementById('atomSizeValue').textContent = general.atomSize.toFixed(1);
    fileBrowser.selectedStructure.elements.forEach((element, index) => {
      fileBrowser.selectedStructure.atomImages[index].forEach(imageIndex => {
        updateSingleAtomDiameter(imageIndex, element)
       });
    });
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    updateMeasurementMarkers(); // Update ring markers when atom size changes

  };


  // Bond width control
  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    bondWidthSlider.oninput = (e) => {
      const v = parseFloat(e.target.value);
      // clamp defensively
      general.bondRadius = Math.max(0.005, Math.min(1.0, isNaN(v) ? bondRadius : v));
      bondWidthValue.textContent = general.bondRadius.toFixed(2);
      for (let i = 0; i < groups.bondsMesh.count; i++) {
        updateSingleBondDiameter(i,  general.bondRadius)
        //updateSingleAtomColor(originalIndex=atomIndex, element=element, opacity = 1.0)
       }
      groups.bondsMesh.instanceColor.needsUpdate = true;

      //updateVisualization();
    };
  }
    let checkbox_polyhedra = document.getElementById("showPolyhedra");
      checkbox_polyhedra.checked = false; // explicitly untick

 //     let checkbox_showComparisonInfo = document.getElementById("showComparisonInfo");
 //     checkbox_showComparisonInfo.checked = false; // explicitly untick

  let checkbox_neighbours = document.getElementById("PBCBondToggle");
      checkbox_neighbours.checked = false; // explicitly untick

  let checkbox_periodic = document.getElementById("showPeriodic");
      checkbox_periodic.checked = true; // explicitly tick


  // Mobile measurement toggle functionality
  document.getElementById('measurementToggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const panel = document.getElementById('measurementPanel');
    panel.classList.toggle('expanded');
  });

  // Mobile camera toggle functionality
  document.getElementById('cameraToggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const panel = document.getElementById('cameraPanel');
    panel.classList.toggle('expanded');
  });

  // New measurement tool handlers with improved click handling
  document.getElementById('distanceModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('distanceModeBtn');
    const wasActive = mode.measureMode === 'distance';

    // Clear previous mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    measurements.selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      mode.measureMode = 'none';
    } else {
      mode.measureMode = 'distance';
      button.classList.add('active');
    }
  });

  document.getElementById('angleModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('angleModeBtn');
    const wasActive = mode.measureMode === 'angle';

    // Clear previous mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    measurements.selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      mode.measureMode = 'none';
    } else {
      mode.measureMode = 'angle';
      button.classList.add('active');
    }
  });

  // Delete atom mode
  document.getElementById('deleteModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('deleteModeBtn');
    const wasActive = mode.measureMode === 'delete';

    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measurements.selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    measurements.selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      mode.measureMode = 'none';
    } else {
      mode.measureMode = 'delete';
      button.classList.add('active');
    }
  });

  document.getElementById('clearAllMeasurements').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    clearAllMeasurements();
    // Also clear active measurement mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    mode.measureMode = 'none';


     // Ensure the fields exist and are the right typed arrays
      //
    structureData.positions = parsed.positions ?? null;
    structureData.elements  = parsed.elements  ?? null;
    structureData.lattice   = parsed.lattice   ?? null;
    structureData.supercell = parsed.supercell ?? null;
    if (general.modifiedLattice != null){
        structureData.lattice = general.modifiedLattice
      }
    if (general.currentSupercell != null){
          createSupercell(currentSupercell.nx,currentSupercell.ny,currentSupercell.nz)
          }
      createBackgroundControl();
      updateVisualization();
      clearMeasure();
    }
  );

  // Add touch event handlers for better mobile support
  document.getElementById('distanceModeBtn').addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('distanceModeBtn').click();
  });

  document.getElementById('angleModeBtn').addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('angleModeBtn').click();
  });

  document.getElementById('clearAllMeasurements').addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('clearAllMeasurements').click();
  });


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
  console.error("after load shared")
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
