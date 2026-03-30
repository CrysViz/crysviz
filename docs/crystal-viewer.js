import * as THREE from './external/three/three.module.js';
// .........................................................................................................
// store.js contains all state and default variables, e.g. three,js related, colors, default structure, etc.
//
//  This is currently necessary as classes are not yet fully adapter. structureData, originalStructureData,spinsData are global variables for now and should be replaced
//  with the proper classes. However, this already solved some problems with camera and controls getting redefined as a side effect of some functions of the viewing angle
//  control. The rest of the singletons should be preserved.
// .........................................................................................................
import { structureShip,highlightHover,app, groups, general,measurements,
         mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,
         getBondVisSettings,getLatticeVisSettings} from './store.js';

//this needs to life somewhere else! only for testing
const tableBody = document.querySelector("#objectTable tbody");


// import from the old file structure that need to be combined and ported to the new structure
import { setupSecondStructureInput } from './modules/SecondStructureModule.js';
import { parseOUTCAR} from './modules/ReadOutcarModule.js';
import { parsePWSCFout} from './modules/ReadPWSCFoutModule.js';
import { parsePWSCFin} from './modules/ReadPWSCFinModule.js';
import { setupStructureInput, parsePOSCAR} from './modules/StructureInputModule.js';

// ........................................................................................................
// Import Modules
//
// These modules should contain all the functions related to specific functionalities
//
// .........................................................................................................
import { updateAngleDisplays, setupAxisControls} from './modules/cameraAngleControl.js';
import { createColorPicker } from './modules/ColorPickerModule.js';
import { pauseRendering, resumeRendering,animation_update} from './modules/AnimateModule.js'; // animate function is not really an animation, but the function that runs the frames.
import { shareStructure,createShareButton,loadSharedStructure} from './modules/ShareModule.js';
import {loadFromFilePath} from './modules/FileURLLoader.js';
import {updateBonds,rebuildBonds,buildBondObjects,updateSingleBondDiameter} from './modules/BondsFracUpdateModule.js'
import {updateSecondBonds,rebuildSecondBonds,buildSecondBondObjects,updateSecondSingleBondDiameter} from './modules/CompBondsFracUpdateModule.js'
import { periodicWrapped, updateLattice,recomputeLatticeDirs,latticeDirsNorm,fracToCart,cartToFrac,latticeDirs} from './modules/LatticeModule.js'
import {updatePolyhedra} from './modules/PolyhedraModule.js'
import {rebuildAtoms,updateAtoms,updateSingleAtomDiameter} from './modules/AtomsFracUpdateModule.js';
import {rebuildSecondAtoms,updateSecondAtoms,updateSecondSingleAtomDiameter} from './modules/CompAtomsFracUpdateModule.js';


import {createSupercell} from './modules/SuperCellModule.js';
import {updateAllMeasurements, addAngleMeasurement, clearAllMeasurements,drawMeasureGraphics,
        addDistanceMeasurement, updateMeasurementMarkers,clearMeasureGraphics,clearMeasure} from './modules/MeasurementModule.js' // not all imports might be needed in this file

import {highlightBondInfoInStructurePanel,clearHighlightAtom,highlightBondIn3D,highlightAtomIn3D,clearAllHighlights,highlightAtomInStructurePanel } from './modules/SelectAndHighlightModule.js';

import {addAtomVacuumPanel} from './modules/addToStructureModule/AddVacuumModule.js'
import {addCameraPanel} from './panels/CameraPanel.js'
import {addColorPanel} from './panels/ColorPanel.js'

import { updateField, parseCHGCARFile, parseCubeFile } from './modules/Render3DFieldModule.js';
//import {addAtomPanel} from './modules/addToStructureModule/addAtomPanel.js'

// .........................................................................................................
// Import Panels
//
// Panel files should contain all the functions related to a specific panels
//
// // .........................................................................................................
import {initCamera, initRenderer, initLabelRenderer,initControls,resizeRenderer,
  initAxesGizmo, disposeGroup, switchCameraType, setViewDirection,resetView,collapseAllAtomExpansions
} from './panels/WindowAndSceneControls.js'
import {loadAboutContent, openAboutPanel, closeAboutPanel} from './panels/AboutPanel.js';
import {addSpinPanel,createSpinControls} from './panels/SpinPanel.js';
import {resetBondLengths, createBondLengthControls} from './panels/BondLengthPanel.js';
import {renderComposition} from './panels/StructureInfoPanel/General.js';
import {addTrajectoryPlayer} from './panels/TrajectoryPanel.js';
import {addControlPanelModeSwitch,addControlPanelSpinForceSwitch,addControlPanelAnalysisSwitch} from './panels/ControlPanel.js';
import {addHistogramPanel} from  './panels/AnalysisPanels/BondAnalysisPanel.js';
import {addBackendModeSwitch} from './panels/BackendPanel/BackendSwitchPanel.js';

import {addSavePanel} from './panels/SavePanel.js'
import {addAnalysisInfoPanel,addStorageInfoPanel,addBackendInfoPanel,addUploadInfoPanel} from './panels/InfoPanel.js'

