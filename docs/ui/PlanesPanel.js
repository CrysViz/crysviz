import { app, fileBrowser, general } from '../state/store.js';
import { Plane, CutModes, DEFAULT_COLORMAP_RESOLUTION, getPlaneDefinitionNormalAndD, normalizePlaneCutMode, CartesianParamsToMillerInds, fitPlaneToPoints, PLANE_VIS_NONE, PLANE_VIS_FIELD } from '../model/Plane.js';
import { fieldBrowser } from './FieldPanel.js';
import { updateAtomCutPlaneState } from '../render/AtomsFracUpdateModule.js';
import { getSelectedAtoms, subscribeToAtomSelection } from './SelectAndHighlightModule.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { createColorBar } from './ColorBarWidget.js';
import { registerColorBarSource } from './ColorBarRegistry.js';
import { computeAutoRange, roundToSigFigs } from '../utils/index.js';

export const planesData = {
  activeInputMode: 'hkl', // 'hkl' or 'uvwd'
  showPlanes: true,
  calculateFromAtomsEnabled: false,
};

const structurePlaneMeshes = new WeakMap();
let activeRenderedStructure = null;
let selectedPlaneIndex = null;
let atomSelectionUnsubscribe = null;

// The floating/dockable color-bar legend (ColorBarWidget.js, same widget
// Forces/Spins/Atoms/Bonds use) for whichever plane is currently selected —
// there's one shared instance, not one per plane, since only one plane's
// controls are ever shown at a time (selectedPlaneIndex). Rebuilt whenever
// the selection changes so it reflects that plane's own colormap/range/
// scale instead of a stale previous plane's.
const PLANE_COLORBAR_FLOATING_ID = 'planeColorBarFloating';
let planesColorBarInstance = null;
// Which plane object planesColorBarInstance is currently showing — needed at
// teardown time (refreshPlaneColorBar) because selectedPlaneIndex may have
// already moved on to a different plane by then (e.g. the user just picked a
// new plane), so the freshly-computed `plane` there is the NEW plane, not
// the one whose legend text is actually being read off the outgoing bar.
let planesColorBarOwnerPlane = null;

registerColorBarSource('plane', 'Field', () => planesColorBarInstance);

function getSelectedStructure() {
  return fileBrowser.selectedStructure || null;
}

function ensureStructurePlaneState(structure) {
  if (!structure) return;
  if (!Array.isArray(structure.planes)) structure.planes = [];
}

function getSelectedStructurePlanes() {
  const structure = getSelectedStructure();
  if (!structure || !Array.isArray(structure.planes)) return [];
  return structure.planes;
}

function getStructureMeshMap(structure) {
  let meshMap = structurePlaneMeshes.get(structure);
  if (!meshMap) {
    meshMap = new Map();
    structurePlaneMeshes.set(structure, meshMap);
  }
  return meshMap;
}

function removePlaneMesh(structure, planeDef) {
  if (!structure) return;
  const meshMap = getStructureMeshMap(structure);
  const mesh = meshMap.get(planeDef);
  if (!mesh) return;
  app.scene?.remove(mesh);
  if (typeof mesh.dispose === 'function') {
    mesh.dispose();
  }
  meshMap.delete(planeDef);
}

function replacePlaneMesh(structure, planeDef) {
  if (!structure || !planeDef || !app.scene) return;
  removePlaneMesh(structure, planeDef);

  const lattice = structure.lattice;
  if (!Array.isArray(lattice) || lattice.length !== 3) return;

  const { normal, d } = getPlaneDefinitionNormalAndD(planeDef, lattice);
  if (!Array.isArray(normal) || normal.length !== 3) {
    return;
  }
  if (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]) < 1e-12) {
    return;
  }

  const planeMesh = new Plane({
    normal,
    d,
    cell: lattice,
    // Mesh tessellation density is no longer a user-exposed setting (it
    // never actually controlled color smoothness — the LUT sampling was
    // always a fixed 256 steps regardless — just the geometry's own vertex
    // density), so this is now always the same default everyone gets.
    resolution: DEFAULT_COLORMAP_RESOLUTION,
    mode: planeDef.visualization || 'None',
    field: planeDef.field || null,
    colormap: planeDef.colormap || 'heatmap',
    colormapMin: planeDef.colormapMin,
    colormapMax: planeDef.colormapMax,
    colormapScale: planeDef.colormapScale || 'linear',
  });

  planeMesh.visible = Boolean(planesData.showPlanes && planeDef.enabled);
  app.scene.add(planeMesh);
  getStructureMeshMap(structure).set(planeDef, planeMesh);
}

function clearRenderedPlanesForStructure(structure) {
  if (!structure || !app.scene) return;
  const meshMap = getStructureMeshMap(structure);
  meshMap.forEach(mesh => {
    app.scene.remove(mesh);
    if (typeof mesh.dispose === 'function') {
      mesh.dispose();
    }
  });
  meshMap.clear();
}

function bindPanelStateToSelectedStructure() {
  const structure = getSelectedStructure();
  if (!structure) return;

  ensureStructurePlaneState(structure);
}

function refreshCurrentStructurePlanesInScene() {
  const structure = getSelectedStructure();
  if (!structure) return;

  clearRenderedPlanesForStructure(structure);
  structure.planes.forEach(planeDef => replacePlaneMesh(structure, planeDef));
}

/**
 * Global "Show Planes" master (the Features window). Gates the visibility of
 * every plane mesh (see replacePlaneMesh, which ANDs planesData.showPlanes
 * with each plane's own `enabled`).
 */
export function setPlanesVisible(visible) {
  planesData.showPlanes = !!visible;
  refreshCurrentStructurePlanesInScene();
}

function syncAtomCutPlanesFromSelectedStructure() {
  const structure = getSelectedStructure();
  const retainedPlanes = (general.atomCutPlanes || []).filter(
    plane => plane?.source !== 'structure-plane'
  );

  if (structure?.planes?.length && Array.isArray(structure.lattice)) {
    structure.planes.forEach((planeDef, planeIndex) => {
      const cutMode = normalizePlaneCutMode(planeDef?.cutMode);
      if (cutMode === CutModes.NONE) return;

      const { normal, d } = getPlaneDefinitionNormalAndD(planeDef, structure.lattice);
      if (!Array.isArray(normal) || normal.length !== 3) return;

      retainedPlanes.push({
        enabled: true,
        x: normal[0],
        y: normal[1],
        z: normal[2],
        r: d,
        side: cutMode === CutModes.OPPOSITEN ? CutModes.OPPOSITEN : CutModes.ALONGN,
        source: 'structure-plane',
        planeIndex,
      });
    });
  }

  general.atomCutPlanes = retainedPlanes;
  updateAtomCutPlaneState();
  updateVisualization({
    atomsUpdate: false,
    bondsUpdate: true,
    reRenderAtoms: false,
    reRenderBonds: false,
    reRenderLattice: false,
    reRenderOther: false,
    reRenderComposition: false,
  });
}

export function syncPlanesForSelectedStructure() {
  const structure = getSelectedStructure();

  if (activeRenderedStructure && activeRenderedStructure !== structure) {
    clearRenderedPlanesForStructure(activeRenderedStructure);
  }

  activeRenderedStructure = structure;
  bindPanelStateToSelectedStructure();

  if (structure) {
    refreshCurrentStructurePlanesInScene();
  }

  syncAtomCutPlanesFromSelectedStructure();

  selectedPlaneIndex = null;
  renderPlanesTable();
}

