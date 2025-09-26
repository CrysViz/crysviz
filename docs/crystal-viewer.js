import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'https://unpkg.com/three@0.160.0/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
//import { RoomEnvironment } from 'https://unpkg.com/three@0.160.0/examples/jsm/environments/RoomEnvironment.js';
import { setupStructureInput, isLikelyCIFContent, parsePOSCAR, parseCIF, cartToFractional } from './structure-input.js';

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
let atomsGroup, bondsGroup, latticeGroup;
let structureData = null;
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
  H: 0xffffff, He: 0xffc0cb, Li: 0xb22222, Be: 0x00ff00, B: 0x00ffff, C: 0x652e00, N: 0x9ea6b0, O: 0xff0000,
  F: 0xdaa520, Ne: 0xffc0cb, Na: 0x0000ff, Mg: 0x228b22, Al: 0x808090, Si: 0xdaa520, P: 0xff8c00, S: 0xffff00,
  Cl: 0x00ff00, Ar: 0xffc0cb, K: 0x8f40d4, Ca: 0x808090, Sc: 0xff1493, Ti: 0x808090, V: 0xff1493, Cr: 0x808090,
  Mn: 0x808090, Fe: 0xff8c00, Co: 0xff1493, Ni: 0x228b22, Cu: 0x8b4513, Zn: 0x808090, Ga: 0xff1493, Ge: 0xff1493,
  As: 0xff1493, Se: 0xff8c00, Br: 0x8b4513, Kr: 0xffc0cb, Rb: 0xff1493, Sr: 0x00ff00, Y: 0xff1493, Zr: 0xff1493,
  Nb: 0xff1493, Mo: 0xff1493, Tc: 0xff1493, Ru: 0xff1493, Rh: 0xff1493, Pd: 0xff1493, Ag: 0x808090, Cd: 0xff1493,
  In: 0xff1493, Sn: 0xff1493, Sb: 0xff1493, Te: 0xff1493, I: 0x8b4513, Xe: 0xffc0cb, Cs: 0xff1493, Ba: 0xff8c00,
  La: 0xff1493, Ce: 0xff1493, Pr: 0xff1493, Nd: 0xff1493, Pm: 0xff1493, Sm: 0xff1493, Eu: 0xff1493, Gd: 0xff1493,
  Tb: 0xff1493, Dy: 0xff1493, Ho: 0xff1493, Er: 0xff1493, Tm: 0xff1493, Yb: 0xff1493, Lu: 0xff1493, Hf: 0xff1493,
  Ta: 0xff1493, W: 0xff1493, Re: 0xff1493, Os: 0xff1493, Ir: 0xff1493, Pt: 0xff1493, Au: 0xffd700, Hg: 0xff1493,
  Tl: 0xff1493, Pb: 0x3c3d3f, Bi: 0xff1493, Po: 0xff1493, At: 0xff1493, Rn: 0xffc0cb
}; //not really, but close enough

function getElementColor(element) {
  // Prefer user override if present
  if (userColorOverrides && userColorOverrides[element] !== undefined) {
    return userColorOverrides[element];
  }
  const colorScheme = useVestaColors ? vestaColors : jmolColors;
  return colorScheme[element] || 0x808080;
}

// Get the default palette color for an element (ignores user overrides)
function getDefaultElementColor(element) {
  const colorScheme = useVestaColors ? vestaColors : jmolColors;
  return colorScheme[element] || 0x808080;
}

