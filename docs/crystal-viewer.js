import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
//import { RoomEnvironment } from 'https://unpkg.com/three@0.160.0/examples/jsm/environments/RoomEnvironment.js';
import { setupStructureInput, isLikelyCIFContent, parsePOSCAR, cartToFractional } from './structure-input.js';
import { parseCIF} from './file_reader.js';
import { createColorPicker } from './color-picker.js';


import {
  captureCompleteState,
  createCompleteShareableURL,
  createLegacyShareableURL,
  restoreCompleteState,
  generatePOSCARString
} from './shareutils.js'; 

const view = document.getElementById('view');
const status = document.getElementById('status');
const setStatus = (s) => {
  if (status) status.textContent = s;
  console.log('[viewer]', s);
};

// Default complex structure (Ba2YCu3O7) - high-Tc superconductor with 4 elements to test collapsible composition
const defaultPOSCAR = `Ba2YCu3O7 - YBCO Superconductor
1.0
3.82 0.00 0.00
0.00 3.89 0.00
0.00 0.00 11.68
Ba Y Cu O
2 1 3 7
Direct
0.5 0.5 0.184
0.5 0.5 0.816
0.5 0.5 0.5
0.0 0.0 0.356
0.0 0.0 0.644
0.0 0.5 0.0
0.5 0.0 0.0
0.0 0.5 0.378
0.5 0.0 0.378
0.0 0.5 0.622
0.5 0.0 0.622
0.0 0.0 0.159
0.0 0.0 0.841`;

let camera, controls, renderer, scene;
let atomsGroup, bondsGroup, latticeGroup,spinGroup;
let structureData = null;
let modifiedLattice = null;
let currentSupercell = null;
let originalStructureData = null; // deep-copy of last loaded structure for restore
let bondLengths = {};
let defaultBondLengths = {};
let atomSize = 1.0;
let bondRadius = 0.08; // radius of bond cylinders
let showBonds = true;
let showLattice = true;
let showNeighborBonds = false; // Periodic image atoms + bonds across cell (off by default)
let useOrthographicCamera = true;
const defaultZoomScale = 0.75; // initial zoom of the atom.
let useVestaColors = true;
let measureMode = 'none'; // 'none', 'distance', 'angle'
let bondVisibility = {};
// User color overrides per element (persisted to localStorage)
let userColorOverrides = {};
// Individual atom color overrides (persisted to localStorage)
let individualAtomColors = {};

let gizmoScene, gizmoCamera, gizmoRenderer;
let keyLight; // Lighting variables

let atomTooltip = null;
let hoveredAtom = null;

const aboutTrigger = document.getElementById('aboutTrigger');
const aboutOverlay = document.getElementById('aboutOverlay');
const aboutModal = document.getElementById('aboutModal');
const aboutClose = document.getElementById('aboutClose');
const aboutContent = document.getElementById('aboutContent');
let aboutLoaded = false;
let aboutLoading = false;
let aboutPreviousFocus = null;

let orthographicFrustumSize = null;

    // Measurement state
let selectedAtoms = []; // Array to store selected atoms (up to 3 for angles)
let measureLine = null;          // THREE.Line
let measureLabel = null;         // CSS2DObject
let labelRenderer = null;        // CSS2DRenderer overlay for main scene
let measureLines = [];           // Array to store multiple measurement lines
let measureLabels = [];          // Array to store multiple measurement labels


// Atomic data
const atomicRadii = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06,
  K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24,
  Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16,
  Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39,
  Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.40,
  Cs: 2.44, Ba: 2.15, La: 2.07, Ce: 2.04, Pr: 2.03, Nd: 2.01, Pm: 1.99, Sm: 1.98, Eu: 1.98, Gd: 1.96,
  Tb: 1.94, Dy: 1.92, Ho: 1.92, Er: 1.89, Tm: 1.90, Yb: 1.87, Lu: 1.87,
  Hf: 1.75, Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32,
  Tl: 1.45, Pb: 1.46, Bi: 1.48, Po: 1.40, At: 1.50, Rn: 1.50
}; // atomic radii in angstroms