// .........................................................................................................
// import utils needs to moce to the "share" functionality. This is currently broken.
// .........................................................................................................
import {
  captureCompleteState,
  createCompleteShareableURL,
  createLegacyShareableURL,
  restoreCompleteState,
  generatePOSCARString,
} from './utils/shareutils.js';

// file browser test
//
//
import {fileBrowser} from './store.js';
import {createRow} from './panels/FileBrowswerPanel.js'


// Class Structure
//
import {Structure} from './classes/Structure.js'

// New imports (which go here, because they need initializations that happen above until things are refactored)
import { parse_any, isLikelyCIFContent, isLikelymagCIFContent } from './modules/io.js';
import { initializeUIOnLoad } from './modules/StructureInputModule.js';
import { fieldBrowser } from './panels/FieldPanel.js';
import { resetMathBackend } from './modules/math/index.js';

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


function openBackgroundColorPicker(dot) {
  // Remove any existing picker first
  //
  let currentHex=null
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());
  if (app.scene.background) currentHex = "#" + app.scene.background.getHexString();
  let selectedHex = currentHex;


  function getLuminance(hex) {
  // Convert hex to RGB
  const c = hex.startsWith("#") ? hex.substring(1) : hex;
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;

  // Perceived luminance formula
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function getContrastingBorder(hex) {
  const lum = getLuminance(hex);
  return lum > 0.5 ? "#333333" : "#ffffff"; // dark border for light bg, white for dark bg
}

  // --- Create main picker container ---
  const pickerPanel = document.createElement("div");
  pickerPanel.className = "spin-color-picker";
  Object.assign(pickerPanel.style, {
    position: "absolute",
    background: "rgba(26,26,26,0.8)",
    border: "1px solid #ccc",
    padding: "10px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: 9999,
  });

  // --- Create the color picker using existing helper ---
  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    let contrastColor = `${getContrastingBorder(selectedHex)}`

    dot.style.border = `2px solid ${contrastColor}`
    general.currentLatticeColor = contrastColor
    updateLattice(contrastColor)
    app.scene.background = new THREE.Color(hex);   // live preview in scene
  });


  //dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;

  // --- Apply / Reset Buttons ---
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, {
    display: "flex",
    justifyContent: "space-between",
    marginTop: "10px",
    gap: "8px"
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn';
  resetBtn.style.cssText = 'height: 32px';
  resetBtn.style.background = general.defaultBackgroundColor;

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px';


  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  // --- Position near the dot ---
  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY + 60;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);
  if (bottomSpace < 40) topPosition = window.innerHeight - pickerPanel.offsetHeight - 65;

  pickerPanel.style.left = `${rect.left + window.scrollX - 200}px`;
  pickerPanel.style.top = `${topPosition}px`;

  // --- Close picker helper ---
  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
  };

  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };

  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Apply button behavior ---
  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;
    app.scene.background = new THREE.Color(selectedHex); // lock in color
    closePicker();
  });

  // --- Reset button behavior ---
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePicker();
    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
   if (isDarkMode )
    {
    app.scene.background = new THREE.Color(0x090A09)
    general.currentLatticeColor = 0xE7E7E7;
    dot.style.border = `2px solid #E7E7E7`
    updateLattice()
   }
   else if (!isDarkMode )
   {
    app.scene.background = new THREE.Color(0xE7E7E7)
    general.currentLatticeColor = 0x090A09;
    dot.style.border = `2px solid #090A09`
    updateLattice()
   }

  });
}


