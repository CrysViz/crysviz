import * as THREE from 'three';
import { ConvexGeometry } from 'https://unpkg.com/three@0.160.0/examples/jsm/geometries/ConvexGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';
//import { RoomEnvironment } from 'https://unpkg.com/three@0.160.0/examples/jsm/environments/RoomEnvironment.js';
import { setupStructureInput, isLikelyCIFContent, parsePOSCAR, cartToFractional } from './old_style/structure-input.js';
import { setupSecondStructureInput } from './old_style/compare-structure-input.js';
import { createLatticeComparisonPanel }from './old_style/lattice_comparison.js'
import { parseCIF} from './old_style/file_reader.js';
import { parseOUTCAR} from './old_style/file_reader_OUTCAR.js';
import { createColorPicker } from './old_style/color-picker.js';
import {updateAngleDisplays, setupAxisControls} from './old_style/cameraAngleControl.js';


// import modules


import {animation_update} from './modules/AnimateModule.js'; // animate function is not really an animation, but the function that runs the frames. 
import {shareStructure,createShareButton,loadSharedStructure} from './modules/ShareModule.js'



// import panels
import {
  initCamera,
  initRenderer,
  initLabelRenderer,
  initControls,
  resizeRenderer,
  initAxesGizmo,
  disposeGroup
} from './panels/WindowAndSceneControls.js'

import {loadAboutContent, openAboutPanel, closeAboutPanel} from './panels/AboutPanel.js';





// import utils needs to moce to the "share" functionality
import {
  captureCompleteState,
  createCompleteShareableURL,
  createLegacyShareableURL,
  restoreCompleteState,
  generatePOSCARString,
} from './utils/shareutils.js'; 

const view = document.getElementById('view');
const status = document.getElementById('status');
const setStatus = (s) => {
  if (status) status.textContent = s;
  console.log('[viewer]', s);
};

// store.js contains all state and default variables, e.g. three,js related, colors, default structure, etc. 
import { app, general,mode,defaultPOSCAR, polyStyle, defaultColors, jmolColors, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from './store.js';


let atomsGroup, bondsGroup, latticeGroup,spinGroup, polyhedraGroup;
let atomsGroup2, bondsGroup2, latticeGroup2,spinGroup2;

let structureData = null;
let structureData2 = null;

let spinsData = null;
let originalStructureData = null; // deep-copy of last loaded structure for restore

let atomTooltip = null;
let hoveredAtom = null;

    // Measurement state
let selectedAtoms = []; // Array to store selected atoms (up to 3 for angles)
let measureLine = null;          // THREE.Line
let measureLabel = null;         // CSS2DObject
let measureLines = [];           // Array to store multiple measurement lines
let measureLabels = [];          // Array to store multiple measurement labels




function getElementColor(element) {
  // Prefer user override if present
  if (general.userColorOverrides && general.userColorOverrides[element] !== undefined) {
    return general.userColorOverrides[element];
  }
  const colorScheme = general.useDefaultColors ? defaultColors : jmolColors;
  return colorScheme[element] || 0x808080;
}

function getIndividualAtomColor(element, atomIndex) {
  // Check if individual atom has custom color
  const atomKey = `${element}_${atomIndex}`;
  if (general.individualAtomColors && general.individualAtomColors[atomKey] !== undefined) {
    return general.individualAtomColors[atomKey];
  }
  // Fall back to element-wide color
  return getElementColor(element);
}

// Get the default palette color for an element (ignores user overrides)
function getDefaultElementColor(element) {
  const colorScheme = general.useDefaultColors ? defaultColors : jmolColors;
  return colorScheme[element] || 0x808080;
}


// This is why the colors are persistent. It is stored in the browser itself. The only thing we store is the customg color state! 

function saveColorOverrides() {
  try { localStorage.setItem('atomColorOverrides', JSON.stringify(general.userColorOverrides || {})); } catch (_) {}
}
function loadColorOverrides() {
  try {
    const raw = localStorage.getItem('atomColorOverrides');
    if (raw) general.userColorOverrides = JSON.parse(raw) || {};
  } catch (_) { general.userColorOverrides = {}; }
}

function saveIndividualAtomColors() {
  try { localStorage.setItem('individualAtomColors', JSON.stringify(general.individualAtomColors || {})); } catch (_) {}
}
function loadIndividualAtomColors() {
  try {
    const raw = localStorage.getItem('individualAtomColors');
    if (raw) general.individualAtomColors = JSON.parse(raw) || {};
  } catch (_) { general.individualAtomColors = {}; }
}

function setElementColorOverride(el, cssHex) {
  if (!cssHex) return false;
  let hex = cssHex.toString().trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  general.userColorOverrides[el] = parseInt(hex, 16);
  saveColorOverrides();
  return true;
}
function clearElementColorOverride(el) {
  delete general.userColorOverrides[el];
  saveColorOverrides();
}

function setIndividualAtomColor(element, atomIndex, cssHex) {
  if (!cssHex) return false;
  let hex = cssHex.toString().trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const atomKey = `${element}_${atomIndex}`;
  general.individualAtomColors[atomKey] = parseInt(hex, 16);
  saveIndividualAtomColors();
  return true;
}

function clearIndividualAtomColor(element, atomIndex) {
  const atomKey = `${element}_${atomIndex}`;
  delete general.individualAtomColors[atomKey];
  saveIndividualAtomColors();
}

function hasIndividualColors(element) {
  if (!general.individualAtomColors) return false;
  return Object.keys(general.individualAtomColors).some(key => key.startsWith(`${element}_`));
}

function getAllIndividualAtomColors(element) {
  if (!general.individualAtomColors) return [];

  // Collect all individual color overrides for the element
  const currentPalette = Object.entries(general.individualAtomColors)
    .filter(([key]) => key.startsWith(`${element}_`))
    .map(([, color]) => colorHexToCss(color));

  // Count how many atoms of this element are in the structure
  let elementCount = 0;
  for (let i = 0; i < structureData.elements.length; i++) {
    if (structureData.elements[i] === element) {
      elementCount++;
    }
  }

  // If not all atoms are overridden, add the default color too
  if (currentPalette.length < elementCount) {
    const defaultColor = colorHexToCss(getElementColor(element));
    currentPalette.push(defaultColor);
  }

  return currentPalette;
}


function getElementDisplayColor(element) {
  if (hasIndividualColors(element)) {
    const colors = getAllIndividualAtomColors(element);
    // Defensive: ensure it's an array of strings
    if (Array.isArray(colors) && colors.every(c => typeof c === 'string')) {
      return colors;
    }
    // If not, fallback:
    return [colorHexToCss(getElementColor(element))];
  } else {
    return [colorHexToCss(getElementColor(element))];
  }
}


function createPieDot(colors, size = 200) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const center = size / 2;
  const radius = center;
  const slice = (2 * Math.PI) / colors.length;

  colors.forEach((color, i) => {
    const start = i * slice;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.arc(center, center, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  });
  canvas.style.borderRadius = '50%';
  canvas.style.border = '1px solid #666';
  canvas.style.display = 'inline-block';

  return canvas;
}


function clearAllIndividualColorsForElement(element) {
  if (!general.individualAtomColors) return;
  // Remove all individual colors for this element
  const keysToRemove = Object.keys(individualAtomColors).filter(key => key.startsWith(`${element}_`));
  keysToRemove.forEach(key => delete general.individualAtomColors[key]);
  saveIndividualAtomColors();
}


function createSupercell(nx = 1, ny = 1, nz = 1) {
 
  if (!originalStructureData) return;

  const basePositions = originalStructureData.positions;
  const baseElements = originalStructureData.elements;

  let baseLattice;

  if (genera.modifiedLattice == null) {
    // No modified lattice → use original
    baseLattice = originalStructureData.lattice;
  } else {
    if (general.currentSupercell == null) {
      // No supercell info → use as-is
      baseLattice = general.modifiedLattice;
    } else {
      // Scale each lattice vector by its corresponding supercell multiplier
      const { nx, ny, nz } = general.currentSupercell;
      const scales = [nx, ny, nz];
      baseLattice = general.modifiedLattice.map((v, i) => v.map(x => x / scales[i]));
    }
  }

  const newPositions = [];
  const newElements = [];

  // Simple tiling
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        for (let p = 0; p < basePositions.length; p++) {
          const pos = basePositions[p];
          newPositions.push([
            (pos[0] + i) / nx,
            (pos[1] + j) / ny,
            (pos[2] + k) / nz
          ]);
          newElements.push(baseElements[p]);
        }
      }
    }
  }

  // Scale lattice vectors
  const newLattice = [
    baseLattice[0].map(x => x * nx),
    baseLattice[1].map(x => x * ny),
    baseLattice[2].map(x => x * nz)
  ];

  // Update structureData
  structureData.positions = newPositions;
  structureData.elements = newElements;
  structureData.lattice = newLattice;
  structureData.supercell = { nx, ny, nz };
  general.currentSupercell={ nx, ny, nz }

  // Re-render
  //
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true
  });
}





function getAtomRadius(element) {
  return (atomicRadii[element] || 1.0) * general.atomSize;
}



// Helper functions for creating measurement markers
function createAtomRings(position, radius, innerColor, outerColor, element = null) {
  const ringGroup = new THREE.Group();

  // Outer ring - scales with atom
  const outerRingGeometry = new THREE.RingGeometry(radius * 1.1, radius * 1.3, 32);
  const outerRingMaterial = new THREE.MeshBasicMaterial({
    color: outerColor,
    transparent: false,
    opacity: 1.0,
    side: THREE.DoubleSide
  });
  const outerRing = new THREE.Mesh(outerRingGeometry, outerRingMaterial);
  outerRing.lookAt(app.camera.position);
  ringGroup.add(outerRing);

  // Inner ring - scales with atom
  const innerRingGeometry = new THREE.RingGeometry(radius * 0.9, radius * 1.05, 32);
  const innerRingMaterial = new THREE.MeshBasicMaterial({
    color: innerColor,
    transparent: false,
    opacity: 1.0,
    side: THREE.DoubleSide
  });
  const innerRing = new THREE.Mesh(innerRingGeometry, innerRingMaterial);
  innerRing.lookAt(app.camera.position);
  ringGroup.add(innerRing);

  ringGroup.position.copy(position);

  // Store metadata for scaling when atom size changes
  ringGroup.userData = {
    isAtomMarker: true,
    markerType: 'rings',
    element: element
  };

  return ringGroup;
}

function updateMeasurementMarkers() {
  // Update all measurement rings to reflect current atom size
  measureLines.forEach(item => {
    if (item.userData && item.userData.isAtomMarker && item.userData.markerType === 'rings') {
      const element = item.userData.element;
      if (element) {
        const newRadius = getAtomRadius(element);

        // Update ring geometries
        item.children.forEach((ring, index) => {
          if (ring.geometry && ring.geometry.type === 'RingGeometry') {
            ring.geometry.dispose(); // Clean up old geometry

            if (index === 0) {
              // Outer ring
              ring.geometry = new THREE.RingGeometry(newRadius * 1.1, newRadius * 1.3, 32);
            } else {
              // Inner ring
              ring.geometry = new THREE.RingGeometry(newRadius * 0.9, newRadius * 1.05, 32);
            }
          }
        });
      }
    }
  });
}

// Cached normalized lattice directions for performance; recompute on structure change
let cachedLatticeDirs = {
  a: new THREE.Vector3(1,0,0),
  b: new THREE.Vector3(0,1,0),
  c: new THREE.Vector3(0,0,1)
};
function recomputeLatticeDirs() {
  if (!structureData || !structureData.lattice) {
    cachedLatticeDirs = {
      a: new THREE.Vector3(1,0,0),
      b: new THREE.Vector3(0,1,0),
      c: new THREE.Vector3(0,0,1)
    };
    return;
  }
  const L = structureData.lattice;
  cachedLatticeDirs = {
    a: new THREE.Vector3(L[0][0], L[0][1], L[0][2]).normalize(),
    b: new THREE.Vector3(L[1][0], L[1][1], L[1][2]).normalize(),
    c: new THREE.Vector3(L[2][0], L[2][1], L[2][2]).normalize()
  };
}
function latticeDirsNorm() { return cachedLatticeDirs; }


function periodicWrapped(frac, elements) {
  // Build a fully "filled" unit cell by duplicating atoms that sit on
  // faces/edges/corners so that both sides of each face are populated.
  // We do this by adding, per-dimension, one extra image just inside the
  // opposite face when an atom is within eps of a boundary. 
  const eps = 1e-6;
  const newElements = [];
  const newFcrds = [];
  const srcIndex = [];

  for (let i = 0; i < frac.length; i++) {
    const f = frac[i];
    const atm = elements[i];

    // Decide offsets for each axis
    const offX = [0];
    const offY = [0];
    const offZ = [0];

    if (f[0] < eps) offX.push(1 - eps);
    if (f[0] > 1 - eps) offX.push(-1 + eps);
    if (f[1] < eps) offY.push(1 - eps);
    if (f[1] > 1 - eps) offY.push(-1 + eps);
    if (f[2] < eps) offZ.push(1 - eps);
    if (f[2] > 1 - eps) offZ.push(-1 + eps);

    for (const dx of offX) {
      for (const dy of offY) {
        for (const dz of offZ) {
          const nx = f[0] + dx;
          const ny = f[1] + dy;
          const nz = f[2] + dz;
          // keep strictly inside [0, 1)
          if (nx >= -eps && nx < 1 - eps + eps &&
              ny >= -eps && ny < 1 - eps + eps &&
              nz >= -eps && nz < 1 - eps + eps) {
            // clamp into range [0, 1-eps]
            const cx = Math.min(Math.max(nx, 0), 1 - eps);
            const cy = Math.min(Math.max(ny, 0), 1 - eps);
            const cz = Math.min(Math.max(nz, 0), 1 - eps);
            newElements.push(atm);
            newFcrds.push([cx, cy, cz]);
            srcIndex.push(i);
          }
        }
      }
    }
  }

  return { elements: newElements, frac: newFcrds, srcIndex };
}


export function getCellCenterAndDist() {
  const L = structureData?.lattice || [[10,0,0],[0,10,0],[0,0,10]];
  const corner = new THREE.Vector3(
    L[0][0]+L[1][0]+L[2][0],
    L[0][1]+L[1][1]+L[2][1],
    L[0][2]+L[1][2]+L[2][2]
  );
  const center = corner.clone().multiplyScalar(0.5);
  const distBase = Math.max(corner.length()*2.5, 20);
  const dist = distBase * app.defaultZoomScale;
  return { center, dist };
}

// makes the center of structure as the rotation center.
export function setViewDirection(dir) {
  //console.log('[setView] rendered camera UUID:', camera.uuid, 'controls.object UUID:', controls.object?.uuid);
  const { center, dist } = getCellCenterAndDist();
  const n = (dir.isVector3 ? dir : new THREE.Vector3(...dir)).clone().normalize();
  if (n.x === 0 && n.y === 1 && n.z === 0){
    //console.log("changing camer.up to 0.,0.,1.")
    app.camera.up = new THREE.Vector3(0.,0.,1.);}
  else {
    app.camera.up = new THREE.Vector3(0.,1.,0.);
    //console.log("changing camer.up to 0.,1.,0.")
  }

  app.camera.position.copy(center.clone().add(n.multiplyScalar(dist)));
  app.controls.target = center;
  app.controls.update();
}


function resetView() { app.controls.reset(); setViewDirection(new THREE.Vector3(1,1,1)); } //CAMERA RESET

function switchCameraType() {
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;

  if (app.useOrthographicCamera) {
    // Switch to orthographic camera
    const { center, dist } = getCellCenterAndDist();
    app.orthographicFrustumSize = dist * 0.5; // Adjust this multiplier as needed
    const aspect = w / h;
    app.camera = new THREE.OrthographicCamera(
      -app.orthographicFrustumSize,
      app.orthographicFrustumSize,
      app.orthographicFrustumSize / aspect,
      -app.orthographicFrustumSize / aspect,
      0.1,
      1000
    );
  } else {
    // Switch to perspective camera
    app.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    app.orthographicFrustumSize = null;
  }
  app.controls.object = app.camera;
  ['x', 'y', 'z'].forEach(axis => setupAxisControls(axis));

  const { center, dist } = getCellCenterAndDist();
  app.camera.position.copy(center.clone().add(new THREE.Vector3(1,1,1).normalize().multiplyScalar(dist)));
  app.controls.target.copy(center);
  app.controls.update();
  resizeRenderer(app.orthographicFrustumSize);
}

function resetBondLengths() {
  for (const pair in general.defaultBondLengths) {
    general.bondLengths[pair] = general.defaultBondLengths[pair];
  }
  createBondLengthControls();
  updateVisualization();
}

function latticeDirs() {
  if (!structureData) return {a:[1,0,0], b:[0,1,0], c:[0,0,1]};
  const L = structureData.lattice;
  return {
    a: [L[0][0], L[0][1], L[0][2]],
    b: [L[1][0], L[1][1], L[1][2]],
    c: [L[2][0], L[2][1], L[2][2]],
  };
}



function fracToCart(frac, lattice) {
  return frac.map(fc => [
    fc[0] * lattice[0][0] + fc[1] * lattice[1][0] + fc[2] * lattice[2][0],
    fc[0] * lattice[0][1] + fc[1] * lattice[1][1] + fc[2] * lattice[2][1],
    fc[0] * lattice[0][2] + fc[1] * lattice[1][2] + fc[2] * lattice[2][2]
  ]);
}

function cartToFrac(cart, lattice) {
  return cartToFractional(cart, lattice);
}


function isOutsideUnitCell(cart, lattice, eps = 1e-6) {
  const f = cartToFrac(cart, lattice);
  return (f[0] < -eps || f[0] >= 1 + eps ||
          f[1] < -eps || f[1] >= 1 + eps ||
          f[2] < -eps || f[2] >= 1 + eps);
}