const jmolColors = {
  H: 0xffffff, He: 0xd9ffff, Li: 0xcc80ff, Be: 0xc2ff00, B: 0xffb5b5, C: 0x909090, N: 0x3050f8, O: 0xff0d0d,
  F: 0x90e050, Ne: 0xb3e3f5, Na: 0xab5cf2, Mg: 0x8aff00, Al: 0xbfa6a6, Si: 0xf0c8a0, P: 0xff8000, S: 0xffff30,
  Cl: 0x1ff01f, Ar: 0x80d1e3, K: 0x8f40d4, Ca: 0x3dff00, Sc: 0xe6e6e6, Ti: 0xbfc2c7, V: 0xa6a6ab, Cr: 0x8a99c7,
  Mn: 0x9c7ac7, Fe: 0xe06633, Co: 0xf090a0, Ni: 0x50d050, Cu: 0xc88033, Zn: 0x7d80b0, Ga: 0xc28f8f, Ge: 0x668f8f,
  As: 0xbd80e3, Se: 0xffa100, Br: 0xa62929, Kr: 0x5cb8d1, Rb: 0x702eb0, Sr: 0x00ff00, Y: 0x94ffff, Zr: 0x94e0e0,
  Nb: 0x73c2c9, Mo: 0x54b5b5, Tc: 0x3b9e9e, Ru: 0x248f8f, Rh: 0x0a7d8c, Pd: 0x006985, Ag: 0xc0c0c0, Cd: 0xffd98f,
  In: 0xa67573, Sn: 0x668080, Sb: 0x9e63b5, Te: 0xd47a00, I: 0x940094, Xe: 0x429eb0, Cs: 0x57178f, Ba: 0x00c900,
  La: 0x70d4ff, Ce: 0xffffc7, Pr: 0xd9ffc7, Nd: 0xc7ffc7, Pm: 0xa3ffc7, Sm: 0x8fffc7, Eu: 0x61ffc7, Gd: 0x45ffc7,
  Tb: 0x30ffc7, Dy: 0x1fffc7, Ho: 0x00ff9c, Er: 0x00e675, Tm: 0x00d452, Yb: 0x00bf38, Lu: 0x00ab24, Hf: 0x4dc2ff,
  Ta: 0x4da6ff, W: 0x2194d6, Re: 0x267dab, Os: 0x266696, Ir: 0x175487, Pt: 0xd0d0e0, Au: 0xffd123, Hg: 0xb8b8d0,
  Tl: 0xa6544d, Pb: 0x575961, Bi: 0x9e4fb5, Po: 0xab5c00, At: 0x754f45, Rn: 0x428296
};
const vestaColors = {
  H:  0xffcccc,
  D:  0xccccff,
  He: 0xfce9d0,
  Li: 0x87e07a,
  Be: 0x5ef6c1,
  B:  0x20a332,
  C:  0x814839,
  N:  0xb1bad6,
  O:  0xff0300,
  F:  0xb1bad6,
  Ne: 0xff37b4,
  Na: 0xf9dd3d,
  Mg: 0xfce27a,
  Al: 0x81b3d6,
  Si: 0x1b3bfa,
  P:  0xc18fa3,
  S:  0xffff00,
  Cl: 0x31fc03,
  Ar: 0xd2ffa4,
  K:  0xa123f7,
  Ca: 0x5b96bd,
  Sc: 0xb57dab,
  Ti: 0x789efb,
  V:  0xe60000,
  Cr: 0x00009e,
  Mn: 0xa90b9f,
  Fe: 0xb5b271,
  Co: 0x0000af,
  Ni: 0xb8b9bd,
  Cu: 0x223fdc,
  Zn: 0x8f8f81,
  Ga: 0x9fb4b7,
  Ge: 0x7f6faa,
  As: 0x75d057,
  Se: 0x9acf0f,
  Br: 0x7e3102,
  Kr: 0xf9c1f4,
  Rb: 0xff0099,
  Sr: 0x00ff26,
  Y:  0x679960,
  Zr: 0x00ff00,
  Nb: 0x4cbc76,
  Mo: 0xb4868f,
  Tc: 0xcdafca,
  Ru: 0xcfb7ad,
  Rh: 0xcdbfab,
  Pd: 0xc1c4b9,
  Ag: 0xb8b9bd,
  Cd: 0xf3f4dc,
  In: 0xd680bb,
  Sn: 0x9b8fba,
  Sb: 0xd78250,
  Te: 0xadd42f,
  I:  0x8e1f8b,
  Xe: 0x9aa1f8,
  Cs: 0x0efcb9,
  Ba: 0x1ee05a,
  La: 0x5ac431,
  Ce: 0xd1fc06,
  Pr: 0xfce21c,
  Nd: 0xfc8e07,
  Pm: 0x0000f5,
  Sm: 0xfc063e,
  Eu: 0xfb04d5,
  Gd: 0xc00eff,
  Tb: 0x7100fe,
  Dy: 0x3117fe,
  Ho: 0x072fae,
  Er: 0x497323,
  Tm: 0x0000e0,
  Yb: 0x273fe4,
  Lu: 0x26fed0,
  Hf: 0xb3b369,
  Ta: 0xb79af5,
  W:  0x8e8690,
  Re: 0xb3b17e,
  Os: 0xc9b179,
  Ir: 0xc9cfc7,
  Pt: 0xccc5c0,
  Au: 0xfeb236,
  Hg: 0xd3b8cc,
  Tl: 0x968a6d,
  Pb: 0x53545b,
  Bi: 0xd22fc7,
  Po: 0x0000ff,
  At: 0x0000ff,
  Rn: 0xffff00,
  Fr: 0x000000,
  Ra: 0x6eaa59,
  Ac: 0x648f73,
  Th: 0x26fe78,
  Pa: 0x28fb35,
  U:  0x7aa1aa,
  Np: 0x4c4c4c,
  Pu: 0x4c4c4c,
  Am: 0x4c4c4c,
  XX: 0x4c4c4c
};


function getElementColor(element) {
  // Prefer user override if present
  if (userColorOverrides && userColorOverrides[element] !== undefined) {
    return userColorOverrides[element];
  }
  const colorScheme = useVestaColors ? vestaColors : jmolColors;
  return colorScheme[element] || 0x808080;
}

function getIndividualAtomColor(element, atomIndex) {
  // Check if individual atom has custom color
  const atomKey = `${element}_${atomIndex}`;
  if (individualAtomColors && individualAtomColors[atomKey] !== undefined) {
    return individualAtomColors[atomKey];
  }
  // Fall back to element-wide color
  return getElementColor(element);
}

// Get the default palette color for an element (ignores user overrides)
function getDefaultElementColor(element) {
  const colorScheme = useVestaColors ? vestaColors : jmolColors;
  return colorScheme[element] || 0x808080;
}


// This is why the colors are persistent. It is stored in the browser itself. The only thing we store is the customg color state! 

function saveColorOverrides() {
  try { localStorage.setItem('atomColorOverrides', JSON.stringify(userColorOverrides || {})); } catch (_) {}
}
function loadColorOverrides() {
  try {
    const raw = localStorage.getItem('atomColorOverrides');
    if (raw) userColorOverrides = JSON.parse(raw) || {};
  } catch (_) { userColorOverrides = {}; }
}

function saveIndividualAtomColors() {
  try { localStorage.setItem('individualAtomColors', JSON.stringify(individualAtomColors || {})); } catch (_) {}
}
function loadIndividualAtomColors() {
  try {
    const raw = localStorage.getItem('individualAtomColors');
    if (raw) individualAtomColors = JSON.parse(raw) || {};
  } catch (_) { individualAtomColors = {}; }
}

function setElementColorOverride(el, cssHex) {
  if (!cssHex) return false;
  let hex = cssHex.toString().trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  userColorOverrides[el] = parseInt(hex, 16);
  saveColorOverrides();
  return true;
}
function clearElementColorOverride(el) {
  delete userColorOverrides[el];
  saveColorOverrides();
}

function setIndividualAtomColor(element, atomIndex, cssHex) {
  if (!cssHex) return false;
  let hex = cssHex.toString().trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const atomKey = `${element}_${atomIndex}`;
  individualAtomColors[atomKey] = parseInt(hex, 16);
  saveIndividualAtomColors();
  return true;
}

function clearIndividualAtomColor(element, atomIndex) {
  const atomKey = `${element}_${atomIndex}`;
  delete individualAtomColors[atomKey];
  saveIndividualAtomColors();
}

function hasIndividualColors(element) {
  if (!individualAtomColors) return false;
  return Object.keys(individualAtomColors).some(key => key.startsWith(`${element}_`));
}

function getAllIndividualAtomColors(element) {
  if (!individualAtomColors) return [];

  // Collect all individual color overrides for the element
  const currentPalette = Object.entries(individualAtomColors)
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
  if (!individualAtomColors) return;
  // Remove all individual colors for this element
  const keysToRemove = Object.keys(individualAtomColors).filter(key => key.startsWith(`${element}_`));
  keysToRemove.forEach(key => delete individualAtomColors[key]);
  saveIndividualAtomColors();
}


