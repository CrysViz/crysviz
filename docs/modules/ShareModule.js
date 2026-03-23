import { app, general, measurements, fileBrowser } from '../store.js';
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR } from './StructureInputModule.js';
import { updateAtoms } from './AtomsFracUpdateModule.js';
import { rebuildBonds } from './BondsFracUpdateModule.js';
import { addDistanceMeasurement, addAngleMeasurement } from './MeasurementModule.js';

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
    .map(l => l.userData)
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

  const shareURL = window.location.href.split('?')[0] + '?state=' + b64;

  // Always show URL in prompt so user can copy the full text (address bar truncates long URLs).
  // Also attempt clipboard write for convenience.
  navigator.clipboard?.writeText(shareURL).catch(() => {});
  prompt('Share URL (select all and copy):', shareURL);
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
      if (m.type === 'distance' && m.atom1Index != null && m.atom2Index != null) {
        const a1 = makeAtomProxy(wrapped, m.atom1Index);
        const a2 = makeAtomProxy(wrapped, m.atom2Index);
        if (a1 && a2) addDistanceMeasurement(a1, a2);
      } else if (m.type === 'angle' && m.atom1Index != null && m.atom2Index != null && m.atom3Index != null) {
        const a1 = makeAtomProxy(wrapped, m.atom1Index);
        const a2 = makeAtomProxy(wrapped, m.atom2Index);
        const a3 = makeAtomProxy(wrapped, m.atom3Index);
        if (a1 && a2 && a3) addAngleMeasurement(a1, a2, a3);
      }
    });
  }, 200);
}

function makeAtomProxy(wrapped, index) {
  if (index < 0 || index >= wrapped.cart.length) return null;
  return {
    position: new THREE.Vector3(...wrapped.cart[index]),
    userData: {
      atomIndex: index,
      element: wrapped.elements[index],
    },
  };
}

// ---------------------------------------------------------------------------
// Load from URL
// ---------------------------------------------------------------------------

export function loadSharedStructure() {
  const match = window.location.search.match(/[?&]state=([^&]+)/);
  const stateParam = match ? match[1] : null;
  if (!stateParam) return;

  // Mark early so loadDefaultStructure() is skipped
  general.sharedStructureLoaded = true;

  let state;
  try {
    const padded = stateParam.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    const b64 = pad ? padded + '='.repeat(4 - pad) : padded;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    state = JSON.parse(new TextDecoder().decode(bytes));
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

  // Apply colors on top of loaded structure, then push to GPU
  applyAtomColors(state.colors, structure);
  updateAtoms();

  // Rebuild bonds to reflect any bondLength / bondVisibility changes
  rebuildBonds();

  // Camera and measurements need the render to have settled
  restoreCamera(state.camera);
  restoreMeasurements(state.measurements);

  // Clean URL
  const newUrl = new URL(window.location);
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
  shareBtn.style.cssText =
    'padding:8px 16px; margin-top:8px; color:white; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; width:100%;';
  shareBtn.onclick = shareStructure;

  const container =
    document.getElementById('structureControls') ||
    document.getElementById('bondControlsGroup') ||
    document.getElementById('composition')?.parentElement;
  if (container) container.appendChild(shareBtn);
}