function createBackgroundControl() {
  const dot = document.getElementById("backgroundDot");
  if (!dot) {
    console.error("No element found with ID 'backgroundDot'");
    return;
  }

  let currentBackground = app.scene.background

  // Make it visible and clickable
  dot.style.position = "fixed";
  dot.style.zIndex = "999";
  dot.style.pointerEvents = "auto";
  dot.style.borderRadius = "50%";
  dot.style.cursor = "pointer";

  // Attach click listener directly
  dot.addEventListener("click", () => {
    console.warn("background dot clicked")
    openBackgroundColorPicker(dot); // uncomment when scene is ready
  });
}

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
    console.warn("Calling rebuildBonds")
    rebuildBonds(mOpacity)
  }

  if (!reRenderBonds && bondsUpdate) {
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
  if (reRenderField && fileBrowser.selectedStructure.volumetricFields && fieldBrowser.selectedField) {
    updateField();
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

    if (treatAsCube) {
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

        if (fileBrowser.selectedStructure.spin != null) {
         addSpinPanel();
         createSpinControls();
        }

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
    updateVisualization({reRenderAtoms:true,reRenderBonds:true,updateOther:true});
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
  loadStructure(defaultPOSCAR, 'defaultYBCO.vasp', true);
      // Create a new Structure instance

}

function init() {
  return initApp();
}

async function initApp() {
  await initializeMathBackend();
  document.body.classList.add(`theme-standard`);
  app.scene = new THREE.Scene();

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (isDarkMode) {
    app.scene.background = new THREE.Color(0x090A09)
    general.defaultBackgroundColor = 0x090A09
    general.currentLatticeColor = 0xE7E7E7
   } else {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x090A09
   };

  //
  //


  //get all things related to the main view window from WindowAndSceneControls.js
  initCamera(app.useOrthographicCamera);

  initRenderer();

  initLabelRenderer();

  initControls();

  resizeRenderer(app.orthographicFrustumSize);


  // not even sure what this does??

  const atomTooltip = document.createElement('div');
  atomTooltip.className = 'atom-tooltip';
  atomTooltip.setAttribute('aria-hidden', 'true');
  view.appendChild(atomTooltip);

  // init Angle display windows

  ['x', 'y', 'z'].forEach(axis => setupAxisControls(axis));

  updateAngleDisplays();


  initAxesGizmo();

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  app.scene.add(ambientLight);

  // Single main directional light - positioned relative to camera
  app.keyLight = new THREE.DirectionalLight(0xffffff, 5.0);
  app.keyLight.castShadow = false;
  app.scene.add(app.keyLight);

  // Click Atom

  let raycaster = new THREE.Raycaster();
  let mouse = new THREE.Vector2();

  function hideAtomTooltip() {
    if (!atomTooltip) return;
    atomTooltip.classList.remove('visible');
    atomTooltip.setAttribute('aria-hidden', 'true');
    highlightHover.hoveredAtom = null;
  }

  function updateAtomTooltip(event) {
    if (!groups.atomsGroup || !groups.atomsGroup.children.length || !atomTooltip) {
      hideAtomTooltip();
      return;
    }

    const rect = app.renderer.domElement.getBoundingClientRect();
    const clientX = event.clientX;
    const clientY = event.clientY;
    if (clientX == null || clientY == null) {
      hideAtomTooltip();
      return;
    }

    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    mouse.set(x, y);
    raycaster.setFromCamera(mouse, app.camera);

    const hits = raycaster.intersectObjects(groups.atomsGroup.children, true);
    if (!hits.length) {
      hideAtomTooltip();
      return;
    }
    const hit = hits[0].object;
    const element = hit?.userData?.element || hit?.parent?.userData?.element || null;
    const sourceIndex = hit?.userData?.sourceIndex ?? hit?.parent?.userData?.sourceIndex ?? null;

    if (!element) {
      hideAtomTooltip();
      return;
    }

    // Build list of all atom indices for this element
    const elementAtomIndices = [];
    let elements = [...fileBrowser.selectedStructure.elements];
    for (let i = 0; i < elements.length; i++) {
      if (elements[i] === element) {
        elementAtomIndices.push(i);
      }
    }

    if (highlightHover.hoveredAtom !== hit) {
      highlightHover.hoveredAtom = hit;

      if (sourceIndex == null) {
        atomTooltip.textContent = `${element}`;
      } else {
        // compute atom number within this element type
        const elementLocalIndex = elementAtomIndices.indexOf(sourceIndex) + 1; // +1 for 1-based display
        const displayIndex = elementLocalIndex || sourceIndex; // fallback if not found
        atomTooltip.textContent = `${element} ${displayIndex}`;
      }
    }


    atomTooltip.style.left = `${clientX - rect.left}px`;
    atomTooltip.style.top = `${clientY - rect.top}px`;
    atomTooltip.classList.add('visible');
    atomTooltip.setAttribute('aria-hidden', 'false');
  }

  app.renderer.domElement.addEventListener('mousemove', updateAtomTooltip);
  app.renderer.domElement.addEventListener('mouseleave', hideAtomTooltip);
  app.renderer.domElement.addEventListener('touchstart', hideAtomTooltip, { passive: true });

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
    if (groups.bondsMesh) {
      groups.bondsMesh.visible = general.showBonds;
  //  updateVisualization()
    }
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
    const { initMathWasmBackend, installMathWasmBackend } = await import('./modules/math/backend-wasm.js');
    const backend = await initMathWasmBackend(new URL('./compiled/math_backend.wasm', import.meta.url));
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
function setupMobileMenu() {
  const hamburger = document.getElementById('mobileMenuToggle');
  const overlay = document.getElementById('mobileOverlay');
  const ui = document.getElementById('ui');

  function togglePanel() {
    if (!ui) return;

    if (window.innerWidth > 1024) {
      // Desktop: toggle panel-hidden
      ui.classList.toggle('panel-hidden');
      document.body.classList.toggle('panel-hidden');
    } else {
      // Mobile: toggle panel-open
      ui.classList.toggle('panel-open');
      if (overlay) overlay.classList.toggle('active');
    }

    // Refresh renderer immediately after layout change
    if (typeof resizeRenderer === 'function') {
      resizeRenderer(app.orthographicFrustumSize);
    }
  }

  function closePanel() {
    if (!ui) return;
    ui.classList.remove('panel-open', 'panel-hidden');
    document.body.classList.remove('panel-hidden');
    if (overlay) overlay.classList.remove('active');
  }

  if (hamburger) {
    hamburger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    hamburger.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
  }

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      closePanel();
    });

    overlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      closePanel();
    });
  }

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
  })
  .catch((error) => {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  });