function createSupercell(nx = 1, ny = 1, nz = 1) {
 
  if (!originalStructureData) return;

  const basePositions = originalStructureData.positions;
  const baseElements = originalStructureData.elements;

  let baseLattice;

  if (modifiedLattice == null) {
    // No modified lattice → use original
    baseLattice = originalStructureData.lattice;
  } else {
    if (currentSupercell == null) {
      // No supercell info → use as-is
      baseLattice = modifiedLattice;
    } else {
      // Scale each lattice vector by its corresponding supercell multiplier
      const { nx, ny, nz } = currentSupercell;
      const scales = [nx, ny, nz];
      baseLattice = modifiedLattice.map((v, i) => v.map(x => x / scales[i]));
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
  currentSupercell={ nx, ny, nz }

  // Re-render
  //
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true
  });
}





function getAtomRadius(element) {
  return (atomicRadii[element] || 1.0) * atomSize;
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
  outerRing.lookAt(camera.position);
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
  innerRing.lookAt(camera.position);
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


function getCellCenterAndDist() {
  const L = structureData?.lattice || [[10,0,0],[0,10,0],[0,0,10]];
  const corner = new THREE.Vector3(
    L[0][0]+L[1][0]+L[2][0],
    L[0][1]+L[1][1]+L[2][1],
    L[0][2]+L[1][2]+L[2][2]
  );
  const center = corner.clone().multiplyScalar(0.5);
  const distBase = Math.max(corner.length()*2.5, 20);
  const dist = distBase * defaultZoomScale;
  return { center, dist };
}

// makes the center of structure as the rotation center.
function setViewDirection(dir) {
  const { center, dist } = getCellCenterAndDist();
  const n = (dir.isVector3 ? dir : new THREE.Vector3(...dir)).clone().normalize();
  camera.position.copy(center.clone().add(n.multiplyScalar(dist)));
  controls.target.copy(center);
  controls.update();
}

function resetView() { setViewDirection(new THREE.Vector3(1,1,1)); } //CAMERA RESET

function switchCameraType() {
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;

  if (useOrthographicCamera) {
    // Switch to orthographic camera
    const { center, dist } = getCellCenterAndDist();
    orthographicFrustumSize = dist * 0.5; // Adjust this multiplier as needed
    const aspect = w / h;
    camera = new THREE.OrthographicCamera(
      -orthographicFrustumSize,
      orthographicFrustumSize,
      orthographicFrustumSize / aspect,
      -orthographicFrustumSize / aspect,
      0.1,
      1000
    );
  } else {
    // Switch to perspective camera
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    orthographicFrustumSize = null;
  }

  controls.object = camera;
  const { center, dist } = getCellCenterAndDist();
  camera.position.copy(center.clone().add(new THREE.Vector3(1,1,1).normalize().multiplyScalar(dist)));
  controls.target.copy(center);
  controls.update();
  resizeRenderer();
}

function resetBondLengths() {
  for (const pair in defaultBondLengths) {
    bondLengths[pair] = defaultBondLengths[pair];
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

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function escapeAttribute(str = '') {
  return escapeHtml(str).replace(/`/g, '&#96;');
}

function renderMarkdownInline(text) {
  if (!text) return '';
  const codePlaceholders = [];
  const linkPlaceholders = [];
  let working = text.replace(/`([^`]+)`/g, (_, code) => {
    const index = codePlaceholders.push(code) - 1;
    return `\u0000CODE${index}\u0000`;
  }).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const index = linkPlaceholders.push({ label, url }) - 1;
    return `\u0000LINK${index}\u0000`;
  });

  working = escapeHtml(working);

  working = working.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                   .replace(/\*(.+?)\*/g, '<em>$1</em>');

  working = working.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => {
    const entry = linkPlaceholders[Number(idx)];
    if (!entry) return '';
    return `<a href="${escapeAttribute(entry.url)}" target="_blank" rel="noopener">${escapeHtml(entry.label)}</a>`;
  });

  working = working.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
    const code = codePlaceholders[Number(idx)];
    return `<code>${escapeHtml(code)}</code>`;
  });

  return working;
}