/**
 * Toggle the enabled state for "Calculate from Selected Atoms" button.
 * @param {boolean} enabled - Whether to enable the button
 */
export function setCalculateFromAtomsEnabled(enabled) {
  planesData.calculateFromAtomsEnabled = enabled;
  const btn = document.getElementById('calcFromAtomsBtn');
  if (btn) {
    btn.disabled = !enabled;
  }
}

function updateCalculateFromAtomsButtonForSelection(selectedAtoms = []) {
  setCalculateFromAtomsEnabled(Array.isArray(selectedAtoms) && selectedAtoms.length >= 3);
}

function ensureAtomSelectionSubscription() {
  if (atomSelectionUnsubscribe) {
    return;
  }

  atomSelectionUnsubscribe = subscribeToAtomSelection(({ selectedAtoms }) => {
    updateCalculateFromAtomsButtonForSelection(selectedAtoms);
  }, { emitCurrent: true });
}

function setNumericInputValue(elementId, value, fractionDigits = null) {
  const input = document.getElementById(elementId);
  if (!input) return;

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    input.value = '0';
    return;
  }

  input.value = fractionDigits === null
    ? `${numericValue}`
    : numericValue.toFixed(fractionDigits);
}

/**
 * Apply the user-adjustable min/max endpoint inputs to the d slider's own
 * range, clamping its current thumb position (display only — the
 * authoritative d value lives in the #planeD text box / plane.params.d).
 */
function applyDSliderBounds() {
  const slider = document.getElementById('planeDSlider');
  const minInput = document.getElementById('planeDSliderMin');
  const maxInput = document.getElementById('planeDSliderMax');
  if (!slider || !minInput || !maxInput) return;

  let min = parseFloat(minInput.value);
  let max = parseFloat(maxInput.value);
  if (!Number.isFinite(min)) min = -10;
  if (!Number.isFinite(max)) max = 10;
  if (min >= max) max = min + 0.01;

  minInput.value = `${min}`;
  maxInput.value = `${max}`;
  slider.min = `${min}`;
  slider.max = `${max}`;
  slider.value = `${Math.min(Math.max(parseFloat(slider.value) || 0, min), max)}`;
}

/**
 * Keep the d slider's endpoints wide enough to cover the plane's current d
 * value (e.g. a plane loaded from a file/state with d outside the default
 * [-10, 10] bounds), then sync the thumb to that value.
 */
function ensureDSliderCoversValue(dValue) {
  const slider = document.getElementById('planeDSlider');
  const minInput = document.getElementById('planeDSliderMin');
  const maxInput = document.getElementById('planeDSliderMax');
  if (!slider || !minInput || !maxInput) return;

  let min = parseFloat(minInput.value);
  let max = parseFloat(maxInput.value);
  if (!Number.isFinite(min)) min = -10;
  if (!Number.isFinite(max)) max = 10;

  if (Number.isFinite(dValue)) {
    if (dValue < min) min = Math.floor(dValue - 1);
    if (dValue > max) max = Math.ceil(dValue + 1);
  }

  minInput.value = `${min}`;
  maxInput.value = `${max}`;
  slider.min = `${min}`;
  slider.max = `${max}`;
  if (Number.isFinite(dValue)) slider.value = `${dValue}`;
}

function updateFieldControlsAvailability(enabled) {
  const fieldSection = document.getElementById('planesFieldSection');
  const fieldCard = fieldSection?.querySelector('.planes-field-colormap-container');
  const fieldControls = document.querySelectorAll(
    '#planesFieldSelect, #planesColormapSelect, #planesColormapRangeMin, #planesColormapRangeMax, #planesLogScaleCheckbox, #planesAutoRangeBtn'
  );
  const hasFields = fieldBrowser.availableFields && fieldBrowser.availableFields.length > 0;
  const controlsEnabled = Boolean(enabled && hasFields);

  fieldControls.forEach(ctrl => {
    ctrl.disabled = !controlsEnabled;
  });

  if (fieldCard) {
    fieldCard.classList.toggle('planes-field-colormap-disabled', !controlsEnabled);
  }
}

function clampPlaneRangeValue(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function formatPlaneRangeLabel(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return '0';
  }

  if (Math.abs(numericValue) >= 1000 || (Math.abs(numericValue) > 0 && Math.abs(numericValue) < 0.01)) {
    return numericValue.toExponential(2);
  }

  return `${numericValue.toFixed(3).replace(/\.?0+$/, '')}`;
}

function configurePlaneRangeInputs(field, plane = null) {
  const rangeMin = document.getElementById('planesColormapRangeMin');
  const rangeMax = document.getElementById('planesColormapRangeMax');
  const rangeDisplay = document.getElementById('planesRangeDisplay');
  if (!rangeMin || !rangeMax) return;

  const fieldMin = Number(field?.minValue);
  const fieldMax = Number(field?.maxValue);
  const hasFieldRange = Number.isFinite(fieldMin) && Number.isFinite(fieldMax);
  let sliderMin = hasFieldRange ? Math.min(fieldMin, fieldMax) : 0;
  let sliderMax = hasFieldRange ? Math.max(fieldMin, fieldMax) : 100;

  // Widen to also cover the plane's own stored range if it already extends
  // past the field's raw min/max (e.g. Auto Range's own 20% padding) —
  // otherwise the slider bounds below would silently clamp/undo that
  // padding every time the panel re-syncs (re-selecting this plane,
  // switching away and back, a structure reload).
  const planeMinRaw = Number(plane?.colormapMin);
  const planeMaxRaw = Number(plane?.colormapMax);
  if (Number.isFinite(planeMinRaw)) sliderMin = Math.min(sliderMin, planeMinRaw);
  if (Number.isFinite(planeMaxRaw)) sliderMax = Math.max(sliderMax, planeMaxRaw);

  rangeMin.min = `${sliderMin}`;
  rangeMin.max = `${sliderMax}`;
  rangeMax.min = `${sliderMin}`;
  rangeMax.max = `${sliderMax}`;

  const span = sliderMax - sliderMin;
  const step = span > 0 ? Math.max(span / 1000, Number.EPSILON) : 1;
  rangeMin.step = `${step}`;
  rangeMax.step = `${step}`;

  const planeMin = clampPlaneRangeValue(plane?.colormapMin, sliderMin);
  const planeMax = clampPlaneRangeValue(plane?.colormapMax, sliderMax);
  const clampedMin = Math.min(Math.max(planeMin, sliderMin), sliderMax);
  const clampedMax = Math.min(Math.max(planeMax, sliderMin), sliderMax);

  rangeMin.value = `${Math.min(clampedMin, clampedMax)}`;
  rangeMax.value = `${Math.max(clampedMin, clampedMax)}`;

  if (rangeDisplay) {
    rangeDisplay.textContent = `${formatPlaneRangeLabel(Number(rangeMin.value))} – ${formatPlaneRangeLabel(Number(rangeMax.value))}`;
  }

  updateDualSliderFill();
}