function createBondLengthControls() {
  const bondControls = document.getElementById('bondControls');
  bondControls.innerHTML = '';

  if (!structureData) return;

  const uniqueElements = [...new Set(structureData.elements)];
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] + '-' + uniqueElements[j];
      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = defaultValue;
        general.defaultBondLengths[pair] = defaultValue; // Store default
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }

  pairs.forEach(pair => {
    const div = document.createElement('div');
    div.className = 'bond-control';

    // Add checkbox for bond visibility
    const checkboxDiv = document.createElement('div');
    checkboxDiv.className = 'bond-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = general.bondVisibility[pair];
    checkbox.onchange = (e) => {
      general.bondVisibility[pair] = e.target.checked;
      updateVisualization();
    };

    const checkboxLabel = document.createElement('label');
    checkboxLabel.textContent = `Show ${pair} bonds`;
    checkboxLabel.style.fontSize = '12px';
    checkboxLabel.style.color = '#ccc';
    checkboxLabel.style.margin = '0';

    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(checkboxLabel);

    const label = document.createElement('div');
    label.className = 'bond-label';
    label.textContent = `${pair}: `;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'slider-value';
    valueSpan.textContent = `${general.bondLengths[pair].toFixed(2)} Å`;
    label.appendChild(valueSpan);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.gap = '8px';
    controlsRow.style.alignItems = 'center';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.0';
    slider.max = '6.0';
    slider.step = '0.1' ;
    slider.value = general.bondLengths[pair];
    slider.style.flex = '1';

    const textInput = document.createElement('input');
    textInput.type = 'number';
    textInput.min = '0.0';
    textInput.max = '6.0';
    textInput.step = '0.01';
    textInput.value = general.bondLengths[pair];
    textInput.style.width = '70px';
    textInput.style.padding = '4px';
    textInput.style.background = 'rgba(255,255,255,0.1)';
    textInput.style.border = '1px solid rgba(255,255,255,0.2)';
    textInput.style.borderRadius = '4px';
    textInput.style.color = '#fff';

    function updateValue(newValue) {
      const val = parseFloat(newValue);
      general.bondLengths[pair] = val;

      // Update display text with special message for disabled bonds
      if (val <= 0.01) {
        valueSpan.textContent = 'Disabled';
        valueSpan.style.color = '#ff6666';
      } else {
        valueSpan.textContent = `${val.toFixed(3)} Å`;
        valueSpan.style.color = 'rgba(6, 140, 50, 1)';
      }

      slider.value = val;
      textInput.value = val;
      updateVisualization();
    }

    slider.oninput = (e) => updateValue(e.target.value);
    textInput.onchange = (e) => {
      const val = Math.max(0.0, Math.min(10.0, parseFloat(e.target.value) || 0.0));
      updateValue(val);
    };

    controlsRow.appendChild(slider);
    controlsRow.appendChild(textInput);

    div.appendChild(checkboxDiv);
    div.appendChild(label);
    div.appendChild(controlsRow);
    bondControls.appendChild(div);
  });
}


function deleteSpins(){
    console.log("deletingSpins")
     if (!spinsData){
       console.warn("no spins data to delete")
       return};
     spinsData = null;
     updateSpins(spinsData, 0.0);
     const textarea = document.getElementById("textArea");
      if (textarea) {
        textarea.value = "";
      } else {
        console.warn('No element with id="textArea" found');
      }

     //populateSpinViewer()
  }




function createSpinControls(containerId = "spinControls") {
  const container = document.getElementById(containerId);
  container.innerHTML = ""; // Clear previous controls

  // ----- 1 Input Mode Toggle -----
  const toggleWrapper = document.createElement("tablist");
  toggleWrapper.className = "spin-input-mode-toggle";
  toggleWrapper.style.marginBottom = "6px";

  const textModeBtn = document.createElement("button");
  textModeBtn.textContent = "Text Input";
  textModeBtn.className = "spin-input-mode-btn active";
  textModeBtn.disabled = true;

  const viewerModeBtn = document.createElement("button");
  viewerModeBtn.textContent = "Spin Viewer";
  viewerModeBtn.className = "spin-input-mode-btn";

  toggleWrapper.appendChild(textModeBtn);
  toggleWrapper.appendChild(viewerModeBtn);
  container.appendChild(toggleWrapper);

  // ----- 2 Slider for scaling arrows -----
  const sliderWrapper = document.createElement("div");
  sliderWrapper.style.marginBottom = "8px";

  const sliderLabel = document.createElement("label");
  sliderLabel.textContent = "Spin Length Factor: ";
  sliderWrapper.appendChild(sliderLabel);

  const sliderValue = document.createElement("span");
  sliderValue.textContent = "1.0";
  sliderValue.style.marginRight = "8px";
  sliderWrapper.appendChild(sliderValue);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = 0.1;
  slider.max = 10;
  slider.step = 0.1;
  slider.value = 1;
  sliderWrapper.appendChild(slider);
  container.appendChild(sliderWrapper);

  // ----- 3 Text Input Panel -----
  const textPanel = document.createElement("div");
  const textarea = document.createElement("textarea");
  textarea.id="textArea";
  textarea.placeholder = "x y z scale color\nExample:\n0 0 1 0.5 #ff0000\n1 1 0 2.0 #0000ff";
  textarea.style.width = "95%";
  textarea.style.height = "200px";
  textarea.style.background= "rgba(16,16,16,0.8)";
  textarea.style.color= "rgb(255, 255, 255)";
  textPanel.appendChild(textarea);


  const drawBtn = document.createElement("button");
  drawBtn.textContent = "Draw Spins";
  drawBtn.style.marginTop = "6px";
  textPanel.appendChild(drawBtn);
  container.appendChild(textPanel);

  // ----- 4 Viewer Panel -----
  const viewerPanel = document.createElement("div");
  viewerPanel.style.display = "none";
  container.appendChild(viewerPanel);

  // ----- 5 Mode Switch -----
  textModeBtn.addEventListener("click", () => {
    textModeBtn.className = "spin-input-mode-btn active";
    viewerModeBtn.className = "spin-input-mode-btn";
    textPanel.style.display = "block";
    viewerPanel.style.display = "none";
    textModeBtn.disabled = true;
    viewerModeBtn.disabled = false;
  });

  viewerModeBtn.addEventListener("click", () => {
    textModeBtn.className = "spin-input-mode-btn";
    viewerModeBtn.className = "spin-input-mode-btn active";
    textPanel.style.display = "none";
    viewerPanel.style.display = "block";
    textModeBtn.disabled = false;
    viewerModeBtn.disabled = true;
    populateSpinViewer();
  });


  // ----- 6 Slider live updates -----
  slider.addEventListener("input", () => {
    let val = parseFloat(slider.value);

    // sticky zone near 1
    if (Math.abs(val - 1) < 0.05) val = 1;

    slider.value = val;
    sliderValue.textContent = val.toFixed(2);

    if (spinsData.length) {
      updateSpins(spinsData, val);
    }
  });

  // ----- 7 Parse input & draw -----
  drawBtn.addEventListener("click", drawSpinsFromInput);
  drawBtn.className="btn-mini highlight"

  function drawSpinsFromInput() {
    const input = textarea.value.trim().split("\n").filter(Boolean);
    const spins = [];
    let scalingFactor = null;
    let color = null;

    input.forEach((line, i) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return; // ignore invalid lines

      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      const z = parseFloat(parts[2]);

      if (/^-?\d+(\.\d+)?$/.test(parts[3])) {
        scalingFactor = parseFloat(parts[3]);
        color = parts[4] || "#000000";
       }
      else {
        scalingFactor = 1.0;
        color = parts[3] || "#000000";
      }

      spins.push({
        atomIndex: i,
        vector: [x, y, z],
        scalingFactor,
        color
      });
    });
    
    let deleteBtn = document.getElementById("deleteSpins")
    console.log("Delete Spin Button Initialised")
    deleteBtn.addEventListener("click",(e) => {
               console.log("Delete Spin Clicked")
               e.stopPropagation();
               deleteSpins();
        });


    spinsData = spins;
    updateSpins(spinsData, parseFloat(slider.value));
  }

function populateSpinViewer() {
  // Inject CSS to hide native spin buttons (only once)
  if (!document.getElementById("hide-native-spin-buttons-style")) {
    const style = document.createElement("style");
    style.id = "hide-native-spin-buttons-style";
    style.textContent = `
      /* Hide native spin buttons in WebKit browsers */
      input[type="number"]::-webkit-inner-spin-button,
      input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* Hide native spin buttons in Firefox */
      input[type="number"] {
        -moz-appearance: textfield;
      }
    `;
    document.head.appendChild(style);
  }

  viewerPanel.innerHTML = "";
  if (spinsData===null) {
    viewerPanel.textContent = "No spins defined yet.";
    return;
  }

  // Helper: create custom number input with vertically stacked buttons
  function createCustomNumberInput(value, step, onChange) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "4px";

    const input = document.createElement("input");
    input.type = "number";
    input.value = value.toFixed(2);
    input.step = step;
    input.style.width = "40px";
    input.style.backgroundColor = "#333";
    input.style.color = "white";
    input.style.border = "1px solid #ccc";
    input.style.fontFamily = "monospace";
    input.style.padding = "2px 6px";
    input.style.textAlign = "right";
    input.style.fontSize = "12px";
    input.style.outline = "none";

    input.addEventListener("keydown", e => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
    });

    // Container for vertical buttons
    const btnContainer = document.createElement("div");
    btnContainer.style.display = "flex";
    btnContainer.style.flexDirection = "column";
    btnContainer.style.justifyContent = "center";
    btnContainer.style.border = "1px solid #444";
    btnContainer.style.borderRadius = "4px";
    btnContainer.style.overflow = "hidden";
    btnContainer.style.height = "32px"; // approx input height
    btnContainer.style.width = "16px";
    btnContainer.style.backgroundColor = "#222";

    const btnUp = document.createElement("button");
    btnUp.type = "button";
    btnUp.textContent = "▲";
    btnUp.style.cssText = `
      background: transparent;
      color: white;
      border: none;
      padding: 0;
      margin: 0;
      flex: 1;
      cursor: pointer;
      font-size: 10px;
      line-height: 1;
      user-select: none;
    `;

  btnUp.addEventListener("mouseenter", () => {
    btnUp.style.backgroundColor = "#555";
  });
  btnUp.addEventListener("mouseleave", () => {
    btnUp.style.backgroundColor = "transparent";
  });

  const btnDown = document.createElement("button");
  btnDown.type = "button";
  btnDown.textContent = "▼";
  btnDown.style.cssText = btnUp.style.cssText;
  btnDown.addEventListener("mouseenter", () => {
    btnDown.style.backgroundColor = "#555";
  });
  btnDown.addEventListener("mouseleave", () => {
    btnDown.style.backgroundColor = "transparent";
  });

  // Press-and-hold logic
  let intervalId;

  function changeValue(delta) {
    let newVal = parseFloat(input.value) + delta;
    if (isNaN(newVal)) newVal = value;
    input.value = newVal.toFixed(3);
    onChange(newVal);
  }

  btnUp.addEventListener("mousedown", () => {
    changeValue(parseFloat(step));
    intervalId = setInterval(() => changeValue(parseFloat(step)), 100);
  });
  btnUp.addEventListener("mouseup", () => clearInterval(intervalId));
  btnUp.addEventListener("mouseleave", () => clearInterval(intervalId));

  btnDown.addEventListener("mousedown", () => {
    changeValue(-parseFloat(step));
    intervalId = setInterval(() => changeValue(-parseFloat(step)), 100);
  });
  btnDown.addEventListener("mouseup", () => clearInterval(intervalId));
  btnDown.addEventListener("mouseleave", () => clearInterval(intervalId));


    btnContainer.appendChild(btnUp);
    btnContainer.appendChild(btnDown);
    wrapper.appendChild(input);
    wrapper.appendChild(btnContainer);

    return wrapper;
  }

  const table = document.createElement("table");
  table.style.width = "auto";
  table.style.maxWidth = "100%";
  table.style.borderCollapse = "collapse";
  table.style.backgroundColor = "transparent";

  const header = document.createElement("tr");
  ["Idx", "X", "Y", "Z", "Scale", "Color"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.borderBottom = "1px solid #aaa";
    th.style.padding = "2px 2px";
    th.style.color = "white";
    th.style.fontSize = "12px";
    th.style.width = "fit-content";
    header.appendChild(th);
  });
  table.appendChild(header);

  spinsData.forEach((spin) => {
    const row = document.createElement("tr");

    // Index cell
    const tdIdx = document.createElement("td");
    tdIdx.textContent = spin.atomIndex;
    tdIdx.style.padding = "2px 2px";
    tdIdx.style.color = "white";
    tdIdx.style.fontSize = "14px";
    row.appendChild(tdIdx);

    // Vector components (custom inputs with vertical buttons)
    spin.vector.forEach((val, comp) => {
      const td = document.createElement("td");
      td.style.padding = "2px 2px";

      const customInput = createCustomNumberInput(val, 0.01, newVal => {
        spin.vector[comp] = newVal;
        updateSpins(spinsData, parseFloat(slider.value));
      });

      td.appendChild(customInput);
      row.appendChild(td);
    });

    // Scale input with custom buttons
    const tdScale = document.createElement("td");
    tdScale.style.padding = "2px 2px";

    const customScaleInput = createCustomNumberInput(spin.scalingFactor, 0.01, newVal => {
      spin.scalingFactor = newVal;
      updateSpins(spinsData, parseFloat(slider.value));
    });

    tdScale.appendChild(customScaleInput);
    row.appendChild(tdScale);

    // Color dot centered with white border
    const tdColor = document.createElement("td");
    tdColor.style.padding = "10px 6px";
    tdColor.style.display = "flex";
    tdColor.style.justifyContent = "center";
    tdColor.style.alignItems = "center";

    const dot = document.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "16px";
    dot.style.height = "16px";
    dot.style.borderRadius = "50%";
    dot.style.backgroundColor = spin.color;
    dot.style.border = "2px solid white";
    dot.style.cursor = "pointer";

    dot.addEventListener("click", () => openColorPicker(spin, dot));

    tdColor.appendChild(dot);
    row.appendChild(tdColor);

    table.appendChild(row);
  });

  viewerPanel.appendChild(table);

}
  



function openColorPicker(spin, dot) {
  // Remove any existing picker first
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());

  // --- Helper: ensure color is in valid hex format ---
  function toHexColor(color) {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = color;
    return ctx.fillStyle.startsWith("#") ? ctx.fillStyle : "#000000";
  }

  const currentHex = toHexColor(spin.color || "#000000");
  let selectedHex = currentHex;

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

  // --- Create the color picker using external helper ---
  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    dot.style.background = hex; // live preview
  });

  // --- Apply / Reset Buttons ---
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, {
    display: "flex",
    justifyContent: "space-between",
    marginTop: "10px",
    gap: "8px"
  });

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset";
  resetBtn.className="reset-btn"

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  applyBtn.className="btn-mini highlight"

  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  // --- Position near the clicked dot ---
  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY - 200;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);

  // Ensure at least 40px space at the bottom of the screen
  if (bottomSpace < 40) {
      topPosition = window.innerHeight - pickerPanel.offsetHeight - 40; // Move it up so it has 40px from the bottom
  }

  pickerPanel.style.left = `${rect.left + window.scrollX + 24}px`;
  pickerPanel.style.top = `${topPosition}px`;



  // --- Close picker helper ---
  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
  };

  // --- Handle outside clicks ---
  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };

  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Apply button behavior ---
  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    spin.color = selectedHex;
    dot.style.backgroundColor = selectedHex;
    updateSpins(spinsData, parseFloat(slider.value));
    closePicker();
  });

  // --- Reset button behavior ---
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedHex = "#000000";
    spin.color = selectedHex;
    dot.style.backgroundColor = selectedHex;
    updateSpins(spinsData, parseFloat(slider.value));
    closePicker();
  });
}





}

function distance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getBondCutoff(elem1, elem2) {
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  return general.bondLengths[pair1] || general.bondLengths[pair2] || 0.0;
}



function formatÅ(x){ return (Math.round(x*1000)/1000).toFixed(3); }

function clearHighlightAtom(m){
  if(!m || !m.material) return;
  if(m.userData._origEmissive!==undefined){
    m.material.emissive.setHex(m.userData._origEmissive);
    m.material.emissiveIntensity = m.userData._origEmissiveInt || 0;
  }
}
function HighlightAtom(m, hex){
  if(!m || !m.material) return;
  if(m.userData._origEmissive===undefined){
    m.userData._origEmissive = m.material.emissive.getHex();
    m.userData._origEmissiveInt = m.material.emissiveIntensity || 0;
  }
  m.material.emissive.setHex(hex);
  m.material.emissiveIntensity = 2.0; // MAXIMUM BLAZING GLOW!
}


function clearMeasureGraphics(){
  if (measureLine){ app.scene.remove(measureLine); measureLine.geometry.dispose(); measureLine = null; }
  if (measureLabel){ app.scene.remove(measureLabel); measureLabel = null; }
}

function clearAllMeasurements(){
  // Clear all stored measurements
  measureLines.forEach(item => {
    app.scene.remove(item);
    if (item.geometry) item.geometry.dispose();
  });
  measureLabels.forEach(label => {
    app.scene.remove(label);
  });
  measureLines = [];
  measureLabels = [];
  selectedAtoms = [];
  clearMeasureGraphics();
}

function calculateAngle(atom1, atom2, atom3) {
  // Calculate angle between three atoms: atom1-atom2-atom3 (atom2 is vertex)
  const p1 = atom1.position.clone();
  const p2 = atom2.position.clone();
  const p3 = atom3.position.clone();

  const v1 = p1.sub(p2).normalize();
  const v2 = p3.sub(p2).normalize();

  const dotProduct = v1.dot(v2);
  const angle = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
  return angle * (180 / Math.PI); // Convert to degrees
}

function addAngleMeasurement(atom1, atom2, atom3) {
  const angle = calculateAngle(atom1, atom2, atom3);

  // Create angle arc visualization
  const p1 = atom1.position.clone();
  const p2 = atom2.position.clone(); // vertex
  const p3 = atom3.position.clone();

  // Create thick dashed cylinders from vertex to other atoms (ORANGE for angles)
  function createDashedCylinder(startPos, endPos, color) {
    const distance = startPos.distanceTo(endPos);
    const direction = new THREE.Vector3().subVectors(endPos, startPos);

    const dashLength = 0.25;
    const gapLength = 0.15;
    const segmentLength = dashLength + gapLength;
    const numSegments = Math.floor(distance / segmentLength);

    const cylinderGroup = new THREE.Group();

    for (let i = 0; i < numSegments; i++) {
      const segmentStart = i * segmentLength;
      const segmentGeometry = new THREE.CylinderGeometry(0.06, 0.06, dashLength, 8); // Slightly thinner than distance
      const segmentMaterial = new THREE.MeshBasicMaterial({ color: color });
      const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

      const segmentCenter = startPos.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
      segment.position.copy(segmentCenter);
      segment.lookAt(endPos);
      segment.rotateX(Math.PI / 2);

      cylinderGroup.add(segment);
    }
    return cylinderGroup;
  }

  // Create orange dashed cylinders for angle measurement
  const angleColor = 0xff6600; // Orange for angle measurements
  const angleLine1 = createDashedCylinder(p2, p1, angleColor);
  const angleLine2 = createDashedCylinder(p2, p3, angleColor);

  // Store atom indices for dynamic updates
  angleLine1.userData = {
    type: 'angle',
    atom1Index: atom1.userData.atomIndex,
    atom2Index: atom2.userData.atomIndex, // vertex
    atom3Index: atom3.userData.atomIndex,
    lineIndex: 1 // first line (vertex to atom1)
  };

  angleLine2.userData = {
    type: 'angle',
    atom1Index: atom1.userData.atomIndex,
    atom2Index: atom2.userData.atomIndex, // vertex
    atom3Index: atom3.userData.atomIndex,
    lineIndex: 2 // second line (vertex to atom3)
  };

  app.scene.add(angleLine1);
  app.scene.add(angleLine2);
  measureLines.push(angleLine1);
  measureLines.push(angleLine2);

  // Add markers to all three atoms
  [atom1, atom2, atom3].forEach((atom, index) => {
    const atomRadius = getAtomRadius(atom.userData.element);
    const color = index === 1 ? 0x00ff00 : 0x00ff88; // Vertex gets different color

    const rings = createAtomRings(atom.position, atomRadius, color, 0x000000, atom.userData.element);
    rings.userData = {
      ...rings.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
      type: 'angleMarker',
      atomIndex: atom.userData.atomIndex,
      atom1Index: atom1.userData.atomIndex,
      atom2Index: atom2.userData.atomIndex,
      atom3Index: atom3.userData.atomIndex
    };
    app.scene.add(rings);
    measureLines.push(rings);

  });

  // Create angle label at vertex
  const div = document.createElement('div');
  div.className = 'measure-label';
  div.style.background = 'rgba(0, 255, 0, 0.9)';
  div.style.border = '2px solid #00ff00';
  div.style.color = '#000000';
  div.style.fontWeight = '700';
  div.style.fontSize = '14px';
  div.style.padding = '2px 6px';
  div.style.borderRadius = '4px';
  const elements = [atom1.userData.element, atom2.userData.element, atom3.userData.element];
  div.textContent = `∠${elements[0]}-${elements[1]}-${elements[2]}: ${angle.toFixed(1)}°`;

  const label = new CSS2DObject(div);
  label.position.copy(p2);

  // Store atom indices for dynamic updates
  label.userData = {
    type: 'angle',
    atom1Index: atom1.userData.atomIndex,
    atom2Index: atom2.userData.atomIndex, // vertex
    atom3Index: atom3.userData.atomIndex
  };

  app.scene.add(label);
  measureLabels.push(label);
}

