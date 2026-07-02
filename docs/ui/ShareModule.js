import { app, general, measurements, fileBrowser } from '../state/store.js';
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR } from './StructureInputModule.js';
import { updateAtoms } from '../render/index.js';
import { rebuildBonds } from '../render/index.js';
import { addDistanceMeasurement, addAngleMeasurement, serializeMeasurementRef } from '../render/MeasurementModule.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { revealFeaturePanels } from './panels/PanelManager.js';
import { fracToCart } from '../math/index.js';

const URL_WARN_CHARS = 4000;
const URL_HARD_CHARS = 10000;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function captureState() {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return null;

  // Per-atom color overrides — only atoms whose color differs from their element color
  const atomColors = {};
  structure.atoms.forEach((atom, i) => {
    if (atom.color !== atom.elementColor) atomColors[i] = atom.color;
  });

  // Per-element color overrides — first occurrence per element
  const elementColors = {};
  structure.atoms.forEach((atom, i) => {
    const el = structure.elements[i];
    if (!(el in elementColors)) elementColors[el] = atom.elementColor;
  });

  // Measurements — labels carry the authoritative userData
  const measurementData = measurements.measureLabels
    .map((l) => {
      const data = l.userData;
      if (!data?.type) return null;
      if (data.type === 'distance') {
        return {
          type: 'distance',
          atom1Ref: serializeMeasurementRef(data.atom1Ref),
          atom2Ref: serializeMeasurementRef(data.atom2Ref),
        };
      }
      if (data.type === 'angle') {
        return {
          type: 'angle',
          atom1Ref: serializeMeasurementRef(data.atom1Ref),
          atom2Ref: serializeMeasurementRef(data.atom2Ref),
          atom3Ref: serializeMeasurementRef(data.atom3Ref),
        };
      }
      return data;
    })
    .filter(d => d && d.type);

  return {
    version: '2.0',
    structure: {
      elements: [...structure.elements],
      lattice: structure.lattice.map(r => [...r]),
      positions: structure.atoms.map(a => [...a.position]),
    },
    colors: {
      atomColors,
      elementColors,
      useDefaultColors: general.useDefaultColors,
    },
    display: {
      atomSize: general.atomSize,
      showAtoms: general.showAtoms,
      showBonds: general.showBonds,
      showLattice: general.showLattice,
      showPeriodic: general.showPeriodic,
      periodicFaceTol: general.periodicFaceTol,
      showPBCBonds: general.showPBCBonds,
      bondLengths: { ...general.bondLengths },
      bondVisibility: { ...general.bondVisibility },
    },
    camera: {
      position: app.camera
        ? [app.camera.position.x, app.camera.position.y, app.camera.position.z]
        : null,
      target: app.controls
        ? [app.controls.target.x, app.controls.target.y, app.controls.target.z]
        : null,
      zoom: app.camera?.zoom ?? null,
    },
    measurements: measurementData,
  };
}

// ---------------------------------------------------------------------------
// POSCAR builder (for encoding into the URL)
// ---------------------------------------------------------------------------