function renderMarkdownContent(markdown) {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      html.push('');
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const content = renderMarkdownInline(headingMatch[2]);
      html.push(`<h${level}>${content}</h${level}>`);
      return;
    }

    const listMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderMarkdownInline(listMatch[1])}</li>`);
      return;
    }

    closeList();
    html.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  });

  closeList();
  return html.join('\n');
}

async function loadAboutContent() {
  if (!aboutContent || aboutLoading || aboutLoaded) return;
  aboutLoading = true;
  aboutContent.innerHTML = '<p id="aboutLoading">Loading About content…</p>';
  try {
    const response = await fetch('about.md', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    const text = await response.text();
    aboutContent.innerHTML = renderMarkdownContent(text) || '<p>No About content available.</p>';
    aboutLoaded = true;
  } catch (error) {
    aboutContent.innerHTML = `<p class="about-error">${escapeHtml(error.message || 'Failed to load About content.')}</p>`;
  } finally {
    aboutLoading = false;
  }
}

function openAboutPanel() {
  if (!aboutOverlay) return;
  if (aboutOverlay.hasAttribute('hidden')) {
    aboutOverlay.removeAttribute('hidden');
  }
  requestAnimationFrame(() => aboutOverlay.classList.add('visible'));
  aboutPreviousFocus = document.activeElement;
  if (!aboutLoaded) {
    loadAboutContent();
  }
  setTimeout(() => {
    if (aboutModal) {
      aboutModal.focus({ preventScroll: true });
    }
    if (aboutClose) {
      aboutClose.focus({ preventScroll: true });
    }
    resizeRenderer();
  }, 120);
}

function closeAboutPanel() {
  if (!aboutOverlay) return;
  aboutOverlay.classList.remove('visible');
  setTimeout(() => {
    if (!aboutOverlay.classList.contains('visible')) {
      aboutOverlay.setAttribute('hidden', '');
    }
  }, 160);
  const focusTarget = aboutPreviousFocus;
  aboutPreviousFocus = null;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    setTimeout(() => focusTarget.focus({ preventScroll: true }), 160);
  }
  setTimeout(resizeRenderer, 200);
}

if (aboutTrigger) {
  aboutTrigger.setAttribute('aria-haspopup', 'dialog');
  aboutTrigger.addEventListener('click', (event) => {
    event.preventDefault();
    openAboutPanel();
  });
  aboutTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAboutPanel();
    }
  });
}

if (aboutOverlay) {
  aboutOverlay.addEventListener('click', (event) => {
    if (event.target === aboutOverlay) {
      closeAboutPanel();
    }
  });
}

if (aboutClose) {
  aboutClose.addEventListener('click', (event) => {
    event.preventDefault();
    closeAboutPanel();
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && aboutOverlay && !aboutOverlay.hasAttribute('hidden')) {
    closeAboutPanel();
  }
});

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

      if (!bondLengths[pair]) {
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        bondLengths[pair] = defaultValue;
        defaultBondLengths[pair] = defaultValue; // Store default
      }

      // Initialize bond visibility if not set
      if (bondVisibility[pair] === undefined) {
        bondVisibility[pair] = true;
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
    checkbox.checked = bondVisibility[pair];
    checkbox.onchange = (e) => {
      bondVisibility[pair] = e.target.checked;
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
    valueSpan.textContent = `${bondLengths[pair].toFixed(2)} Å`;
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
    slider.value = bondLengths[pair];
    slider.style.flex = '1';

    const textInput = document.createElement('input');
    textInput.type = 'number';
    textInput.min = '0.0';
    textInput.max = '6.0';
    textInput.step = '0.01';
    textInput.value = bondLengths[pair];
    textInput.style.width = '70px';
    textInput.style.padding = '4px';
    textInput.style.background = 'rgba(255,255,255,0.1)';
    textInput.style.border = '1px solid rgba(255,255,255,0.2)';
    textInput.style.borderRadius = '4px';
    textInput.style.color = '#fff';

    function updateValue(newValue) {
      const val = parseFloat(newValue);
      bondLengths[pair] = val;

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




function createSpinControls(containerId = "spinControls") {
  const container = document.getElementById(containerId);
  container.innerHTML = ""; // Clear previous controls

  // ----- 1️⃣ Input Mode Toggle -----
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

  // ----- 2️⃣ Slider for scaling arrows -----
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

  // ----- 3️⃣ Text Input Panel -----
  const textPanel = document.createElement("div");
  const textarea = document.createElement("textarea");
  textarea.placeholder = "x y z scale color\nExample:\n0 0 1 0.5 #ff0000\n1 1 0 2.0 #0000ff";
  textarea.style.width = "100%";
  textarea.style.height = "120px";
  textarea.style.background= "rgba(16,16,16,0.8)";
  textarea.style.color= "rgb(255, 255, 255)";
  textPanel.appendChild(textarea);


  const drawBtn = document.createElement("button");
  drawBtn.textContent = "Draw Spins";
  drawBtn.style.marginTop = "6px";
  textPanel.appendChild(drawBtn);
  container.appendChild(textPanel);

  // ----- 4️⃣ Viewer Panel -----
  const viewerPanel = document.createElement("div");
  viewerPanel.style.display = "none";
  container.appendChild(viewerPanel);

  // ----- 5️⃣ Mode Switch -----
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

  // ----- 6️⃣ Spins data -----
  let spinsData = [];

  // ----- 7️⃣ Slider live updates -----
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

  // ----- 8️⃣ Parse input & draw -----
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
        console.log("not a number")  
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
  if (!spinsData.length) {
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
  Object.assign(resetBtn.style, {
    padding: "4px 8px",
    borderRadius: "4px",
    border: "1px solid #ccc",
    cursor: "pointer",
    background: "#f6f6f6"
  });

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  Object.assign(applyBtn.style, {
    padding: "4px 8px",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    background: "#007bff",
    color: "#fff"
  });

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
  return bondLengths[pair1] || bondLengths[pair2] || 0.0;
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
  if (measureLine){ scene.remove(measureLine); measureLine.geometry.dispose(); measureLine = null; }
  if (measureLabel){ scene.remove(measureLabel); measureLabel = null; }
}

function clearAllMeasurements(){
  // Clear all stored measurements
  measureLines.forEach(item => {
    scene.remove(item);
    if (item.geometry) item.geometry.dispose();
  });
  measureLabels.forEach(label => {
    scene.remove(label);
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

  scene.add(angleLine1);
  scene.add(angleLine2);
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
    scene.add(rings);
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

  scene.add(label);
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

  scene.add(cylinderGroup);
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
  scene.add(ringsA);
  measureLines.push(ringsA);

  const ringsB = createAtomRings(pb, atomRadiusB, 0xffff00, 0x000000, atom2.userData.element); // Yellow inner, black outer
  ringsB.userData = {
    ...ringsB.userData, // Preserve ring metadata (isAtomMarker, markerType, element)
    type: 'distanceMarker',
    atomIndex: atom2.userData.atomIndex,
    measurementIndex: measureLines.length - 1 // Reference to the cylinder group
  };
  scene.add(ringsB);
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

  scene.add(label);
  measureLabels.push(label);
}

function drawMeasureGraphics(){
  clearMeasureGraphics();

  // Show preview lines/indicators for current selection
  if (measureMode === 'distance' && selectedAtoms.length === 1) {
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
    scene.add(measureLabel);
  } else if (measureMode === 'angle' && selectedAtoms.length > 0) {
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
    scene.add(measureLabel);
  }
}

function clearMeasure(){
  selectedAtoms.forEach(atom => clearHighlightAtom(atom));
  selectedAtoms = [];
  clearMeasureGraphics();
}



function createAtomMesh(element, position, atomIndex = null) {
  const radius = getAtomRadius(element);
  const color = atomIndex !== null ? getIndividualAtomColor(element, atomIndex) : getElementColor(element);
  const geometry = new THREE.SphereGeometry(radius, 32, 24);
  const material = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.3,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.1
  });
  //const material = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.userData.element = element;
  mesh.userData.atomIndex = atomIndex;
  return mesh;
}

function createBond(pos1, pos2, elem1, elem2, atomIndex1, atomIndex2) {
  const p1 = new THREE.Vector3(pos1[0], pos1[1], pos1[2]);
  const p2 = new THREE.Vector3(pos2[0], pos2[1], pos2[2]);
  const dist = distance(p1, p2);
  const cutoff = getBondCutoff(elem1, elem2);

  // If bond length is set to 0 or very small, don't create any bonds
  if (cutoff <= 0.01 || dist > cutoff || dist < 0.005) return null;

  // Check bond visibility
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  const isVisible = bondVisibility[pair1] !== false && bondVisibility[pair2] !== false;

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
  const radius = bondRadius;

  const geometryHalf = new THREE.CylinderGeometry(radius, radius, halfLen, 20);

  const matCommon = {
    transparent: false,
    opacity: 1.0,
    roughness: 0.2,
    metalness: 0.3,
    clearcoat: 0.5,
    clearcoatRoughness: 0.05
  };

  const material1 = new THREE.MeshPhysicalMaterial({ color: color1, ...matCommon });
  const material2 = new THREE.MeshPhysicalMaterial({ color: color2, ...matCommon });

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

function createLatticeLines() {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({
    color: 0x000000,
    transparent: false,
    opacity: 1.0,
    linewidth: 3
  });

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
    if (currentSupercell === null) {
      formula += element + (count > 1 ? `<sub>${count}</sub>` : ''); // Add subscript if count > 1
    } else {
      const supercellSize = currentSupercell.nx * currentSupercell.ny * currentSupercell.nz;
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
  console.log(mom_color[0])

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
    if (currentSupercell != null) {
    input.value = currentSupercell[axis];
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

// Share functionality - moved to shareutils.js

function shareStructure() {
  // Prepare global state object for sharing
  const globalState = {
    userColorOverrides,
    individualAtomColors,
    useVestaColors,
    atomSize,
    bondRadius,
    showBonds,
    showLattice,
    showNeighborBonds,
    useOrthographicCamera,
    bondLengths,
    bondVisibility,
    camera,
    controls,
    measureMode
  };

  // Use complete state sharing instead of basic structure sharing
  const shareURL = createCompleteShareableURL(structureData, globalState);
  if (!shareURL) {
    alert('No structure loaded to share!');
    return;
  }

  // Try modern clipboard API first, then fallback
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareURL).then(() => {
      // Show success message
      const shareBtn = document.getElementById('shareBtn');
      const originalText = shareBtn.textContent;
      shareBtn.textContent = '✓ Copied!';
      shareBtn.style.backgroundColor = '#4CAF50';

      setTimeout(() => {
        shareBtn.textContent = originalText;
        shareBtn.style.backgroundColor = '';
      }, 2000);
    }).catch(() => {
      // Fallback: show URL in prompt for manual copying
      prompt('Copy this URL to share:', shareURL);
    });
  } else {
    // Clipboard API not available, use fallback method
    try {
      // Try the older document.execCommand method
      const textArea = document.createElement('textarea');
      textArea.value = shareURL;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      const success = document.execCommand('copy');
      document.body.removeChild(textArea);

      if (success) {
        // Show success message
        const shareBtn = document.getElementById('shareBtn');
        const originalText = shareBtn.textContent;
        shareBtn.textContent = '✓ Copied!';
        shareBtn.style.backgroundColor = '#4CAF50';

        setTimeout(() => {
          shareBtn.textContent = originalText;
          shareBtn.style.backgroundColor = '';
        }, 2000);
      } else {
        throw new Error('execCommand failed');
      }
    } catch (err) {
      // Final fallback: show URL in prompt for manual copying
      prompt('Copy this URL to share:', shareURL);
    }
  }
}

// Function to create share button UI
function createShareButton() {
  // Check if button already exists
  let shareBtn = document.getElementById('shareBtn');
  if (shareBtn) return;

  shareBtn = document.createElement('button');
  shareBtn.id = 'shareBtn';
  shareBtn.textContent = '🔗 Share All';
  shareBtn.style.cssText = `
    padding: 8px 16px;
    margin-top: 8px;
    background: linear-gradient(135deg, #4CAF50, #45a049);
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s ease;
    width: 100%;
  `;

  shareBtn.addEventListener('mouseenter', () => {
    shareBtn.style.background = 'linear-gradient(135deg, #45a049, #4CAF50)';
    shareBtn.style.transform = 'translateY(-1px)';
  });

  shareBtn.addEventListener('mouseleave', () => {
    shareBtn.style.background = 'linear-gradient(135deg, #4CAF50, #45a049)';
    shareBtn.style.transform = 'translateY(0)';
  });

  shareBtn.onclick = shareStructure;

  // Try multiple locations to ensure the button appears
  const structureControls = document.getElementById('structureControls');

  const bondControlsGroup = document.getElementById('bondControlsGroup');
  const spinControlsGroup = document.getElementById('spinControlsGroup');
  const composition = document.getElementById('composition');

  if (structureControls) {
    structureControls.appendChild(shareBtn);
    console.log('Share button added to structureControls');
  } else if (bondControlsGroup) {
    bondControlsGroup.appendChild(shareBtn);
    console.log('Share button added to bondControlsGroup (fallback)');
  } else if (composition) {
    composition.parentElement.appendChild(shareBtn);
    console.log('Share button added near composition (fallback 2)');
  } else {
    console.error('Could not find a suitable container for share button');
  }
}

// Flag to track if we've loaded a shared structure
let sharedStructureLoaded = false;


// Function to load structure from URL parameter
function loadSharedStructure() {
  const urlParams = new URLSearchParams(window.location.search);
  const stateParam = urlParams.get('state');
  const structureParam = urlParams.get('structure'); // Legacy support

  // Try new complete state format first
  if (stateParam) {
    try {
      const stateJSON = atob(stateParam);
      const completeState = JSON.parse(stateJSON);

      console.log('Loading complete shared state');
      restoreCompleteState(completeState, {
        setStructureData: (data) => { structureData = data; },
        setOriginalStructureData: (data) => { originalStructureData = data; },
        setUserColorOverrides: (overrides) => { userColorOverrides = overrides; },
        setIndividualAtomColors: (colors) => { individualAtomColors = colors; },
        setUseVestaColors: (use) => { useVestaColors = use; },
        setAtomSize: (size) => { atomSize = size; },
        setBondRadius: (radius) => { bondRadius = radius; },
        setShowBonds: (show) => { showBonds = show; },
        setShowLattice: (show) => { showLattice = show; },
        setShowNeighborBonds: (show) => { showNeighborBonds = show; },
        setUseOrthographicCamera: (use) => { useOrthographicCamera = use; },
        setBondLengths: (lengths) => { bondLengths = lengths; },
        setBondVisibility: (visibility) => { bondVisibility = visibility; },
        loadColorOverrides,
        loadIndividualAtomColors,
        updateVisualization,
        createBondLengthControls,
        createSpinControls,
        createBackgroundControl,
        createShareButton,
        switchCameraType,
        resetView,
        clearMeasure,
        resizeRenderer,
        setStatus,
        camera,
        controls
      });

      // Clear the URL parameter
      const newUrl = new URL(window.location);
      newUrl.searchParams.delete('state');
      window.history.replaceState({}, document.title, newUrl.toString());
      sharedStructureLoaded = true;
      return;
    } catch (error) {
      console.error('Failed to load complete state:', error);
      setStatus('Failed to load shared state');
      sharedStructureLoaded = true; // Prevent default structure from loading
      return;
    }
  }

  // Fallback to legacy structure-only sharing
  if (structureParam) {
    try {
      // Decode base64 to get POSCAR string
      const poscarString = atob(structureParam);
      console.log('Decoded POSCAR string:', poscarString);

      // Debug: check the individual lines
      const lines = poscarString.split('\n');
      console.log('POSCAR lines:', lines);
      console.log('Scale line (line 1):', `"${lines[1]}"`);
      console.log('parseFloat of scale line:', parseFloat(lines[1]));
      console.log('isFinite check:', Number.isFinite(parseFloat(lines[1])));

      // Parse the POSCAR string
      console.log('About to call parsePOSCAR...');
      let parsedStructureData;
      try {
        parsedStructureData = parsePOSCAR(poscarString);
        console.log('parsePOSCAR succeeded:', parsedStructureData);
      } catch (parseError) {
        console.error('parsePOSCAR failed:', parseError);
        console.error('Error stack:', parseError.stack);
        throw parseError;
      }

      if (parsedStructureData) {
        // Set the global structure data variable
        structureData = parsedStructureData;
        originalStructureData = JSON.parse(JSON.stringify(structureData));
        loadColorOverrides();
        loadIndividualAtomColors();
        setStatus('Loaded shared structure');

        // Show structure controls and create share button
        document.getElementById('structureControls').style.display = 'block';
        document.getElementById('bondControlsGroup').style.display = 'block';
        document.getElementById('spinControlsGroup').style.display = 'block';
        createBondLengthControls();
        createSpinControls();
        createShareButton();

        console.log('About to call updateVisualization with structure data:', structureData);
        updateVisualization();
        console.log('updateVisualization completed');

        // Rebuild camera and reset view
        console.log('About to rebuild camera and reset view');
        switchCameraType();
        resetView();
        clearMeasure();
        resizeRenderer();
        console.log('Camera rebuild and view reset completed');

        // Clear the URL parameter to clean up the URL
        const newUrl = new URL(window.location);
        newUrl.searchParams.delete('structure');
        window.history.replaceState({}, document.title, newUrl.toString());

        // Set flag to prevent loading default structure
        sharedStructureLoaded = true;
      }
    } catch (error) {
      console.error('Failed to load shared structure:', error);
      console.error('POSCAR string was:', atob(structureParam));
      setStatus('Failed to load shared structure');
    }
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

function disposeGroup(grp) {
  if (!grp) return;
  grp.traverse(obj => {
    if (obj.geometry) { try { obj.geometry.dispose(); } catch(_){} }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(m => { try { m.dispose(); } catch(_){} });
    }
  });
  scene.remove(grp);
}

function updateAtoms() {
  disposeGroup(atomsGroup);
  atomsGroup = new THREE.Group();

  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const atomMesh = createAtomMesh(wrapped.elements[i], wrappedCart[i], originalIndex);
    atomMesh.userData.sourceIndex = originalIndex;
    atomsGroup.add(atomMesh);
  }
  scene.add(atomsGroup);
}

function updateBonds() {
  disposeGroup(bondsGroup);
  bondsGroup = new THREE.Group();

  if (!showBonds) return;

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

  const maxCutoff = Math.max(0.0, ...Object.values(bondLengths || {dummy:0.0}));


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
        } else if (showNeighborBonds) {
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

  scene.add(bondsGroup);
}



function updateSpins(spinData, spinFactor = 1) {
  // Dispose old spin arrows
  if (spinGroup) {
    spinGroup.children.forEach(child => {
      child.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    });
    scene.remove(spinGroup);
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
    const baseLen = dirVec.length();
    const totalLength = baseLen * scalingFactor * spinFactor;
    const dir = dirVec.clone().normalize();

    // --- Material (match atom style) ---
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      roughness: 0.3,
      metalness: 0.05,
      clearcoat: 0.4,
      clearcoatRoughness: 0.1,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.15
    });

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
  scene.add(spinGroup);
}




function updateLattice() {
  disposeGroup(latticeGroup);

  if (showLattice) {
    latticeGroup = createLatticeLines();
    scene.add(latticeGroup);
  }
}

function updateOther() {
  renderComposition();
  clearMeasureGraphics();

  measureLines.forEach(line => scene.add(line));
  measureLabels.forEach(label => scene.add(label));

  recomputeLatticeDirs();
  updateAllMeasurements();
}


// ===== SPINS STATE =====
let showSpins = true;
let spinsGroup = new THREE.Group();

let defaultSpinLength = 1.0;           // default length for spins
let defaultSpinColor  = '#ff3366';     // default color for spins (hex string)
let spinCoordSpace    = 'cart';        // 'cart' or 'frac' (direction input)
let spinTextInput     = '';            // holds raw multi-line text input

// Per-atom spin spec.
// Key is source atom index (structureData.positions index).
// Value: { dir:[ax,by,cz], length?:number, color?:string }
let spinData = new Map();

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

function openBackgroundColorPicker(scene, dot) {
  // Remove any existing picker first
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());

  let currentHex = "#E7E7E7"; 
  if (scene.background) currentHex = "#" + scene.background.getHexString();



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

  // --- Create the color picker using your existing helper ---
  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    dot.style.backgroundColor = hex;           // live preview on dot
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`
    scene.background = new THREE.Color(hex);   // live preview in scene
  });


  dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;

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
  Object.assign(resetBtn.style, {
    padding: "4px 8px",
    borderRadius: "4px",
    border: "1px solid #ccc",
    cursor: "pointer",
    background: "#f6f6f6"
  });

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  Object.assign(applyBtn.style, {
    padding: "4px 8px",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    background: "#007bff",
    color: "#fff"
  });

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
    scene.background = new THREE.Color(selectedHex); // lock in color
    dot.style.backgroundColor = selectedHex;
    closePicker();
  });

  // --- Reset button behavior ---
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedHex = "#E7E7E7";
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`
    scene.background = new THREE.Color(selectedHex);
    dot.style.backgroundColor = selectedHex;
    closePicker();
  });
}


function createBackgroundControl() {
  const dot = document.getElementById("backgroundDot");
  if (!dot) {
    console.error("No element found with ID 'backgroundDot'");
    return;
  }

  let currentBackground = scene.backgrounda

  // Make it visible and clickable
  dot.style.position = "fixed";
  dot.style.zIndex = "9999";
  dot.style.pointerEvents = "auto";
  dot.style.borderRadius = "50%";
  dot.style.backgroundColor = currentBackground;

  dot.style.cursor = "pointer";

  // Attach click listener directly
  dot.addEventListener("click", () => {
    openBackgroundColorPicker(scene, dot); // uncomment when scene is ready
  });
}


function updateVisualization(options = {}) {
  const {
    reRenderAtoms = true,
    reRenderBonds = true,
    reRenderLattice = true,
    reRenderOther = true
  } = options;

  if (!structureData) {
    console.log('No structureData available, returning early');
    return;
  }

  if (reRenderAtoms) updateAtoms();
  if (reRenderBonds) updateBonds();
  if (reRenderLattice) updateLattice();
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

    if (treatAsCIF) {
      structureData = await parseCIF(contentString);
    } else {
      structureData = parsePOSCAR(contentString);
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
    // Rebuild camera with size/distance based on structure and zoom scale
    switchCameraType();
    resetView();
    clearMeasure();
    resizeRenderer();

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}

function loadDefaultStructure() {
  // Don't load default structure if we've already loaded a shared structure
  if (sharedStructureLoaded) {
    console.log('Skipping default structure load - shared structure already loaded');
    return;
  }

  setStatus('Loading default NaCl structure...');
  setTimeout(() => {
    loadStructure(defaultPOSCAR, 'POSCAR', true);
  }, 100);
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xE7E7E7); // maybe dynamically update this to give the option to change the background?

  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;

  // Initialize with orthographic camera by default
  if (useOrthographicCamera) {
    const size = 20; // Initial size - will be adjusted when structure loads
    camera = new THREE.OrthographicCamera(-size, size, size / (w/h), -size / (w/h), 0.1, 1000);
  } else {
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  }

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  // renderer.shadowMap.enabled = false;
  // renderer.outputColorSpace = THREE.SRGBColorSpace;
  // renderer.toneMapping = THREE.NoToneMapping;
  // renderer.toneMappingExposure = 1.0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  view.appendChild(renderer.domElement);

  resizeRenderer();


  // Label for distances
  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(w, h);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  view.appendChild(labelRenderer.domElement);

  atomTooltip = document.createElement('div');
  atomTooltip.className = 'atom-tooltip';
  atomTooltip.setAttribute('aria-hidden', 'true');
  view.appendChild(atomTooltip);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; //damping the rotation for smoother experience
  //controls.dampingFactor = 0.05;
  controls.maxDistance = 1000;
  controls.minDistance = 1;

  controls.enableRotate = true;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;

  // Enable touch controls for mobile
  controls.enableKeys = false; // Disable keyboard controls to avoid conflicts
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN
  };

  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
  };

  // Keep rotation centered on crystal structure
  // Removed auto-reset of controls target to allow proper panning on mobile

  // VESTA-style lighting setup - single camera-relative light

  // Moderate ambient light for base illumination
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  // Single main directional light - positioned relative to camera
  keyLight = new THREE.DirectionalLight(0xffffff, 5.0);
  keyLight.castShadow = false;
  scene.add(keyLight);

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

    const rect = renderer.domElement.getBoundingClientRect();
    const clientX = event.clientX;
    const clientY = event.clientY;
    if (clientX == null || clientY == null) {
      hideAtomTooltip();
      return;
    }

    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    mouse.set(x, y);
    raycaster.setFromCamera(mouse, camera);

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

  renderer.domElement.addEventListener('mousemove', updateAtomTooltip);
  renderer.domElement.addEventListener('mouseleave', hideAtomTooltip);
  renderer.domElement.addEventListener('touchstart', hideAtomTooltip, { passive: true });

  function onClickPick(event){
    // Only handle clicks if a mode is enabled
    if (measureMode === 'none') return;

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

    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;

    mouse.set(x, y);
    raycaster.setFromCamera(mouse, camera);
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
    if (measureMode === 'distance' && selectedAtoms.length === 2) {
      // Distance measurement complete
      addDistanceMeasurement(selectedAtoms[0], selectedAtoms[1]);

      // Clear selection
      selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      selectedAtoms = [];
      clearMeasureGraphics();
    } else if (measureMode === 'angle' && selectedAtoms.length === 3) {
      // Angle measurement complete
      addAngleMeasurement(selectedAtoms[0], selectedAtoms[1], selectedAtoms[2]);

      // Clear selection
      selectedAtoms.forEach(atom => clearHighlightAtom(atom));
      selectedAtoms = [];
      clearMeasureGraphics();
    } else if (measureMode === 'delete') {
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

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    // Raycast to find clicked atom
    raycaster.setFromCamera(mouse, camera);
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
  renderer.domElement.addEventListener('click', onClickPick);

  // Add double-click listener for atom highlighting feature
  renderer.domElement.addEventListener('dblclick', onDoubleClickAtom);


  // Add single click listener to clear highlights when clicking empty space
  renderer.domElement.addEventListener('click', (event) => {
    // Only clear highlights if no measurement mode is active
    if (measureMode === 'none') {
      // Small delay to avoid conflicts with double-click
      setTimeout(() => {
        // Check if we clicked on empty space
        const rect = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        const clientX = event.clientX || (event.changedTouches && event.changedTouches[0].clientX);
        const clientY = event.clientY || (event.changedTouches && event.changedTouches[0].clientY);

        if (clientX && clientY) {
          mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

          raycaster.setFromCamera(mouse, camera);
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
const el = renderer.domElement;

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


  // Axes gizmo (bottom-left)
  const gizmoDiv = document.getElementById('axesGizmo');
  gizmoRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  gizmoRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  gizmoDiv.appendChild(gizmoRenderer.domElement);

  // No label renderer needed for gizmo - labels are in separate legend

  gizmoScene = new THREE.Scene();
  gizmoCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  gizmoCamera.position.set(0, 0, 3);
  gizmoCamera.lookAt(0, 0, 0);

  const arrowLen = 1.3, headLen = 0.35, headWidth = 0.22;
  const makeArrow = (color) => new THREE.ArrowHelper(
    new THREE.Vector3(1,0,0), new THREE.Vector3(0,0,0), arrowLen, color, headLen, headWidth
  );
  const aArrow = makeArrow(0xff3333);
  const bArrow = makeArrow(0x33cc33);
  const cArrow = makeArrow(0x3366ff);
  gizmoScene.add(aArrow, bArrow, cArrow);

  // No labels needed inside gizmo - they're in the external legend

  // keep handles for animate()
  gizmoScene.userData.aArrow = aArrow;
  gizmoScene.userData.bArrow = bArrow;
  gizmoScene.userData.cArrow = cArrow;

function sizeGizmo(){
  const w = gizmoDiv.clientWidth || 110; 
  const h = gizmoDiv.clientHeight || 110;
  gizmoRenderer.setSize(w, h);
  gizmoCamera.aspect = w / h;
  gizmoCamera.updateProjectionMatrix();
}
  sizeGizmo();



  document.getElementById('viewX').onclick = () => setViewDirection([1,0,0]);
  document.getElementById('viewY').onclick = () => setViewDirection([0,1,0]);
  document.getElementById('viewZ').onclick = () => setViewDirection([0,0,1]);

  document.getElementById('viewA').onclick = () => { const {a} = latticeDirs(); setViewDirection(a); };
  document.getElementById('viewB').onclick = () => { const {b} = latticeDirs(); setViewDirection(b); };
  document.getElementById('viewC').onclick = () => { const {c} = latticeDirs(); setViewDirection(c); };
  document.getElementById('resetView').onclick = () => resetView();

  setupStructureInput({
    onLoadStructure: (content, name) => loadStructure(content, name),
    setStatus,
  });

  // Check for shared structure in URL
  loadSharedStructure();

  // Control handlers
  document.getElementById('showBonds').onchange = (e) => {
    showBonds = e.target.checked;
    updateVisualization();
  };

  document.getElementById('showLattice').onchange = (e) => {
    showLattice = e.target.checked;
    updateVisualization();
  };

  // Toggle for VESTA-style neighbor bonds/ghost atoms
  const neighborBondsEl = document.getElementById('neighborBonds');
  if (neighborBondsEl) {
    neighborBondsEl.onchange = (e) => {
      showNeighborBonds = e.target.checked;
      updateVisualization();
    };
  }

  document.getElementById('atomSize').oninput = (e) => {
    atomSize = parseFloat(e.target.value);
    document.getElementById('atomSizeValue').textContent = atomSize.toFixed(1);
    updateVisualization();
    updateMeasurementMarkers(); // Update ring markers when atom size changes
  };

  // Bond width control
  const bondWidthSlider = document.getElementById('bondWidth');
  const bondWidthValue = document.getElementById('bondWidthValue');
  if (bondWidthSlider && bondWidthValue) {
    bondWidthSlider.oninput = (e) => {
      const v = parseFloat(e.target.value);
      // clamp defensively
      bondRadius = Math.max(0.005, Math.min(1.0, isNaN(v) ? bondRadius : v));
      bondWidthValue.textContent = bondRadius.toFixed(2);
      updateVisualization();
    };
  }

  // New control handlers
  document.getElementById('orthographicCamera').onchange = (e) => {
    useOrthographicCamera = e.target.checked;
    switchCameraType();
  };

  document.getElementById('vestaColors').onchange = (e) => {
    useVestaColors = e.target.checked;
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
    const wasActive = measureMode === 'distance';

    // Clear previous mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      measureMode = 'none';
    } else {
      measureMode = 'distance';
      button.classList.add('active');
    }
  });

  document.getElementById('angleModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('angleModeBtn');
    const wasActive = measureMode === 'angle';

    // Clear previous mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      measureMode = 'none';
    } else {
      measureMode = 'angle';
      button.classList.add('active');
    }
  });

  // Delete atom mode
  document.getElementById('deleteModeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const button = document.getElementById('deleteModeBtn');
    const wasActive = measureMode === 'delete';

    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    selectedAtoms.forEach(atom => clearHighlightAtom(atom));
    selectedAtoms = [];
    clearMeasureGraphics();

    if (wasActive) {
      measureMode = 'none';
    } else {
      measureMode = 'delete';
      button.classList.add('active');
    }
  });

  document.getElementById('clearAllMeasurements').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    clearAllMeasurements();
    // Also clear active measurement mode
    document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
    measureMode = 'none';

    // Also restore deleted atoms
    if (originalStructureData) {
      const currentLattice = structureData.lattice
      structureData = JSON.parse(JSON.stringify(originalStructureData));

      if (modifiedLattice != null){
        structureData.lattice = modifiedLattice
      }
      if (currentSupercell != null){
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
        atomSize = v; // apply slider value to internal scale
        if (span) span.textContent = atomSize.toFixed(1);
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
        bondRadius = v;
        if (span) span.textContent = bondRadius.toFixed(2);
        if (structureData) updateVisualization();
      }
    }
  })();

  camera.position.set(20, 20, 20);
  controls.update();

  animate();

  // Load default structure after everything is initialized
  loadDefaultStructure();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  // Update camera-relative lighting position
  const cameraPosition = camera.position.clone();

  // Single key light from upper front-right relative to camera
  keyLight.position.copy(cameraPosition).add(
    new THREE.Vector3(3, 4, 3).applyQuaternion(camera.quaternion)
  );

  renderer.render(scene, camera);
  const invCamQ = camera.quaternion.clone().invert();
  const { a, b, c } = latticeDirsNorm();

  gizmoScene.userData.aArrow.setDirection(a.clone().applyQuaternion(invCamQ));
  gizmoScene.userData.bArrow.setDirection(b.clone().applyQuaternion(invCamQ));
  gizmoScene.userData.cArrow.setDirection(c.clone().applyQuaternion(invCamQ));

  gizmoRenderer.render(gizmoScene, gizmoCamera);
  labelRenderer.render(scene, camera);

}

// window resize
function resizeRenderer() {
  if (!renderer || !camera) return;
  const w = view.clientWidth || window.innerWidth;
  const h = view.clientHeight || window.innerHeight;
  const aspect = w / h;

  if (camera.isOrthographicCamera) {
    const base = orthographicFrustumSize || 10;
    camera.left = -base;
    camera.right = base;
    camera.top = base / aspect;
    camera.bottom = -base / aspect;
  } else if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);

  if (labelRenderer) {
    labelRenderer.setSize(w, h);
  }

  if (gizmoRenderer && gizmoCamera) {
    const gizmoDiv = document.getElementById('axesGizmo');
    if (gizmoDiv) {
      const gw = gizmoDiv.clientWidth || 110;
      const gh = gizmoDiv.clientHeight || 110;
      gizmoRenderer.setSize(gw, gh);
      gizmoCamera.aspect = gw / gh;
      gizmoCamera.updateProjectionMatrix();
    }
  }
}

window.addEventListener('resize', resizeRenderer);
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
      resizeRenderer();
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
resetView();
setupMobileMenu();
