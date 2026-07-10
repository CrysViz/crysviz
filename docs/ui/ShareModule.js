import { app, general, measurements, fileBrowser, structureShip } from '../state/store.js';

/** Deep copy of a sparse style-store object, or undefined when empty/absent
 *  (keeps captured sessions small). */
function nonEmptyDeepCopy(obj) {
  return obj && Object.keys(obj).length ? JSON.parse(JSON.stringify(obj)) : undefined;
}
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR, initializeUIOnLoad } from './StructureInputModule.js';
import { readPOSCAR } from '../io/ReadPOSCARModule.js';
import { StructureContainer } from '../model/index.js';
import { updateAtoms } from '../render/index.js';
import { rebuildBonds, updatePolyhedra, setActivePipeline } from '../render/index.js';
import { addDistanceMeasurement, addAngleMeasurement, serializeMeasurementRef } from '../render/MeasurementModule.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { sizeValueToSlider, ATOM_SIZE_RANGE, BOND_RADIUS_RANGE, GROUND_OFFSET_RANGE, GROUND_SIZE_RANGE } from './ControlsWiring.js';
import { revealFeaturePanels } from './panels/PanelManager.js';
import { fracToCart } from '../math/index.js';
import { updateAxesGizmoWidth, switchCameraType, resizeRenderer } from './WindowAndSceneControls.js';
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
export function captureState({ includeFrames = false } = {}) {
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

  // Whole-trajectory frames (all steps of the active container), so saving an
  // MD/relaxation run preserves every frame — not just the viewed one. Each
  // frame is stored in its native atom order. Only the .crysviz file save opts
  // in (includeFrames); the share-URL omits them to keep the URL small. The
  // single `structure` field below always carries the viewed frame (back-compat).
  let frames;
  if (includeFrames) {
    const activeContainer = structureShip.container?.[fileBrowser.selectedRowIndex];
    frames = (activeContainer?.structures ?? [structure]).map(frame => ({
      elements: [...frame.elements],
      lattice: frame.lattice.map(r => [...r]),
      positions: frame.atoms.map(a => [...a.position]),
    }));
  }

  return {
    version: '2.10',
    ...(frames ? { frames } : {}),
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
      // The per-item / per-category style stores (all stably keyed, so they
      // re-attach after the load-time rebuilds; sparse — only saved when set).
      atomImageStyles: nonEmptyDeepCopy(structure.atomImageStyles),
      bondUserStyles: nonEmptyDeepCopy(structure.bondUserStyles),
      bondCategoryStyles: nonEmptyDeepCopy(structure.bondCategoryStyles),
      polyhedraUserStyles: nonEmptyDeepCopy(structure.polyhedraUserStyles),
      polyhedraCategoryStyles: nonEmptyDeepCopy(structure.polyhedraCategoryStyles),
      // Ray/path-tracing materials: per-species + per-atom overrides (bond/
      // poly materials ride in their user/category stores above).
      atomMaterials: nonEmptyDeepCopy(structure.atomMaterials),
      atomUserMaterials: nonEmptyDeepCopy(structure.atomUserMaterials),
    },
    display: {
      atomSize: general.atomSize,
      bondRadius: general.bondRadius,
      showAtoms: general.showAtoms,
      showBonds: general.showBonds,
      showLattice: general.showLattice,
      showPeriodic: general.showPeriodic,
      linkPeriodicCopies: general.linkPeriodicCopies,
      periodicFaceTol: general.periodicFaceTol,
      showPBCBonds: general.showPBCBonds,
      showAxes: general.showAxes,
      showPolyhedra: general.showPolyhedra,
      completePolyhedra: general.completePolyhedra,
      axesLineWidth: general.axesLineWidth,
      latticeLineWidth: general.latticeLineWidth,
      bondLengths: { ...general.bondLengths },
      bondVisibility: { ...general.bondVisibility },
      atomVisibility: { ...general.atomVisibility },
      bondCutImmunity: { ...general.bondCutImmunity },
    },
    style: {
      renderStyle: general.renderStyle,
      renderPipeline: general.renderPipeline,
      depthPeelLayers: general.depthPeelLayers,
      rtResolutionScale: general.rtResolutionScale,
      rtTiledRender: general.rtTiledRender,
      rtReflectivity: general.rtReflectivity,
      ptDenoise: general.ptDenoise,
      ptLightSoftness: general.ptLightSoftness,
      rtDofAperture: general.rtDofAperture,
      rtDofFocus: general.rtDofFocus,
      rtGroundPlane: general.rtGroundPlane,
      rtGroundPattern: general.rtGroundPattern,
      rtGroundColor1: general.rtGroundColor1,
      rtGroundColor2: general.rtGroundColor2,
      rtGroundScale: general.rtGroundScale,
      rtGroundOffset: general.rtGroundOffset,
      rtGroundSize: general.rtGroundSize,
      rtGroundReflect: general.rtGroundReflect,
      rtLightIntensity: general.rtLightIntensity,
      rtAmbient: general.rtAmbient,
      rtSaturation: general.rtSaturation,
      celOutlineWidth: general.celOutlineWidth,
      celHullWidth: general.celHullWidth,
      polyEdgeWidth: general.polyEdgeWidth,
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
      // The trackball controls roll the camera's up vector freely — without
      // it, position+target restore the view direction but not the rotation.
      up: app.camera
        ? [app.camera.up.x, app.camera.up.y, app.camera.up.z]
        : null,
      zoom: app.camera?.zoom ?? null,
      orthographic: !!app.useOrthographicCamera,
      frustumSize: app.orthographicFrustumSize ?? null,
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

  // The size sliders hold [0,1] positions with a quadratic value mapping —
  // write the inverse-mapped position, but show the real value in the span.
  if (display.atomSize != null) {
    general.atomSize = display.atomSize;
    setSlider('atomSize', 'atomSizeValue', sizeValueToSlider(display.atomSize, ATOM_SIZE_RANGE), 2);
    const span = document.getElementById('atomSizeValue');
    if (span) span.textContent = Number(display.atomSize).toFixed(2);
  }
  if (display.bondRadius != null) {
    general.bondRadius = display.bondRadius;
    setSlider('bondWidth', 'bondWidthValue', sizeValueToSlider(display.bondRadius, BOND_RADIUS_RANGE), 2);
    const span = document.getElementById('bondWidthValue');
    if (span) span.textContent = Number(display.bondRadius).toFixed(2);
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
  // The Atoms-tab toggle is rebuilt from `general` on the next renderComposition.
  if (display.linkPeriodicCopies != null){ general.linkPeriodicCopies = display.linkPeriodicCopies; }
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
  if (display.atomVisibility) Object.assign(general.atomVisibility, display.atomVisibility);
  if (display.bondCutImmunity) Object.assign(general.bondCutImmunity, display.bondCutImmunity);
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
  if (style.renderPipeline) {
    // Unknown ids fall back to 'forward' inside setActivePipeline.
    setActivePipeline(style.renderPipeline);
    setSelect('renderPipelineMenu', general.renderPipeline);
  }
  if (style.depthPeelLayers != null) {
    general.depthPeelLayers = style.depthPeelLayers;
    setSelect('depthPeelLayersSlider', style.depthPeelLayers);
  }
  if (style.rtResolutionScale != null) {
    general.rtResolutionScale = style.rtResolutionScale;
    setSelect('rtResolutionScale', style.rtResolutionScale);
  }
  if (style.rtTiledRender != null) {
    general.rtTiledRender = style.rtTiledRender;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtTiledToggle'));
    if (toggle) toggle.checked = style.rtTiledRender;
  }
  if (style.rtReflectivity != null) {
    general.rtReflectivity = style.rtReflectivity;
    setSelect('rtReflectivity', style.rtReflectivity);
  }
  if (style.ptDenoise != null) {
    general.ptDenoise = style.ptDenoise;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('ptDenoiseToggle'));
    if (toggle) toggle.checked = style.ptDenoise;
  }
  if (style.ptLightSoftness != null) {
    general.ptLightSoftness = style.ptLightSoftness;
    setSelect('ptLightSoftness', style.ptLightSoftness);
  }
  if (style.rtDofAperture != null) {
    general.rtDofAperture = style.rtDofAperture;
    setSelect('rtDofAperture', style.rtDofAperture);
  }
  if (style.rtDofFocus != null) {
    general.rtDofFocus = style.rtDofFocus;
    setSelect('rtDofFocus', style.rtDofFocus);
  }
  if (style.rtGroundPlane != null) {
    general.rtGroundPlane = style.rtGroundPlane;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtGroundToggle'));
    if (toggle) {
      toggle.checked = style.rtGroundPlane;
      toggle.dispatchEvent(new Event('change')); // also shows/hides the ground options
    }
  }
  if (style.rtGroundPattern != null) { general.rtGroundPattern = style.rtGroundPattern; setSelect('rtGroundPattern', style.rtGroundPattern); }
  if (style.rtGroundColor1 !== undefined) {
    general.rtGroundColor1 = style.rtGroundColor1;
    if (style.rtGroundColor1) setSelect('rtGroundColor1', style.rtGroundColor1);
  }
  if (style.rtGroundColor2 !== undefined) {
    general.rtGroundColor2 = style.rtGroundColor2;
    if (style.rtGroundColor2) setSelect('rtGroundColor2', style.rtGroundColor2);
  }
  if (style.rtGroundScale != null) { general.rtGroundScale = style.rtGroundScale; setSelect('rtGroundScale', style.rtGroundScale); }
  if (style.rtGroundOffset != null) { general.rtGroundOffset = style.rtGroundOffset; setSelect('rtGroundOffset', sizeValueToSlider(style.rtGroundOffset, GROUND_OFFSET_RANGE)); }
  if (style.rtGroundSize != null) { general.rtGroundSize = style.rtGroundSize; setSelect('rtGroundSize', sizeValueToSlider(style.rtGroundSize, GROUND_SIZE_RANGE)); }
  if (style.rtGroundReflect != null) { general.rtGroundReflect = style.rtGroundReflect; setSelect('rtGroundReflect', style.rtGroundReflect); }
  if (style.rtLightIntensity != null) {
    general.rtLightIntensity = style.rtLightIntensity;
    setSelect('rtLightIntensity', style.rtLightIntensity);
  }
  if (style.rtAmbient != null) {
    general.rtAmbient = style.rtAmbient;
    setSelect('rtAmbient', style.rtAmbient);
  }
  if (style.rtSaturation != null) {
    general.rtSaturation = style.rtSaturation;
    setSelect('rtSaturation', style.rtSaturation);
  }
  if (style.celOutlineWidth != null) general.celOutlineWidth = style.celOutlineWidth;
  if (style.celHullWidth != null) general.celHullWidth = style.celHullWidth;
  if (style.polyEdgeWidth != null) {
    general.polyEdgeWidth = style.polyEdgeWidth;
    setSelect('polyEdgeWidth', style.polyEdgeWidth);
  }
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

  // Per-periodic-copy overrides: keys are stable ("srcIndex:dx,dy,dz") and the
  // element sanity check in getAtomImageStyle drops any that no longer match;
  // the caller's updateAtoms() applies them.
  if (colors.atomImageStyles) {
    structure.atomImageStyles = JSON.parse(JSON.stringify(colors.atomImageStyles));
  }

  // Per-bond / per-polyhedron style stores. This runs after restoreAtomOrder
  // (see applySharedState), so the wrapped-index bondUserStyles keys match the
  // corrected atom order when the caller's rebuildBonds() re-applies them;
  // stale keys are silently ignored by the stores' element/geometry checks.
  for (const k of ['bondUserStyles', 'bondCategoryStyles', 'polyhedraUserStyles', 'polyhedraCategoryStyles', 'atomMaterials', 'atomUserMaterials']) {
    if (colors[k]) structure[k] = JSON.parse(JSON.stringify(colors[k]));
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
    // Camera type first: switching rebuilds app.camera at a default pose, so
    // it must precede the pose restore.
    if (camState.orthographic != null && camState.orthographic !== app.useOrthographicCamera) {
      app.useOrthographicCamera = camState.orthographic;
      const toggle = document.getElementById('orthographicCamera');
      if (toggle) /** @type {HTMLInputElement} */ (toggle).checked = camState.orthographic;
      switchCameraType();
    }
    if (camState.orthographic && camState.frustumSize != null) {
      app.orthographicFrustumSize = camState.frustumSize;
      resizeRenderer(camState.frustumSize); // re-derives the ortho frustum planes
    }
    app.camera.position.set(...camState.position);
    if (camState.up) app.camera.up.set(...camState.up);
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

  // A saved trajectory carries every frame in `frames`; older single-frame
  // files (and the share-URL) carry only `structure`.
  const frames = Array.isArray(state.frames) ? state.frames : null;
  const multiFrame = !!(frames && frames.length > 1);
  let trajectoryContainer = null;

  // Load structure (synchronous — triggers updateVisualization internally)
  try {
    if (multiFrame) {
      // Rebuild each frame's Structure, restoring its native atom order (buildPOSCAR
      // groups by element) so per-atom indices stay stable across the trajectory.
      const structures = frames.map((f) => {
        const s = readPOSCAR(buildPOSCAR({ structure: f }), fileName);
        restoreAtomOrder(f, s);
        return s;
      });
      trajectoryContainer = new StructureContainer({ fileName, structures });
      initializeUIOnLoad(trajectoryContainer);
    } else {
      parsePOSCAR(buildPOSCAR(state), fileName);
    }
  } catch (e) {
    console.error('Failed to load structure from state:', e);
    return false;
  }

  const structure = fileBrowser.selectedStructure;
  if (!structure) return false;

  // Single-frame: buildPOSCAR() groups atoms by element, so restore the saved
  // atom ordering before applying any per-atom state that relies on stable
  // indices. (Multi-frame frames were already restored above.)
  if (!multiFrame) restoreAtomOrder(state.structure, structure);

  revealFeaturePanels();
  createBondLengthControls();

  // Apply colors on top of loaded structure, then push to GPU
  applyAtomColors(state.colors, structure);
  // Propagate the restored colors to every other frame so scrubbing the
  // trajectory keeps the saved appearance (indices align — all frames restored).
  if (multiFrame) trajectoryContainer.flushColorToAllStructures(structure);
  updateAtoms();

  // Rebuild bonds to reflect any bondLength / bondVisibility changes
  rebuildBonds();

  // parsePOSCAR's updateVisualization kicked off the (async) polyhedra compute
  // BEFORE restoreAtomOrder and the style-store restore above; re-run it so
  // keys derive from the corrected atom order and restored styles render.
  // (updatePolyhedra coalesces with any in-flight compute.)
  if (general.showPolyhedra || general.completePolyhedra) updatePolyhedra();

  // Cel style: re-fire the dropdown so its dependent controls (outline block)
  // appear; the handler re-renders, which is only paid for cel states.
  if (state.style?.renderStyle === 'cel') {
    document.getElementById('renderStyleMenu')?.dispatchEvent(new Event('change'));
  }
  // Depth peeling / ray tracing: same re-fire so their control blocks show.
  if (['depthpeel', 'raytrace', 'pathtrace'].includes(state.style?.renderPipeline)) {
    document.getElementById('renderPipelineMenu')?.dispatchEvent(new Event('change'));
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