function syncDerivedPlaneInputs(params, lattice) {
  if (!params) return;

  if (params.type === 'hkl') {
    const h = Number(params.h) || 0;
    const k = Number(params.k) || 0;
    const l = Number(params.l) || 0;

    setNumericInputValue('planeH', h);
    setNumericInputValue('planeK', k);
    setNumericInputValue('planeL', l);

    if (!Array.isArray(lattice) || lattice.length !== 3) {
      setNumericInputValue('planeU', 0, 4);
      setNumericInputValue('planeV', 0, 4);
      setNumericInputValue('planeW', 0, 4);
      setNumericInputValue('planeD', 0, 4);
      ensureDSliderCoversValue(0);
      return;
    }

    const derived = getPlaneDefinitionNormalAndD({ params }, lattice);
    const normal = Array.isArray(derived?.normal) ? derived.normal : [0, 0, 0];
    setNumericInputValue('planeU', normal[0] ?? 0, 4);
    setNumericInputValue('planeV', normal[1] ?? 0, 4);
    setNumericInputValue('planeW', normal[2] ?? 0, 4);
    setNumericInputValue('planeD', derived?.d ?? 0, 4);
    ensureDSliderCoversValue(derived?.d ?? 0);
    return;
  }

  if (params.type === 'uvwd') {
    const u = Number(params.u) || 0;
    const v = Number(params.v) || 0;
    const w = Number(params.w) || 0;
    const d = Number(params.d) || 0;

    setNumericInputValue('planeU', u, 4);
    setNumericInputValue('planeV', v, 4);
    setNumericInputValue('planeW', w, 4);
    setNumericInputValue('planeD', d, 4);
    ensureDSliderCoversValue(d);

    if (!Array.isArray(lattice) || lattice.length !== 3) {
      setNumericInputValue('planeH', 0);
      setNumericInputValue('planeK', 0);
      setNumericInputValue('planeL', 0);
      return;
    }

    /** @type {any} */
    const derived = CartesianParamsToMillerInds([u, v, w], d, lattice) || {};
    // Derived (not user-typed) — floating-point round-trip through the
    // lattice matrix routinely lands a "clean" 1 as 0.9999999999999998, so
    // this needs the same 4-digit rounding u/v/w/d already get above.
    setNumericInputValue('planeH', derived.h ?? 0, 4);
    setNumericInputValue('planeK', derived.k ?? 0, 4);
    setNumericInputValue('planeL', derived.l ?? 0, 4);
  }
}

function updateDualSliderFill() {
  const rangeMin = document.getElementById('planesColormapRangeMin');
  const rangeMax = document.getElementById('planesColormapRangeMax');
  const fill = document.getElementById('planesDualSliderFill');
  if (!rangeMin || !rangeMax || !fill) return;

  const sliderMin = Number(rangeMin.min) || 0;
  const sliderMax = Number(rangeMin.max) || 100;
  const span = Math.max(sliderMax - sliderMin, 1);
  const minValue = Number(rangeMin.value);
  const maxValue = Number(rangeMax.value);
  const start = ((minValue - sliderMin) / span) * 100;
  const end = ((maxValue - sliderMin) / span) * 100;

  fill.style.left = `${Math.min(start, end)}%`;
  fill.style.width = `${Math.max(end - start, 0)}%`;
}

function updateRangeDisplayAndPlane(changedInput = null) {
  const rangeMin = document.getElementById('planesColormapRangeMin');
  const rangeMax = document.getElementById('planesColormapRangeMax');
  const rangeDisplay = document.getElementById('planesRangeDisplay');
  if (!rangeMin || !rangeMax || !rangeDisplay) return;

  let minValue = Number(rangeMin.value);
  let maxValue = Number(rangeMax.value);

  if (minValue > maxValue) {
    if (changedInput === rangeMin) {
      maxValue = minValue;
      rangeMax.value = `${maxValue}`;
    } else {
      minValue = maxValue;
      rangeMin.value = `${minValue}`;
    }
  }

  rangeDisplay.textContent = `${formatPlaneRangeLabel(minValue)} – ${formatPlaneRangeLabel(maxValue)}`;
  updateDualSliderFill();

  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
  const plane = structure.planes[selectedPlaneIndex];
  if (!plane) return;

  plane.colormapMin = minValue;
  plane.colormapMax = maxValue;
  replacePlaneMesh(structure, plane);
  // Keep the floating/dockable color bar's own Min/Max in sync with the
  // slider — setRange (not a full refreshPlaneColorBar rebuild) so dragging
  // the slider doesn't reset the bar's floating position/orientation mid-drag.
  planesColorBarInstance?.setRange(minValue, maxValue);
}

// Reverse direction of the sync above: keeps the dual slider's displayed
// value AND its own min/max bounds in sync with a range that originated
// from the color bar (typed Min/Max, or Auto Range) instead of the slider
// itself. Widening the bounds matters because a native <input type=range>
// can't represent a value outside its own min/max attributes at all — a
// typed or auto-computed value past the field's raw data range (Auto
// Range's own 20% padding, for instance) would otherwise just silently
// clamp back to whatever the slider's old bounds were.
function syncPlaneRangeControls(minValue, maxValue) {
  const rangeMin = document.getElementById('planesColormapRangeMin');
  const rangeMax = document.getElementById('planesColormapRangeMax');
  const rangeDisplay = document.getElementById('planesRangeDisplay');
  if (!rangeMin || !rangeMax) return;

  const sliderMin = Math.min(Number(rangeMin.min) || 0, minValue);
  const sliderMax = Math.max(Number(rangeMin.max) || 100, maxValue);
  const span = sliderMax - sliderMin;
  const step = span > 0 ? Math.max(span / 1000, Number.EPSILON) : 1;
  [rangeMin, rangeMax].forEach(el => {
    el.min = `${sliderMin}`;
    el.max = `${sliderMax}`;
    el.step = `${step}`;
  });

  rangeMin.value = `${minValue}`;
  rangeMax.value = `${maxValue}`;
  if (rangeDisplay) rangeDisplay.textContent = `${formatPlaneRangeLabel(minValue)} – ${formatPlaneRangeLabel(maxValue)}`;
  updateDualSliderFill();
}