function addDistanceMeasurement(atom1, atom2) {
  // Create thick dashed cylinder for distance measurement (BLUE for distance)
  const pa = atom1.position.clone(), pb = atom2.position.clone();
  const distance = pa.distanceTo(pb);
  const direction = new THREE.Vector3().subVectors(pb, pa);
  const midpoint = new THREE.Vector3().addVectors(pa, pb).multiplyScalar(0.5);

  // Create multiple cylinder segments for dashed effect
  const dashLength = 0.3;
  const gapLength = 0.2;
  const segmentLength = dashLength + gapLength;
  const numSegments = Math.floor(distance / segmentLength);

  const cylinderGroup = new THREE.Group();

  for (let i = 0; i < numSegments; i++) {
    const segmentStart = i * segmentLength;
    const segmentGeometry = new THREE.CylinderGeometry(0.08, 0.08, dashLength, 8); // Thick cylinder
    const segmentMaterial = new THREE.MeshBasicMaterial({ color: 0x0066ff }); // Blue for distance
    const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

    // Position segment along the line
    const segmentCenter = pa.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
    segment.position.copy(segmentCenter);
    segment.lookAt(pb);
    segment.rotateX(Math.PI / 2);

    cylinderGroup.add(segment);
  }

  // Store atom indices for dynamic updates
  cylinderGroup.userData = {
    type: 'distance',
    atom1Index: atom1.userData.atomIndex,
    atom2Index: atom2.userData.atomIndex
  };

  app.scene.add(cylinderGroup);
  measureLines.push(cylinderGroup);

  // Create atom-size-aware surface markers

  // Get atom radii for proper scaling
  const atomRadiusA = getAtomRadius(atom1.userData.element);
  const atomRadiusB = getAtomRadius(atom2.userData.element);

  // Add scaling rings to both atoms
  const ringsA = createAtomRings(pa, atomRadiusA, 0xffff00, 0x000000, atom1.userData.element); // Yellow inner, black outer
  ringsA.userData = {
    ...ringsA.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    atomIndex: atom1.userData.atomIndex,
    measurementIndex: measureLines.length // Reference to the cylinder group
  };
  app.scene.add(ringsA);
  measureLines.push(ringsA);

  const ringsB = createAtomRings(pb, atomRadiusB, 0xffff00, 0x000000, atom2.userData.element); // Yellow inner, black outer
  ringsB.userData = {
    ...ringsB.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    atomIndex: atom2.userData.atomIndex,
    measurementIndex: measureLines.length - 1 // Reference to the cylinder group
  };
  app.scene.add(ringsB);
  measureLines.push(ringsB);

  // Create a compact black and white floating label
  const mid = pa.clone().add(pb).multiplyScalar(0.5);
  const div = document.createElement('div');
  div.className = 'measure-label';
  div.style.background = 'rgba(255, 255, 255, 0.95)';
  div.style.border = '2px solid #000000';
  div.style.color = '#000000';
  div.style.fontWeight = '700';
  div.style.fontSize = '14px';
  div.style.padding = '2px 6px';
  div.style.textShadow = '1px 1px 2px rgba(255,255,255,0.8)';
  div.style.boxShadow = '0 3px 8px rgba(0,0,0,0.4)';
  div.style.borderRadius = '4px';
  const a = atom1.userData.element, b = atom2.userData.element;
  const d = pa.distanceTo(pb);
  //div.textContent = `${a}—${b}: ${formatÅ(d)} Å`;
  div.textContent = `${formatÅ(d)} Å`;
  const label = new CSS2DObject(div);
  label.position.copy(mid);

  // Store atom indices for dynamic updates
  label.userData = {
    type: 'distance',
    atom1Index: atom1.userData.atomIndex,
    atom2Index: atom2.userData.atomIndex
  };

  app.scene.add(label);
  measureLabels.push(label);
}

function drawMeasureGraphics(){
  clearMeasureGraphics();

  // Show preview lines/indicators for current selection
  if (mode.measureMode === 'distance' && selectedAtoms.length === 1) {
    // Show preview for distance measurement (1 atom selected)
    const atom1 = selectedAtoms[0];
    const div = document.createElement('div');
    div.className = 'measure-label';
    div.style.background = 'rgba(255, 255, 255, 0.8)';
    div.style.border = '2px solid #000000';
    div.style.color = '#000000';
    div.style.fontWeight = '700';
    div.style.fontSize = '12px';
    div.style.padding = '4px 8px';
    div.style.borderRadius = '4px';
    //div.textContent = `${atom1.userData.element} — ? (click 2nd atom)`;
    div.textContent = `choose 2nd atom`;
    measureLabel = new CSS2DObject(div);
    measureLabel.position.copy(atom1.position);
    app.scene.add(measureLabel);
  } else if (mode.measureMode === 'angle' && selectedAtoms.length > 0) {
    // Show preview for angle measurement
    const div = document.createElement('div');
    div.className = 'measure-label';
    div.style.background = 'rgba(0, 255, 0, 0.8)';
    div.style.border = '2px solid #00ff00';
    div.style.color = '#000000';
    div.style.fontWeight = '700';
    div.style.fontSize = '10px';
    div.style.padding = '2px 4px';
    div.style.borderRadius = '4px';

    if (selectedAtoms.length === 1) {
      div.textContent = `${selectedAtoms[0].userData.element} — ? — ? (select vertex)`;
    } else if (selectedAtoms.length === 2) {
      div.textContent = `${selectedAtoms[0].userData.element} — ${selectedAtoms[1].userData.element} — ? (select 3rd atom)`;
    }

    measureLabel = new CSS2DObject(div);
    measureLabel.position.copy(selectedAtoms[selectedAtoms.length - 1].position);
    app.scene.add(measureLabel);
  }
}

function clearMeasure(){
  selectedAtoms.forEach(atom => clearHighlightAtom(atom));
  selectedAtoms = [];
  clearMeasureGraphics();
}

function createAtomMesh(element, position, atomIndex = null,opacity=1.0) {
  const radius = getAtomRadius(element);
  const color = atomIndex !== null ? getIndividualAtomColor(element, atomIndex) : getElementColor(element);
  const geometry = new THREE.SphereGeometry(radius, 32, 24);
  const material = new THREE.MeshPhysicalMaterial(getAtomVisSettings(color, opacity));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.userData.element = element;
  mesh.userData.atomIndex = atomIndex;
  return mesh;
}

function createBond(pos1, pos2, elem1, elem2, atomIndex1, atomIndex2,opacity=1.0) {
  const p1 = new THREE.Vector3(pos1[0], pos1[1], pos1[2]);
  const p2 = new THREE.Vector3(pos2[0], pos2[1], pos2[2]);
  const dist = distance(p1, p2);
  const cutoff = getBondCutoff(elem1, elem2);

  // If bond length is set to 0 or very small, don't create any bonds
  if (cutoff <= 0.01 || dist > cutoff || dist < 0.005) return null;

  // Check bond visibility
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  const isVisible = general.bondVisibility[pair1] !== false && general.bondVisibility[pair2] !== false;

  if (!isVisible) return null;

  const direction = new THREE.Vector3().subVectors(p2, p1);
  const midpoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);

  // Build VESTA-style split bond, but start at atom surfaces
  const bondGroup = new THREE.Group();

  const color1 = getIndividualAtomColor(elem1,atomIndex1);
  const color2 = getIndividualAtomColor(elem2,atomIndex2);

  // Compute visible segment between atom surfaces
  const r1 = getAtomRadius(elem1)-0.05*getAtomRadius(elem1);
  const r2 = getAtomRadius(elem2)-0.05*getAtomRadius(elem2);
  const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
  const visibleLen = Math.max(dist - (r1 + r2), 0);
  if (visibleLen <= 1e-3) return null; // spheres overlap or touch; skip bond

  const halfLen = visibleLen * 0.5;
  const radius = general.bondRadius;

  const geometryHalf = new THREE.CylinderGeometry(radius, radius, halfLen, 20);


  const material1 = new THREE.MeshPhysicalMaterial(getBondVisSettings(color1,opacity));
  const material2 = new THREE.MeshPhysicalMaterial(getBondVisSettings(color2,opacity));

  // Centers for the two halves: start from each surface and end at the
  // midpoint between surfaces, so centers are offset by r + halfLen/2
  const center1 = p1.clone().add(dir.clone().multiplyScalar(r1 + halfLen / 2));
  const center2 = p2.clone().add(dir.clone().multiplyScalar(-r2 - halfLen / 2));

  const half1 = new THREE.Mesh(geometryHalf, material1);
  half1.position.copy(center1);
  half1.lookAt(p2);
  half1.rotateX(Math.PI / 2);

  const half2 = new THREE.Mesh(geometryHalf, material2);
  half2.position.copy(center2);
  half2.lookAt(p2);
  half2.rotateX(Math.PI / 2);

  bondGroup.add(half1);
  bondGroup.add(half2);

  return bondGroup;
}

function createLatticeLines(color = currentLatticeColor) {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial(getLatticeVisSettings(color));

  const lattice = structureData.lattice;

  // Define unit cell vertices
  const vertices = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]),
    new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]),
    new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]),
    new THREE.Vector3(lattice[0][0] + lattice[1][0], lattice[0][1] + lattice[1][1], lattice[0][2] + lattice[1][2]),
    new THREE.Vector3(lattice[0][0] + lattice[2][0], lattice[0][1] + lattice[2][1], lattice[0][2] + lattice[2][2]),
    new THREE.Vector3(lattice[1][0] + lattice[2][0], lattice[1][1] + lattice[2][1], lattice[1][2] + lattice[2][2]),
    new THREE.Vector3(lattice[0][0] + lattice[1][0] + lattice[2][0], lattice[0][1] + lattice[1][1] + lattice[2][1], lattice[0][2] + lattice[1][2] + lattice[2][2])
  ];

  // Define edges of unit cell
  const edges = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4], [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7]
  ];

  edges.forEach(edge => {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      vertices[edge[0]], vertices[edge[1]]
    ]);
    const line = new THREE.Line(geometry, material);
    group.add(line);
  });

  return group;
}

function computeComposition() {
  if (!structureData) return {};
  const counts = {};
  structureData.elements.forEach(e => counts[e] = (counts[e] || 0) + 1);
  return counts;
}

function getCompositionString() {
  // Generate the chemical formula as a string
  const counts = computeComposition();
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const elements = Object.keys(counts).sort();

  let formula = '';

  // Iterate through the counts object and build the formula string
  for (const element in counts) {
    const count = counts[element];
    if (general.currentSupercell === null) {
      formula += element + (count > 1 ? `<sub>${count}</sub>` : ''); // Add subscript if count > 1
    } else {
      const supercellSize = general.currentSupercell.nx * general.currentSupercell.ny * general.currentSupercell.nz;
      // Divide the count by the supercell size
      const currCount = count / supercellSize;
      formula += element + (currCount > 1 ? `<sub>${Math.round(currCount)}</sub>` : ''); // Add subscript if count > 1
    }
  }

  // Set the composition string in the 'h4' of the #structureToggle
  const structureToggleHeading = document.querySelector('#structureToggle h4');
  if (structureToggleHeading) {
    structureToggleHeading.innerHTML = formula + ` (${total} Atoms)`; // Use innerHTML to allow HTML tags
  }

  // Display the chemical formula and the total number of atoms
  const compString = document.createElement('div');
  compString.innerHTML = `${formula} (${total} Atoms)`; // Use innerHTML to allow HTML tags
  compString.style.cssText = 'font-size:12px; font-weight:500; margin-bottom:10px;';

  const compWrapper = document.querySelector('#composition');
  compWrapper.appendChild(compString);

  // Return elements, counts, and total
  return { elements, counts, total };
}

function renderComposition() {

  const {elements, counts, total}=getCompositionString()

  const compDiv = document.getElementById('composition');
  compDiv.innerHTML = '';
   const compString = document.createElement('div');
  const compWrapper = document.createElement('div');
    compWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;


  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  title.textContent = 'Modify Color/Positions';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  compDiv.appendChild(titleWrapper);

  // Ensure structure panel starts collapsed by default
  compDiv.classList.remove('open');
  compDiv.style.maxHeight = ''; // reset
  const toggleIcon = document.getElementById('structureToggleIcon');
  if (toggleIcon) {
    toggleIcon.textContent = '+';
    toggleIcon.classList.remove('open');
  }
  const structureToggle = document.getElementById('structureToggle');
  if (structureToggle) {
    structureToggle.setAttribute('aria-expanded', 'false');
    // Rebind listener cleanly
    structureToggle.removeEventListener('click', handleStructurePanelToggle);
    structureToggle.addEventListener('click', handleStructurePanelToggle);
  }



  // Render ALL rows directly (no “+N more” collapsing)
  elements.forEach(el => {
    const row = createCompositionRow(el, counts[el], total);
    compDiv.appendChild(row);
  });

  // Lattice parameters section
  addSupercellSection();
  addLatticeParametersSection();
}

function createCompositionRow(el, count, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

  const row = document.createElement('div');
  row.className = 'comp-row';
  // Two-column grid: left (fixed auto), right (flex). Editor lives under right.
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px; cursor: pointer; transition: background-color 0.2s ease;';

  const left = document.createElement('div');
  left.className = 'comp-left';
  const currentColor = getElementDisplayColor(el);
  const curr_elem_colors = getElementDisplayColor(el);
  let dot;

  if (curr_elem_colors.length > 1) {
    dot = createPieDot(curr_elem_colors, 20);
    dot.classList.add('dot');
  } else {
    dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = curr_elem_colors[0];
  }

  const name = document.createElement('span');
  name.textContent = el;

  // Add expand/collapse indicator - starts collapsed
  const expandIcon = document.createElement('span');
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = 'margin-left: 4px; font-size: 14px; transition: transform 0.2s ease; color: rgba(255,255,255,0.8); transform: rotate(0deg);';

  left.appendChild(dot);
  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('span');
  const pct = (100*count/total).toFixed(1);
  right.textContent = `${count} (${pct}%)`;

  row.appendChild(left); // grid col 1
  row.appendChild(right); // grid col 2


  // Create individual atoms container (hidden by default)
  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;';

  // Create individual atom rows - need to map element-specific indices to actual structure indices
  const elementAtomIndices = [];
  for (let i = 0; i < structureData.elements.length; i++) {
    if (structureData.elements[i] === el) {
      elementAtomIndices.push(i);
    }
  }

  for (let i = 0; i < elementAtomIndices.length; i++) {
    const actualAtomIndex = elementAtomIndices[i];
    const atomRow = createIndividualAtomRow(el, actualAtomIndex, i + 1); // Pass display number as well
    atomsContainer.appendChild(atomRow);
  }

  // Add hover effects
  row.addEventListener('mouseenter', () => {
    row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    row.style.backgroundColor = 'transparent';
  });

  // Add click handler for expand/collapse
  row.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering parent events
    const isExpanded = atomsContainer.style.display !== 'none';

    // Toggle this element's expansion
    atomsContainer.style.display = isExpanded ? 'none' : 'block';
    expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
  });

  container.appendChild(row);
  container.appendChild(atomsContainer);

  // Inline color editor (hidden by default)
  const editor = document.createElement('div');
  // Make editor occupy only the right column and not depend on name length
  editor.style.cssText = 'display:none; grid-column:2; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;';
  editor.className = 'color-editor';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = currentColor;
  colorInput.style.cssText = 'width: 32px; height: 32px; border: none; background: transparent; cursor: pointer; flex-shrink: 0; margin: 0; padding: 0; box-sizing: border-box; vertical-align: top;';

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = currentColor;
  hexInput.placeholder = '#RRGGBB';
  hexInput.style.cssText = 'width: 80px; height: 32px; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 12px; margin: 0; box-sizing: border-box; vertical-align: top;';

  const mom_color = getElementDisplayColor(el);

  const picker = createColorPicker(mom_color[0], (hex) => {
    clearAllIndividualColorsForElement(el);      // Clear old color overrides
    const ok = setElementColorOverride(el, hex); // Apply new color override
    dot.style.background = hex;
      if (ok) {
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      }
    });


  // Single line: color swatch + hex field + buttons
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  topRow.appendChild(picker.element);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 44px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  // Add buttons to the same row
  // Create separate button row
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  // Assembly: two rows
  editor.appendChild(topRow);
  editor.appendChild(buttonRow);
  row.appendChild(editor);

  // Helper to decide readable text color over a background
  function textColorForBg(cssHex) {
    let hex = cssHex.replace('#','');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0,2), 16);
    const g = parseInt(hex.slice(2,4), 16);
    const b = parseInt(hex.slice(4,6), 16);
    const yiq = (r*299 + g*587 + b*114) / 1000;
    return yiq >= 128 ? '#000' : '#fff';
  }
  dot.style.cursor = 'pointer';
  row.style.cursor = 'default';
  dot.title = 'Customize color';
  dot.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
    if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
  };
  // Only sync inputs; application happens on Apply button
  colorInput.oninput = (e) => { hexInput.value = e.target.value; };
  hexInput.oninput = (e) => { colorInput.value = e.target.value; };

  // Style reset button with the element's default palette color
  const defaultColorCss = colorHexToCss(getDefaultElementColor(el));
  resetBtn.style.background = defaultColorCss;
  resetBtn.style.borderColor = 'rgba(0,0,0,0.15)';
  resetBtn.style.color = textColorForBg(defaultColorCss);

  // Reset clears both element-wide override AND all individual colors for this element
  resetBtn.onclick = () => {
    clearElementColorOverride(el);
    clearAllIndividualColorsForElement(el);
    updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
  };

   applyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      renderComposition();
      updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      editor.style.display = 'none';

  };
  // Add element-wide color editor to container (after individual atoms)
  container.appendChild(editor);

  return container;
}


