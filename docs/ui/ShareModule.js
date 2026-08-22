import { app, general, groups, measurements, fileBrowser, structureShip } from '../state/store.js';

/** Deep copy of a sparse style-store object, or undefined when empty/absent
 *  (keeps captured sessions small). */
function nonEmptyDeepCopy(obj) {
  return obj && Object.keys(obj).length ? JSON.parse(JSON.stringify(obj)) : undefined;
}

/** A THREE.Color (or css string) to '#rrggbb', or null. */
function colorToHex(c) {
  if (!c) return null;
  if (typeof c === 'string') return c;
  return c.getHexString ? '#' + c.getHexString() : null;
}

/** Serialize a structure's per-atom force or spin arrows for a .crysviz frame.
 *  Index-aligned to structure.atoms (matching the file readers). Only `vector`
 *  is mandatory; scaling/color/hidden and the spin-only atomIndex/element/
 *  position are written when set, so a plain arrow list stays compact. A saved
 *  `color` means a pinned per-arrow pick (userColor) — the colormap otherwise
 *  recomputes color on load. userMaterial follows the same frame-only path. */
function serializeArrows(arrows, isSpin = false) {
  return arrows.map((a) => {
    const out = { vector: [...a.vector] };
    if (a.scaling != null) out.scaling = a.scaling;
    if (a.userColor) out.color = colorToHex(a.userColor);
    if (a.userMaterial) out.material = JSON.parse(JSON.stringify(a.userMaterial));
    if (a.hidden) out.hidden = true;
    if (isSpin) {
      if (a.atomIndex != null) out.atomIndex = a.atomIndex;
      if (a.element != null) out.element = a.element;
      if (a.position != null) out.position = [...a.position];
    }
    return out;
  });
}

// --- Volumetric-field byte <-> base64 helpers (used only by the .crysviz save) ---
// Field values are Float32Array; the .crysviz format stores their raw little-endian
// bytes base64-encoded. Endianness assumption: every platform CrysViz runs on is
// little-endian in practice (x86 / ARM / WASM), and a .crysviz is loaded back on a
// like-endian machine — no byte-swap is performed. No compression in v1: the load
// path is readAsText/JSON, so a large grid inflates ~1.33x; gzip via
// CompressionStream is a possible follow-up.
const B64_CHUNK = 0x8000; // String.fromCharCode.apply overflows on very large arrays