// Rebuilds the floating/dockable legend (ColorBarWidget.js, the same
// widget Forces/Spins/Atoms/Bonds use) to reflect whichever plane is
// currently selected — there's one shared instance, not one per plane,
// since only one plane's controls are ever shown at a time. Called
// whenever the selection, field assignment, or colormap changes; a plain
// range edit (slider drag, color bar Min/Max, Auto Range) uses the
// lighter setRange()/syncPlaneRangeControls() sync instead so it doesn't
// reset the bar's floating position mid-drag.
function refreshPlaneColorBar() {
  const container = document.getElementById('planesColorBarContainer');
  if (!container) return;

  const structure = getSelectedStructure();
  const plane = (structure && selectedPlaneIndex !== null && selectedPlaneIndex >= 0)
    ? structure.planes[selectedPlaneIndex]
    : null;
  const hasField = Boolean(plane && plane.visualization === PLANE_VIS_FIELD && plane.field);

  // Persist floating/orientation state before tearing down (mirrors
  // ForcePanel.js/SpinPanel.js's captureColorBarState) — switching planes
  // or fields shouldn't reset a bar the user dragged into the scene back
  // to docked/horizontal.
  if (planesColorBarInstance) {
    const settings = planesColorBarInstance.getSettings();
    general.planeColorBarOrientation = settings.orientation;
    general.planeColorBarFlipSide = settings.flipSide;
    general.colorBarSize = settings.size;
    if (planesColorBarOwnerPlane) {
      planesColorBarOwnerPlane.legendText = settings.legend;
    }
    general.planeColorBarFloating = planesColorBarInstance.isFloating();
    if (general.planeColorBarFloating) {
      general.planeColorBarFloatPos = planesColorBarInstance.getAnchor();
    }
    planesColorBarInstance.remove();
    planesColorBarInstance = null;
    planesColorBarOwnerPlane = null;
  }
  container.innerHTML = '';

  if (!hasField) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  // Same rounding as the fieldSelect handler's plane.colormapMin/Max
  // assignment — this fallback only fires when those are somehow still
  // unset (e.g. plane state restored from an older save), but the raw
  // field.minValue/maxValue it falls back to has the identical noisy-float
  // problem, so it needs the same treatment.
  const minValue = Number.isFinite(plane.colormapMin) ? plane.colormapMin : roundToSigFigs(plane.field.minValue ?? 0, 4);
  const maxValue = Number.isFinite(plane.colormapMax) ? plane.colormapMax : roundToSigFigs(plane.field.maxValue ?? 1, 4);

  planesColorBarInstance = createColorBar(container, plane.colormap || 'heatmap', minValue, maxValue, {
    floatingId: PLANE_COLORBAR_FLOATING_ID,
    fallbackMin: minValue,
    fallbackMax: maxValue,
    legend: plane.legendText ?? (plane.field.label || plane.fieldLabel || 'Field'),
    scale: plane.colormapScale || 'linear',
    orientation: general.planeColorBarOrientation,
    flipSide: general.planeColorBarFlipSide,
    size: general.colorBarSize,
    onLimitsCommit: (min, max) => {
      const s = getSelectedStructure();
      if (!s || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const p = s.planes[selectedPlaneIndex];
      if (!p) return;
      p.colormapMin = min;
      p.colormapMax = max;
      syncPlaneRangeControls(min, max);
      replacePlaneMesh(s, p);
    },
    onScaleChange: (scale) => applyPlaneLogScale(scale === 'log'),
    onAutoRange: () => applyPlaneAutoRange(),
  });
  planesColorBarOwnerPlane = plane;

  if (general.planeColorBarFloating && general.planeColorBarFloatPos) {
    planesColorBarInstance.floatAtAnchor(general.planeColorBarFloatPos);
  }
}

// Shared by the side-panel checkbox and the floating color bar's own
// burger-menu "Log Scale" item — either can flip it, both stay in sync
// since this is the only place that actually applies the change. Mirrors
// ForcePanel.js's applyLogScale.
function applyPlaneLogScale(isLog) {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
  const plane = structure.planes[selectedPlaneIndex];
  if (!plane) return;

  plane.colormapScale = isLog ? 'log' : 'linear';
  // log10(0) is -Infinity — floor a min at/below 0 to a small positive
  // value the moment log scale turns on, same guard Forces/Spins/Atoms/
  // Bonds all apply.
  if (isLog && (!Number.isFinite(plane.colormapMin) || plane.colormapMin <= 0)) {
    plane.colormapMin = 0.01;
    syncPlaneRangeControls(plane.colormapMin, plane.colormapMax);
    planesColorBarInstance?.setRange(plane.colormapMin, plane.colormapMax);
  }
  const logScaleCheckbox = document.getElementById('planesLogScaleCheckbox');
  if (logScaleCheckbox) logScaleCheckbox.checked = isLog;
  planesColorBarInstance?.update(plane.colormap, plane.colormapScale);
  replacePlaneMesh(structure, plane);
}

// Shared by the Auto Range button and the burger menu's own "Auto Range"
// item. Recomputes min/max from the field's actual data range (minValue/
// maxValue — the field's own already-computed true extremes), padded 20%
// of the data's own span on each side and rounded to 3 significant figures
// (computeAutoRange), exactly matching Forces/Spins/Atoms/Bonds.
function applyPlaneAutoRange() {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
  const plane = structure.planes[selectedPlaneIndex];
  if (!plane || !plane.field) return;

  const range = computeAutoRange([Number(plane.field.minValue), Number(plane.field.maxValue)]);
  if (!range) return;
  let { min, max } = range;
  if (plane.colormapScale === 'log' && min <= 0) min = 0.01;

  plane.colormapMin = min;
  plane.colormapMax = max;
  syncPlaneRangeControls(min, max);
  planesColorBarInstance?.setRange(min, max);
  replacePlaneMesh(structure, plane);
}

export function addPlanesPanel(target = "cvPanelBody-planes") {
  const container = document.getElementById(target);
  if (!container) {
    console.error(`${target} not found`);
    return;
  }

  bindPanelStateToSelectedStructure();
  ensureAtomSelectionSubscription();
  container.innerHTML = `
    <div class="control-group">
      <div class="planes-header">
        <button id="addPlaneBtn" class="planes-action-btn planes-top-btn">Add Plane</button>
      </div>

      <!-- Planes table in container -->
      <div class="planes-table-wrapper">
        <p id="noPlanesMsg" class="planes-empty-msg">No planes added yet.</p>
        <table id="planesTable" class="planes-table" style="display:none;">
          <thead>
            <tr>
              <th class="planes-th planes-th-narrow"></th>
              <th class="planes-th">(hkl)</th>
              <th class="planes-th">(xyz | d)</th>
              <th class="planes-th">Field</th>
              <th class="planes-th">Filter</th>
              <th class="planes-th planes-th-narrow planes-th-del-sticky"></th>
            </tr>
          </thead>
          <tbody id="planesTableBody"></tbody>
        </table>
      </div>

      <!-- Calculate from atoms button (centered) -->
      <div class="planes-center-row">
        <button id="calcFromAtomsBtn" class="planes-action-btn planes-calc-btn" disabled>
          Calculate from Selected Atoms
        </button>
      </div>

      <!-- Plane parameter controls (hidden until plane selected) -->
      <div class="planes-params-section" id="planesParamsSection" style="display:none;">
        <h4 class="planes-section-title">Plane Parameters</h4>

        <div class="control-group">
          <label class="toggle_row toggle_container">
            <span class="toggle_switch">
              <input type="checkbox" id="showPlanesToggle" ${planesData.showPlanes ? 'checked' : ''}>
              <span class="toggle_slider"></span>
            </span>
            <span class="toggle_text">Show Plane</span>
          </label>
        </div>

        <div class="planes-input-section">

          <!-- Row 1: u v w + d -->
          <div class="planes-input-row" id="planeRowUVWD">
            <label class="planes-radio-label">
              <input type="radio" name="planeInputMode" id="radioUVWD" value="uvwd">
              <span>Cartesian parameters</span>
            </label>
            <div class="planes-row-inputs planes-uvwd-layout" id="uvwdInputs">
              <div class="planes-uvw-cluster">
                <div class="planes-labeled-input">
                  <span class="planes-input-label">x</span>
                  <input type="number" id="planeU" class="planes-num-input" value="0" step="0.1" disabled>
                </div>
                <div class="planes-labeled-input">
                  <span class="planes-input-label">y</span>
                  <input type="number" id="planeV" class="planes-num-input" value="0" step="0.1" disabled>
                </div>
                <div class="planes-labeled-input">
                  <span class="planes-input-label">z</span>
                  <input type="number" id="planeW" class="planes-num-input" value="1" step="0.1" disabled>
                </div>
              </div>
              <div class="planes-d-cluster">
                <div class="planes-labeled-input">
                  <span class="planes-input-label">d</span>
                  <input type="number" id="planeD" class="planes-num-input" value="0" step="0.1" disabled>
                </div>
                <div class="planes-d-slider-row">
                  <input type="range" id="planeDSlider" class="planes-d-slider" min="-10" max="10" step="0.01" value="0" disabled>
                </div>
                <div class="planes-d-slider-bounds">
                  <input type="number" id="planeDSliderMin" class="planes-num-input planes-d-bound-input" value="-10" step="0.1" disabled title="Slider min">
                  <input type="number" id="planeDSliderMax" class="planes-num-input planes-d-bound-input" value="10" step="0.1" disabled title="Slider max">
                </div>
              </div>
            </div>
          </div>

          <!-- Row 2: h k l -->
          <div class="planes-input-row" id="planeRowHKL">
            <label class="planes-radio-label">
              <input type="radio" name="planeInputMode" id="radioHKL" value="hkl" checked>
              <span>Miller indices</span>
            </label>
            <div class="planes-row-inputs" id="hklInputs">
              <div class="planes-labeled-input">
                <span class="planes-input-label">h</span>
                <input type="number" id="planeH" class="planes-num-input" value="1" step="1" disabled>
              </div>
              <div class="planes-labeled-input">
                <span class="planes-input-label">k</span>
                <input type="number" id="planeK" class="planes-num-input" value="0" step="1" disabled>
              </div>
              <div class="planes-labeled-input">
                <span class="planes-input-label">l</span>
                <input type="number" id="planeL" class="planes-num-input" value="0" step="1" disabled>
              </div>
            </div>
          </div>

        </div>

        <!-- Cut mode -->
        <div class="planes-cut-row">
          <label class="planes-cut-label">Filter/hide atoms:</label>
          <select id="planeCutMode" class="planes-select" disabled>
            <option value="${CutModes.NONE}">None</option>
            <option value="${CutModes.ALONGN}">Along Normal</option>
            <option value="${CutModes.OPPOSITEN}">Opposite Normal</option>
          </select>
        </div>

      </div>

      <!-- Field + colormap grouped -->
      <div class="planes-field-section" id="planesFieldSection" style="display:none;">
        <h4 class="planes-section-title">Field &amp; Colormap</h4>
        <div class="planes-field-colormap-container">

          <div class="planes-field-colormap-grid">
            <div class="planes-field-control">
            <label for="planesFieldSelect">Field:</label>
            <select id="planesFieldSelect" class="planes-select planes-full-width" disabled>
              <option value="">No fields available</option>
            </select>
            </div>

            <div class="planes-field-control">
            <label for="planesColormapSelect">Colormap:</label>
            <select id="planesColormapSelect" class="planes-select planes-full-width" disabled>
              <option value="heatmap">Heat Map</option>
              <option value="batlow">Batlow</option>
              <option value="hawaii">Hawaii</option>
              <option value="managua">Managua</option>
              <option value="viridis">Viridis</option>
              <option value="plasma">Plasma</option>
              <option value="spectralR">Spectral R</option>
              <option value="jet">Jet</option>
            </select>
          </div>
          </div>

          <div class="planes-field-control planes-field-range-control">
            <label>Range:</label>
            <div class="planes-range-container">
              <div class="planes-dual-slider">
                <div class="planes-dual-slider-track"></div>
                <div class="planes-dual-slider-fill" id="planesDualSliderFill"></div>
                <input type="range" id="planesColormapRangeMin" class="planes-slider planes-slider-min" value="0" min="0" max="100" step="1" disabled>
                <input type="range" id="planesColormapRangeMax" class="planes-slider planes-slider-max" value="100" min="0" max="100" step="1" disabled>
              </div>
              <span id="planesRangeDisplay">0 – 100</span>
            </div>
          </div>

          <!-- Log Scale + Auto Range, side by side, above the color bar itself
               — same pattern as Forces/Spins/Atoms/Bonds (ForcePanel.js et
               al.): a docked-reachable pair of controls, since the floating
               color bar's own burger menu only exists once it's dragged into
               the scene. -->
          <div class="planes-field-control" id="planesBarControlsRow" style="display:flex; align-items:center; gap:12px; margin:4px 0;">
            <label style="display:flex; align-items:center; gap:4px; font-size:12px; color:white; white-space:nowrap; cursor:pointer;">
              <input type="checkbox" id="planesLogScaleCheckbox" disabled>
              Log Scale
            </label>
            <button type="button" id="planesAutoRangeBtn" class="file-action-btn cv-auto-range-btn" disabled>Auto Range</button>
          </div>

          <!-- Floating/dockable legend — same shared ColorBarWidget.js
               Forces/Spins/Atoms/Bonds use, draggable into the 3D scene.
               Mirrors whichever plane is currently selected; the dual
               slider above stays as an additional inline range control,
               synced to this bar's own Min/Max in both directions. -->
          <div class="planes-field-control">
            <div id="planesColorBarContainer" style="width:100%; display:none;"></div>
          </div>

        </div>
      </div>

    </div>
  `;

  setupPlanesEvents(container);
  updateCalculateFromAtomsButtonForSelection(getSelectedAtoms());
  syncPlanesForSelectedStructure();
  renderPlanesTable();
}

function setupPlanesEvents(container) {
  const showPlanesToggle = container.querySelector('#showPlanesToggle');
  showPlanesToggle.addEventListener('change', e => {
    const structure = getSelectedStructure();
    if (structure && selectedPlaneIndex !== null && selectedPlaneIndex >= 0) {
      const plane = structure.planes[selectedPlaneIndex];
      if (plane) {
        plane.enabled = e.target.checked;
        replacePlaneMesh(structure, plane);
        syncAtomCutPlanesFromSelectedStructure();
      }
    }
  });

  const radioUVWD = container.querySelector('#radioUVWD');
  const radioHKL  = container.querySelector('#radioHKL');

  const uvwdInputs = () => container.querySelectorAll('#planeU, #planeV, #planeW, #planeD');
  const hklInputs  = () => container.querySelectorAll('#planeH, #planeK, #planeL');
  const dSliderControls = () => container.querySelectorAll('#planeDSlider, #planeDSliderMin, #planeDSliderMax');

  function applyRadioState() {
    const isHKL = radioHKL.checked;
    hklInputs().forEach(inp  => { inp.disabled = !isHKL; });
    uvwdInputs().forEach(inp => { inp.disabled =  isHKL; });
    dSliderControls().forEach(inp => { inp.disabled = isHKL; });
    planesData.activeInputMode = isHKL ? 'hkl' : 'uvwd';
  }

  radioHKL.addEventListener('change',  applyRadioState);
  radioUVWD.addEventListener('change', applyRadioState);

  // Commit plane parameter edits on blur or Enter.
  [...hklInputs(), ...uvwdInputs()].forEach(input => {
    input.addEventListener('blur', updateSelectedPlaneFromInputs);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    });
  });

  container.querySelector('#addPlaneBtn').addEventListener('click', addPlaneFromCurrentInputs);
  container.querySelector('#calcFromAtomsBtn').addEventListener('click', calculatePlaneFromSelectedAtoms);

  // d slider: mirrors the d text box, updating the plane in real time while
  // dragging (not just on blur/Enter like the other numeric inputs).
  const planeDInput = container.querySelector('#planeD');
  const planeDSlider = container.querySelector('#planeDSlider');
  const planeDSliderMin = container.querySelector('#planeDSliderMin');
  const planeDSliderMax = container.querySelector('#planeDSliderMax');

  planeDSlider.addEventListener('input', () => {
    planeDInput.value = planeDSlider.value;
    updateSelectedPlaneFromInputs();
  });

  // The slider's own endpoints are user-adjustable, independent of the d value.
  [planeDSliderMin, planeDSliderMax].forEach(boundInput => {
    boundInput.addEventListener('change', () => applyDSliderBounds());
    boundInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    });
  });

  // Field section event listeners
  const fieldSelect = container.querySelector('#planesFieldSelect');
  if (fieldSelect) {
    fieldSelect.addEventListener('change', e => {
      const structure = getSelectedStructure();
      if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const plane = structure.planes[selectedPlaneIndex];
      if (!plane) return;
      
      // Update field assignment
      const selectedFieldLabel = e.target.value;
      
      plane.fieldLabel = selectedFieldLabel;
      // A previously-customized legend almost always describes the OLD
      // field ("Charge Density"); leaving it in place after switching to a
      // different field would silently mislabel the new one. Clearing it
      // here falls back to the new field's own name (refreshPlaneColorBar's
      // `plane.legendText ?? plane.field.label` default).
      plane.legendText = null;
      if (selectedFieldLabel) {
        plane.visualization = PLANE_VIS_FIELD;
        const selectedField = fieldBrowser.availableFields.find(f => f.label === selectedFieldLabel);
        plane.field = selectedField || null;
        // Raw field data min/max (Float32Array-derived) routinely comes out
        // as something like 0.009999999776482582 — round it to a clean 4
        // digits before it ever reaches the Min/Max boxes, rather than
        // showing that noise until the user hits Auto Range.
        plane.colormapMin = Number.isFinite(selectedField?.minValue) ? roundToSigFigs(selectedField.minValue, 4) : selectedField?.minValue;
        plane.colormapMax = Number.isFinite(selectedField?.maxValue) ? roundToSigFigs(selectedField.maxValue, 4) : selectedField?.maxValue;
        configurePlaneRangeInputs(selectedField, plane);
      }
      else {
        plane.visualization = PLANE_VIS_NONE;
        plane.field = null;
        plane.colormapMin = 0;
        plane.colormapMax = 100;
        configurePlaneRangeInputs(null, plane);
      }
      replacePlaneMesh(structure, plane);
      refreshPlaneColorBar();
      renderPlanesTable();
    });
  }

  const colormapSelect = container.querySelector('#planesColormapSelect');
  if (colormapSelect) {
    colormapSelect.addEventListener('change', e => {
      const structure = getSelectedStructure();
      if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const plane = structure.planes[selectedPlaneIndex];
      if (!plane) return;
      plane.colormap = e.target.value;
      replacePlaneMesh(structure, plane);
      refreshPlaneColorBar();
    });
  }

  const rangeMin = container.querySelector('#planesColormapRangeMin');
  const rangeMax = container.querySelector('#planesColormapRangeMax');

  if (rangeMin && rangeMax) {
    const bringThumbToFront = activeInput => {
      rangeMin.style.zIndex = activeInput === rangeMin ? '3' : '2';
      rangeMax.style.zIndex = activeInput === rangeMax ? '3' : '2';
    };

    rangeMin.addEventListener('input', () => updateRangeDisplayAndPlane(rangeMin));
    rangeMax.addEventListener('input', () => updateRangeDisplayAndPlane(rangeMax));
    rangeMin.addEventListener('focus', () => bringThumbToFront(rangeMin));
    rangeMax.addEventListener('focus', () => bringThumbToFront(rangeMax));
    rangeMin.addEventListener('pointerdown', () => bringThumbToFront(rangeMin));
    rangeMax.addEventListener('pointerdown', () => bringThumbToFront(rangeMax));

    updateRangeDisplayAndPlane();
  }

  const logScaleCheckbox = container.querySelector('#planesLogScaleCheckbox');
  if (logScaleCheckbox) {
    logScaleCheckbox.addEventListener('change', () => applyPlaneLogScale(logScaleCheckbox.checked));
  }

  const autoRangeBtn = container.querySelector('#planesAutoRangeBtn');
  if (autoRangeBtn) {
    autoRangeBtn.addEventListener('click', applyPlaneAutoRange);
  }

  const cutModeSelect = container.querySelector('#planeCutMode');
  if (cutModeSelect) {
    cutModeSelect.addEventListener('change', e => {
      const structure = getSelectedStructure();
      if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;
      const plane = structure.planes[selectedPlaneIndex];
      if (!plane) return;
      plane.cutMode = normalizePlaneCutMode(e.target.value);
      syncAtomCutPlanesFromSelectedStructure();
      renderPlanesTable();
    });
  }
}