function addSupercellSection() {
  const compDiv = document.getElementById('composition');
  if (!compDiv || !structureData) return;
  const resetWrapper = document.createElement('div');
  resetWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 16px;
  `;

  const fullColorResetBtn = document.createElement('button');
  fullColorResetBtn.textContent = 'Reset All Colors';
  fullColorResetBtn.className = 'reset-btn';
  fullColorResetBtn.style.cssText = `
    height: 32px;
    padding: 6px 12px;
    font-size: 12px;
    min-width: 50px;
    cursor: pointer;
  `;

  fullColorResetBtn.onclick = () => {
    const uniqueElements = new Set(structureData.elements);
    for (const element of uniqueElements) {
      clearElementColorOverride(element);
      clearAllIndividualColorsForElement(element);
    }
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: false,
      reRenderOther: true,
    });
  };

  resetWrapper.appendChild(fullColorResetBtn);
  compDiv.appendChild(resetWrapper);

  // Wrapper section
  const supercellSection = document.createElement('div');
  supercellSection.id = 'supercellSection';
  supercellSection.style.cssText = `
    border-top: 2px solid rgba(255,255,255,0.1);
    margin-top: 12px;
    padding-top: 12px;
    color: rgba(255,255,255,0.85);
  `;

  // Title
  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  title.textContent = 'Create Supercell';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  supercellSection.appendChild(titleWrapper);

    // --- Initialize supercell values ---
  if (!structureData.supercell) structureData.supercell = { nx: 1, ny: 1, nz: 1 };
  const { nx,ny,nz } = structureData.supercell;

  // --- Input row ---
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex; gap:6px; margin-bottom:8px;justify-content: center;';
  const inputs = {};
  ['nx', 'ny', 'nz'].forEach(axis => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    if (general.currentSupercell != null) {
    input.value = general.currentSupercell[axis];
    }
    else{
      input.value = 1
    }  
    input.style.cssText =
      'width:50px; text-align:center; border:none; border-radius:4px; background:rgba(255,255,255,0.1); color:white; font-family:monospace; padding:3px;';
    inputs[axis] = input;
    inputRow.appendChild(input);
  });
  supercellSection.appendChild(inputRow);

  // --- Buttons row ---
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'mini-btn';
  applyBtn.style.cssText =
    'flex:1; background:rgba(255,255,255,0.15); border:none; border-radius:6px; color:white; height:28px; cursor:pointer;';


  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn';
  resetBtn.style.cssText =
    'flex:1; border:none; border-radius:6px; color:white; height:28px; cursor:pointer;';


  btnRow.appendChild(applyBtn);
  btnRow.appendChild(resetBtn);
  supercellSection.appendChild(btnRow);

  // --- Apply logic ---
  applyBtn.onclick = () => {
    const newA = Math.max(1, parseInt(inputs.nx.value));
    const newB = Math.max(1, parseInt(inputs.ny.value));
    const newC = Math.max(1, parseInt(inputs.nz.value));
    structureData.supercell = { nx: newA, ny: newB, nz: newC };

    // Restore pristine structure from originalStructureData
    structureData.atoms = structuredClone(originalStructureData.atoms);
    structureData.lattice = structuredClone(originalStructureData.lattice);
    structureData.elements = structuredClone(originalStructureData.elements);

    // Build supercell
    createSupercell(newA, newB, newC);
    updateVisualization({
        reRenderAtoms: true,
        reRenderBonds: true,
        reRenderLattice: true
      });
    resetView()
  };

  resetBtn.onclick = () => {
    createSupercell(1, 1, 1);
    updateVisualization({
        reRenderAtoms: true,
        reRenderBonds: true,
        reRenderLattice: true
      });
    resetView()
  }
  // --- Attach section ---
  compDiv.appendChild(supercellSection);
}



// Function to add lattice parameters section to composition
//

function addLatticeParametersSection() {
  const compDiv = document.getElementById('composition');
  if (!compDiv || !structureData || !structureData.lattice) return;

  const oldSection = document.getElementById('latticeSection');
  if (oldSection) oldSection.remove();

  const latticeSection = document.createElement('div');
  latticeSection.id = 'latticeSection';
  latticeSection.style.cssText = `
    border-top: 2px solid rgba(255,255,255,0.1);
    margin-top: 12px;
    padding-top: 12px;
    color: rgba(255,255,255,0.85);
    font-size: 13px;
  `;


  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  title.textContent = 'Modify Lattice';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  latticeSection.appendChild(titleWrapper);

   const latticeResetBtnWrapper = document.createElement('div');
    latticeResetBtnWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  const latticeResetBtn = document.createElement('button');
  latticeResetBtn.textContent = 'Reset Lattice';
  latticeResetBtn.className = 'reset-btn';
  latticeResetBtn.id = 'LatticeResetBtn';
  latticeResetBtn.style.cssText = `
    height: 28px;
    padding: 4px 10px;
    font-size: 12px;
    margin-bottom: 10px;
    cursor: pointer;
    border: none;
    border-radius: 4px;
    color: white;
  `;
  latticeResetBtnWrapper.appendChild(latticeResetBtn);
  latticeSection.appendChild(latticeResetBtnWrapper);


  // ---- Toggle controls ----
  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = 'display:flex; justify-content:center; align-items:center; margin-bottom:8px;';

  const toggleLabel = document.createElement('span');
  toggleLabel.textContent = 'Input Option:    ';
  toggleLabel.style.cssText = 'font-weight:600; color:rgba(255,255,255,0.8);';

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Matrix';
  toggleBtn.className = 'mini-btn';
  toggleBtn.style.cssText = `
    height:24px; padding:2px 8px; font-size:12px; cursor:pointer;
    border:none; border-radius:4px; background:rgba(255,255,255,0.1); color:white;margin-left:8px;
  `;

  toggleRow.appendChild(toggleLabel);
  toggleRow.appendChild(toggleBtn);
  latticeSection.appendChild(toggleRow);


  // ---- Container for inputs ----
  const viewContainer = document.createElement('div');
  latticeSection.appendChild(viewContainer);

  // ---- Volume display ----
  const volumeDiv = document.createElement('div');
  volumeDiv.style.cssText = 'margin-top:8px; font-size:13px; color:rgba(255,255,255,0.8);';
  latticeSection.appendChild(volumeDiv);

  compDiv.appendChild(latticeSection);

  // ===== Helper math functions =====
  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const dot = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const acosDeg = (x) => Math.acos(clamp(x, -1, 1)) * 180 / Math.PI;
  const deg2rad = (deg) => deg * Math.PI / 180;
  const cross = (a,b) => [
    a[1]*b[2]-a[2]*b[1],
    a[2]*b[0]-a[0]*b[2],
    a[0]*b[1]-a[1]*b[0]
  ];

  function updateVolumeDisplay(L) {
    const V = Math.abs(dot(L[0], cross(L[1], L[2])));
    volumeDiv.textContent = `Volume: ${V.toFixed(3)} Å³`;
  }

  // ===== Lattice Parameter View =====
  function renderLatticeParams() {
    viewContainer.innerHTML = '';
    const L = structureData.lattice;
    const a = norm(L[0]);
    const b = norm(L[1]);
    const c = norm(L[2]);
    const alpha = acosDeg(dot(L[1], L[2]) / (b * c || 1));
    const beta  = acosDeg(dot(L[0], L[2]) / (a * c || 1));
    const gamma = acosDeg(dot(L[0], L[1]) / (a * b || 1));

    const params = { a, b, c, alpha, beta, gamma };
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    const tbody = document.createElement('tbody');

    for (const [key, val] of Object.entries(params)) {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.textContent = key;
      tdLabel.style.cssText = 'padding:4px;';

      const tdInput = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.value = val.toFixed(4);
      input.step = key.length === 1 ? '0.01' : '0.1';
      input.style.cssText = 'width:80px; text-align:right; font-family:monospace; padding:2px;';
      input.id = `${key}Input`;
      input.oninput = () => {
        const vals = {
          a: parseFloat(document.querySelector('#aInput').value),
          b: parseFloat(document.querySelector('#bInput').value),
          c: parseFloat(document.querySelector('#cInput').value),
          alpha: parseFloat(document.querySelector('#alphaInput').value),
          beta: parseFloat(document.querySelector('#betaInput').value),
          gamma: parseFloat(document.querySelector('#gammaInput').value),
        };
        if (Object.values(vals).some(v => !isFinite(v))) return;

        const { a, b, c, alpha, beta, gamma } = vals;
        const cosA = Math.cos(deg2rad(alpha));
        const cosB = Math.cos(deg2rad(beta));
        const cosG = Math.cos(deg2rad(gamma));
        const sinG = Math.sin(deg2rad(gamma));
        const Lnew = [
          [a, 0, 0],
          [b*cosG, b*sinG, 0],
          [c*cosB, c*(cosA - cosB*cosG)/sinG, c*Math.sqrt(1 - cosB**2 - ((cosA - cosB*cosG)/sinG)**2)]
        ];
        modifiedLattice = Lnew;
        structureData.lattice = Lnew;
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: true,
          reRenderOther: false
        });
        updateVolumeDisplay(Lnew);
      };
      tdInput.appendChild(input);
      tr.appendChild(tdLabel);
      tr.appendChild(tdInput);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    viewContainer.appendChild(table);
    updateVolumeDisplay(L);
  }

  // ===== Matrix View =====
  function renderMatrixView() {
    viewContainer.innerHTML = '';
    const L = structureData.lattice;

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    const tbody = document.createElement('tbody');

    for (let i = 0; i < 3; i++) {
      const tr = document.createElement('tr');
      for (let j = 0; j < 3; j++) {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.value = L[i][j].toFixed(4);
        input.step = '0.01';
        input.style.cssText = 'width:80px; text-align:right; font-family:monospace; padding:2px;';
        input.oninput = () => {
          const val = parseFloat(input.value);
          if (isFinite(val)) {
            structureData.lattice[i][j] = val;
            updateVisualization({ 
                        reRenderAtoms: true,
                        reRenderBonds: true,
                        reRenderLattice: true,
                        reRenderOther: false
            });
            updateVolumeDisplay(structureData.lattice);
          }
        };
        modifiedLattice = structureData.lattice
        td.appendChild(input);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    viewContainer.appendChild(table);
    updateVolumeDisplay(L);
  }

  // ===== Event Handlers =====
  let showMatrix = false;
  toggleBtn.onclick = () => {
    showMatrix = !showMatrix;
    toggleBtn.textContent = showMatrix ? 'Parameters' : 'Show Matrix';
    showMatrix ? renderMatrixView() : renderLatticeParams();
  };

  latticeResetBtn.onclick = () => {
    const originalData = JSON.parse(JSON.stringify(originalStructureData));
    //createSupercell(1,1,1)
    modifiedLattice = null
    structureData.lattice = originalData.lattice
    if (currentSupercell != null){
      createSupercell(currentSupercell.nx,currentSupercell.ny,currentSupercell.nz)
    } 
    updateVisualization({ reRenderAtoms:true, reRenderBonds:true, reRenderLattice:true,reRenderOther:true });
    resetView();
    (showMatrix ? renderMatrixView : renderLatticeParams)();
  };

  // Initial render
  renderLatticeParams();
}


// Global variable to track currently highlighted atoms
let currentlyHighlightedAtom = null;
let currentlyHighlightedRow = null;

function highlightAtomInStructurePanel(element, sourceIndex) {
  // First, clear any existing highlights
  clearAllHighlights();

  // Auto-expand the structure panel if it's collapsed
  const structureToggle = document.getElementById('structureToggle');
  const composition = document.getElementById('composition');
  if (!composition) return;

  // Collapse all other atom expansions first
  collapseAllAtomExpansions();

  // Check if structure panel is collapsed and expand it
  if (composition.classList.contains('collapsible-content') && !composition.classList.contains('open')) {
    const toggleIcon = document.getElementById('structureToggleIcon');
    composition.classList.add('open');
    // composition.setAttribute('aria-hidden', 'false'); // Removed to prevent focus issues
    if (toggleIcon) {
      toggleIcon.textContent = '−';
      toggleIcon.classList.add('open');
    }
    if (structureToggle) {
      structureToggle.setAttribute('aria-expanded', 'true');
    }
  }

  // Look for the element container
  const elementContainers = composition.querySelectorAll('.comp-container');
  let targetContainer = null;

  for (const container of elementContainers) {
    const elementName = container.querySelector('.comp-left span:nth-child(2)');
    if (elementName && elementName.textContent === element) {
      targetContainer = container;
      break;
    }
  }

  if (!targetContainer) return;

  // Auto-expand the element if not already expanded
  const atomsContainer = targetContainer.querySelector('.individual-atoms');
  const expandIcon = targetContainer.querySelector('.comp-left span:last-child');

  if (atomsContainer && atomsContainer.style.display === 'none') {
    atomsContainer.style.display = 'block';
    if (expandIcon) {
      expandIcon.style.transform = 'rotate(90deg)';
    }
  }

  // Find the specific individual atom row
  const atomRows = atomsContainer.querySelectorAll('.individual-atom-row');
  for (const row of atomRows) {
    const atomNameSpan = row.querySelector('span:nth-child(1)');  // was 2 which is the coordiante and not the name. therefore the highlight did not work 
    if (atomNameSpan) {
      // Extract the atom index from the display name (e.g., "Ba1" -> check if this is sourceIndex 0)
      const actualIndex = getAtomActualIndex(element, atomNameSpan.textContent);
      if (actualIndex === sourceIndex) {
        // Highlight this row
        highlightAtomRow(row);
        // Scroll into view
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }
  }
}

function getAtomActualIndex(element, displayName) {
  // Convert "Ba1" to actual index by finding all atoms of this element
  //if (!structureData) return -1;
  const displayNumber = parseInt(displayName.replace(element, ''));
  let elementCount = 0;

  for (let i = 0; i < structureData.elements.length; i++) {
    if (structureData.elements[i] === element) {
      elementCount++;
      if (elementCount === displayNumber) {
        return i;
      }
    }
  }
  return -1;
}

function highlightAtomRow(row) {
  // Clear previous highlight
  console.log("Highlighting atom row")
  if (currentlyHighlightedRow) {
    currentlyHighlightedRow.style.backgroundColor = '';
    currentlyHighlightedRow.style.borderLeft = '';
  }

  // Add highlight to new row
  row.style.backgroundColor = 'rgba(255, 191, 0, 0.2)'; // Orange highlight
  row.style.borderLeft = '3px solid #FFB347';
  currentlyHighlightedRow = row;

}

function highlightAtomIn3D(atomMesh) {
  // Clear previous 3D highlight
  if (currentlyHighlightedAtom) {
    clearHighlightAtom(currentlyHighlightedAtom);
  }

  // Add new highlight
  HighlightAtom(atomMesh, 0xFFB347); // Orange glow
  currentlyHighlightedAtom = atomMesh;

}

function clearAllHighlights() {
  // Clear UI highlight
  if (currentlyHighlightedRow) {
    currentlyHighlightedRow.style.backgroundColor = '';
    currentlyHighlightedRow.style.borderLeft = '';
    currentlyHighlightedRow = null;
  }

  // Clear 3D highlight
  if (currentlyHighlightedAtom) {
    clearHighlightAtom(currentlyHighlightedAtom);
    currentlyHighlightedAtom = null;
  }
}

// Make clearAllHighlights available globally for manual clearing
window.clearAtomHighlight = clearAllHighlights;

// Function to collapse all individual atom expansions
function collapseAllAtomExpansions() {
  const atomsContainers = document.querySelectorAll('.individual-atoms');
  const expandIcons = document.querySelectorAll('.comp-left span:last-child');

  atomsContainers.forEach(container => {
    container.style.display = 'none';
  });

  expandIcons.forEach(icon => {
    icon.style.transform = 'rotate(0deg)';
  });
}



// Function to handle structure panel toggle
function handleStructurePanelToggle() {
  const composition = document.getElementById('composition');
  if (composition && !composition.classList.contains('open')) {
    // Structure panel is being collapsed, so collapse all atom expansions
    collapseAllAtomExpansions();
  }
}


function createIndividualAtomRow(element, atomIndex, displayNumber = atomIndex + 1) {
  const row = document.createElement('div');
  row.className = 'individual-atom-row';
  row.style.cssText = 'display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: 20px; padding: 4px 0; font-size: 11px;';

  // Individual atom dot with its specific color
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; border: 1px solid rgba(255,255,255,0.4);';
  const currentColor = colorHexToCss(getIndividualAtomColor(element, atomIndex));
  dot.style.background = currentColor;

  // Atom name and coordinates container
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  name.textContent = `${element}${displayNumber}  `;
  name.style.color = '#ddd';

  // Coordinates display (fractional)
  const coords = structureData.positions[atomIndex];
  const coordsDisplay = document.createElement('span');
  coordsDisplay.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.8); font-family: monospace;';
  coordsDisplay.textContent = `(${coords[0].toFixed(3)}, ${coords[1].toFixed(3)}, ${coords[2].toFixed(3)})`;

  nameContainer.appendChild(name);
  nameContainer.appendChild(coordsDisplay);

  row.appendChild(nameContainer);

  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 10px;';

  // Color picker button
  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; min-width: 22px;';
  const choosenColor = hexToRgba(colorHexToCss(getIndividualAtomColor(element, atomIndex)),0.8);
  colorBtn.style.background = choosenColor;
  colorBtn.title = `Change color for ${element}${displayNumber}`;

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
  coordBtn.style.cssText = 'background: rgba(6,100,50,0.8); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; min-width: 22px;';
  coordBtn.title = `Edit coordinates for ${element}${displayNumber}`;

  buttonContainer.appendChild(colorBtn);
  buttonContainer.appendChild(coordBtn);

  row.appendChild(buttonContainer);

  // Create color editor for this individual atom
  const editor = document.createElement('div');
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';
  const mom_color = colorHexToCss(getIndividualAtomColor(element, atomIndex))
  const picker = createColorPicker(mom_color, (hex) => {
    const ok = setIndividualAtomColor(element, atomIndex, hex); 
    dot.style.background = hex;
      if (ok) {
        updateBonds()
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      }
    });

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const editorControls = document.createElement('div');
  editorControls.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  // First row: color + hex
  const topRowIndiv = document.createElement('div');
  topRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';

  topRowIndiv.appendChild(picker.element);

  // Second row: buttons
  const buttonRowIndiv = document.createElement('div');
  buttonRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  buttonRowIndiv.appendChild(resetBtn);
  buttonRowIndiv.appendChild(applyBtn);

  editor.appendChild(topRowIndiv);
  editor.appendChild(buttonRowIndiv);

  // Create coordinate editor for this individual atom
  const coordEditor = document.createElement('div');
  coordEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const coordTitle = document.createElement('div');
  coordTitle.textContent = 'Fractional Coordinates';
  coordTitle.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.8); margin-bottom: 6px; font-weight: 500;';

  const xInput = document.createElement('input');
  xInput.type = 'number';
  xInput.value = coords[0].toFixed(6);
  xInput.step = '0.000001';
  xInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  xInput.placeholder = 'x';

  const yInput = document.createElement('input');
  yInput.type = 'number';
  yInput.value = coords[1].toFixed(6);
  yInput.step = '0.000001';
  yInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  yInput.placeholder = 'y';

  const zInput = document.createElement('input');
  zInput.type = 'number';
  zInput.value = coords[2].toFixed(6);
  zInput.step = '0.000001';
  zInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  zInput.placeholder = 'z';

  const coordInputsRow = document.createElement('div');
  coordInputsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-bottom: 6px;';
  coordInputsRow.appendChild(xInput);
  coordInputsRow.appendChild(yInput);
  coordInputsRow.appendChild(zInput);

  const coordApplyBtn = document.createElement('button');
  coordApplyBtn.textContent = 'Apply';
  coordApplyBtn.className = 'btn-mini highlight';
  coordApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';

  const coordResetBtn = document.createElement('button');
  coordResetBtn.textContent = 'Reset';
  coordResetBtn.className = 'btn-mini';
  coordResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';

  const coordButtonsRow = document.createElement('div');
  coordButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';
  coordButtonsRow.appendChild(coordResetBtn);
  coordButtonsRow.appendChild(coordApplyBtn);

  coordEditor.appendChild(coordTitle);
  coordEditor.appendChild(coordInputsRow);
  coordEditor.appendChild(coordButtonsRow);

  //Event handlers
  colorBtn.onclick = (e) => {
      e.stopPropagation();
    coordEditor.style.display = 'none'; // Hide coord editor
    editor.style.display = (editor.style.display === 'none') ? 'block' : 'none';
  };


  coordBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = 'none'; // Hide color editor
    coordEditor.style.display = (coordEditor.style.display === 'none') ? 'block' : 'none';
  };

  // Coordinate event handlers
  coordApplyBtn.onclick = () => {
    const newX = parseFloat(xInput.value);
    const newY = parseFloat(yInput.value);
    const newZ = parseFloat(zInput.value);

    if (!isNaN(newX) && !isNaN(newY) && !isNaN(newZ)) {
      updateAtomCoordinates(atomIndex, [newX, newY, newZ]);
      coordsDisplay.textContent = `(${newX.toFixed(3)}, ${newY.toFixed(3)}, ${newZ.toFixed(3)})`;
      coordEditor.style.display = 'none';
    }
  };

  coordResetBtn.onclick = () => {
    // Reset to original coordinates
    if (originalStructureData && originalStructureData.positions[atomIndex]) {
      const originalCoords = originalStructureData.positions[atomIndex];
      xInput.value = originalCoords[0].toFixed(6);
      yInput.value = originalCoords[1].toFixed(6);
      zInput.value = originalCoords[2].toFixed(6);
      updateAtomCoordinates(atomIndex, [...originalCoords]);
      coordsDisplay.textContent = `(${originalCoords[0].toFixed(3)}, ${originalCoords[1].toFixed(3)}, ${originalCoords[2].toFixed(3)})`;
      coordEditor.style.display = 'none';
    }
  };

  applyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      renderComposition();
      editor.style.display = 'none';
  };

  resetBtn.onclick = () => {
    clearIndividualAtomColor(element, atomIndex);
    const newColor = colorHexToCss(getIndividualAtomColor(element, atomIndex));
    dot.style.background = newColor;
    //colorInput.value = newColor;
   // hexInput.value = newColor;
    updateVisualization();
    // Update the composition to refresh element colors
    renderComposition();
    editor.style.display = 'none';
  };

  row.appendChild(editor);
  row.appendChild(coordEditor);
  return row;
}

// Function to update all measurements when atom positions change
// Helper function to find atom by its original index (atomIndex) in the current atomsGroup
function findAtomByOriginalIndex(originalIndex) {
  if (!atomsGroup || !atomsGroup.children) return null;
  
  for (let i = 0; i < atomsGroup.children.length; i++) {
    const atom = atomsGroup.children[i];
    if (atom.userData && atom.userData.atomIndex === originalIndex) {
      return atom;
    }
  }
  return null;
}

function updateAllMeasurements() {
  if (!atomsGroup || !atomsGroup.children) return;

  measureLines.forEach(measureItem => {
    if (!measureItem.userData) return;

    if (measureItem.userData.type === 'distance') {
      // Update distance measurement
      const atom1Index = measureItem.userData.atom1Index;
      const atom2Index = measureItem.userData.atom2Index;

      const atom1 = findAtomByOriginalIndex(atom1Index);
      const atom2 = findAtomByOriginalIndex(atom2Index);

      if (atom1 && atom2) {
        // Recalculate distance and update display
        const pa = atom1.position.clone();
        const pb = atom2.position.clone();
        const distance = pa.distanceTo(pb);

        // Update the cylinder segments positions
        const direction = new THREE.Vector3().subVectors(pb, pa);
        const dashLength = 0.3;
        const gapLength = 0.2;
        const segmentLength = dashLength + gapLength;
        const numSegments = Math.floor(distance / segmentLength);

        // Clear old segments
        measureItem.clear();

        // Create new segments with updated positions
        for (let i = 0; i < numSegments; i++) {
          const segmentStart = i * segmentLength;
          const segmentGeometry = new THREE.CylinderGeometry(0.08, 0.08, dashLength, 8);
          const segmentMaterial = new THREE.MeshBasicMaterial({ color: 0x0066ff });
          const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

          const segmentCenter = pa.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
          segment.position.copy(segmentCenter);
          segment.lookAt(pb);
          segment.rotateX(Math.PI / 2);

          measureItem.add(segment);
        }
      }
    } else if (measureItem.userData.type === 'angle') {
      // Update angle measurement
      const atom1Index = measureItem.userData.atom1Index;
      const atom2Index = measureItem.userData.atom2Index; // vertex
      const atom3Index = measureItem.userData.atom3Index;
      const lineIndex = measureItem.userData.lineIndex;

      const atom1 = findAtomByOriginalIndex(atom1Index);
      const atom2 = findAtomByOriginalIndex(atom2Index); // vertex
      const atom3 = findAtomByOriginalIndex(atom3Index);

      if (atom1 && atom2 && atom3) {
        // Determine which line this is (vertex to atom1 or vertex to atom3)
        const startPos = atom2.position.clone(); // vertex
        const endPos = lineIndex === 1 ? atom1.position.clone() : atom3.position.clone();

        const distance = startPos.distanceTo(endPos);
        const direction = new THREE.Vector3().subVectors(endPos, startPos);

        const dashLength = 0.25;
        const gapLength = 0.15;
        const segmentLength = dashLength + gapLength;
        const numSegments = Math.floor(distance / segmentLength);

        // Clear old segments
        measureItem.clear();

        // Create new segments with updated positions
        for (let i = 0; i < numSegments; i++) {
          const segmentStart = i * segmentLength;
          const segmentGeometry = new THREE.CylinderGeometry(0.06, 0.06, dashLength, 8);
          const segmentMaterial = new THREE.MeshBasicMaterial({ color: 0xff6600 }); // Orange
          const segment = new THREE.Mesh(segmentGeometry, segmentMaterial);

          const segmentCenter = startPos.clone().add(direction.clone().normalize().multiplyScalar(segmentStart + dashLength/2));
          segment.position.copy(segmentCenter);
          segment.lookAt(endPos);
          segment.rotateX(Math.PI / 2);

          measureItem.add(segment);
        }
      }
    } else if (measureItem.userData.type === 'distanceMarker') {
      // Update distance marker position
      const atomIndex = measureItem.userData.atomIndex;
      const atom = findAtomByOriginalIndex(atomIndex);
      
      if (atom) {
        measureItem.position.copy(atom.position);
      }
    } else if (measureItem.userData.type === 'angleMarker') {
      // Update angle marker position
      const atomIndex = measureItem.userData.atomIndex;
      const atom = findAtomByOriginalIndex(atomIndex);
      
      if (atom) {
        measureItem.position.copy(atom.position);
      }
    }
  });

  // Update measurement labels
  measureLabels.forEach(label => {
    if (label.userData && label.userData.type === 'distance') {
      const atom1Index = label.userData.atom1Index;
      const atom2Index = label.userData.atom2Index;

      const atom1 = findAtomByOriginalIndex(atom1Index);
      const atom2 = findAtomByOriginalIndex(atom2Index);

      if (atom1 && atom2) {
        const pa = atom1.position.clone();
        const pb = atom2.position.clone();
        const distance = pa.distanceTo(pb);
        const midpoint = pa.clone().add(pb).multiplyScalar(0.5);

        // Update label position and text
        label.position.copy(midpoint);
        if (label.element && label.element.firstChild) {
          label.element.firstChild.textContent = distance.toFixed(3) + ' Å';
        }
      }
    } else if (label.userData && label.userData.type === 'angle') {
      // Update angle label
      const atom1Index = label.userData.atom1Index;
      const atom2Index = label.userData.atom2Index; // vertex
      const atom3Index = label.userData.atom3Index;

      const atom1 = findAtomByOriginalIndex(atom1Index);
      const atom2 = findAtomByOriginalIndex(atom2Index); // vertex
      const atom3 = findAtomByOriginalIndex(atom3Index);

      if (atom1 && atom2 && atom3) {
        // Recalculate angle
        const angle = calculateAngle(atom1, atom2, atom3);

        // Update label position to vertex
        label.position.copy(atom2.position);

        // Update label text
        if (label.element && label.element.firstChild) {
          const elements = [atom1.userData.element, atom2.userData.element, atom3.userData.element];
          label.element.firstChild.textContent = `∠${elements[0]}-${elements[1]}-${elements[2]}: ${angle.toFixed(1)}°`;
        }
      }
    }
  });

  // Update measurement marker sizes to match current atom sizes
  updateMeasurementMarkers();
}

// Function to update atom coordinates and refresh visualization
function updateAtomCoordinates(atomIndex, newCoords) {
  if (!structureData || !structureData.positions || atomIndex >= structureData.positions.length) {
    console.error('Invalid atom index or structure data');
    return;
  }

  // Update the coordinates in the structure data
  structureData.positions[atomIndex] = [...newCoords];

  // Refresh the visualization to show the updated position
  updateVisualization();

  console.log(`Updated atom ${atomIndex} coordinates to: ${newCoords.join(', ')}`);
}


function updateAtoms(opacity=1.0) {
  disposeGroup(atomsGroup);
  atomsGroup = new THREE.Group();

  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const atomMesh = createAtomMesh(wrapped.elements[i], wrappedCart[i], originalIndex,opacity);
    atomMesh.userData.sourceIndex = originalIndex;
    atomsGroup.add(atomMesh);
  }
  app.scene.add(atomsGroup);
}

function addSecondStructure(opacity=1.0) {

  function updateAtomCoordinates(atomIndex, newCoords, _structureData) {
    if (!_structureData || !_structureData.positions || atomIndex >= _structureData.positions.length) {
      console.error('Invalid atom index or structure data');
      return;
    }
    // Update the coordinates in the structure data
    _structureData.positions[atomIndex] = [...newCoords];
    console.log(`Updated atom ${atomIndex} coordinates to: ${newCoords.join(', ')}`);
    return _structureData
  }

  disposeGroup(atomsGroup2);

  if (!showSecond) return;
    atomsGroup2 = new THREE.Group();
  
  const _structureData = structureData2
  console.log("added second")

  const wrapped = periodicWrapped(_structureData.positions, _structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, _structureData.lattice);
  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const atomMesh = createAtomMesh(wrapped.elements[i], wrappedCart[i], originalIndex,opacity);
    atomMesh.userData.sourceIndex = originalIndex;
    atomsGroup2.add(atomMesh);
  }


  if (showComparisonInfo===true) {
       const latticeCompPanel =  createLatticeComparisonPanel( structureData.lattice, _structureData.lattice)
       if (latticeCompPanel){
        document.body.appendChild(latticeCompPanel);
        latticeCompPanel.style.display = "block";
        console.log("Added latticeCompPanel") 
        }
        else{
          console.log("latticeCompPanel not defined")
        }
  }
  app.scene.add(atomsGroup2);
}


function NewupdatePolyhedra() {
  const DEBUG = true;

  if (polyhedraGroup) disposeGroup(polyhedraGroup);
  polyhedraGroup = new THREE.Group();
  if (!general.showPolyhedra) { app.scene.add(polyhedraGroup); return; }

  // --- Style ---
  const FACE_OPACITY = 0.7;
  const EDGE_OPACITY = 1.0
  const FACE_FALLBACK_COLOR = 0x00aaff;
  const EDGE_COLOR = 0x006c99;
  const EDGE_ANGLE = 18;
  const DOUBLE_SIDE = true;
  const DEPTH_WRITE = false;
  const POLY_OFFSET = true;
  const POLY_OFFSET_FACTOR = 1;
  const POLY_OFFSET_UNITS = 1;

  // --- Behavior ---
  const CENTERED_CNs_DESC = [12,10,8,7,6,5,4];
  const ALLOW_CAGES = true;
  const CAGE_TARGET_NS_DESC = [20,12,10,8,6,4];
  const CAGE_BFS_DEPTH = 5;
  const MAX_EDGE_SPREAD = 1.30;
  const MIN_THICKNESS_RATIO = 0.08;

  const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined') ? ConvexGeometry : (THREE.ConvexGeometry || null);
  if (!ConvexGeomCtor) { console.error('[updatePolyhedra] ConvexGeometry missing'); scene.add(polyhedraGroup); return; }

  // --- Helpers ---
  function thicknessRatio(points) {
    const mean = points.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/points.length);
    const rel = points.map(p=>p.clone().sub(mean));
    let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
    for(const v of rel){ const x=v.x,y=v.y,z=v.z; xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z; }
    const n=Math.max(1,rel.length); xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
    const m00=xx,m01=xy,m02=xz,m11=yy,m12=yz,m22=zz;
    const p1=m01*m01+m02*m02+m12*m12;
    let eMin=0,eMax=0;
    if(p1<=1e-18){ const e=[m00,m11,m22].sort((a,b)=>a-b); eMin=e[0]; eMax=e[2]; }
    else {
      const q=(m00+m11+m22)/3;
      let p2=(m00-q)*(m00-q)+(m11-q)*(m11-q)+(m22-q)*(m22-q)+2*p1;
      const p=Math.sqrt(p2/6);
      const b00=(m00-q)/p,b01=m01/p,b02=m02/p,b10=m01/p,b11=(m11-q)/p,b12=m12/p,b20=m02/p,b21=m12/p,b22=(m22-q)/p;
      const detB = b00*(b11*b22-b12*b21)-b01*(b10*b22-b12*b20)+b02*(b10*b21-b11*b20);
      const r = Math.max(-1,Math.min(1,detB/2));
      const phi = Math.acos(r)/3;
      const eig1 = q+2*p*Math.cos(phi);
      const eig3 = q+2*p*Math.cos(phi+2*Math.PI/3);
      const eig2 = 3*q-eig1-eig3;
      const ev=[eig1,eig2,eig3].sort((a,b)=>a-b);
      eMin=ev[0]; eMax=ev[2];
    }
    return eMin/Math.max(1e-12,eMax);
  }

  function edgeSpreadOK(geom) {
    if(!geom) return false;
    const egeom=new THREE.EdgesGeometry(geom,EDGE_ANGLE);
    const pos=egeom.getAttribute('position');
    let minL=Infinity,maxL=0;
    for(let i=0;i<pos.count;i+=2){
      const a=new THREE.Vector3().fromBufferAttribute(pos,i);
      const b=new THREE.Vector3().fromBufferAttribute(pos,i+1);
      const L=a.distanceTo(b);
      minL=Math.min(minL,L); maxL=Math.max(maxL,L);
    }
    egeom.dispose();
    if(!isFinite(minL)||minL<=1e-9) return false;
    return maxL/minL<=MAX_EDGE_SPREAD;
  }

  function pickSpreadSubset(points,N){
    if(points.length<N) return null;
    let aIdx=0,bIdx=1,best=-1;
    for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++){ const d=points[i].distanceToSquared(points[j]); if(d>best){best=d;aIdx=i;bIdx=j;} }
    const chosenIdx=[aIdx,bIdx];
    while(chosenIdx.length<N){
      let bestIdx=-1,bestScore=-Infinity;
      for(let i=0;i<points.length;i++){ if(chosenIdx.includes(i)) continue; let minD=Infinity; for(const j of chosenIdx){ const d=points[i].distanceToSquared(points[j]); if(d<minD) minD=minD; } if(minD>bestScore){ bestScore=minD; bestIdx=i; } }
      if(bestIdx<0) break;
      chosenIdx.push(bestIdx);
    }
    if(chosenIdx.length<N) return null;
    return chosenIdx.map(k=>points[k]);
  }

  function pointInsideConvexGeometry(p,geom,eps=1e-6){
    if(!geom) return false;
    const pos=geom.getAttribute('position');
    const idx=geom.getIndex();
    if(!pos) return false;
    const pc=new THREE.Vector3();
    for(let i=0;i<pos.count;i++) pc.add(new THREE.Vector3().fromBufferAttribute(pos,i));
    pc.multiplyScalar(1/pos.count);
    const triCount=idx?idx.count/3:pos.count/3;
    for(let t=0;t<triCount;t++){
      const i0=idx?idx.getX(3*t):3*t,i1=idx?idx.getX(3*t+1):3*t+1,i2=idx?idx.getX(3*t+2):3*t+2;
      const a=new THREE.Vector3().fromBufferAttribute(pos,i0),b=new THREE.Vector3().fromBufferAttribute(pos,i1),c=new THREE.Vector3().fromBufferAttribute(pos,i2);
      const n=b.clone().sub(a).cross(c.clone().sub(a));
      if(n.lengthSq()<1e-18) continue;
      const outward=Math.sign(n.dot(a.clone().sub(pc)))||1;
      n.multiplyScalar(outward);
      if(n.dot(new THREE.Vector3().subVectors(p,a))>eps) return false;
    }
    return true;
  }

  // --- Build wrapped positions, adjacency, per-center images ---
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac,structureData.lattice);
  const Wpos = wrappedCart.map(p=>new THREE.Vector3(p[0],p[1],p[2]));
  const Welem = wrapped.elements;
  const Wsrc = wrapped.srcIndex;
  const L = structureData.lattice;
  const a = new THREE.Vector3(...L[0]), b=new THREE.Vector3(...L[1]), c=new THREE.Vector3(...L[2]);

  const shifts=[];
  for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(let dz=-1;dz<=1;dz++) shifts.push([dx,dy,dz]);

  const adjacency = new Map();
  function addBond(u,v){ if(!adjacency.has(u)) adjacency.set(u,new Set()); if(!adjacency.has(v)) adjacency.set(v,new Set()); adjacency.get(u).add(v); adjacency.get(v).add(u); }

  const perCenterImages = new Map();
  for(let i=0;i<Wpos.length;i++){
    const pi=Wpos[i],ei=Welem[i],srcI=Wsrc[i];
    const bonded=[];
    for(let j=0;j<Wpos.length;j++){ if(i===j) continue; const pj=Wpos[j],ej=Welem[j],srcJ=Wsrc[j]; const cutoff=getBondCutoff(ei,ej); if(cutoff<=1e-3) continue;
      for(const [dx,dy,dz] of shifts){ const shiftVec=new THREE.Vector3().addScaledVector(a,dx).addScaledVector(b,dy).addScaledVector(c,dz); const q=pj.clone().add(shiftVec); const d=q.distanceTo(pi); if(d>cutoff||d<1e-4) continue; addBond(srcI,srcJ); bonded.push({pos:q,srcJ,shift:[dx,dy,dz],d,wi:j}); } 
    } 
    perCenterImages.set(i,bonded);
  }

  const wrappedIdxBySrc = new Map();
  for(let wi=0;wi<Wsrc.length;wi++){ const s=Wsrc[wi]; if(!wrappedIdxBySrc.has(s)) wrappedIdxBySrc.set(s,[]); wrappedIdxBySrc.get(s).push(wi); }

  if(DEBUG) console.info('[poly DEBUG] Wpos.length=',Wpos.length,'uniqueSrcs=',new Set(Wsrc).size,'adjacencyEntries=',adjacency.size);

  // --- Candidates generation (centered and cage) ---
  const candidates=[];

  // Centered polyhedra
  for(let i=0;i<Wpos.length;i++){
    const imgs=perCenterImages.get(i)||[];
    if(imgs.length<3) continue;
    for(const N of CENTERED_CNs_DESC){ if(imgs.length<N) continue;
      const nearest=imgs.slice().sort((u,v)=>u.d-v.d).slice(0,N);
      const posList=nearest.map(o=>o.pos);
      let geom;
      try{ geom=new ConvexGeomCtor(posList); } catch{ continue; }
      if(!edgeSpreadOK(geom)||thicknessRatio(posList)<MIN_THICKNESS_RATIO){ geom.dispose(); continue; }
      candidates.push({kind:'centered',centerWrappedIdx:i,centerPos:Wpos[i],colorElem:Welem[i],posList,posListSrcs:nearest.map(o=>o.srcJ),geom});
      break;
    }
  }

  // Cage polyhedra
  if(ALLOW_CAGES){
    for(let seedWi=0;seedWi<Wpos.length;seedWi++){
      const seedSrc=Wsrc[seedWi]; const seedElem=Welem[seedWi];
      let pool=[{wi:seedWi,pos:Wpos[seedWi],src:seedSrc}];
      // Simple BFS limited to CAGE_BFS_DEPTH
      const visited=new Set([seedSrc]); let q=[seedSrc]; let depth=0;
      while(q.length>0 && depth<CAGE_BFS_DEPTH){ const nextQ=[]; for(const u of q){ const nb=adjacency.get(u)||[]; for(const v of nb){ if(!visited.has(v)){ visited.add(v); const idxs=wrappedIdxBySrc.get(v)||[]; for(const wi of idxs) pool.push({wi,pos:Wpos[wi],src:v}); nextQ.push(v); } } } q=nextQ; depth++; }
      if(pool.length<4) continue;
      const centroid=pool.reduce((acc,o)=>acc.add(o.pos),new THREE.Vector3()).multiplyScalar(1/pool.length);
      const dists=pool.map(o=>o.pos.distanceTo(centroid)).sort((a,b)=>a-b);
      for(const N of CAGE_TARGET_NS_DESC){
        const band=pool.slice(0,N);
        const posList=band.map(o=>o.pos);
        let geom;
        try{ geom=new ConvexGeomCtor(posList); } catch{ continue; }
        if(!edgeSpreadOK(geom)||thicknessRatio(posList)<MIN_THICKNESS_RATIO){ geom.dispose(); continue; }
        candidates.push({kind:'cage',posList,colorElem:seedElem,posListSrcs:band.map(o=>o.src),geom});
        break;
      }
    }
  }

  // --- Sorting candidates: larger N first, centered over cages ---
  candidates.sort((A,B)=>{ if(A.posList.length!==B.posList.length) return B.posList.length-A.posList.length; if(A.kind!==B.kind) return (A.kind==='centered'? -1:1); return 0; });

  const acceptedCenterWrappedKeys=new Set();
  const acceptedHulls=[];

  const sharedEdgeMat=new THREE.LineBasicMaterial({color:EDGE_COLOR,transparent:true,opacity:EDGE_OPACITY});

  for(const cand of candidates){
    // Avoid nesting
    let inside=false;
    for(const g of acceptedHulls){ if(pointInsideConvexGeometry(cand.posList[0],g)) inside=true; }
    if(inside){ if(cand.geom && cand.geom.dispose) cand.geom.dispose(); continue; }

    const faceColor=(typeof getElementColor==='function')? getElementColor(cand.colorElem): FACE_FALLBACK_COLOR;
    const mat=new THREE.MeshStandardMaterial({color:faceColor,transparent:true,opacity:FACE_OPACITY,metalness:0,roughness:1,side:DOUBLE_SIDE?THREE.DoubleSide:THREE.FrontSide,depthWrite:DEPTH_WRITE,polygonOffset:POLY_OFFSET,polygonOffsetFactor:POLY_OFFSET?POLY_OFFSET_FACTOR:0,polygonOffsetUnits:POLY_OFFSET?POLY_OFFSET_UNITS:0});

    const mesh=new THREE.Mesh(cand.geom,mat);
    mesh.userData={type:'polyhedron',mode:cand.kind,cn:cand.posList.length,vertexSrcs:cand.posListSrcs};
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(cand.geom,EDGE_ANGLE),sharedEdgeMat));
    polyhedraGroup.add(mesh);

    acceptedHulls.push(cand.geom);
    if(cand.kind==='centered'&&typeof cand.centerWrappedIdx==='number') acceptedCenterWrappedKeys.add(`wi:${cand.centerWrappedIdx}`);
  }

  app.scene.add(polyhedraGroup);
  if(DEBUG) console.info('[poly DEBUG] total candidates rendered:',polyhedraGroup.children.length);
}


//----------------------------------/
//-----Below versio works but not with B12 cages ----------------------/
//----------------------------------/

// --- Utility: robust median (used by the C12 "band-hull" path and a few sanity checks) ---
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  return (n % 2) ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}


// Keep this group at module scope

function updatePolyhedra() {
  // ---------- TOGGLE ----------
  if (polyhedraGroup) disposeGroup(polyhedraGroup);
  polyhedraGroup = new THREE.Group();
  if (!general.showPolyhedra) {
    app.scene.add(polyhedraGroup);
    return; // IMPORTANT: nothing drawn when hidden
  }

  // ---------- STYLE ----------
  const FACE_OPACITY = 0.80;
  const EDGE_OPACITY = Math.min(1, FACE_OPACITY + 0.35);
  const FACE_FALLBACK_COLOR = 0x00aaff;
  const EDGE_COLOR = 0x006c99;
  const EDGE_ANGLE = 18;
  const DOUBLE_SIDE = true;
  const DEPTH_WRITE = false;
  const POLY_OFFSET = true;
  const POLY_OFFSET_FACTOR = 1;
  const POLY_OFFSET_UNITS = 1;

  // ---------- BEHAVIOR ----------
  // Centered CNs (largest-first prioritization is achieved later via candidate sort)
  const CENTERED_CNs_DESC = [12, 10, 8, 7, 6, 5, 4];

  // Cages (uncentered): **includes N = 20 dodecahedra**
  const ALLOW_CAGES = true;
  const CAGE_TARGET_NS_DESC = [20, 12, 10, 8, 6, 4]; // 20 first for dodecahedron cages
  const CAGE_BFS_DEPTH = 5; // a bit deeper to ensure we hit full N=20 shells

  // Mild distortion tolerance (applies to both centered and cages)
  const MAX_EDGE_SPREAD = 1.30;      // max(edge)/min(edge) ≤ 1.30  (~30%)
  const MIN_THICKNESS_RATIO = 0.08;  // very lenient anti-flatness (e_min / e_max)

  // Minimal induced degree per cage size (tune as needed)
function minVertexDegreeForCageSize(N) {
  if (N === 12) return 5; // B12 icosahedral cage in boron carbide
  if (N === 20) return 3; // 20-vertex dodecahedron (degree 3)
  if (N === 10) return 3;
  if (N === 8)  return 3;
  if (N === 6)  return 3;
  if (N === 4)  return 2;
  return 3;
}

  // ---------- SAFETY ----------
  const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined')
    ? ConvexGeometry
    : (THREE && THREE.ConvexGeometry ? THREE.ConvexGeometry : null);
  if (!ConvexGeomCtor) {
    console.error('[updatePolyhedra] ConvexGeometry missing. Load examples/jsm/geometries/ConvexGeometry.js');
    app.scene.add(polyhedraGroup);
    return;
  }

  // ---------- Helpers ----------
  function thicknessRatio(points) {
    const mean = points.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/points.length);
    const rel  = points.map(p=>p.clone().sub(mean));
    let xx=0,xy=0,xz=0, yy=0,yz=0, zz=0;
    for (const v of rel) { const x=v.x,y=v.y,z=v.z; xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z; }
    const n = Math.max(1, rel.length);
    xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
    const m00=xx, m01=xy, m02=xz, m11=yy, m12=yz, m22=zz;
    const p1 = m01*m01 + m02*m02 + m12*m12;
    let eMin=0,eMax=0;
    if (p1 <= 1e-18) { const e=[m00,m11,m22].sort((a,b)=>a-b); eMin=e[0]; eMax=e[2]; }
    else {
      const q=(m00+m11+m22)/3;
      let p2=(m00-q)*(m00-q)+(m11-q)*(m11-q)+(m22-q)*(m22-q)+2*p1;
      const p=Math.sqrt(p2/6);
      const b00=(m00-q)/p, b01=m01/p,   b02=m02/p;
      const b10=m01/p,   b11=(m11-q)/p, b12=m12/p;
      const b20=m02/p,   b21=m12/p,     b22=(m22-q)/p;
      const detB = b00*(b11*b22-b12*b21)-b01*(b10*b22-b12*b20)+b02*(b10*b21-b11*b20);
      const r = Math.max(-1, Math.min(1, detB/2));
      const phi = Math.acos(r)/3;
      const eig1 = q + 2*p*Math.cos(phi);
      const eig3 = q + 2*p*Math.cos(phi + 2*Math.PI/3);
      const eig2 = 3*q - eig1 - eig3;
      const ev=[eig1,eig2,eig3].sort((a,b)=>a-b);
      eMin=ev[0]; eMax=ev[2];
    }
    return eMin / Math.max(1e-12, eMax);
  }

  function edgeSpreadOK(geom) {
    const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
    const pos = egeom.getAttribute('position');
    let minL = Infinity, maxL = 0;
    for (let i=0; i<pos.count; i+=2) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i+1);
      const L = a.distanceTo(b);
      if (L < minL) minL = L;
      if (L > maxL) maxL = L;
    }
    egeom.dispose();
    if (!isFinite(minL) || minL <= 1e-9) return false;
    return (maxL / minL) <= MAX_EDGE_SPREAD;
  }

  function pointInsideConvexGeometry(p, geom, eps=1e-6) {
    const pos = geom.getAttribute('position');
    const idx = geom.getIndex();
    if (!pos) return false;
    const pc = new THREE.Vector3();
    for (let i=0;i<pos.count;i++) pc.add(new THREE.Vector3().fromBufferAttribute(pos, i));
    pc.multiplyScalar(1/pos.count);
    const triCount = idx ? idx.count/3 : pos.count/3;
    for (let t=0; t<triCount; t++) {
      const i0 = idx ? idx.getX(3*t+0) : 3*t+0;
      const i1 = idx ? idx.getX(3*t+1) : 3*t+1;
      const i2 = idx ? idx.getX(3*t+2) : 3*t+2;
      const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i1);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i2);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-18) continue;
      const outward = Math.sign(n.dot(a.clone().sub(pc))) || 1;
      n.multiplyScalar(outward);
      const s = n.dot(new THREE.Vector3().subVectors(p, a));
      if (s > eps) return false;
    }
    return true;
  }

  function bfs(adjacency, srcStart, depthMax) {
    const visited = new Map(); // src -> depth
    const q = [[srcStart, 0]];
    visited.set(srcStart, 0);
    while (q.length) {
      const [u,d] = q.shift();
      if (d === depthMax) continue;
      for (const v of (adjacency.get(u) || [])) {
        if (!visited.has(v)) { visited.set(v, d+1); q.push([v,d+1]); }
      }
    }
    return visited;
  }

  // Spherical farthest-point sampling: pick N vertices well spread (angle-based)
  function pickSpreadSubset(points, N) {
    if (points.length < N) return null;
    let aIdx = 0, bIdx = 1, best = -1;
    for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
      const d = points[i].distanceToSquared(points[j]);
      if (d > best) { best = d; aIdx=i; bIdx=j; }
    }
    const chosenIdx = [aIdx, bIdx];
    while (chosenIdx.length < N) {
      let bestIdx=-1, bestScore=-Infinity;
      for (let i=0;i<points.length;i++) {
        if (chosenIdx.includes(i)) continue;
        let minD = Infinity;
        for (const j of chosenIdx) {
          const d = points[i].distanceToSquared(points[j]);
          if (d < minD) minD = d;
        }
        if (minD > bestScore) { bestScore = minD; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      chosenIdx.push(bestIdx);
    }
    if (chosenIdx.length < N) return null;
    return chosenIdx.map(k => points[k]);
  }

  function quantile(sortedArr, q) {
    if (!sortedArr.length) return 0;
    const i = (sortedArr.length - 1) * q;
    const i0 = Math.floor(i), i1 = Math.min(sortedArr.length - 1, i0 + 1);
    const t = i - i0;
    return sortedArr[i0] * (1 - t) + sortedArr[i1] * t;
  }


  function inducedDegreeOK(selSrcs, minDeg) {
    const set = new Set(selSrcs);
    for (const u of selSrcs) {
      const nb = adjacency.get(u) || new Set();
      let deg = 0;
      for (const v of nb) if (set.has(v) && v !== u) deg++;
      if (deg < minDeg) return false;
    }
    return true;
  }

  // ---------- Build bond graph + per-center bonded images (with shifts) ----------
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  const Wpos  = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const Welem = wrapped.elements;
  const Wsrc  = wrapped.srcIndex;

  const L = structureData.lattice;
  const a = new THREE.Vector3(L[0][0], L[0][1], L[0][2]);
  const b = new THREE.Vector3(L[1][0], L[1][1], L[1][2]);
  const c = new THREE.Vector3(L[2][0], L[2][1], L[2][2]);

  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || { dummy: 0.0 }));
  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
  const shifts = [];
  for (let dx=-ax; dx<=ax; dx++)
    for (let dy=-by; dy<=by; dy++)
      for (let dz=-cz; dz<=cz; dz++)
        shifts.push([dx,dy,dz]);

  /** @type {Map<number, Set<number>>} */
  const adjacency = new Map();
  function addBond(u, v) {
    if (!adjacency.has(u)) adjacency.set(u, new Set());
    if (!adjacency.has(v)) adjacency.set(v, new Set());
    adjacency.get(u).add(v); adjacency.get(v).add(u);
  }

  /** @type {Map<number, Array<{pos:THREE.Vector3, srcJ:number, shift:[number,number,number], d:number}>>} */
  const perCenterImages = new Map();
  for (let i=0; i<Wpos.length; i++) {
    const pi = Wpos[i], ei = Welem[i], srcI = Wsrc[i];
    const bonded = [];
    for (let j=0; j<Wpos.length; j++) {
      if (j === i) continue;
      const pj = Wpos[j], ej = Welem[j], srcJ = Wsrc[j];
      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 1e-3) continue;
      for (const [dx,dy,dz] of shifts) {
        const shiftVec = new THREE.Vector3().addScaledVector(a,dx).addScaledVector(b,dy).addScaledVector(c,dz);
        const q = pj.clone().add(shiftVec);
        const d = q.distanceTo(pi);
        if (d > cutoff || d < 1e-4) continue;
        addBond(srcI, srcJ);
        bonded.push({ pos: q, srcJ, shift:[dx,dy,dz], d });
      }
    }
    perCenterImages.set(i, bonded);
  }

  // Map src -> list of wrapped indices (to identify cage vertex images)
  const wrappedIdxBySrc = new Map();
  for (let wi=0; wi<Wsrc.length; wi++) {
    const s = Wsrc[wi];
    if (!wrappedIdxBySrc.has(s)) wrappedIdxBySrc.set(s, []);
    wrappedIdxBySrc.get(s).push(wi);
  }

  // ---------- Build candidates ----------
  /** @type {Array<{
   *   kind: 'centered'|'cage',
   *   colorElem: string,
   *   centerWrappedIdx?: number,
   *   centerSrc?: number,
   *   centerPos?: THREE.Vector3,
   *   posList: THREE.Vector3[],
   *   vertexSrcList: number[],
   *   vertexWrappedIdxList?: number[],              // cages
   *   vertexImageList?: Array<{src:number, shift:[number,number,number]}>, // centered
   *   refPoint: THREE.Vector3,
   * }>} */
  const candidates = [];

  // ---- Centered (one per center; try largest CNs first) ----
  for (let i=0; i<Wpos.length; i++) {
    const centerPos = Wpos[i], centerElem = Welem[i], centerSrc = Wsrc[i];
    const imgs = perCenterImages.get(i) || [];
    if (imgs.length < 3) continue;

    for (const N of CENTERED_CNs_DESC) {
      if (imgs.length < N) continue;

      const nearest = imgs.slice().sort((u,v)=>u.d - v.d).slice(0, N);
      const allPos = imgs.map(o=>o.pos);
      const spreadPos = (imgs.length > N) ? (pickSpreadSubset(allPos, N) || []) : nearest.map(o=>o.pos);

      const variants = [];
      variants.push(nearest);
      if (spreadPos.length === N) {
        // map spread positions back to entries
        const spreadEntries = spreadPos.map(p => {
          let best=null, bestD=Infinity;
          for (const o of imgs) {
            const dd = p.distanceToSquared(o.pos);
            if (dd < bestD) { bestD = dd; best = o; }
          }
          return best;
        });
        const nearestSet = new Set(nearest.map(o=>o.pos));
        if (spreadEntries.some(o => !nearestSet.has(o.pos))) variants.push(spreadEntries);
      }

      let acceptedVariant = null;
      for (const variant of variants) {
        const posList = variant.map(o=>o.pos);
        let geom;
        try { geom = new ConvexGeomCtor(posList); } catch { continue; }
        const okSpread = edgeSpreadOK(geom);
        const okThick  = thicknessRatio(posList) >= MIN_THICKNESS_RATIO;
        if (okSpread && okThick) { acceptedVariant = { posList, variant }; geom.dispose(); break; }
        geom.dispose();
      }

      if (acceptedVariant) {
        candidates.push({
          kind: 'centered',
          colorElem: centerElem,
          centerWrappedIdx: i,
          centerSrc,
          centerPos,
          posList: acceptedVariant.posList,
          vertexSrcList: acceptedVariant.variant.map(o=>o.srcJ),
          vertexImageList: acceptedVariant.variant.map(o=>({ src:o.srcJ, shift:o.shift })),
          refPoint: centerPos.clone(),
        });
        break; // only one centered candidate per center (largest-first)
      }
    }
  }

  // ---- Cages (uncentered): includes N=20 dodecahedra; largest-first ----
  if (ALLOW_CAGES) {
    function buildPoolForSeed(seedSrc, depthMax) {
      const reach = bfs(adjacency, seedSrc, depthMax);
      const pool = [];
      for (const s of reach.keys()) {
        const idxs = wrappedIdxBySrc.get(s) || [];
        for (const wi of idxs) pool.push({ wi, pos: Wpos[wi], src: Wsrc[wi] });
      }
      return pool;
    }

    for (let seedWi=0; seedWi<Wpos.length; seedWi++) {
      const seedSrc = Wsrc[seedWi];
      const seedElem = Welem[seedWi];

      // expand pool up to depth until we have plenty of candidates for N=20
      let depth = 3;
      let pool = buildPoolForSeed(seedSrc, depth);
      while (pool.length < 40 && depth < CAGE_BFS_DEPTH) { // heuristic ≥2×N
        depth++;
        pool = buildPoolForSeed(seedSrc, depth);
      }
      if (pool.length < 4) continue;

      // reference: centroid of pool (better shell center)
      const centroid = pool.reduce((acc,o)=>acc.add(o.pos), new THREE.Vector3()).multiplyScalar(1/pool.length);
      const dists = pool.map(o => o.pos.distanceTo(centroid)).sort((a,b)=>a-b);
      const q30 = quantile(dists, 0.30), q70 = quantile(dists, 0.70);
      const q25 = quantile(dists, 0.25), q75 = quantile(dists, 0.75);
      const q20 = quantile(dists, 0.20), q80 = quantile(dists, 0.80);

      for (const N of CAGE_TARGET_NS_DESC) {
        // band widths (narrow → wide)
        const bands = [
          [q30, q70],
          [q25, q75],
          [q20, q80],
        ];
        let builtThisN = false;

        for (const [lo, hi] of bands) {
          const band = pool.filter(o => {
            const r = o.pos.distanceTo(centroid);
            return r >= lo && r <= hi;
          });
          if (band.length < N) continue;

          // Hull of band → extract hull vertices → possibly reduce to N by spread
          let geomBand;
          try { geomBand = new ConvexGeomCtor(band.map(o=>o.pos)); } catch { geomBand = null; }
          if (!geomBand) continue;
          geomBand.computeVertexNormals();

          const posAttr = geomBand.getAttribute('position');
          const hullPts = [];
          for (let k=0;k<posAttr.count;k++) hullPts.push(new THREE.Vector3().fromBufferAttribute(posAttr, k));

          // Unique nearest mapping back to band entries
          const chosenMap = new Map(); // band index -> band entry
          for (const hp of hullPts) {
            let bi=-1, best=Infinity;
            for (let j=0; j<band.length; j++) {
              const dd = hp.distanceToSquared(band[j].pos);
              if (dd < best) { best=dd; bi=j; }
            }
            if (bi>=0 && !chosenMap.has(bi)) chosenMap.set(bi, band[bi]);
          }
          let verts = Array.from(chosenMap.values()); // {wi,pos,src}[]

          if (verts.length !== N) {
            if (verts.length < N) { geomBand.dispose(); continue; }
            // reduce to N by spread
            const subset = pickSpreadSubset(verts.map(o=>o.pos), N);
            if (!subset) { geomBand.dispose(); continue; }
            verts = subset.map(p => {
              let best=null, bestD=Infinity;
              for (const o of band) {
                const dd = p.distanceToSquared(o.pos);
                if (dd < bestD) { bestD = dd; best = o; }
              }
              return best;
            });
          }

          // Build candidate hull on selected N verts
          const posList = verts.map(o=>o.pos);
          let geom;
          try { geom = new ConvexGeomCtor(posList); } catch { geom = null; }
          if (!geom) { geomBand.dispose(); continue; }
 
          geom.computeVertexNormals();

          // ---- CAGE acceptance: induced-degree rule instead of hull-edges-as-bonds ----

          // 1) Mild shape sanity (keep your existing checks)
          const okSpread = edgeSpreadOK(geom);                   // max(edge)/min(edge) ≤ 1.30
          const okThick  = thicknessRatio(posList) >= 0.08;      // very lenient anti-flatness
          if (!(okSpread && okThick)) { geom.dispose(); continue; }

          // 2) Induced-degree in the selected vertex set (B12 needs 5)
          const minDeg = minVertexDegreeForCageSize(posList.length);
          if (!inducedDegreeOK(selSrcs, minDeg)) { 
            geom.dispose(); continue; 
          }
          // 3) Accept cage candidate (push into candidates with posList/selSrcs/refPoint as you already do)


          // Accept candidate cage
          candidates.push({
            kind: 'cage',
            colorElem: seedElem,
            posList,
            vertexSrcList: selSrcs,
            vertexWrappedIdxList: verts.map(o=>o.wi),
            refPoint: posList.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/posList.length),
          });

          geom.dispose();
          geomBand.dispose();
          builtThisN = true;
          break; // move to next N (largest-first, one per band here)
        } // bands
        // (optionally keep building more cages per seed/N; current strategy keeps it moderate)
        if (builtThisN) continue;
      } // Ns
    } // seeds
  } // cages enabled

  // ---------- Global constraints & render ----------
  // Image-level center-not-corner:
  //  - The exact wrapped center image cannot appear as a vertex image elsewhere.
  const acceptedCenterWrappedKeys = new Set(); // 'wi:<wrappedIndex>'
  const acceptedHulls = []; // keep geometries for inside tests (do not dispose)

  // Priority: larger N first; then centered over cages

  candidates.sort((A, B) => {
    const nA = A.posList.length, nB = B.posList.length;
    if (nA !== nB) return nB - nA; // larger first

    // For large shells, prefer cages (so they aren't blocked by centered selections)
    if (nA >= 12 && A.kind !== B.kind) {
      return (A.kind === 'cage' ? -1 : 1);
    }

    // Otherwise your previous preference (centered first)
    if (A.kind !== B.kind) return (A.kind === 'centered' ? -1 : 1);

    return 0;
  });


  const sharedEdgeMat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR, transparent: true, opacity: EDGE_OPACITY,
  });

  for (const cand of candidates) {
    // Image-level center-not-corner
    if (cand.kind === 'cage' && cand.vertexWrappedIdxList) {
      // A cage must not use an already-accepted center image as a vertex
      const conflict = cand.vertexWrappedIdxList.some(wi => acceptedCenterWrappedKeys.has(`wi:${wi}`));
      if (conflict) continue;
    }

    // Build final hull
    let geom;
    try { geom = new ConvexGeomCtor(cand.posList); } catch { continue; }
    geom.computeVertexNormals();

    // No nesting: reference point not inside any accepted hull
    let inside = false;
    for (const g of acceptedHulls) {
      if (pointInsideConvexGeometry(cand.refPoint, g, 1e-6)) { inside = true; break; }
    }
    if (inside) { geom.dispose(); continue; }

    // Render
    const faceColor = (typeof getElementColor === 'function') ? getElementColor(cand.colorElem) : FACE_FALLBACK_COLOR;
    const mat = new THREE.MeshStandardMaterial({
      color: faceColor,
      transparent: true,
      opacity: FACE_OPACITY,
      metalness: 0.0,
      roughness: 1.0,
      side: DOUBLE_SIDE ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: DEPTH_WRITE,
      polygonOffset: POLY_OFFSET,
      polygonOffsetFactor: POLY_OFFSET ? POLY_OFFSET_FACTOR : 0,
      polygonOffsetUnits: POLY_OFFSET ? POLY_OFFSET_UNITS : 0,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = {
      type: 'polyhedron',
      mode: cand.kind,
      cn: cand.posList.length,
      centerWrappedIdx: (cand.kind === 'centered') ? cand.centerWrappedIdx : undefined,
      centerSrcIndex:   (cand.kind === 'centered') ? cand.centerSrc : undefined,
      centerElement:    (cand.kind === 'centered') ? cand.colorElem : undefined,
      vertexSrcs: cand.vertexSrcList,
    };

    const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
    mesh.add(new THREE.LineSegments(egeom, sharedEdgeMat));
    polyhedraGroup.add(mesh);

    // Update constraint sets
    if (cand.kind === 'centered' && typeof cand.centerWrappedIdx === 'number') {
      acceptedCenterWrappedKeys.add(`wi:${cand.centerWrappedIdx}`);
    }
    acceptedHulls.push(geom); // keep for future inside tests
  }

  app.scene.add(polyhedraGroup);
}

function updateBonds() {
  disposeGroup(bondsGroup);
  bondsGroup = new THREE.Group();

  if (!general.showBonds) return;

  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);

  // 1) Bonds entirely inside the unit cell among the wrapped atoms
  for (let i = 0; i < wrappedCart.length; i++) {
    for (let j = i + 1; j < wrappedCart.length; j++) {
      const ei = wrapped.elements[i];
      const atomIndex_i = wrapped.srcIndex[i]; 
      const ej = wrapped.elements[j];
      const atomIndex_j = wrapped.srcIndex[j];
      const bond = createBond(wrappedCart[i], wrappedCart[j], ei, ej, atomIndex_i, atomIndex_j);
      if (bond) bondsGroup.add(bond);
    }
  }

  // 2) Neighbor bonds to atoms outside the cell (ghosts)
  const lattice = structureData.lattice;
  const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
  const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
  const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);

  const primCarts = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const primElems = wrapped.elements;

  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {dummy:0.0}));


  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
  const shifts = [];
  for (let dx = -ax; dx <= ax; dx++)
    for (let dy = -by; dy <= by; dy++)
      for (let dz = -cz; dz <= cz; dz++)
        shifts.push([dx, dy, dz]);

  const ghostAdded = new Map();
  const bondDedupe = new Set();

  for (let i = 0; i < primCarts.length; i++) {
    const pi = primCarts[i];
    const ei = primElems[i];
    const atomIndex_i = wrapped.srcIndex[i]; // here is something off!!! 
    for (let j = 0; j < primCarts.length; j++) {
      if (j === i) continue;
      const pj = primCarts[j];
      const ej = primElems[j];
      const atomIndex_j = wrapped.srcIndex[j];

      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 0.01) continue;

      for (const [dx, dy, dz] of shifts) {
        const shiftVec = new THREE.Vector3()
          .addScaledVector(a, dx)
          .addScaledVector(b, dy)
          .addScaledVector(c, dz);
        const candidate = pj.clone().add(shiftVec);
        const d = pi.distanceTo(candidate);
        if (d > cutoff || d < 0.005) continue;

        if (dx === 0 && dy === 0 && dz === 0) {
          // already handled in step (1)
        } else if (general.showNeighborBonds) {
          const candidateArr = [candidate.x, candidate.y, candidate.z];
          if (!isOutsideUnitCell(candidateArr, lattice)) continue;

          const gkey = `${j}:${dx},${dy},${dz}`;
          let ghostMesh = ghostAdded.get(gkey);
          if (!ghostMesh) {
            ghostMesh = createAtomMesh(ej, [candidate.x, candidate.y, candidate.z]);
            ghostMesh.userData.isGhost = true;
            ghostMesh.material.opacity = 1.0;
            ghostMesh.material.transparent = true;
            ghostMesh.material.depthWrite = false;
            atomsGroup.add(ghostMesh);
            ghostAdded.set(gkey, ghostMesh);
          }

          const bkey = `${i}-${j}-${dx},${dy},${dz}`;
          if (!bondDedupe.has(bkey)) {
            console.log(atomIndex_i,atomIndex_j)
            const bond = createBond([pi.x, pi.y, pi.z], [candidate.x, candidate.y, candidate.z], ei, ej,atomIndex_i,atomIndex_j);
            if (bond) {
              if (bond.children && bond.children[1] && bond.children[1].material) {
                bond.children[1].material.transparent = true;
                bond.children[1].material.opacity = 1.0;
              }
              bondsGroup.add(bond);
            }
            bondDedupe.add(bkey);
          }

          // Symmetric ghost on opposite side
          const opposite = pi.clone().sub(shiftVec);
          if (isOutsideUnitCell([opposite.x, opposite.y, opposite.z], lattice)) {
            const gkey2 = `${i}:${-dx},${-dy},${-dz}`;
            if (!ghostAdded.has(gkey2)) {
              const ghostMesh2 = createAtomMesh(ei, [opposite.x, opposite.y, opposite.z]);
              ghostMesh2.userData.isGhost = true;
              ghostMesh2.material.opacity = 1.0;
              ghostMesh2.material.transparent = true;
              ghostMesh2.material.depthWrite = false;
              atomsGroup.add(ghostMesh2);
              ghostAdded.set(gkey2, ghostMesh2);
            }
            const bkey2 = `sym-${i}-${j}-${dx},${dy},${dz}`;
            if (!bondDedupe.has(bkey2)) {
              const bond2 = createBond([opposite.x, opposite.y, opposite.z], [pj.x, pj.y, pj.z], ei, ej,atomIndex_i,atomIndex_j );
              if (bond2) {
                if (bond2.children && bond2.children[0] && bond2.children[0].material) {
                  bond2.children[0].material.transparent = true;
                  bond2.children[0].material.opacity = 1.0;
                }
                bondsGroup.add(bond2);
              }
              bondDedupe.add(bkey2);
            }
          }
        }
      }
    }
  }

  app.scene.add(bondsGroup);
}



function updateSpins(spinData, spinFactor = 1) {
  console.log(spinData)

    let deleteBtn = document.getElementById("deleteSpins")

    if (deleteBtn){
    console.log("Delete Spin Button Initialised")
    deleteBtn.addEventListener("click",(e) => {
               console.log("Delete Spin Clicked")
               e.stopPropagation();
               deleteSpins();
        });};

  // Dispose old spin arrows
  if (spinGroup) {
    spinGroup.children.forEach(child => {
      child.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    });
    disposeGroup(spinGroup);
  }

  if (spinData === null){
    return;
    }

  spinGroup = new THREE.Group();

  if (!structureData || !structureData.positions || !structureData.lattice) return;

  // --- 1️⃣ Wrap atomic positions periodically ---
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);

  // --- 2️⃣ Get lattice vectors for ghost cell replication (like bonds) ---
  const lattice = structureData.lattice;
  const a = new THREE.Vector3(...lattice[0]);
  const b = new THREE.Vector3(...lattice[1]);
  const c = new THREE.Vector3(...lattice[2]);

  // --- 3️⃣ Render arrows per atom ---
  for (let i = 0; i < wrappedCart.length; i++) {
    const atomIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const spin = spinData.find(s => s.atomIndex === atomIndex);
    if (!spin || !spin.vector || spin.vector.length !== 3) continue;

    const { vector, scalingFactor = 1.0, color = "#000000" } = spin;

    const origin = new THREE.Vector3(...wrappedCart[i]);
    const dirVec = new THREE.Vector3(...vector);

    const norm = Math.sqrt(vector[0]**2 + vector[1]**2 + vector[2]**2);
    if (norm < 0.05) {
      console.warn("Spin vector too small (<0.05)", norm)
      continue};

    const baseLen = dirVec.length();
    const totalLength = baseLen * scalingFactor * spinFactor;
    const dir = dirVec.clone().normalize();

    // --- Material (match atom style) ---
    const material = new THREE.MeshPhysicalMaterial(getAtomVisSettings(color,1.0));

    // --- Shaft geometry (extends both directions) ---
    const shaftRadius = 0.1;
    const shaftLength = totalLength;

    const shaftPos = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength / 2, 16),
      material
    );
    shaftPos.position.set(0, shaftLength / 4, 0);

    const shaftNeg = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength / 2, 16),
      material
    );
    shaftNeg.position.set(0, -shaftLength / 4, 0);

    // --- Tip (only positive direction) ---
    const tipLength = 0.8;
    const tipRadius = 0.3;
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(tipRadius, tipLength, 16),
      material
    );
    tip.position.set(0, shaftLength / 2 + tipLength / 2, 0);

    // --- Combine into arrowGroup ---
    const arrowGroup = new THREE.Group();
    arrowGroup.add(shaftPos);
    arrowGroup.add(shaftNeg);
    arrowGroup.add(tip);

    // --- Orientation ---
    const arrowAxis = new THREE.Vector3(0, 1, 0);
    arrowGroup.quaternion.setFromUnitVectors(arrowAxis, dir);
    arrowGroup.position.copy(origin);

    // --- Add to main group ---
    spinGroup.add(arrowGroup);
  }

  // --- 4️⃣ Add to scene ---
  app.scene.add(spinGroup);
}




function updateLattice(color = general.currentLatticeColor) {
  disposeGroup(latticeGroup);
  if (showLattice) { 
    latticeGroup = createLatticeLines(color);
    app.scene.add(latticeGroup);
  }
}

function updateOther() {
  renderComposition();
  clearMeasureGraphics();

  measureLines.forEach(line => app.scene.add(line));
  measureLabels.forEach(label => app.scene.add(label));

  recomputeLatticeDirs();
  updateAllMeasurements();
}



// Per-atom spin spec.
// Key is source atom index (structureData.positions index).
// Value: { dir:[ax,by,cz], length?:number, color?:string }
let spinData = null;

// ===== UTILS =====
function parseColorToHexInt(s, fallback = '#ff3366') {
  if (!s || typeof s !== 'string') s = fallback;
  let t = s.trim();
  if (t.startsWith('0x')) t = '#' + t.slice(2);
  if (!t.startsWith('#')) t = '#' + t;
  // three.js Color can take string; ArrowHelper also accepts Color/number.
  // We'll return integer for consistency.
  const col = new THREE.Color(t);
  return col.getHex();
}

function fracVecToCart(ax, by, cz, lattice) {
  // lattice is 3x3 array [a,b,c] with Cartesian components
  const a = lattice[0], b = lattice[1], c = lattice[2];
  const v = new THREE.Vector3(
    ax * a[0] + by * b[0] + cz * c[0],
    ax * a[1] + by * b[1] + cz * c[1],
    ax * a[2] + by * b[2] + cz * c[2],
  );
  return v;
}

function parseSpinsText(text, { allowLineIndexMapping = true } = {}) {
  // Lines can be:
  //   "a b c length color"
  //   "index a b c length color"
  // index: 0-based or 1-based (we normalize to 0-based)
  // length, color are optional; we fallback to defaults
  const out = new Map();
  if (!text) return out;
  const lines = text.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue;
    const toks = raw.split(/[\s,]+/).filter(Boolean);
    if (toks.length < 3) continue;

    let idx = null, off = 0;

    // If first token looks like an integer, treat it as index
    const maybeIdx = parseFloat(toks[0]);
    if (Number.isFinite(maybeIdx) && Math.floor(maybeIdx) === maybeIdx && toks.length >= 4) {
      idx = parseInt(toks[0], 10);
      // Support 1-based in input by auto-shifting to 0-based if user used 1..N range:
      if (idx >= 1) {
        // We accept both; if you want strict 0-based only, remove this adjustment.
        idx = idx - 1;
      }
      off = 1;
    } else if (!allowLineIndexMapping) {
      // If we require explicit indices and didn't get one, skip.
      continue;
    }

    const ax = parseFloat(toks[0 + off]);
    const by = parseFloat(toks[1 + off]);
    const cz = parseFloat(toks[2 + off]);
    if (!Number.isFinite(ax) || !Number.isFinite(by) || !Number.isFinite(cz)) continue;

    let length = undefined;
    let color  = undefined;

    if (toks[3 + off] !== undefined) {
      const maybeLen = parseFloat(toks[3 + off]);
      if (Number.isFinite(maybeLen)) length = maybeLen;
      else color = toks[3 + off]; // user may have omitted length and given color
    }
    if (toks[4 + off] !== undefined) {
      color = toks[4 + off];
    }

    if (idx === null) idx = li; // line i maps to atom i when index not given

    out.set(idx, { dir: [ax, by, cz], length, color });
  }

  return out;
}

function makeArrowAt(positionVec3, dirVec3, length, colorHexInt) {
  const dir = dirVec3.clone();
  const L = (typeof length === 'number') ? length : defaultSpinLength;
  if (dir.lengthSq() < 1e-16 || L <= 1e-8) return null;
  dir.normalize();

  // ArrowHelper(colorHex|Color)
  const arrow = new THREE.ArrowHelper(dir, positionVec3, L, colorHexInt);
  // Optionally tweak shaft/head sizes, if desired:
  // arrow.line.material.linewidth = 2; // (Note: line width not supported widely in WebGL)
  // arrow.cone.scale.set(1.0, 1.0, 1.0); // adjust head thickness if needed
  return arrow;
}

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
    currentLatticeColor = contrastColor
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
    app.scene.background = new THREE.Color(0x021302)
    general.currentLatticeColor = 0xE7E7E7;
    dot.style.border = `2px solid #E7E7E7`
    updateLattice()
   }
   else if (!isDarkMode )
   {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.currentLatticeColor = 0x021302
    dot.style.border = `2px solid #021302`
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
    openBackgroundColorPicker(dot); // uncomment when scene is ready
  });
}


