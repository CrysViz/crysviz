import { app, general, measurements, fileBrowser } from '../state/store.js';
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR } from './StructureInputModule.js';
import { updateAtoms } from '../render/index.js';
import { rebuildBonds } from '../render/index.js';
import { addDistanceMeasurement, addAngleMeasurement, serializeMeasurementRef } from '../render/MeasurementModule.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { revealFeaturePanels } from './panels/PanelManager.js';
import { fracToCart } from '../math/index.js';
import { updateAxesGizmoWidth } from './WindowAndSceneControls.js';
import { getContrastingBorder } from './BackgroundPicker.js';

const URL_WARN_CHARS = 4000;
const URL_HARD_CHARS = 10000;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Collect the full visual state (structure, colors, display settings, style,
 * camera, measurements) — everything EXCEPT window placements, which live in
 * the panel system's own localStorage. Shared by the Share-URL feature and
 * the .crysviz file download (SavePanel).
 */
export function captureState() {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return null;

  // Per-atom color overrides — only atoms whose color differs from their element color
  const atomColors = {};
  structure.atoms.forEach((atom, i) => {
    if (atom.color !== atom.elementColor) atomColors[i] = atom.color;
  });

  // Per-atom opacity / size overrides (sparse: only non-default values)
  const atomOpacities = {};
  const atomRadiusScales = {};
  structure.atoms.forEach((atom, i) => {
    const opacity = atom.getOpacity?.() ?? atom.opacity ?? 1;
    if (opacity < 0.999) atomOpacities[i] = opacity;
    const radiusScale = atom.getRadiusScale?.() ?? 1;
    if (Math.abs(radiusScale - 1) > 1e-9) atomRadiusScales[i] = radiusScale;
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
    version: '2.1',
    structure: {
      elements: [...structure.elements],
      lattice: structure.lattice.map(r => [...r]),
      positions: structure.atoms.map(a => [...a.position]),
    },
    colors: {
      atomColors,
      elementColors,
      useDefaultColors: general.useDefaultColors,
      atomOpacities,
      atomRadiusScales,
    },
    display: {
      atomSize: general.atomSize,
      bondRadius: general.bondRadius,
      showAtoms: general.showAtoms,
      showBonds: general.showBonds,
      showLattice: general.showLattice,
      showPeriodic: general.showPeriodic,
      periodicFaceTol: general.periodicFaceTol,
      showPBCBonds: general.showPBCBonds,
      showAxes: general.showAxes,
      showPolyhedra: general.showPolyhedra,
      completePolyhedra: general.completePolyhedra,
      axesLineWidth: general.axesLineWidth,
      latticeLineWidth: general.latticeLineWidth,
      bondLengths: { ...general.bondLengths },
      bondVisibility: { ...general.bondVisibility },
    },
    style: {
      renderStyle: general.renderStyle,
      celOutlineWidth: general.celOutlineWidth,
      celHullWidth: general.celHullWidth,
      atomsColor: general.atomsColor,
      bondsColor: general.bondsColor,
      background: app.scene?.background ? '#' + app.scene.background.getHexString() : null,
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
  const setSlider = (id, valueId, val, decimals) => {
    const s = document.getElementById(id);
    const sv = document.getElementById(valueId);
    if (s) s.value = val;
    if (sv) sv.textContent = Number(val).toFixed(decimals);
  };

  if (display.atomSize != null) {
    general.atomSize = display.atomSize;
    setSlider('atomSize', 'atomSizeValue', display.atomSize, 2);
  }
  if (display.bondRadius != null) {
    general.bondRadius = display.bondRadius;
    setSlider('bondWidth', 'bondWidthValue', display.bondRadius, 2);
  }
  if (display.axesLineWidth != null) {
    general.axesLineWidth = display.axesLineWidth;
    setSlider('axesWidth', 'axesWidthValue', display.axesLineWidth, 3);
    updateAxesGizmoWidth();
  }
  if (display.latticeLineWidth != null) {
    // The lattice outline is (re)built after the structure loads, so setting
    // the width here is enough.
    general.latticeLineWidth = display.latticeLineWidth;
    setSlider('latticeWidth', 'latticeWidthValue', display.latticeLineWidth, 3);
  }
  if (display.showAtoms != null)   { general.showAtoms   = display.showAtoms;   setToggle('showAtoms', display.showAtoms); }
  if (display.showBonds != null)   { general.showBonds   = display.showBonds;   setToggle('showBonds', display.showBonds); }
  if (display.showLattice != null) { general.showLattice = display.showLattice; setToggle('showLattice', display.showLattice); }
  if (display.showPeriodic != null){ general.showPeriodic= display.showPeriodic;setToggle('showPeriodic', display.showPeriodic); }
  if (display.periodicFaceTol != null){ general.periodicFaceTol = display.periodicFaceTol; }
  if (display.showPBCBonds != null){ general.showPBCBonds= display.showPBCBonds;setToggle('PBCBondToggle', display.showPBCBonds); }
  if (display.showAxes != null) {
    setToggle('showAxes', display.showAxes);
    // The change handler owns the gizmo/legend visibility (ControlsWiring).
    document.getElementById('showAxes')?.dispatchEvent(new Event('change'));
  }
  if (display.showPolyhedra != null) { general.showPolyhedra = display.showPolyhedra; setToggle('showPolyhedra', display.showPolyhedra); }
  if (display.completePolyhedra != null) { general.completePolyhedra = display.completePolyhedra; setToggle('completePolyhedraToggle', display.completePolyhedra); }
  if (display.bondLengths)    Object.assign(general.bondLengths, display.bondLengths);
  if (display.bondVisibility) Object.assign(general.bondVisibility, display.bondVisibility);
}

/** Render style, color modes and scene background. Runs BEFORE the structure
 *  loads: the initial render then picks these up directly. */
function applyStyleSettings(style) {
  if (!style) return;
  const setSelect = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  if (style.renderStyle) { general.renderStyle = style.renderStyle; setSelect('renderStyleMenu', style.renderStyle); }
  if (style.celOutlineWidth != null) general.celOutlineWidth = style.celOutlineWidth;
  if (style.celHullWidth != null) general.celHullWidth = style.celHullWidth;
  if (style.atomsColor) { general.atomsColor = style.atomsColor; setSelect('atomsMenu', style.atomsColor); }
  if (style.bondsColor) { general.bondsColor = style.bondsColor; setSelect('bondsMenu', style.bondsColor); }
  if (style.background && app?.scene) {
    app.scene.background = new THREE.Color(style.background);
    // Keep the lattice readable against the restored background, like the
    // background picker does (the lattice is built after this runs).
    general.currentLatticeColor = getContrastingBorder(style.background);
  }
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

  // Per-atom opacity/size overrides; updateAtoms() (run by the caller) pushes
  // both to the instanced mesh.
  if (colors.atomOpacities) {
    Object.entries(colors.atomOpacities).forEach(([idx, value]) => {
      structure.atoms[parseInt(idx)]?.setOpacity?.(value);
    });
  }
  if (colors.atomRadiusScales) {
    Object.entries(colors.atomRadiusScales).forEach(([idx, value]) => {
      structure.atoms[parseInt(idx)]?.setRadiusScale?.(value);
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

  if (!applySharedState(state, 'shared.vasp')) return;

  // Clean URL
  const newUrl = new URL(window.location.href);
  newUrl.searchParams.delete('state');
  window.history.replaceState({}, document.title, newUrl.toString());
}

/**
 * Apply a captured state (see captureState): load its structure and restore
 * colors, display/style settings, camera and measurements. Shared by the
 * ?state= share-URL loader and the .crysviz file loader.
 * @returns {boolean} whether the state was applied
 */
export function applySharedState(state, fileName = 'shared.vasp') {
  if (!state?.version?.startsWith('2')) {
    console.warn('State version not supported:', state?.version);
    return false;
  }

  // Apply display/style settings before loading so parsePOSCAR renders with them
  applyDisplaySettings(state.display);
  applyStyleSettings(state.style);

  // Load structure (synchronous — triggers updateVisualization internally)
  try {
    parsePOSCAR(buildPOSCAR(state), fileName);
  } catch (e) {
    console.error('Failed to load structure from state:', e);
    return false;
  }

  const structure = fileBrowser.selectedStructure;
  if (!structure) return false;

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

  // Cel style: re-fire the dropdown so its dependent controls (outline block)
  // appear; the handler re-renders, which is only paid for cel states.
  if (state.style?.renderStyle === 'cel') {
    document.getElementById('renderStyleMenu')?.dispatchEvent(new Event('change'));
  }

  // Camera and measurements need the render to have settled
  restoreCamera(state.camera);
  restoreMeasurements(state.measurements);
  return true;
}

// ---------------------------------------------------------------------------
// Load from a .crysviz file (the Download menu's save format)
// ---------------------------------------------------------------------------

export function loadCrysvizFile(content, fileName = 'file.crysviz') {
  let state;
  try {
    state = JSON.parse(content);
  } catch {
    throw new Error(`${fileName} is not a valid .crysviz file (JSON expected).`);
  }
  if (state?.format !== 'crysviz') {
    throw new Error(`${fileName} is not a CrysViz state file.`);
  }
  if (!applySharedState(state, fileName)) {
    throw new Error(`Could not apply the state in ${fileName} (unsupported version?).`);
  }
}

// ---------------------------------------------------------------------------
// Share button
// ---------------------------------------------------------------------------

export function createShareButton() {
  if (document.getElementById('shareBtn')) return;

  const shareBtn = document.createElement('button');
  shareBtn.id = 'shareBtn';
  shareBtn.type = 'button';
  shareBtn.textContent = 'Share';
  shareBtn.className = 'file-action-btn';
  shareBtn.onclick = shareStructure;

  // The Share button joins the Upload / Paste Text / Download action row in
  // the Files window (#uploadSection exists from startup, so this works even
  // before the panel windows are built).
  const container =
    document.querySelector('#uploadSection .file-actions') ||
    document.getElementById('cvPanelBody-files') ||
    document.getElementById('structureControls') ||
    document.getElementById('composition')?.parentElement;
  if (container) container.appendChild(shareBtn);
}