function addPlaneFromCurrentInputs() {
  const structure = getSelectedStructure();
  if (!structure) {
    alert('Load/select a structure before adding planes.');
    return;
  }

  ensureStructurePlaneState(structure);

  const newPlane = {
    enabled:       true,
    params:        { type: 'hkl', h: 1, k: 1, l: 1 },
    label:         '(1 1 1)',
    visualization: 'None',
    cutMode:       CutModes.NONE,
    colormap:      'jet',
    colormapScale: 'linear',
    colormapMin:   0,
    colormapMax:   100,
    field:        null,
  };

  structure.planes.push(newPlane);
  replacePlaneMesh(structure, newPlane);

  selectedPlaneIndex = structure.planes.length - 1;
  renderPlanesTable();
  loadSelectedPlaneParameters();
}

function calculatePlaneFromSelectedAtoms() {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) {
    alert('Select a plane to update before calculating from atoms.');
    return;
  }

  const plane = structure.planes[selectedPlaneIndex];
  if (!plane) {
    alert('Selected plane could not be found.');
    return;
  }

  const atoms = getSelectedAtoms();
  if (!atoms || atoms.length < 3) {
    alert('Select at least 3 atoms to define a plane.');
    return;
  }

  const points = atoms
    .map((atom) => atom.position)
    .filter((point) => point);
  const planeFit = fitPlaneToPoints(points);
  if (!planeFit.valid) {
    alert('Selected atoms do not define a stable plane.');
    return;
  }

  const derivedParams = {
    type: 'uvwd',
    u: planeFit.normal[0],
    v: planeFit.normal[1],
    w: planeFit.normal[2],
    d: planeFit.d,
  };

  plane.params = derivedParams;
  // plane.label = `[${derivedParams.u.toFixed(2)} ${derivedParams.v.toFixed(2)} ${derivedParams.w.toFixed(2)}] d=${derivedParams.d.toFixed(2)}`;

  syncDerivedPlaneInputs(derivedParams, structure?.lattice);

  // Switch to uvwd mode
  const radioUVWD = document.getElementById('radioUVWD');
  if (radioUVWD) {
    radioUVWD.checked = true;
    radioUVWD.dispatchEvent(new Event('change'));
  }

  replacePlaneMesh(structure, plane);
  syncAtomCutPlanesFromSelectedStructure();
  renderPlanesTable();
}