function buildPOSCAR(state) {
  const { elements, lattice, positions } = state.structure;

  const seen = new Set();
  const uniqueElements = [];
  for (const el of elements) {
    if (!seen.has(el)) { seen.add(el); uniqueElements.push(el); }
  }

  const counts = uniqueElements.map(el => elements.filter(e => e === el).length);

  const lines = [
    'Shared via CrysViz',
    '   1.0',
    ...lattice.map(v => v.map(x => x.toFixed(8).padStart(18)).join('')),
    '   ' + uniqueElements.join('   '),
    '   ' + counts.join('   '),
    'Direct',
  ];

  for (const el of uniqueElements) {
    elements.forEach((e, i) => {
      if (e === el) lines.push(positions[i].map(v => v.toFixed(8).padStart(18)).join(''));
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Share (capture → encode → clipboard)
// ---------------------------------------------------------------------------

export function shareStructure() {
  const state = captureState();
  if (!state) { alert('No structure loaded to share.'); return; }

  // TextEncoder → Uint8Array → btoa avoids Latin-1 limitation of btoa(string)
  const jsonBytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = '';
  for (let i = 0; i < jsonBytes.length; i++) binary += String.fromCharCode(jsonBytes[i]);
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  if (b64.length > URL_HARD_CHARS) {
    const kb = (b64.length / 1024).toFixed(1);
    const ok = confirm(
      `Warning: the share URL is very large (${kb} KB). It may not work in all browsers or messaging platforms. Continue?`
    );
    if (!ok) return;
  } else if (b64.length > URL_WARN_CHARS) {
    console.warn(`Share URL is ${(b64.length / 1024).toFixed(1)} KB — may be large for some platforms.`);
  }

  const shareURL = new URL(window.location.href);
  shareURL.searchParams.set('state', b64);

  // Always show URL in prompt so user can copy the full text (address bar truncates long URLs).
  // Also attempt clipboard write for convenience.
  const shareURLText = shareURL.toString();
  navigator.clipboard?.writeText(shareURLText).catch(() => {});
  prompt('Share URL (select all and copy):', shareURLText);
}

// ---------------------------------------------------------------------------
// Restore helpers
// ---------------------------------------------------------------------------

function applyDisplaySettings(display) {
  if (!display) return;

  const setToggle = (id, val) => {
    if (val == null) return;
    const el = document.getElementById(id);
    if (el) el.checked = val;
  };

  if (display.atomSize != null) {
    general.atomSize = display.atomSize;
    const s = document.getElementById('atomSize');
    const sv = document.getElementById('atomSizeValue');
    if (s) s.value = display.atomSize;
    if (sv) sv.textContent = Number(display.atomSize).toFixed(2);
  }
  if (display.showAtoms != null)   { general.showAtoms   = display.showAtoms;   setToggle('showAtoms', display.showAtoms); }
  if (display.showBonds != null)   { general.showBonds   = display.showBonds;   setToggle('showBonds', display.showBonds); }
  if (display.showLattice != null) { general.showLattice = display.showLattice; setToggle('showLattice', display.showLattice); }
  if (display.showPeriodic != null){ general.showPeriodic= display.showPeriodic;setToggle('showPeriodic', display.showPeriodic); }
  if (display.periodicFaceTol != null){ general.periodicFaceTol = display.periodicFaceTol; }
  if (display.showPBCBonds != null){ general.showPBCBonds= display.showPBCBonds;setToggle('PBCBondToggle', display.showPBCBonds); }
  if (display.bondLengths)    Object.assign(general.bondLengths, display.bondLengths);
  if (display.bondVisibility) Object.assign(general.bondVisibility, display.bondVisibility);
}

function applyAtomColors(colors, structure) {
  if (!colors || !structure) return;

  if (colors.useDefaultColors != null) general.useDefaultColors = colors.useDefaultColors;

  if (colors.elementColors) {
    structure.atoms.forEach((atom, i) => {
      const el = structure.elements[i];
      if (colors.elementColors[el] != null) {
        atom.elementColor = colors.elementColors[el];
        atom.color = colors.elementColors[el];
      }
    });
  }

  if (colors.atomColors) {
    Object.entries(colors.atomColors).forEach(([idx, color]) => {
      const atom = structure.atoms[parseInt(idx)];
      if (atom) atom.color = color;
    });
  }
}

function atomKey(element, position) {
  return [
    element,
    ...position.map(v => Number(v).toFixed(8)),
  ].join('|');
}

function restoreAtomOrder(savedStructure, loadedStructure) {
  if (!savedStructure || !loadedStructure?.atoms?.length) return;

  const buckets = new Map();
  loadedStructure.atoms.forEach((atom, i) => {
    const key = atomKey(loadedStructure.elements[i], atom.position);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      element: loadedStructure.elements[i],
      atom,
    });
  });

  const reorderedAtoms = [];
  const reorderedElements = [];

  for (let i = 0; i < savedStructure.elements.length; i++) {
    const key = atomKey(savedStructure.elements[i], savedStructure.positions[i]);
    const bucket = buckets.get(key);
    if (!bucket?.length) {
      console.warn('Failed to restore original atom order for shared structure at index', i, key);
      return;
    }

    const match = bucket.shift();
    reorderedAtoms.push(match.atom);
    reorderedElements.push(match.element);
  }

  loadedStructure.atoms = reorderedAtoms;
  loadedStructure.elements = reorderedElements;
  loadedStructure.uniqueElements = [...new Set(reorderedElements)];
}

function restoreCamera(camState) {
  if (!camState?.position || !camState?.target) return;
  setTimeout(() => {
    app.camera.position.set(...camState.position);
    app.controls.target.set(...camState.target);
    if (camState.zoom != null) {
      app.camera.zoom = camState.zoom;
      app.camera.updateProjectionMatrix();
    }
    app.controls.update();
  }, 150);
}

function restoreMeasurements(measurementData) {
  if (!measurementData?.length) return;
  setTimeout(() => {
    const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
    if (!wrapped) return;

    measurementData.forEach(m => {
      if (m.type === 'distance' && (m.atom1Ref || m.atom1Index != null) && (m.atom2Ref || m.atom2Index != null)) {
        const a1 = makeAtomProxy(wrapped, m.atom1Ref ?? { atomIndex: m.atom1Index, atomPosition: m.atom1Position });
        const a2 = makeAtomProxy(wrapped, m.atom2Ref ?? { atomIndex: m.atom2Index, atomPosition: m.atom2Position });
        if (a1 && a2) addDistanceMeasurement(a1, a2);
      } else if (m.type === 'angle' && (m.atom1Ref || m.atom1Index != null) && (m.atom2Ref || m.atom2Index != null) && (m.atom3Ref || m.atom3Index != null)) {
        const a1 = makeAtomProxy(wrapped, m.atom1Ref ?? { atomIndex: m.atom1Index, atomPosition: m.atom1Position });
        const a2 = makeAtomProxy(wrapped, m.atom2Ref ?? { atomIndex: m.atom2Index, atomPosition: m.atom2Position });
        const a3 = makeAtomProxy(wrapped, m.atom3Ref ?? { atomIndex: m.atom3Index, atomPosition: m.atom3Position });
        if (a1 && a2 && a3) addAngleMeasurement(a1, a2, a3);
      }
    });
  }, 200);
}

function makeAtomProxy(wrapped, ref) {
  const atomIndex = ref?.atomIndex;
  const savedPosition = ref?.atomPosition ?? null;
  let bestMatch = null;
  let bestDistance = Infinity;

  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (srcIdx !== atomIndex) continue;

    const candidate = {
      position: new THREE.Vector3(...wrapped.cart[i]),
      userData: {
        atomIndex: srcIdx,
        element: wrapped.elements[i],
        instanceId: i,
        wrappedFrac: wrapped.frac?.[i] ? [...wrapped.frac[i]] : null,
      },
    };

    if (Array.isArray(ref?.imageOffset) && candidate.userData.wrappedFrac) {
      const baseFrac = fileBrowser.selectedStructure?.atoms?.[atomIndex]?.position;
      if (baseFrac) {
        const candidateOffset = candidate.userData.wrappedFrac.map((value, axis) => Math.round(value - baseFrac[axis]));
        if (candidateOffset.every((value, axis) => value === ref.imageOffset[axis])) return candidate;
      }
    }

    if (!savedPosition?.length) return candidate;

    const distance = candidate.position.distanceTo(new THREE.Vector3(...savedPosition));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  if (Array.isArray(ref?.imageOffset) && fileBrowser.selectedStructure?.atoms?.[atomIndex]) {
    const baseFrac = fileBrowser.selectedStructure.atoms[atomIndex].position;
    const wrappedFrac = baseFrac.map((value, axis) => value + ref.imageOffset[axis]);
    const cart = fracToCart([wrappedFrac], fileBrowser.selectedStructure.lattice)[0];
    return {
      position: new THREE.Vector3(...cart),
      userData: {
        atomIndex,
        element: fileBrowser.selectedStructure.elements?.[atomIndex] ?? '?',
        wrappedFrac,
      },
    };
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Load from URL
// ---------------------------------------------------------------------------

export function loadSharedStructure() {
  console.log("In loadSharedStructure")
  const stateParam = new URLSearchParams(window.location.search).get('state');
  if (!stateParam) return;

  let state;
  try {
    const normalized = stateParam.trim().replace(/\s+/g, '');
    if (normalized.includes('...')) {
      throw new Error('Shared URL appears truncated (contains "..."). Copy the full link from the share dialog.');
    }

    // Accept both current base64url and older plain base64 forms.
    const padded = normalized
      .replace(/ /g, '+')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const pad = padded.length % 4;
    const b64 = pad ? padded + '='.repeat(4 - pad) : padded;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    state = JSON.parse(new TextDecoder().decode(bytes));
    general.sharedStructureLoaded = true;
    console.log(general.sharedStructureLoaded)
  } catch (e) {
    const invalidChars = [...stateParam].filter(c => !/[A-Za-z0-9\-_]/.test(c));
    console.error('Failed to decode shared state:', e,
      'param length:', stateParam.length,
      'invalid chars:', invalidChars.slice(0, 10));
    return;
  }

  if (!state.version?.startsWith('2')) {
    console.warn('Shared state version not supported:', state.version);
    return;
  }

  // Apply display settings before loading so parsePOSCAR renders with them
  applyDisplaySettings(state.display);

  // Load structure (synchronous — triggers updateVisualization internally)
  try {
    parsePOSCAR(buildPOSCAR(state), 'shared.vasp');
  } catch (e) {
    console.error('Failed to load shared structure:', e);
    return;
  }

  const structure = fileBrowser.selectedStructure;
  if (!structure) return;

  // buildPOSCAR() groups atoms by element, so restore the saved atom ordering
  // before applying any per-atom state that relies on stable indices.
  restoreAtomOrder(state.structure, structure);

  revealFeaturePanels();
  createBondLengthControls();

  // Apply colors on top of loaded structure, then push to GPU
  applyAtomColors(state.colors, structure);
  updateAtoms();

  // Rebuild bonds to reflect any bondLength / bondVisibility changes
  rebuildBonds();

  // Camera and measurements need the render to have settled
  restoreCamera(state.camera);
  restoreMeasurements(state.measurements);

  // Clean URL
  const newUrl = new URL(window.location.href);
  newUrl.searchParams.delete('state');
  window.history.replaceState({}, document.title, newUrl.toString());
}

// ---------------------------------------------------------------------------
// Share button
// ---------------------------------------------------------------------------

export function createShareButton() {
  if (document.getElementById('shareBtn')) return;

  const shareBtn = document.createElement('button');
  shareBtn.id = 'shareBtn';
  shareBtn.textContent = 'Share';
  shareBtn.style.cssText = 'padding:8px 16px; margin-top:8px; color:white; background-color: var(--accent-color); border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; width:100%;';
  shareBtn.onclick = shareStructure;

  // The Share button lives in the Files panel window (with the storage
  // options). On the very first structure load the panel may not exist yet —
  // fall back to the hidden staging area; the Files panel adopts #shareBtn
  // when it is built.
  const container =
    document.getElementById('cvPanelBody-files') ||
    document.getElementById('structureControls') ||
    document.getElementById('composition')?.parentElement;
  if (container) container.appendChild(shareBtn);
}