/** Encode a Float32Array's raw bytes to base64 (chunked to avoid arg overflow). */
function float32ToBase64(floatArray) {
  const bytes = new Uint8Array(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 (raw little-endian float bytes) back to a Float32Array. */
function base64ToFloat32(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Serialize a structure's volumetric fields for embedding in a .crysviz file.
 *  Returns undefined when there is nothing to save. */
function captureFields(structure) {
  const container = structure?.volumetricFields;
  const fields = container?.fields;
  if (!fields?.length) return undefined;

  // The field browser tracks which field is selected/shown; fall back to 0.
  const selectedIndex = (fieldBrowser?.selectedField && fieldBrowser.selectedFieldIndex >= 0)
    ? fieldBrowser.selectedFieldIndex : 0;

  return {
    fileName: container.fileName,
    source: container.source,
    selectedIndex,
    // Isosurface render material (pos/neg colors + opacity) — module globals.
    isoSettings: getIsosurfaceMaterialSettings(),
    fields: fields.map((f) => ({
      label: f.label,
      nx: f.nx, ny: f.ny, nz: f.nz,
      origin: f.origin, voxel: f.voxel,
      component: f.component,
      isoValue: f.isoValue,
      useAbsoluteIsoValue: f.useAbsoluteIsoValue,
      isVisible: f.isVisible,
      minValue: f.minValue, maxValue: f.maxValue,
      absMinValue: f.absMinValue, absMaxValue: f.absMaxValue,
      values: f.values ? float32ToBase64(f.values) : null,
    })),
  };
}
import * as THREE from '../external/three/three.module.js';
import { parsePOSCAR, initializeUIOnLoad } from './StructureInputModule.js';
import { readPOSCAR } from '../io/ReadPOSCARModule.js';
import {
  StructureContainer, Field, FieldContainer, Force, Spin,
  getIsosurfaceMaterialSettings, setIsosurfaceMaterialSettings,
  applyMaterialSettingsToStoredIsosurfaces,
} from '../model/index.js';
import { updateAtoms } from '../render/index.js';
import { rebuildBonds, updatePolyhedra, setActivePipeline, updateGroundPlane, setActiveField, updateField, updateForces, updateSpins, removeForces, removeSpins } from '../render/index.js';
import { showTrajectoryFrame } from './TrajectoryPanel.js';
import { fieldBrowser } from './FieldPanel.js';
import { addDistanceMeasurement, addAngleMeasurement, serializeMeasurementRef } from '../render/MeasurementModule.js';
import { createBondLengthControls } from './BondLengthPanel.js';
import { rebuildRenderPipelineMenu } from './ColorPanel.js';
import { sizeValueToSlider, ATOM_SIZE_RANGE, BOND_RADIUS_RANGE, GROUND_OFFSET_RANGE, GROUND_SIZE_RANGE } from './ControlsWiring.js';
import { revealFeaturePanels, refreshPanelAvailability } from './panels/PanelManager.js';
import { fracToCart, cartToFractional, normalizeFractional } from '../math/index.js';
import { updateAxesGizmoWidth, switchCameraType, resizeRenderer, applyCameraSnapshot } from './WindowAndSceneControls.js';
import { getContrastingBorder } from './BackgroundPicker.js';
import { showShareLink } from './ShareLinkModal.js';

const URL_WARN_CHARS = 4000;
const URL_HARD_CHARS = 10000;
let lastRestorePromise = Promise.resolve();

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Collect the full visual state (structure, colors, display settings, style,
 * camera, measurements) — everything EXCEPT window placements, which live in
 * the panel system's own localStorage. Shared by the Share-URL feature and
 * the .crysviz file download (SavePanel).
 */
export function captureState({ includeFrames = false, includeFields = false } = {}) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return null;

  // Volumetric fields are embedded ONLY in the .crysviz file save (includeFields):
  // they are large (base64 float bytes) and must not bloat share URLs or the many
  // other captureState() callers/tests.
  const fields = includeFields ? captureFields(structure) : undefined;

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
  // frame carries its native atom order plus the per-atom force/spin arrows
  // shown on screen (issue #53). Only the .crysviz file save opts in
  // (includeFrames); the share-URL omits them to keep the URL small. When
  // frames are present they are the sole source of truth for geometry — the
  // top-level `structure` field is dropped to avoid duplicating the viewed
  // frame (issue #53), and `selectedFrameIndex` records which one is on screen.
  let frames;
  let selectedFrameIndex;
  if (includeFrames) {
    const activeContainer = structureShip.container?.[fileBrowser.selectedRowIndex];
    const structures = activeContainer?.structures ?? [structure];
    frames = structures.map(frame => ({
      elements: [...frame.elements],
      lattice: frame.lattice.map(r => [...r]),
      positions: frame.atoms.map(a => [...a.position]),
      ...(frame.forces?.length ? { forces: serializeArrows(frame.forces) } : {}),
      ...(frame.spins?.length ? { spins: serializeArrows(frame.spins, true) } : {}),
    }));
    selectedFrameIndex = Math.max(0, structures.indexOf(structure));
  }

  return {
    version: '2.16',
    ...(frames ? { frames, selectedFrameIndex } : {}),
    ...(fields ? { fields } : {}),
    // The viewed frame lives in `frames[selectedFrameIndex]` when frames are
    // present (the .crysviz file save); only the share-URL / frame-less capture
    // carries a standalone `structure` (issue #53 — no duplication).
    ...(frames ? {} : {
      structure: {
        elements: [...structure.elements],
        lattice: structure.lattice.map(r => [...r]),
        positions: structure.atoms.map(a => [...a.position]),
      },
    }),
    colors: {
      atomColors,
      elementColors,
      useDefaultColors: general.useDefaultColors,
      elementMaterialsMap: general.elementMaterialsMap,
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
      spinCategoryStyles: nonEmptyDeepCopy(structure.spinCategoryStyles),
      forceCategoryStyles: nonEmptyDeepCopy(structure.forceCategoryStyles),
      fieldMaterial: nonEmptyDeepCopy(structure.fieldMaterial),
    },
    display: {
      atomSize: general.atomSize,
      bondRadius: general.bondRadius,
      showAtoms: general.showAtoms,
      showBonds: general.showBonds,
      showCharges: general.showCharges,
      showLattice: general.showLattice,
      showPeriodic: general.showPeriodic,
      linkPeriodicCopies: general.linkPeriodicCopies,
      periodicFaceTol: general.periodicFaceTol,
      periodicBounds: general.periodicBounds,
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
      // Force / spin arrow display (issue #53). Only the values ForceModule/
      // SpinModule read to draw the arrows are persisted — not panel widget
      // state; undefined keys (e.g. never-toggled forcesActive) drop out of the
      // JSON and are left at their defaults on load.
      forcesActive: general.forcesActive,
      forceScale: general.forceScale,
      forceRadius: general.forceRadius,
      forceMin: general.forceMin,
      forceMax: general.forceMax,
      forceColorScale: general.forceColorScale,
      forceLengthLogScale: general.forceLengthLogScale,
      forceColorMap: general.forceColorMap,
      spinsActive: general.spinsActive,
      spinScale: general.spinScale,
      spinRadius: general.spinRadius,
      spinMin: general.spinMin,
      spinMax: general.spinMax,
      spinColorScale: general.spinColorScale,
      spinLengthLogScale: general.spinLengthLogScale,
      spinColorMap: general.spinColorMap,
      spinSpeciesVisibility: nonEmptyDeepCopy(general.speciesVisibility),
    },
    style: {
      renderStyle: general.renderStyle,
      renderPipeline: general.renderPipeline,
      depthPeelLayers: general.depthPeelLayers,
      rtResolutionScale: general.rtResolutionScale,
      rtTiledRender: general.rtTiledRender,
      rtRasterPreview: general.rtRasterPreview,
      rtBackgroundMatch: general.rtBackgroundMatch,
      rtToneMapLegacy: general.rtToneMapLegacy,
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
      quaternion: app.camera
        ? [app.camera.quaternion.x, app.camera.quaternion.y, app.camera.quaternion.z, app.camera.quaternion.w]
        : null,
      pan: app.cameraPan ? [app.cameraPan.x, app.cameraPan.y] : [0, 0],
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

  // Species RUNS, not one group per element: VASP 5 lets a symbol repeat
  // ("Ba Y Ba" over counts "1 1 1"), so the captured atom order survives.
  //
  // Grouping by element used to permute the atoms here. restoreAtomOrder put
  // structure.atoms back, but NOT structure.periodic, which readPOSCAR builds
  // from the order it parsed — and the renderer colours instance i from
  // atoms[periodic.wrapped.srcIndex[i]]. The two disagreed, so every per-atom
  // colour was drawn on a different atom. Invisible in a unit cell whose atoms
  // already arrive element-grouped; obvious in a supercell, where the tiling
  // interleaves species.
  const species = [];
  const counts = [];
  for (const el of elements) {
    if (species.length && species[species.length - 1] === el) counts[counts.length - 1]++;
    else { species.push(el); counts.push(1); }
  }

  const lines = [
    'Shared via CrysViz',
    '   1.0',
    ...lattice.map(v => v.map(x => x.toFixed(8).padStart(18)).join('')),
    '   ' + species.join('   '),
    '   ' + counts.join('   '),
    'Direct',
    ...positions.map(p => p.map(v => v.toFixed(8).padStart(18)).join('')),
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Share (capture → encode → clipboard)
// ---------------------------------------------------------------------------

// Share URLs carry the state as JSON -> raw deflate -> base64url. Uncompressed
// it runs ~3.7 KB for a plain structure, past the ~2.9 KB a QR code can hold at
// ALL; deflate brings a typical state to well under a kilobyte, which is what
// makes the share dialog's QR useful rather than a permanent "too long" note.
//
// Compressed payloads travel as ?z=, uncompressed as ?state=. Old links keep
// working, and a browser without CompressionStream simply emits the old form.
const STATE_PARAM = 'state';
const PACKED_PARAM = 'z';

function bytesToB64URL(bytes) {
  // Chunked so a large payload can't blow the argument limit of String.fromCharCode.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Raw-deflate `bytes`, or null when the browser has no CompressionStream. */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // unsupported format string on older engines
  }
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function shareStructure() {
  const state = captureState();
  if (!state) { alert('No structure loaded to share.'); return; }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(state));
  const packed = await deflateRaw(jsonBytes);
  const b64 = bytesToB64URL(packed ?? jsonBytes);

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
  shareURL.searchParams.delete(packed ? STATE_PARAM : PACKED_PARAM);
  shareURL.searchParams.set(packed ? PACKED_PARAM : STATE_PARAM, b64);

  // A dialog, not the address bar: long URLs are truncated there, and the
  // dialog is where the QR code lives. The eager clipboard write is only
  // best-effort now that an await sits between the click and here — some
  // browsers drop user activation across it — so the dialog's Copy button is
  // the path that always works.
  const shareURLText = shareURL.toString();
  navigator.clipboard?.writeText(shareURLText).catch(() => {});
  showShareLink(shareURLText);
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
  if (display.showCharges != null) { general.showCharges = display.showCharges; setToggle('showCharges', display.showCharges); }
  if (display.showLattice != null) { general.showLattice = display.showLattice; setToggle('showLattice', display.showLattice); }
  if (display.showPeriodic != null){ general.showPeriodic= display.showPeriodic;setToggle('showPeriodic', display.showPeriodic); }
  if (display.periodicFaceTol != null){ general.periodicFaceTol = display.periodicFaceTol; }
  // Active Cell Boundary (VESTA-style display bounds); the Cell panel rebuilds
  // its inputs from `general` when next opened.
  if (display.periodicBounds != null){ general.periodicBounds = display.periodicBounds; }
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

  // Force / spin arrow display (issue #53). Only general.* is restored — the
  // panels read it live and rebuild their own widgets; the arrows themselves
  // are (re)drawn by applySharedState once the structure's periodic wrap
  // exists. Absent keys keep the current default.
  const setGen = (key, val) => { if (val != null) general[key] = val; };
  setGen('forceScale', display.forceScale);
  setGen('forceRadius', display.forceRadius);
  setGen('forceMin', display.forceMin);
  setGen('forceMax', display.forceMax);
  setGen('forceColorScale', display.forceColorScale);
  setGen('forceLengthLogScale', display.forceLengthLogScale);
  setGen('forceColorMap', display.forceColorMap);
  setGen('spinScale', display.spinScale);
  setGen('spinRadius', display.spinRadius);
  setGen('spinMin', display.spinMin);
  setGen('spinMax', display.spinMax);
  setGen('spinColorScale', display.spinColorScale);
  setGen('spinLengthLogScale', display.spinLengthLogScale);
  setGen('spinColorMap', display.spinColorMap);
  if (display.spinSpeciesVisibility) general.speciesVisibility = { ...display.spinSpeciesVisibility };
  if (display.forcesActive != null) { general.forcesActive = display.forcesActive; setToggle('showForcesToggle', display.forcesActive); }
  if (display.spinsActive != null) { general.spinsActive = display.spinsActive; setToggle('showSpinsToggle', display.spinsActive); }
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
    // A restored id may be a hidden pipeline (superseded split/sorted) with no
    // dropdown option — rebuild the option list first so the select can hold it.
    rebuildRenderPipelineMenu();
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
  if (style.rtRasterPreview != null) {
    general.rtRasterPreview = style.rtRasterPreview;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtPreviewToggle'));
    if (toggle) {
      toggle.checked = style.rtRasterPreview;
      toggle.dispatchEvent(new Event('change'));
    }
  }
  if (style.rtBackgroundMatch != null) {
    general.rtBackgroundMatch = style.rtBackgroundMatch;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtBgMatchToggle'));
    if (toggle) toggle.checked = style.rtBackgroundMatch;
  }
  if (style.rtToneMapLegacy != null) {
    general.rtToneMapLegacy = style.rtToneMapLegacy;
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtLegacyToneToggle'));
    if (toggle) toggle.checked = style.rtToneMapLegacy;
  }
  // rtPreviewRestDelay is a hidden config-only setting (no GUI) and is no longer
  // persisted; older saves that still carry the key are simply ignored so they
  // can't override the current default.
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
  // Defensive: the toggle's change-dispatch fires before offset/size restore, so
  // sync the raster disc to the final restored state (placement is re-fixed by
  // the structure load's updateVisualization, which runs after applyStyleSettings).
  updateGroundPlane();
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

  // Element-Materials-Map id (state v2.15+). Absent key = a pre-map state,
  // authored when everything defaulted to the plain standard material — force
  // 'standard' (NOT the fresh-session 'crysviz' default) so the saved look is
  // reproduced. Only the select VALUE is synced: dispatching 'change' would
  // run the dropdown's reset-manual-edits handler and wipe the materials
  // restored below.
  general.elementMaterialsMap = colors.elementMaterialsMap ?? 'standard';
  const materialsMapSelect = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('atomsElementMaterialsMapMenu'));
  if (materialsMapSelect) materialsMapSelect.value = general.elementMaterialsMap;

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
  for (const k of ['bondUserStyles', 'bondCategoryStyles', 'polyhedraUserStyles', 'polyhedraCategoryStyles', 'atomMaterials', 'atomUserMaterials', 'spinCategoryStyles', 'forceCategoryStyles', 'fieldMaterial']) {
    if (colors[k]) structure[k] = JSON.parse(JSON.stringify(colors[k]));
  }
}

// readPOSCAR wraps every fractional coordinate into [0,1), so a saved position
// of 1.0 (or -1e-12) comes back as 0. Normalise both sides or the lookup misses
// and the whole reorder is abandoned.
function atomKey(element, position) {
  return [
    element,
    ...position.map(v => normalizeFractional(Number(v)).toFixed(8)),
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

/** Rebuild the Force/Spin arrow objects saved in a .crysviz frame and attach
 *  them to the structure, which must already have had its atom order restored
 *  (arrows are index-aligned to structure.atoms, like the file readers build
 *  them). A saved `color` marks a pinned per-arrow pick, so it becomes
 *  userColor; otherwise the colormap recomputes color when the arrows draw. */
function applyArrows(saved, structure) {
  if (!structure) return;
  if (saved?.forces?.length) {
    structure.forces = saved.forces.map((f) => {
      const force = new Force({ vector: [...f.vector], scaling: f.scaling ?? null, color: f.color ?? null });
      if (f.color) force.userColor = force.color;
      if (f.material) force.userMaterial = JSON.parse(JSON.stringify(f.material));
      if (f.hidden) force.hidden = true;
      return force;
    });
  }
  if (saved?.spins?.length) {
    structure.spins = saved.spins.map((s) => {
      const spin = new Spin({
        vector: [...s.vector], scaling: s.scaling ?? null, color: s.color ?? null,
        atomIndex: s.atomIndex ?? null, element: s.element ?? null,
        position: s.position ? [...s.position] : null,
      });
      if (s.color) spin.userColor = spin.color;
      if (s.material) spin.userMaterial = JSON.parse(JSON.stringify(s.material));
      if (s.hidden) spin.hidden = true;
      return spin;
    });
  }
}

/** Rebuild volumetric fields embedded in a .crysviz and re-attach them to the
 *  loaded structure, replicating the CHGCAR/cube reader's post-attach sequence
 *  (fieldBrowser.setCatalog -> setSelectedField -> setActiveField ->
 *  updateField) plus the isosurface material restore. Synchronous, like the
 *  rest of the state restore. A field saved hidden stays hidden (updateField
 *  early-returns on !isVisible). */
function restoreFields(fieldState, structure) {
  const savedFields = fieldState?.fields;
  if (!savedFields?.length || !structure) return;

  const fields = savedFields.map((f) => new Field({
    label: f.label,
    nx: f.nx, ny: f.ny, nz: f.nz,
    origin: f.origin, voxel: f.voxel,
    component: f.component,
    isoValue: f.isoValue,
    useAbsoluteIsoValue: f.useAbsoluteIsoValue,
    isVisible: f.isVisible,
    minValue: f.minValue, maxValue: f.maxValue,
    absMinValue: f.absMinValue, absMaxValue: f.absMaxValue,
    values: f.values ? base64ToFloat32(f.values) : null,
  }));

  structure.volumetricFields = new FieldContainer({
    fileName: fieldState.fileName,
    source: fieldState.source,
    fields,
  });

  const selectedIndex = Math.min(Math.max(fieldState.selectedIndex ?? 0, 0), fields.length - 1);

  // Drive the browser from the container's own catalog rather than a separate
  // flat list, so the panel and the saved structure agree on one source of
  // truth. A .crysviz session only ever stores fully-materialised fields, so
  // this catalog is flat and every entry is loaded — setCatalog re-selects
  // index 0 and the saved index is applied straight after.
  fieldBrowser.setCatalog(structure.volumetricFields.catalog);
  fieldBrowser.setSelectedField(selectedIndex);
  const selected = fieldBrowser.selectedField;
  if (!selected) return;

  // The saved useAbsoluteIsoValue is already on the Field (a boolean, not null),
  // so pass it explicitly rather than letting setActiveField re-derive it.
  setActiveField(selected, selected.useAbsoluteIsoValue);
  updateField(selected.isoValue);

  // Isosurface material (positive/negative colors + opacity) — module globals.
  if (fieldState.isoSettings) {
    setIsosurfaceMaterialSettings(fieldState.isoSettings);
    applyMaterialSettingsToStoredIsosurfaces(groups.isosurfaceGroup, fieldState.isoSettings);
  }

  // The Field window is greyed until a structure carries volumetric fields.
  refreshPanelAvailability();
}

function restoreCamera(camState) {
  if (!camState?.position || !camState?.target) return Promise.resolve();
  try {
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
    applyCameraSnapshot({
      position: new THREE.Vector3(...camState.position),
      target: new THREE.Vector3(...camState.target),
      up: camState.up ? new THREE.Vector3(...camState.up) : app.camera.up.clone(),
      quaternion: camState.quaternion ? new THREE.Quaternion(...camState.quaternion) : null,
      pan: Array.isArray(camState.pan)
        ? { x: Number.isFinite(camState.pan[0]) ? camState.pan[0] : 0,
          y: Number.isFinite(camState.pan[1]) ? camState.pan[1] : 0 }
        : { x: 0, y: 0 },
      zoom: camState.zoom,
      orthographicFrustumSize: camState.orthographic ? camState.frustumSize : null,
    });
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

function restoreMeasurements(measurementData) {
  if (!measurementData?.length) return Promise.resolve();

  // Measurement refs resolve against the loaded structure's periodic wrap. That
  // wrap is usually ready synchronously, but can lag behind on a heavy structure
  // or the file-load path. A single fixed 200 ms delay used to fire before the
  // wrap existed and then silently `return`, dropping every measurement with no
  // retry — the reason a saved measurement did not reliably survive a reload.
  // Poll until the wrap is present (applied immediately in the common case),
  // capped so a structure that never wraps can't spin forever.
  const stepMs = 100;
  const maxWaitMs = 3000;
  let waited = 0;

  return new Promise((resolve, reject) => {
    const apply = () => {
    const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
    if (!wrapped) {
      waited += stepMs;
      if (waited <= maxWaitMs) setTimeout(apply, stepMs);
      else reject(new Error('Structure wrap was not ready for saved measurements'));
      return;
    }

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
      resolve();
    };

    apply();
  });
}

function makeAtomProxy(wrapped, ref) {
  const atomIndex = ref?.atomIndex;
  const structure = fileBrowser.selectedStructure;

  // Resolve against structure.atoms by POSITION, not by atomIndex. atomIndex is
  // fragile across a reload — a supercell round-trips through buildPOSCAR (which
  // re-groups atoms by element), so the same source index points at a different
  // atom, AND the periodic wrap's srcIndex can be out of sync with the reordered
  // atoms. Resolving by index (or by the wrap's srcIndex) then lands on the
  // wrong atom / wrong periodic image — visible as measurements that jump to a
  // different cell after sharing, especially when both endpoints sit on a
  // boundary.
  //
  // The ref carries `lastResolvedFrac`: the picked copy's fractional position in
  // the saved lattice, which is the SAME lattice on reload. We find the base
  // atom whose own fractional position differs from it by an integer lattice
  // translation — that gives a self-consistent { atomIndex, imageOffset } pair
  // in the current structure, independent of any renumbering. (`atomPosition` is
  // the legacy Cartesian form of the same information.)
  let targetFrac = null;
  if (Array.isArray(ref?.lastResolvedFrac)) {
    targetFrac = ref.lastResolvedFrac;
  } else if (ref?.atomPosition?.length && structure?.lattice) {
    targetFrac = cartToFractional(ref.atomPosition, structure.lattice);
  }

  if (targetFrac && structure?.atoms?.length && structure.lattice) {
    let bestJ = -1;
    let bestResidual = Infinity;
    let bestOffset = null;
    for (let j = 0; j < structure.atoms.length; j++) {
      if (ref?.element && structure.elements?.[j] && structure.elements[j] !== ref.element) continue;
      const baseFrac = structure.atoms[j].position;
      const offset = targetFrac.map((value, axis) => Math.round(value - baseFrac[axis]));
      // Residual after removing the integer translation — zero for the true atom.
      const residual = targetFrac.reduce((sum, value, axis) => sum + Math.abs(value - baseFrac[axis] - offset[axis]), 0);
      if (residual < bestResidual) { bestResidual = residual; bestJ = j; bestOffset = offset; }
    }
    if (bestJ >= 0 && bestResidual < 0.05) {
      const wrappedFrac = structure.atoms[bestJ].position.map((value, axis) => value + bestOffset[axis]);
      const cart = fracToCart([wrappedFrac], structure.lattice)[0];
      return {
        position: new THREE.Vector3(...cart),
        userData: {
          atomIndex: bestJ,
          element: structure.elements?.[bestJ] ?? ref?.element ?? '?',
          wrappedFrac,
        },
      };
    }
  }

  // Legacy fallback: no saved position at all — resolve by atomIndex, honouring
  // imageOffset if present (never grab the first source-index match, which is
  // the base copy).
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
      const baseFrac = structure?.atoms?.[atomIndex]?.position;
      if (baseFrac) {
        const candidateOffset = candidate.userData.wrappedFrac.map((value, axis) => Math.round(value - baseFrac[axis]));
        if (candidateOffset.every((value, axis) => value === ref.imageOffset[axis])) return candidate;
      }
    }
    if (!Array.isArray(ref?.imageOffset)) return candidate;
  }

  if (Array.isArray(ref?.imageOffset) && structure?.atoms?.[atomIndex]) {
    const baseFrac = structure.atoms[atomIndex].position;
    const wrappedFrac = baseFrac.map((value, axis) => value + ref.imageOffset[axis]);
    const cart = fracToCart([wrappedFrac], structure.lattice)[0];
    return {
      position: new THREE.Vector3(...cart),
      userData: {
        atomIndex,
        element: structure.elements?.[atomIndex] ?? '?',
        wrappedFrac,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Load from URL
// ---------------------------------------------------------------------------

export async function loadSharedStructure() {
  const params = new URLSearchParams(window.location.search);
  // ?z= is the deflated payload written since the QR code landed; ?state= is the
  // plain form, still emitted where CompressionStream is missing and still
  // present in every link shared before that.
  const packedParam = params.get(PACKED_PARAM);
  const stateParam = packedParam ?? params.get(STATE_PARAM);
  if (!stateParam) return false;

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
    let bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (packedParam) bytes = await inflateRaw(bytes);
    state = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    const invalidChars = [...stateParam].filter(c => !/[A-Za-z0-9\-_]/.test(c));
    console.error('Failed to decode shared state:', e,
      'param length:', stateParam.length,
      'invalid chars:', invalidChars.slice(0, 10));
    throw new Error(`Failed to decode shared state: ${e.message}`);
  }

  if (!applySharedState(state, 'shared.vasp')) {
    throw new Error('Shared state could not be applied.');
  }
  await waitForStateRestoration();

  general.sharedStructureLoaded = true;

  // Clean URL
  const newUrl = new URL(window.location.href);
  newUrl.searchParams.delete(STATE_PARAM);
  newUrl.searchParams.delete(PACKED_PARAM);
  window.history.replaceState({}, document.title, newUrl.toString());
  return true;
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
  // files (and the share-URL) carry only `structure`. New .crysviz files omit
  // the redundant top-level `structure` entirely (issue #53) — the viewed frame
  // is frames[selectedFrameIndex]; `viewed` resolves either form.
  const frames = Array.isArray(state.frames) ? state.frames : null;
  const multiFrame = !!(frames && frames.length > 1);
  const selectedFrameIndex = frames
    ? Math.min(Math.max(state.selectedFrameIndex ?? 0, 0), frames.length - 1)
    : 0;
  const viewed = state.structure ?? (frames ? frames[selectedFrameIndex] : null);
  if (!viewed) {
    console.warn('State has neither frames nor a structure to load.');
    return false;
  }
  let trajectoryContainer = null;

  // Load structure (synchronous — triggers updateVisualization internally)
  try {
    if (multiFrame) {
      // Rebuild each frame's Structure, restoring its native atom order (buildPOSCAR
      // groups by element) so per-atom indices stay stable across the trajectory,
      // then re-attach that frame's force/spin arrows (index-aligned to atoms).
      const structures = frames.map((f) => {
        const s = readPOSCAR(buildPOSCAR({ structure: f }), fileName);
        restoreAtomOrder(f, s);
        applyArrows(f, s);
        return s;
      });
      trajectoryContainer = new StructureContainer({ fileName, structures });
      initializeUIOnLoad(trajectoryContainer);
      // Land on the frame the user was viewing before colors/fields are applied,
      // so `structure` below is that frame (also draws its arrows via the gated
      // updateForces/updateSpins in updateStructureFromFrame).
      showTrajectoryFrame(selectedFrameIndex, trajectoryContainer);
    } else {
      parsePOSCAR(buildPOSCAR({ structure: viewed }), fileName);
    }
  } catch (e) {
    console.error('Failed to load structure from state:', e);
    return false;
  }

  const structure = fileBrowser.selectedStructure;
  if (!structure) return false;

  // Single-frame: buildPOSCAR() groups atoms by element, so restore the saved
  // atom ordering before applying any per-atom state that relies on stable
  // indices, then re-attach the arrows. (Multi-frame frames were already
  // restored above.)
  if (!multiFrame) {
    restoreAtomOrder(viewed, structure);
    applyArrows(viewed, structure);
  }

  revealFeaturePanels();
  // A share-URL boot restores through here instead of loadStructure(), so the
  // Share button (added by the normal load path, crystal-viewer.js) would never
  // be created — the loaded shared structure ended up with no Share button.
  // createShareButton() is idempotent (guards on #shareBtn).
  createShareButton();
  createBondLengthControls();

  // Apply colors on top of loaded structure, then push to GPU
  applyAtomColors(state.colors, structure);
  // Propagate the restored colors to every other frame so scrubbing the
  // trajectory keeps the saved appearance (indices align — all frames restored).
  if (multiFrame) trajectoryContainer.flushColorToAllStructures(structure);
  updateAtoms();

  // Volumetric fields embedded in a .crysviz: rebuild + re-attach after the
  // structure exists. Independent of the colors.fieldMaterial restore above
  // (that sets structure.fieldMaterial, consumed per-primitive by the tracer
  // SceneEncoder), so the two compose on the next trace.
  if (state.fields) restoreFields(state.fields, structure);

  // Rebuild bonds to reflect any bondLength / bondVisibility changes
  rebuildBonds();

  // Force / spin arrows (issue #53): general.* was restored in
  // applyDisplaySettings; draw them now that periodic.wrapped exists. The
  // multi-frame path already drew the viewed frame's arrows via
  // showTrajectoryFrame, so only the single-frame view needs this kick.
  if (!multiFrame) {
    if (general.forcesActive && structure.forces?.length) updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
    else removeForces();
    if (general.spinsActive && structure.spins?.length) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
    else removeSpins();
  } else {
    // Category stores follow the existing bondCategoryStyles restore scope:
    // they are restored on the selected frame only. Redraw that frame after
    // applying the stores so the raster arrow buffers no longer show the
    // pre-restore category colors.
    if (general.forcesActive && structure.forces?.length) updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
    else removeForces();
    if (general.spinsActive && structure.spins?.length) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
    else removeSpins();
  }

  // parsePOSCAR's updateVisualization kicked off the (async) polyhedra compute
  // BEFORE restoreAtomOrder and the style-store restore above; re-run it so
  // keys derive from the corrected atom order and restored styles render.
  // (updatePolyhedra coalesces with any in-flight compute.)
  const restorationTasks = [restoreCamera(state.camera), restoreMeasurements(state.measurements)];
  if (general.showPolyhedra || general.completePolyhedra) restorationTasks.push(updatePolyhedra());
  lastRestorePromise = Promise.all(restorationTasks).then(() => undefined);
  // Legacy synchronous callers still receive the boolean below; the async
  // loaders await this same promise. Mark the rejection handled here so a
  // legacy caller cannot create an unhandled rejection while the async owner
  // still receives the original failure when it awaits the promise.
  lastRestorePromise.catch(() => {});

  // Cel style: re-fire the dropdown so its dependent controls (outline block)
  // appear; the handler re-renders, which is only paid for cel states.
  if (state.style?.renderStyle === 'cel') {
    document.getElementById('renderStyleMenu')?.dispatchEvent(new Event('change'));
  }
  // Re-fire the pipeline dropdown so ColorPanel's updateRenderingControlsVisibility
  // runs for EVERY restored pipeline id (not just the tracers): a raster restore
  // while the app is currently in a tracer must hide the tracer control blocks +
  // the `tracer-pipeline` body class and reveal the raster-only Render Style menu.
  // No tracer warning fires during a restore because the handler's
  // `isTracer && !wasTracer` guard is already false here (general.renderPipeline
  // was set by applyStyleSettings before this dispatch), so no one-shot
  // suppression is needed.
  if (state.style?.renderPipeline) {
    document.getElementById('renderPipelineMenu')?.dispatchEvent(new Event('change'));
  }

  return true;
}

export async function waitForStateRestoration() {
  await lastRestorePromise;
}

// ---------------------------------------------------------------------------
// Load from a .crysviz file (the Download menu's save format)
// ---------------------------------------------------------------------------

export async function loadCrysvizFile(content, fileName = 'file.crysviz') {
  const initialContainerCount = structureShip.container.length;
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
  await waitForStateRestoration();
  const container = structureShip.container.length > initialContainerCount
    ? structureShip.container.at(-1)
    : null;
  if (!container) {
    throw new Error(`Could not find the loaded structure in ${fileName}.`);
  }
  return container;
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
  // shareStructure is async (it deflates the state); swallow the rejection here
  // so a failure surfaces in the console rather than as an unhandled rejection.
  shareBtn.onclick = () => { shareStructure().catch(e => console.error('Share failed:', e)); };

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