/**
 * Load parameters from the selected plane into the input fields.
 */
function loadSelectedPlaneParameters() {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) {
    return;
  }

  const plane = structure.planes[selectedPlaneIndex];
  if (!plane || !plane.params) return;

  const paramsSection = document.getElementById('planesParamsSection');
  const fieldSection = document.getElementById('planesFieldSection');
  if (paramsSection) paramsSection.style.display = 'block';
  if (fieldSection) fieldSection.style.display = 'block';

  // Enable/disable controls
  enablePlaneControls(true);
  updateFieldSelectionDropdown();

  // Load parameters based on type
  if (plane.params.type === 'hkl') {
    document.getElementById('radioHKL').checked = true;
    document.getElementById('radioHKL').dispatchEvent(new Event('change'));
  } else if (plane.params.type === 'uvwd') {
    document.getElementById('radioUVWD').checked = true;
    document.getElementById('radioUVWD').dispatchEvent(new Event('change'));
  }

  syncDerivedPlaneInputs(plane.params, structure.lattice);

  // Load show planes toggle
  if (plane.enabled !== undefined) {
    document.getElementById('showPlanesToggle').checked = plane.enabled;
  }

  // Load colormap settings
  if (document.getElementById('planesColormapSelect')) {
    document.getElementById('planesColormapSelect').value = plane.colormap || 'jet';
  }
  const logScaleCheckbox = document.getElementById('planesLogScaleCheckbox');
  if (logScaleCheckbox) logScaleCheckbox.checked = plane.colormapScale === 'log';
  if (document.getElementById('planesColormapRangeMin')) {
    configurePlaneRangeInputs(plane.field, plane);
    updateRangeDisplayAndPlane();
  }
  refreshPlaneColorBar();
  // Load cut mode
  const cutModeEl = document.getElementById('planeCutMode');
  if (cutModeEl) cutModeEl.value = normalizePlaneCutMode(plane.cutMode);
}