function updateVisualization(options = {}) {
  const {
    reRenderAtoms = true,
    reRenderBonds = true,
    reRenderLattice = true,
    reRenderOther = true,
    sOpactiy = general.secondOpacity,
    mOpacity = general.mainOpacity
  } = options;

  if (!structureData) {
    console.log('No structureData available, returning early');
    return;
  }

  if (reRenderAtoms) {
    updateAtoms(mOpacity);
    if (atomsGroup2){
      addSecondStructure(sOpactiy)
     }
  }

  if (reRenderBonds) updateBonds();
  if (reRenderLattice) updateLattice(general.currentLatticeColor);
  if (reRenderOther) updateOther();
}

function colorHexToCss(hex) {
    const s = hex.toString(16).padStart(6,'0');
    return `#${s}`;
}

function hexToRgba(color, alpha = 1) {
  // Create a dummy element to let the browser parse the color
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  const computed = ctx.fillStyle; // normalized to #rrggbb

  // Extract RGB from normalized hex (#rrggbb)
  const r = parseInt(computed.substr(1, 2), 16);
  const g = parseInt(computed.substr(3, 2), 16);
  const b = parseInt(computed.substr(5, 2), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;

}

async function loadStructure(content, fileName = '', isDefault = false) {
  try {
    const lower = (fileName || '').toLowerCase();
    const contentString = typeof content === 'string' ? content : '';
    const treatAsCIF = lower.endsWith('.cif') ||
                      lower.includes('.cif') ||
                      /(^|\W)cif(\W|$)/.test(lower) ||
                      isLikelyCIFContent(contentString);

     const treatAsOUTCAR = lower.endsWith('.vasp.out') ||
                      lower.includes('.vasp.out') ||
                      lower.includes('outcar');

    if (treatAsCIF) {
      console.log("This is probably a CIF file")
      structureData = await parseCIF(contentString);
    } 
    
    else if (treatAsOUTCAR){

      console.log("This is probably an OUTCAR file");
      ({ structure: structureData, spin: spinsData } = await parseOUTCAR(contentString));
    }


    else {
      console.log("This is probably a POSCAR file")
      structureData = await parsePOSCAR(contentString);
    }


    // keep a deep copy for restore (fractional positions + arrays)
    originalStructureData = JSON.parse(JSON.stringify(structureData));
    loadColorOverrides();
    loadIndividualAtomColors();
    if (isDefault) {
      setStatus(`Default structure: ${structureData.elements.length} atoms`);
    } else {
      setStatus(`Loaded: ${structureData.elements.length} atoms`);
    }

    document.getElementById('structureControls').style.display = 'block';
    document.getElementById('bondControlsGroup').style.display = 'block';
    document.getElementById('spinControlsGroup').style.display = 'block';

    createBondLengthControls();
    createSpinControls();
    createBackgroundControl();
    createShareButton();
    updateVisualization();
    if (spinsData != null){
      updateSpins(spinsData, 1.0);
      //populateSpinViewer();
    }
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

async function loadSecondStructure(content, fileName = '', isDefault = false) {
  try {
    const lower = (fileName || '').toLowerCase();
    const contentString = typeof content === 'string' ? content : '';
    const treatAsCIF = lower.endsWith('.cif') ||
                      lower.includes('.cif') ||
                      /(^|\W)cif(\W|$)/.test(lower) ||
                      isLikelyCIFContent(contentString);

    if (treatAsCIF) {
      structureData2 = await parseCIF(contentString);
    } else {
      structureData2 = parsePOSCAR(contentString);
    }
    loadColorOverrides();
    loadIndividualAtomColors();
    if (isDefault) {
      setStatus(`Default structure: ${structureData.elements.length} atoms`);
    } else {
      setStatus(`Loaded: ${structureData.elements.length} atoms`);
    }
    addSecondStructure();
    if (structureData2){
    }
    general.structure2OpacityValue=0.5

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}

function loadDefaultStructure() {
  // Don't load default structure if we've already loaded a shared structure
  if (general.sharedStructureLoaded) {
    console.log('Skipping default structure load - shared structure already loaded');
    return;
  }

  setStatus('Loading default NaCl structure...');
  setTimeout(() => {
    loadStructure(defaultPOSCAR, 'POSCAR', true);
  }, 100);
}

function init() {

  app.scene = new THREE.Scene();

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (isDarkMode) {
    console.log("The user prefers a dark theme.");
    app.scene.background = new THREE.Color(0x021302)
    general.defaultBackgroundColor = 0x021302
    general.currentLatticeColor = 0xE7E7E7
   } else {
    console.log("The user prefers a light theme.");
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x021302
   };

  console.log(`picked lattice color ${general.currentLatticeColor}`);
  //
  //


  //get all things related to the main view window from WindowAndSceneControls.js
  initCamera(app.useOrthographicCamera);

  initRenderer();

  initLabelRenderer();

  initControls();

  resizeRenderer(app.orthographicFrustumSize);


  // not even sure what this does??

  atomTooltip = document.createElement('div');
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
    hoveredAtom = null;
  }

  function updateAtomTooltip(event) {
    if (!atomsGroup || !atomsGroup.children.length || !atomTooltip) {
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

    const hits = raycaster.intersectObjects(atomsGroup.children, true);
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
    for (let i = 0; i < structureData.elements.length; i++) {
      if (structureData.elements[i] === element) {
        elementAtomIndices.push(i);
      }
    }

    if (hoveredAtom !== hit) {
      hoveredAtom = hit;

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
    raycaster.setFromCamera(mouse,app.camera);
    if(!atomsGroup) return;

    const hits = raycaster.intersectObjects(atomsGroup.children, true);
    if (!hits.length) {
      // Clicked on empty space - reset selection
      selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      selectedAtoms = [];
      clearMeasureGraphics();
      return;
    }

    const hit = hits[0].object;

    // Don't select the same atom twice
    if (selectedAtoms.includes(hit)) return;

    // Add atom to selection
    selectedAtoms.push(hit);
    HighlightAtom(hit, selectedAtoms.length === 1 ? 0xff0000 : selectedAtoms.length === 2 ? 0x0000ff : 0x00ff00);

    // Handle actions based on mode
    if (mode.measureMode === 'distance' && selectedAtoms.length === 2) {
      // Distance measurement complete
      addDistanceMeasurement(selectedAtoms[0], selectedAtoms[1]);

      // Clear selection
      selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      selectedAtoms = [];
      clearMeasureGraphics();
    } else if (mode.measureMode === 'angle' && selectedAtoms.length === 3) {
      // Angle measurement complete
      addAngleMeasurement(selectedAtoms[0], selectedAtoms[1], selectedAtoms[2]);

      // Clear selection
      selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      selectedAtoms = [];
      clearMeasureGraphics();
    } else if (mode.measureMode === 'delete') {
      const idx = hit.userData.sourceIndex;
      if (idx !== undefined && idx >= 0 && idx < structureData.positions.length) {
        // Remove atom from structure
        structureData.positions.splice(idx, 1);
        structureData.elements.splice(idx, 1);
        // Clean selections and graphics
        selectedAtoms.forEach(atom => clearHighlightAtom(atom));
        selectedAtoms = [];
        clearMeasureGraphics();
        // Rebuild controls and view
        createBondLengthControls();
        createSpinControls();
        createBackgroundControl();
        updateVisualization();
      }
      return; // nothing else to do in delete mode
    }

    drawMeasureGraphics();
  }

  // Double-click handler for atom highlighting feature
  function onDoubleClickAtom(event) {
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

    // Raycast to find clicked atom
    raycaster.setFromCamera(mouse, app.camera);
    const hits = raycaster.intersectObjects(atomsGroup.children, true);

    if (hits.length > 0) {
      const hit = hits[0];
      const atomMesh = hit.object;

      // Skip ghost atoms
      if (atomMesh.userData.isGhost) return;

      const element = atomMesh.userData.element;
      const sourceIndex = atomMesh.userData.sourceIndex;

      // Double-clicked atom detected

      // Highlight the clicked atom in the structure panel
      highlightAtomInStructurePanel(element, sourceIndex);

      // Add visual glow to the 3D atom
      highlightAtomIn3D(atomMesh);
    }
  }

  // Add event listeners - use touchstart instead of touchend for better responsiveness
  app.renderer.domElement.addEventListener('click', onClickPick);

  // Add double-click listener for atom highlighting feature
  app.renderer.domElement.addEventListener('dblclick', onDoubleClickAtom);


  // Add single click listener to clear highlights when clicking empty space
  app.renderer.domElement.addEventListener('click', (event) => {
    // Only clear highlights if no measurement mode is active
    if (mode.measureMode === 'none') {
      // Small delay to avoid conflicts with double-click
      setTimeout(() => {
        // Check if we clicked on empty space
        const rect = app.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        const clientX = event.clientX || (event.changedTouches && event.changedTouches[0].clientX);
        const clientY = event.clientY || (event.changedTouches && event.changedTouches[0].clientY);

        if (clientX && clientY) {
          mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

          raycaster.setFromCamera(mouse, app.camera);
          const hits = raycaster.intersectObjects(atomsGroup.children, true);

          // If no atom was clicked, clear highlights
          if (hits.length === 0) {
            clearAllHighlights();
          }
        }
      }, 100);
    }
  });

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



  document.getElementById('viewX').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 1., 0., 0.))};
  document.getElementById('viewY').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 1., 0.))};
  document.getElementById('viewZ').onclick = () => {app.controls.reset(); setViewDirection(new THREE.Vector3( 0., 0., 1.))};


  document.getElementById('viewA').onclick = () => {app.controls.reset(); const {a} = latticeDirs(); setViewDirection(a); };
  document.getElementById('viewB').onclick = () => {app.controls.reset(); const {b} = latticeDirs(); setViewDirection(b); };
  document.getElementById('viewC').onclick = () => {app.controls.reset(); const {c} = latticeDirs(); setViewDirection(c); };
  document.getElementById('resetView').onclick = () => resetView();

  setupStructureInput({
    onLoadStructure: (content, name) => loadStructure(content, name),
    setStatus,
  });

  setupSecondStructureInput({
    onLoadStructure: (content, name) => loadSecondStructure(content, name),
    setStatus,
  });

  // Check for shared structure in URL
  loadSharedStructure();

  // Control handlers
  document.getElementById('showBonds').onchange = (e) => {
    general.showBonds = e.target.checked;
    updateVisualization();
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

  document.getElementById('showSecond').onchange = (e) => {
    general.showSecond = e.target.checked;
    let slider = document.getElementById("structure2OpacityValue");
    general.structure2OpacityValue=0.5;
    slider.value=0.5;
    addSecondStructure();
  };

  document.getElementById('showComparisonInfo').onchange = (e) => {
    general.showComparisonInfo = e.target.checked;
    addSecondStructure();
  }

   

  // Toggle for VESTA-style neighbor bonds/ghost atoms
  const neighborBondsEl = document.getElementById('neighborBonds');
  if (neighborBondsEl) {
    neighborBondsEl.onchange = (e) => {
      general.showNeighborBonds = e.target.checked;
      updateVisualization();
    };
  }

  document.getElementById('atomSize').oninput = (e) => {
    general.atomSize = parseFloat(e.target.value);
    document.getElementById('atomSizeValue').textContent = atomSize.toFixed(1);
    updateVisualization();
    updateMeasurementMarkers(); // Update ring markers when atom size changes
  };

  document.getElementById('structure2OpacityValue').oninput = (e) => {
    general.structure2OpacityValue = parseFloat(e.target.value);
    document.getElementById('structure2OpacityValue').textContent = general.structure2OpacityValue.toFixed(1);
    if (showSecond){
     general.mainOpacity = 2*structure2OpacityValue
     general.secondOpacity = 1.0

    if (general.structure2OpacityValue < 0.5){
           general.secondOpacity = 2*general.structure2OpacityValue
     general.mainOpacity = 1.0
      }
    else if (general.structure2OpacityValue > 0.5){
      general.mainOpacity = 1-2 * (general.structure2OpacityValue - 0.5)
      general.secondOpacity = 1.0
      addSecondStructure(1.0)
      updateAtoms(1-2 * (general.structure2OpacityValue - 0.5))
      }
    else {
      general.secondOpacity =1.0
      general.mainOpacity = 1.0
    }
    updateVisualization(general.mainOpacity,general.secondOpacity);
      
    updateVisualization({
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: true
        });


    }
  };

  // Bond width control
  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    bondWidthSlider.oninput = (e) => {
      const v = parseFloat(e.target.value);
      // clamp defensively
      general.bondRadius = Math.max(0.005, Math.min(1.0, isNaN(v) ? bondRadius : v));
      bondWidthValue.textContent = bondRadius.toFixed(2);
      updateVisualization();
    };
  }

  let checkbox_second = document.getElementById("showSecond");
      checkbox_second.checked = false; // explicitly untick

    let checkbox_polyhedra = document.getElementById("showPolyhedra");
      checkbox_polyhedra.checked = false; // explicitly untick 

      let checkbox_showComparisonInfo = document.getElementById("showComparisonInfo");
      checkbox_showComparisonInfo.checked = false; // explicitly untick

     let checkbox_secondBonds = document.getElementById("showSecondBonds");
      checkbox_secondBonds.checked = false; // explicitly untick

  let checkbox_secondLattice = document.getElementById("showSecondLattice");
      checkbox_secondLattice.checked = false; // explicitly untick



  let checkbox_neighbours = document.getElementById("neighborBonds");
      checkbox_neighbours.checked = false; // explicitly untick

  // New control handlers
  document.getElementById('orthographicCamera').onchange = (e) => {
    app.useOrthographicCamera = e.target.checked;
    switchCameraType();
  };

  document.getElementById('defaultColors').onchange = (e) => {
    general.useDefaultColors = e.target.checked;
    updateVisualization(); // also re-renders composition
  };

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
    selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    selectedAtoms = [];
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
    selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    selectedAtoms = [];
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
    selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    selectedAtoms = [];
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

    // Also restore deleted atoms
    if (originalStructureData) {
      general.currentLattice = structureData.lattice
      structureData = JSON.parse(JSON.stringify(originalStructureData));

      if (general.modifiedLattice != null){
        structureData.lattice = general.modifiedLattice
      }
      if (general.currentSupercell != null){
          createSupercell(currentSupercell.nx,currentSupercell.ny,currentSupercell.nz)
          }
      createBondLengthControls();
      createSpinControls();
      createBackgroundControl();
      updateVisualization();
      clearMeasure();
    }
  });

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

  document.getElementById('resetBondLengths').onclick = resetBondLengths;

  // Initialize atomSize from the UI slider so the initial view respects the slider value
  (function initAtomSizeFromSlider(){
    const slider = document.getElementById('atomSize');
    const span = document.getElementById('atomSizeValue');
    if (slider) {
      const v = parseFloat(slider.value);
      if (!isNaN(v)) {
        general.atomSize = v; // apply slider value to internal scale
        if (span) span.textContent = general.atomSize.toFixed(1);
        if (structureData) updateVisualization();
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
        if (structureData) updateVisualization();
      }
    }
  })();

  app.camera.position.set(20, 20, 20);
  app.controls.update();
 
  animation_update();

  // Load default structure after everything is initialized
  loadDefaultStructure();
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
      resizeRenderer(orthographicFrustumSize);
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

  // Add viewport meta tag if not present for proper mobile scaling
  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1.0, user-scalable=no';
    document.head.appendChild(viewport);
  }
}


init();
//resetView();
setupMobileMenu();