function saveColorOverrides() {
  try { localStorage.setItem('atomColorOverrides', JSON.stringify(userColorOverrides || {})); } catch (_) {}
}
function loadColorOverrides() {
  try {
    const raw = localStorage.getItem('atomColorOverrides');
    if (raw) userColorOverrides = JSON.parse(raw) || {};
  } catch (_) { userColorOverrides = {}; }
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
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide
  });
  const outerRing = new THREE.Mesh(outerRingGeometry, outerRingMaterial);
  outerRing.lookAt(camera.position);
  ringGroup.add(outerRing);

  // Inner ring - scales with atom
  const innerRingGeometry = new THREE.RingGeometry(radius * 0.9, radius * 1.05, 32);
  const innerRingMaterial = new THREE.MeshBasicMaterial({
    color: innerColor,
    transparent: true,
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
    valueSpan.textContent = `${bondLengths[pair].toFixed(3)} Å`;
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
    textInput.max = '10.0';
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

function distance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getBondCutoff(elem1, elem2) {
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  return bondLengths[pair1] || bondLengths[pair2] || 3.0;
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

  scene.add(angleLine1);
  scene.add(angleLine2);
  measureLines.push(angleLine1);
  measureLines.push(angleLine2);

  // Add markers to all three atoms
  [atom1, atom2, atom3].forEach((atom, index) => {
    const atomRadius = getAtomRadius(atom.userData.element);
    const color = index === 1 ? 0x00ff00 : 0x00ff88; // Vertex gets different color

    const rings = createAtomRings(atom.position, atomRadius, color, 0x000000, atom.userData.element);
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

  scene.add(cylinderGroup);
  measureLines.push(cylinderGroup);

  // Create atom-size-aware surface markers

  // Get atom radii for proper scaling
  const atomRadiusA = getAtomRadius(atom1.userData.element);
  const atomRadiusB = getAtomRadius(atom2.userData.element);

  // Add scaling rings to both atoms
  const ringsA = createAtomRings(pa, atomRadiusA, 0xffff00, 0x000000, atom1.userData.element); // Yellow inner, black outer
  scene.add(ringsA);
  measureLines.push(ringsA);

  const ringsB = createAtomRings(pb, atomRadiusB, 0xffff00, 0x000000, atom2.userData.element); // Yellow inner, black outer
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



function createAtomMesh(element, position) {
  const radius = getAtomRadius(element);
  const color = getElementColor(element);
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
  return mesh;
}

function createBond(pos1, pos2, elem1, elem2) {
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

  const color1 = getElementColor(elem1);
  const color2 = getElementColor(elem2);

  // Compute visible segment between atom surfaces
  const r1 = getAtomRadius(elem1);
  const r2 = getAtomRadius(elem2);
  const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
  const visibleLen = Math.max(dist - (r1 + r2), 0);
  if (visibleLen <= 1e-3) return null; // spheres overlap or touch; skip bond

  const halfLen = visibleLen * 0.5;
  const radius = bondRadius;

  const geometryHalf = new THREE.CylinderGeometry(radius, radius, halfLen, 8);

  const matCommon = {
    transparent: true,
    opacity: 0.8,
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
    transparent: true,
    opacity: 0.7,
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

function renderComposition() {
  const compDiv = document.getElementById('composition');
  compDiv.innerHTML = '';
  const counts = computeComposition();
  const total = Object.values(counts).reduce((a,b)=>a+b,0) || 1;
  const elements = Object.keys(counts).sort();

  // Create collapsible structure if more than 3 elements
  if (elements.length > 3) {
    elements.slice(0, 3).forEach(el => {
      const row = createCompositionRow(el, counts[el], total);
      compDiv.appendChild(row);
    });

    // Add expand/collapse toggle
    const toggleRow = document.createElement('div');
    toggleRow.className = 'comp-toggle';
    toggleRow.style.cssText = 'padding: 4px 0; cursor: pointer; color: #4fc3f7; font-size: 11px; text-align: center; border-top: 1px dashed rgba(255,255,255,0.1); margin-top: 4px;';
    toggleRow.textContent = `+${elements.length - 3} more`;

    const hiddenDiv = document.createElement('div');
    hiddenDiv.className = 'comp-hidden';
    hiddenDiv.style.display = 'none';

    elements.slice(3).forEach(el => {
      const row = createCompositionRow(el, counts[el], total);
      hiddenDiv.appendChild(row);
    });

    toggleRow.onclick = () => {
      const isHidden = hiddenDiv.style.display === 'none';
      hiddenDiv.style.display = isHidden ? 'block' : 'none';
      toggleRow.textContent = isHidden ? '− collapse' : `+${elements.length - 3} more`;
    };

    compDiv.appendChild(toggleRow);
    compDiv.appendChild(hiddenDiv);
  } else {
    elements.forEach(el => {
      const row = createCompositionRow(el, counts[el], total);
      compDiv.appendChild(row);
    });
  }
}

function createCompositionRow(el, count, total) {
  const row = document.createElement('div');
  row.className = 'comp-row';
  // Two-column grid: left (fixed auto), right (flex). Editor lives under right.
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px;';
  const left = document.createElement('div');
  left.className = 'comp-left';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const currentColor = colorHexToCss(getElementColor(el));
  dot.style.background = currentColor;
  const name = document.createElement('span');
  name.textContent = el;
  left.appendChild(dot);
  left.appendChild(name);

  const right = document.createElement('span');
  const pct = (100*count/total).toFixed(1);
  right.textContent = `${count} (${pct}%)`;

  row.appendChild(left); // grid col 1
  row.appendChild(right); // grid col 2

  // Inline color editor (hidden by default)
  const editor = document.createElement('div');
  // Make editor occupy only the right column and not depend on name length
  editor.style.cssText = 'display:none; grid-column:2; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;';
  editor.className = 'color-editor';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = currentColor;
  colorInput.style.width = '28px';
  colorInput.style.height = '28px';
  colorInput.style.border = 'none';
  colorInput.style.background = 'transparent';

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = currentColor;
  hexInput.placeholder = '#RRGGBB';
  hexInput.style.cssText = 'flex:1; height:28px; padding:6px 8px; border-radius:6px; background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.1); color:#e7f5ff; font-size:12px; box-sizing:border-box;';

  // Top line: color swatch + hex field side by side
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:6px;';
  topRow.appendChild(colorInput);
  topRow.appendChild(hexInput);

  // Buttons container to push Apply to the right
  const btnBar = document.createElement('div');
  btnBar.style.cssText = 'display:flex; align-items:center; gap:8px; justify-content:space-between;';

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.height = '30px';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.height = '30px';

  btnBar.appendChild(resetBtn);
  btnBar.appendChild(applyBtn);

  editor.appendChild(topRow);
  editor.appendChild(btnBar);
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

  // Reset clears override and refreshes (composition also rerendered inside updateVisualization)
  resetBtn.onclick = () => { clearElementColorOverride(el); updateVisualization(); };

  // Apply commits the chosen color
  applyBtn.onclick = () => {
    const val = hexInput.value;
    const ok = setElementColorOverride(el, val);
    if (ok) { updateVisualization(); }
  };
  return row;
}



function updateVisualization() {
  if (!structureData) return;

  // Clear existing geometry and dispose GPU resources
  const disposeGroup = (grp) => {
    if (!grp) return;
    grp.traverse(obj => {
      if (obj.geometry) { try { obj.geometry.dispose(); } catch(_){} }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => { try { m.dispose(); } catch(_){} });
      }
    });
    scene.remove(grp);
  };
  disposeGroup(atomsGroup);
  disposeGroup(bondsGroup);
  disposeGroup(latticeGroup);

  atomsGroup = new THREE.Group();
  bondsGroup = new THREE.Group();
  latticeGroup = new THREE.Group();

  // Create atoms to mimic PBC inside the cell: draw base atoms plus
  // face/edge duplicates that still lie within the unit cell bounds.
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  for (let i = 0; i < wrappedCart.length; i++) {
    const atomMesh = createAtomMesh(wrapped.elements[i], wrappedCart[i]);
    atomMesh.userData.sourceIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    atomsGroup.add(atomMesh);
  }

  // Create bonds
  if (showBonds) {
    // 1) Bonds entirely inside the unit cell among the wrapped atoms
    //    (fills corners/edges). This guarantees the box is fully connected.
    for (let i = 0; i < wrappedCart.length; i++) {
      for (let j = i + 1; j < wrappedCart.length; j++) {
        const ei = wrapped.elements[i];
        const ej = wrapped.elements[j];
        const bond = createBond(wrappedCart[i], wrappedCart[j], ei, ej);
        if (bond) bondsGroup.add(bond);
      }
    }

    // 2) Neighbor bonds to atoms outside the cell (ghosts)
    //    Use a minimum-image approach on the reference cell and
    //    explicitly add ghost atoms when needed.
    const lattice = structureData.lattice;
    const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
    const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
    const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);

    // Treat the filled unit cell as primary
    const primCarts = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const primElems = wrapped.elements;

    // Precompute translation range dynamically from current maximum cutoff
    const maxCutoff = Math.max(3.0, ...Object.values(bondLengths || {dummy:3.0}));
    const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
    const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
    const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
    const shifts = [];
    for (let dx = -ax; dx <= ax; dx++)
      for (let dy = -by; dy <= by; dy++)
        for (let dz = -cz; dz <= cz; dz++)
          shifts.push([dx, dy, dz]);

    const ghostAdded = new Map(); // key -> mesh (for potential styling later)
    const bondDedupe = new Set();

    for (let i = 0; i < primCarts.length; i++) {
      const pi = primCarts[i];
      const ei = primElems[i];
      for (let j = 0; j < primCarts.length; j++) {
        if (j === i) continue;
        const pj = primCarts[j];
        const ej = primElems[j];

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
            // Already handled in step (1) via wrapped bonds; skip here to avoid dupes
          } else if (showNeighborBonds) {
            // Only show true ghosts (position must lie outside the unit cell)
            const candidateArr = [candidate.x, candidate.y, candidate.z];
            if (!isOutsideUnitCell(candidateArr, lattice)) continue;
            const gkey = `${j}:${dx},${dy},${dz}`;
            let ghostMesh = ghostAdded.get(gkey);
            if (!ghostMesh) {
              ghostMesh = createAtomMesh(ej, [candidate.x, candidate.y, candidate.z]);
              ghostMesh.userData.isGhost = true;
              // Make ghost atoms feel translucent and slightly smaller
              ghostMesh.material.opacity = 0.35;
              ghostMesh.material.transparent = true;
              ghostMesh.material.depthWrite = false;
              atomsGroup.add(ghostMesh);
              ghostAdded.set(gkey, ghostMesh);
            }
            const bkey = `${i}-${j}-${dx},${dy},${dz}`;
            if (!bondDedupe.has(bkey)) {
              const bond = createBond([pi.x, pi.y, pi.z], [candidate.x, candidate.y, candidate.z], ei, ej);
              if (bond) {
                // Fade the half connected to the ghost atom
                if (bond.children && bond.children[1] && bond.children[1].material) {
                  bond.children[1].material.transparent = true;
                  bond.children[1].material.opacity = 0.5;
                }
                bondsGroup.add(bond);
              }
              bondDedupe.add(bkey);
            }

            // Symmetric ghost on the opposite side: ghost image of atom i
            const opposite = pi.clone().sub(shiftVec);
            if (isOutsideUnitCell([opposite.x, opposite.y, opposite.z], lattice)) {
              const gkey2 = `${i}:${-dx},${-dy},${-dz}`;
              if (!ghostAdded.has(gkey2)) {
                const ghostMesh2 = createAtomMesh(ei, [opposite.x, opposite.y, opposite.z]);
                ghostMesh2.userData.isGhost = true;
                ghostMesh2.material.opacity = 0.35;
                ghostMesh2.material.transparent = true;
                ghostMesh2.material.depthWrite = false;
                atomsGroup.add(ghostMesh2);
                ghostAdded.set(gkey2, ghostMesh2);
              }
              const bkey2 = `sym-${i}-${j}-${dx},${dy},${dz}`;
              if (!bondDedupe.has(bkey2)) {
                const bond2 = createBond([opposite.x, opposite.y, opposite.z], [pj.x, pj.y, pj.z], ei, ej);
                if (bond2) {
                  if (bond2.children && bond2.children[0] && bond2.children[0].material) {
                    bond2.children[0].material.transparent = true;
                    bond2.children[0].material.opacity = 0.5;
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
  }

  // Create lattice
  if (showLattice) {
    latticeGroup = createLatticeLines();
  }

  scene.add(atomsGroup);
  if (showBonds) scene.add(bondsGroup);
  if (showLattice) scene.add(latticeGroup);

  renderComposition();
  clearMeasureGraphics();

  // Re-add persistent measurements
  measureLines.forEach(line => scene.add(line));
  measureLabels.forEach(label => scene.add(label));

  // Update cached lattice directions for gizmo
  recomputeLatticeDirs();
}

function colorHexToCss(hex) {
    const s = hex.toString(16).padStart(6,'0');
    return `#${s}`;
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
    if (isDefault) {
      setStatus(`Default structure: ${structureData.elements.length} atoms`);
    } else {
      setStatus(`Loaded: ${structureData.elements.length} atoms`);
    }

    document.getElementById('structureControls').style.display = 'block';
    document.getElementById('bondControlsGroup').style.display = 'block';

    createBondLengthControls();
    updateVisualization();
    // Rebuild camera with size/distance based on structure and zoom scale
    switchCameraType();
    resetView();
    clearMeasure();
    resizeRenderer();
    // Hide restore button when loading new structure
    const btn = document.getElementById('restoreStructure');
    if (btn) btn.classList.remove('visible');

  } catch (error) {
    setStatus(`Error: ${error.message}`);
    console.error(error);
  }
}

function loadDefaultStructure() {
  setStatus('Loading default NaCl structure...');
  setTimeout(() => {
    loadStructure(defaultPOSCAR, 'POSCAR', true);
  }, 100);
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf8f9fa);

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
    if (!element) {
      hideAtomTooltip();
      return;
    }

    if (hoveredAtom !== hit) {
      hoveredAtom = hit;
      atomTooltip.textContent = element;
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
        updateVisualization();
        // Show restore button
        const btn = document.getElementById('restoreStructure');
        if (btn) btn.classList.add('visible');
      }
      return; // nothing else to do in delete mode
    }

    drawMeasureGraphics();
  }

  // Add event listeners - use touchstart instead of touchend for better responsiveness
  renderer.domElement.addEventListener('click', onClickPick);
  renderer.domElement.addEventListener('touchstart', onClickPick, { passive: false });


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

  document.getElementById('resetView').onclick = resetView;
  const restoreBtn = document.getElementById('restoreStructure');
  if (restoreBtn) {
    restoreBtn.onclick = () => {
      if (!originalStructureData) return;
      structureData = JSON.parse(JSON.stringify(originalStructureData));
      createBondLengthControls();
      updateVisualization();
      clearMeasure();
      restoreBtn.classList.remove('visible');
    };
  }
  setupStructureInput({
    onLoadStructure: (content, name) => loadStructure(content, name),
    setStatus,
  });

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

// Mobile menu functionality
function setupMobileMenu() {
  const mobileToggle = document.getElementById('mobileMenuToggle');
  const mobileOverlay = document.getElementById('mobileOverlay');
  const ui = document.getElementById('ui');


  function toggleMobileMenu() {
    if (ui && mobileOverlay) {
      ui.classList.toggle('mobile-open');
      mobileOverlay.classList.toggle('active');
      // Reflect drawer state on body for responsive positioning
      if (ui.classList.contains('mobile-open')) {
        document.body.classList.add('panel-open');
      } else {
        document.body.classList.remove('panel-open');
      }
    }
  }

  function closeMobileMenu() {
    if (ui && mobileOverlay) {
      ui.classList.remove('mobile-open');
      mobileOverlay.classList.remove('active');
      document.body.classList.remove('panel-open');
    }
  }

  if (mobileToggle) {
    mobileToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileMenu();
    });

    mobileToggle.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileMenu();
    });
  }

  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', (e) => {
      e.preventDefault();
      closeMobileMenu();
    });

    mobileOverlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      closeMobileMenu();
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