/**
 * Update the selected plane from the current input field values.
 */
function updateSelectedPlaneFromInputs() {
  const structure = getSelectedStructure();
  if (!structure || selectedPlaneIndex === null || selectedPlaneIndex < 0) return;

  const plane = structure.planes[selectedPlaneIndex];
  if (!plane) return;

  if (planesData.activeInputMode === 'hkl') {
    const h = parseFloat(document.getElementById('planeH').value) || 0;
    const k = parseFloat(document.getElementById('planeK').value) || 0;
    const l = parseFloat(document.getElementById('planeL').value) || 0;
    plane.params = { type: 'hkl', h, k, l };
    plane.label = `(${h} ${k} ${l})`;
  } else {
    const u = parseFloat(document.getElementById('planeU').value) || 0;
    const v = parseFloat(document.getElementById('planeV').value) || 0;
    const w = parseFloat(document.getElementById('planeW').value) || 0;
    const d = parseFloat(document.getElementById('planeD').value) || 0;
    plane.params = { type: 'uvwd', u, v, w, d };
    plane.label = `[${u.toFixed(2)} ${v.toFixed(2)} ${w.toFixed(2)}] d=${d.toFixed(2)}`;
  }

  syncDerivedPlaneInputs(plane.params, structure.lattice);
  replacePlaneMesh(structure, plane);
  syncAtomCutPlanesFromSelectedStructure();
  renderPlanesTable();
}

/**
 * Enable or disable plane control inputs.
 */
function enablePlaneControls(enabled) {
  const inputs = document.querySelectorAll(
    '#planeH, #planeK, #planeL, #planeU, #planeV, #planeW, #planeD, #planeDSlider, #planeDSliderMin, #planeDSliderMax, #radioHKL, #radioUVWD, #showPlanesToggle, #planeCutMode'
  );
  inputs.forEach(inp => {
    inp.disabled = !enabled;
  });

  updateFieldControlsAvailability(enabled);
}

/**
 * Disable all plane controls.
 */
function disablePlaneControls() {
  const inputs = document.querySelectorAll(
    '#planeH, #planeK, #planeL, #planeU, #planeV, #planeW, #planeD, #planeDSlider, #planeDSliderMin, #planeDSliderMax, #radioHKL, #radioUVWD, #showPlanesToggle, #planeCutMode'
  );
  inputs.forEach(inp => {
    inp.disabled = true;
  });
  updateFieldControlsAvailability(false);

  const paramsSection = document.getElementById('planesParamsSection');
  const fieldSection = document.getElementById('planesFieldSection');
  if (paramsSection) paramsSection.style.display = 'none';
  if (fieldSection) fieldSection.style.display = 'none';
  refreshPlaneColorBar();
}

/**
 * Update the field selection dropdown with available fields.
 */
function updateFieldSelectionDropdown() {
  const select = document.getElementById('planesFieldSelect');
  if (!select) return;

  const structure = getSelectedStructure();
  const hasFields = fieldBrowser.availableFields && fieldBrowser.availableFields.length > 0;

  if (!hasFields) {
    select.innerHTML = '<option value="">No fields available</option>';
    configurePlaneRangeInputs(null);
    updateFieldControlsAvailability(true);
    refreshPlaneColorBar();
    return;
  }

  select.innerHTML = '<option value="">No Field</option>';

  fieldBrowser.availableFields.forEach(field => {
    const option = document.createElement('option');
    option.value = field.label || '';
    option.textContent = field.label || 'Unnamed Field';
    select.appendChild(option);
  });

  // Select the field if one is assigned to the current plane
  if (structure && selectedPlaneIndex !== null && selectedPlaneIndex >= 0) {
    const plane = structure.planes[selectedPlaneIndex];
    if (plane && plane.field && plane.field.label) {
      select.value = plane.field.label;
    }
    configurePlaneRangeInputs(plane?.field, plane);
  }

  updateFieldControlsAvailability(true);
  refreshPlaneColorBar();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatPlaneTableValue(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return numericValue.toFixed(2).replace(/\.?0+$/, '');
}

function buildVectorMarkup(values, wrapperClass = '') {
  const classSuffix = wrapperClass ? ` ${wrapperClass}` : '';
  return `
    <div class="planes-vector${classSuffix}" aria-hidden="true">
      <span class="planes-vector-bracket">(</span>
      <span class="planes-vector-values">${values.map(value => `<span>${escapeHtml(formatPlaneTableValue(value))}</span>`).join('')}</span>
      <span class="planes-vector-bracket">)</span>
    </div>
  `;
}

function getPlaneTableDisplayData(plane, lattice) {
  const p = plane.params || {};

  if (p.type === 'hkl') {
    const hValues = [p.h ?? 0, p.k ?? 0, p.l ?? 0];
    let uvwdValues = ['0.00', '0.00', '0.00'];
    let dValue = '0.00';

    if (lattice) {
      const res = getPlaneDefinitionNormalAndD(plane, lattice);
      if (Array.isArray(res?.normal) && res.normal.length === 3) {
        uvwdValues = res.normal.map(value => Number(value ?? 0).toFixed(2));
        dValue = Number(res.d ?? 0).toFixed(2);
      }
    }

    return {
      hklValues: hValues,
      uvwdValues,
      dValue,
    };
  }

  if (p.type === 'uvwd') {
    const uvwdValues = [p.u ?? 0, p.v ?? 0, p.w ?? 0].map(value => Number(value).toFixed(2));
    const dValue = Number(p.d ?? 0).toFixed(2);
    let hklValues = ['0', '0', '0'];

    if (lattice) {
      const res = CartesianParamsToMillerInds([p.u ?? 0, p.v ?? 0, p.w ?? 0], p.d ?? 0, lattice);
      if (res) {
        hklValues = [res.h ?? 0, res.k ?? 0, res.l ?? 0].map(value => `${value}`);
      }
    }

    return {
      hklValues,
      uvwdValues,
      dValue,
    };
  }

  return {
    hklValues: ['0', '0', '0'],
    uvwdValues: ['0.00', '0.00', '0.00'],
    dValue: '0.00',
  };
}

/**
 * Build human-readable hkl and uvwd|d strings for a plane, cross-converting
 * the representation not stored in params using the structure lattice.
 */
function getPlaneTableDisplayParams(plane, lattice) {
  const p = plane.params || {};
  let hklStr = '—';
  let uvwdStr = '—';

  if (p.type === 'hkl') {
    const h = p.h ?? 0, k = p.k ?? 0, l = p.l ?? 0;
    hklStr = `(${h} ${k} ${l})`;
    if (lattice) {
      const res = getPlaneDefinitionNormalAndD(plane, lattice);
      if (res.normal) {
        const [u, v, w] = res.normal;
        uvwdStr = `(${u.toFixed(2)} ${v.toFixed(2)} ${w.toFixed(2)} | ${(res.d ?? 0).toFixed(2)})`;
      }
    }
  } else if (p.type === 'uvwd') {
    const u = p.u ?? 0, v = p.v ?? 0, w = p.w ?? 0, d = p.d ?? 0;
    uvwdStr = `(${u.toFixed(2)} ${v.toFixed(2)} ${w.toFixed(2)} | ${d.toFixed(2)})`;
    if (lattice) {
      const res = CartesianParamsToMillerInds([u, v, w], d, lattice);
      if (res && (res.h !== 0 || res.k !== 0 || res.l !== 0)) {
        hklStr = `(${res.h} ${res.k} ${res.l})`;
      }
    }
  }

  return { hklStr, uvwdStr };
}

function getPlaneFilterDisplayLabel(plane) {
  const cutMode = normalizePlaneCutMode(plane?.cutMode);
  if (cutMode === CutModes.ALONGN) return 'Along N';
  if (cutMode === CutModes.OPPOSITEN) return 'Opposite N';
  return '-';
}

function renderPlanesTable() {
  const tbody = document.getElementById('planesTableBody');
  const noMsg = document.getElementById('noPlanesMsg');
  const table = document.getElementById('planesTable');
  if (!tbody) return;

  tbody.innerHTML = '';

  const structure = getSelectedStructure();
  const planes = getSelectedStructurePlanes();
  const lattice = structure?.lattice;

  const empty = planes.length === 0;
  if (noMsg) noMsg.style.display = empty ? 'block' : 'none';
  if (table) table.style.display = empty ? 'none' : 'table';
  if (empty) {
    selectedPlaneIndex = null;
    disablePlaneControls();
    return;
  }

  planes.forEach((plane, idx) => {
    const tr = document.createElement('tr');
    tr.className = selectedPlaneIndex === idx ? 'planes-row-selected' : '';
    tr.dataset.planeIndex = idx;

    const { hklStr, uvwdStr } = getPlaneTableDisplayParams(plane, lattice);
    const { hklValues, uvwdValues, dValue } = getPlaneTableDisplayData(plane, lattice);
    const rawField = plane.field?.label || '—';
    const fieldDisplay = rawField !== '—' && rawField.length > 15
      ? rawField.slice(0, 14) + '…'
      : rawField;
    const cutMode = getPlaneFilterDisplayLabel(plane);

    tr.innerHTML = `
      <td class="planes-td planes-td-cb">
        <input type="checkbox" class="plane-enable-cb" data-idx="${idx}" ${plane.enabled ? 'checked' : ''}>
      </td>
      <td class="planes-td planes-td-mono planes-td-vector" title="${escapeHtml(hklStr)}">${buildVectorMarkup(hklValues, 'planes-vector-tight')}</td>
      <td class="planes-td planes-td-mono planes-td-vector" title="${escapeHtml(uvwdStr)}">
        <div class="planes-uvwd-cell">
          ${buildVectorMarkup(uvwdValues, 'planes-vector-tight')}
          <span class="planes-d-inline">d=${escapeHtml(dValue)}</span>
        </div>
      </td>
      <td class="planes-td planes-td-field" title="${escapeHtml(rawField)}">${escapeHtml(fieldDisplay)}</td>
      <td class="planes-td planes-td-cut">${cutMode}</td>
      <td class="planes-td planes-td-del planes-td-del-sticky">
        <button class="plane-delete-btn" data-idx="${idx}" title="Remove">&times;</button>
      </td>
    `;

    tr.addEventListener('click', e => {
      const t = /** @type {any} */ (e.target);
      if (t.classList.contains('plane-enable-cb') ||
          t.classList.contains('plane-delete-btn')) return;
      selectedPlaneIndex = idx;
      renderPlanesTable();
      loadSelectedPlaneParameters();
    });

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.plane-enable-cb').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const idx = parseInt(e.target.dataset.idx, 10);
      const s = getSelectedStructure();
      const plane = s?.planes?.[idx];
      if (!plane) return;
      plane.enabled = e.target.checked;
      replacePlaneMesh(s, plane);
      syncAtomCutPlanesFromSelectedStructure();
    });
  });

  tbody.querySelectorAll('.plane-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(e.target.dataset.idx, 10);
      const s = getSelectedStructure();
      const plane = s?.planes?.[idx];
      if (!plane || !s) return;

      removePlaneMesh(s, plane);
      s.planes.splice(idx, 1);

      if (selectedPlaneIndex !== null && selectedPlaneIndex >= s.planes.length) {
        selectedPlaneIndex = s.planes.length > 0 ? s.planes.length - 1 : null;
      }

      renderPlanesTable();
      syncAtomCutPlanesFromSelectedStructure();
      if (selectedPlaneIndex !== null) {
        loadSelectedPlaneParameters();
      } else {
        disablePlaneControls();
      }
    });
  });
}

export function removePlanesPanel(target = "cvPanelBody-planes") {
  const container = document.getElementById(target);
  if (container) {
    container.innerHTML = '';
  }

  if (atomSelectionUnsubscribe) {
    atomSelectionUnsubscribe();
    atomSelectionUnsubscribe = null;
  }

  //if (activeRenderedStructure) {
  //  clearRenderedPlanesForStructure(activeRenderedStructure);
  //}
}
