import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general } from '../state/store.js';
import { getColorFromMap, getElementDefaultColor } from '../defaults/color_texture_defaults.js';
import { createArrowMaterial, addArrowEmissiveAttributes } from './ArrowMaterial.js';
import { applyFocusToArrows } from './FocusRegionModule.js';



const SHAFT_SEGS = 20;
const TIP_SEGS = 20;
const TIP_LENGTH = 0.8;
const TIP_RADIUS = 0.3;
const UP = new THREE.Vector3(0, 1, 0);
const LOG_EPS = 1e-6;
// Rendered arrow length range for "log length" mode only — normal (linear)
// mode keeps spin length directly proportional to magnitude (unchanged,
// unlike ForceModule.js which always compresses into this kind of window),
// since a spin's magnitude is itself a meaningful physical quantity at a
// human-readable scale. Log mode needs *some* fixed window to map into
// (log-compressed values aren't proportional to anything by construction),
// so it borrows ForceModule.js's own range for a consistent look.
const ARROW_LEN_MIN = 0.3;
const ARROW_LEN_MAX = 2.0;

function disposeSpinMeshes() {
  for (const key of ['spinShaftMesh', 'spinTipMesh']) {
    if (groups[key]) {
      groups[key].geometry.dispose();
      groups[key].material.dispose();
      app.scene.remove(groups[key]);
      groups[key] = null;
    }
  }
  groups.spinsInstanceBySrcIndex = null;
  groups.spinsArrowByInstance = null;
}

export function removeSpins() {
  disposeSpinMeshes();
}

export function deleteSpins() {
  disposeSpinMeshes();
}

/**
 * The exact color a spin vector gets from the given colormap/range — the
 * same math updateSpins()'s own per-frame recolor loop below uses, pulled
 * out so StructureInfoPanel's Spin/Force row editor ("Color" button) can
 * compute one atom's color without duplicating (or drifting from) it.
 * Returns null for colorMap "none"/"direction" being unset — there's
 * nothing to compute, the caller should leave whatever color is already
 * there alone.
 */
export function computeSpinColor(vector, scaling, {
  colorMap = general.spinColorMap ?? "none",
  minValue = general.spinMin || 0,
  maxValue = general.spinMax || 2,
  useLog = general.spinColorScale === "log",
  element = null,
} = {}) {
  if (!vector) return null;
  // Element map ignores the vector entirely — every spin on the same species
  // gets that species' own color (general.customColorMap-aware via
  // getElementDefaultColor), same source atoms/bonds already use.
  if (colorMap === "element") {
    return element ? new THREE.Color(getElementDefaultColor(element)) : null;
  }
  const mag = Math.sqrt(vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2);
  const colorMag = mag * (scaling ?? 1.0);

  if (colorMap !== "none" && colorMap !== "direction" && colorMap !== "plusminus") {
    let normalizedValue;
    if (useLog) {
      const lo = Math.log10(Math.max(minValue, LOG_EPS));
      const hi = Math.log10(Math.max(maxValue, LOG_EPS));
      const v = Math.log10(Math.max(colorMag, LOG_EPS));
      normalizedValue = hi > lo ? Math.min(Math.max((v - lo) / (hi - lo), 0), 1) : 0;
    } else {
      normalizedValue = maxValue > minValue ? Math.min(Math.max((colorMag - minValue) / (maxValue - minValue), 0), 1) : 0;
    }
    return getColorFromMap(normalizedValue, colorMap);
  }

  const normalizedDir = new THREE.Vector3(...vector).normalize();
  if (colorMap === "direction") {
    return new THREE.Color(
      Math.abs(normalizedDir.x),
      Math.abs(normalizedDir.y),
      Math.abs(normalizedDir.z)
    );
  }
  if (colorMap === "plusminus") {
    let r = 0, g = 0, b = 0;
    if (normalizedDir.x > 0) r += normalizedDir.x;
    else if (normalizedDir.x < 0) b += -normalizedDir.x;
    if (normalizedDir.y > 0) g += normalizedDir.y;
    else if (normalizedDir.y < 0) { r += -normalizedDir.y; b += -normalizedDir.y; }
    if (normalizedDir.z > 0) b += normalizedDir.z;
    else if (normalizedDir.z < 0) g += -normalizedDir.z;
    return new THREE.Color(r, g, b);
  }
  return null;
}




export function updateSpins(spinFactor = 1.0, useManualSpins = false, manualSpins = [], colorMap = "none") {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.periodic?.wrapped) { disposeSpinMeshes(); return; }

  const wrapped = structure.periodic.visibleWrapped;
  const shaftDiameter = general.spinRadius ?? 0.08;
  const tipDiameter = TIP_RADIUS * (shaftDiameter / 0.08);
  const tipLength = TIP_LENGTH * (shaftDiameter / 0.08);

  let spins;
  if (useManualSpins) {
    spins = manualSpins;
  } else {
    spins = structure.spins;
  }

  if (!spins?.length) { disposeSpinMeshes(); return; }

  // Update spin colors based on colormap
  const minValue = general.spinMin || 0;
  const maxValue = general.spinMax || 2;
  const useLog = general.spinColorScale === "log";
  // Arrow LENGTH can follow its own log/linear switch (Spins panel "log
  // length" toggle), independent of the color scale above — though turning
  // it on also forces+locks useLog on (ui/SpinPanel.js), same one-directional
  // coupling as ForceModule.js's forceLengthLogScale.
  const useLogLength = general.spinLengthLogScale === true;

  // Same shape as ForceModule.js's normalizeMag() — only used for length
  // here (in log-length mode; color keeps its own inline normalization
  // above/below since it also needs to handle "none"/direction/plusminus).
  function normalizeMag(mag) {
    const lo = Math.log10(Math.max(minValue, LOG_EPS));
    const hi = Math.log10(Math.max(maxValue, LOG_EPS));
    const v = Math.log10(Math.max(mag, LOG_EPS));
    return hi > lo ? Math.min(Math.max((v - lo) / (hi - lo), 0), 1) : 0;
  }

  spins.forEach((spin, idx) => {
    if (!spin.vector) return;
    // A per-arrow color pick (StructureInfoPanel's Spin/Force row editor)
    // is sticky — it wins over the colormap until the row's Reset clears
    // it, so this loop leaves spin.color (and userColor) untouched here.
    if (spin.userColor) return;

    // manualSpins isn't index-aligned to structure.atoms the way
    // structure.spins is — each entry carries its own atomIndex instead.
    const atomIdx = useManualSpins ? (spin.atomIndex ?? idx) : idx;

    const categoryColor = structure.spinCategoryStyles?.[structure.elements[atomIdx]]?.color;
    if (categoryColor != null) {
      spin.color = new THREE.Color(categoryColor);
      return;
    }

    if (colorMap === "element") {
      spin.color = new THREE.Color(getElementDefaultColor(structure.elements[atomIdx]));
      return;
    }

    const mag = Math.sqrt(spin.vector[0] ** 2 + spin.vector[1] ** 2 + spin.vector[2] ** 2);
    // spinFactor (the panel's own visual length slider) deliberately isn't
    // part of this — it's a display convenience, and letting it feed the
    // color normalization would mean dragging it silently recolors atoms
    // with no change to their actual spin values (same fix as
    // ForceModule.js's colorMag/normalize).
    const colorMag = mag * (spin.scaling ?? 1.0);

    if (colorMap !== "none" && colorMap !== "direction" && colorMap !== "plusminus") {
      // Normalize the spin magnitude to [0, 1] using UI min/max, linearly or on a log scale
      let normalizedValue;
      if (useLog) {
        const lo = Math.log10(Math.max(minValue, LOG_EPS));
        const hi = Math.log10(Math.max(maxValue, LOG_EPS));
        const v = Math.log10(Math.max(colorMag, LOG_EPS));
        normalizedValue = hi > lo ? Math.min(Math.max((v - lo) / (hi - lo), 0), 1) : 0;
      } else {
        normalizedValue = maxValue > minValue ? Math.min(Math.max((colorMag - minValue) / (maxValue - minValue), 0), 1) : 0;
      }
      spin.updateColor(normalizedValue, colorMap);
    } else if (colorMap === "direction") {
      // Direction-based coloring
      const normalizedDir = new THREE.Vector3(...spin.vector).normalize();
      spin.color = new THREE.Color(
        Math.abs(normalizedDir.x),
        Math.abs(normalizedDir.y),
        Math.abs(normalizedDir.z)
      );
    } else if (colorMap === "plusminus") {
      // Plus/minus coloring
      const normalizedDir = new THREE.Vector3(...spin.vector).normalize();
      let r = 0, g = 0, b = 0;
      if (normalizedDir.x > 0) r += normalizedDir.x;
      else if (normalizedDir.x < 0) b += -normalizedDir.x;
      if (normalizedDir.y > 0) g += normalizedDir.y;
      else if (normalizedDir.y < 0) { r += -normalizedDir.y; b += -normalizedDir.y; }
      if (normalizedDir.z > 0) b += normalizedDir.z;
      else if (normalizedDir.z < 0) g += -normalizedDir.z;
      spin.color = new THREE.Color(r, g, b);
    }
    // "none" case: spin.color is already set (default or manual)
  });

  // --- Prepare arrows for rendering ---
  const arrows = [];
  const seen = new Set();

  // Get species visibility
  const speciesVisibility = {};
  const checkboxes = document.querySelectorAll('#speciesVisibilityContainer input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    const element = checkbox.id.replace('species-', '');
    speciesVisibility[element] = /** @type {HTMLInputElement} */ (checkbox).checked;
  });

  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (seen.has(srcIdx)) continue;
    seen.add(srcIdx);

    const spin = useManualSpins ? spins.find(s => s.atomIndex === srcIdx) : spins[srcIdx];
    if (!spin?.vector) continue;
    if (spin.hidden) continue; // that atom's own row "Hide" checkbox

    const element = structure.elements[srcIdx];
    if (!speciesVisibility[element]) continue;

    const v = spin.vector;
    const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    if (mag < 0.05) continue;

    // Linear mode: length directly proportional to magnitude (unchanged).
    // Log mode: same compressed-into-a-fixed-window shape ForceModule.js
    // uses for its own arrows, so a spin spanning orders of magnitude
    // doesn't collapse every small one down to invisible.
    const totalLen = useLogLength
      ? (ARROW_LEN_MIN + normalizeMag(mag * (spin.scaling ?? 1.0)) * (ARROW_LEN_MAX - ARROW_LEN_MIN)) * spinFactor
      : mag * (spin.scaling ?? 1.0) * spinFactor;
    if (totalLen < 0.05) continue;

    arrows.push({
      srcIdx,
      origin: new THREE.Vector3(...wrapped.cart[i]),
      dir: new THREE.Vector3(...v).normalize(),
      shaftHalfLen: totalLen / 2,
      color: spin.getColor(), // userColor (if pinned) or the colormap-driven one
    });
  }

  // --- Rendering logic ---
  const count = arrows.length;

  if (!groups.spinShaftMesh || groups.spinShaftMesh.count !== count * 2) {
    disposeSpinMeshes();
    if (count === 0) return;

    const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, SHAFT_SEGS, 1);
    // Same PBR preset atoms/bonds use (render/MaterialStyles.js) — a
    // hardcoded material here previously gave the arrows different
    // roughness/metalness and no clearcoat, so the same per-instance color
    // as an atom's rendered visibly duller/paler instead of matching it.
    const shaftMat = createArrowMaterial();
    groups.spinShaftMesh = new THREE.InstancedMesh(shaftGeo, shaftMat, count * 2);
    groups.spinShaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 2 * 3), 3);
    groups.spinShaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.spinShaftMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    addArrowEmissiveAttributes(groups.spinShaftMesh, count * 2);
    app.scene.add(groups.spinShaftMesh);

    const tipGeo = new THREE.ConeGeometry(1, 1, TIP_SEGS);
    const tipMat = createArrowMaterial();
    groups.spinTipMesh = new THREE.InstancedMesh(tipGeo, tipMat, count);
    groups.spinTipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    groups.spinTipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.spinTipMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    addArrowEmissiveAttributes(groups.spinTipMesh, count);
    app.scene.add(groups.spinTipMesh);
  }

  // Which arrow-instance index (shaft i*2/i*2+1, tip i) belongs to which
  // atom (structure.atoms order) — SelectAndHighlightModule.js uses this to
  // highlight a selected atom's own spin arrow along with the atom itself.
  // AFTER the mesh-rebuild block above, not before: disposeSpinMeshes()
  // (called from inside it, on a rebuild) unconditionally nulls this out —
  // setting it earlier would just have it wiped again immediately.
  const instanceBySrcIndex = new Map();
  const arrowByInstance = new Map();
  arrows.forEach(({ srcIdx }, i) => {
    instanceBySrcIndex.set(srcIdx, i);
    arrowByInstance.set(i, useManualSpins ? structure.spins[srcIdx] : spins[srcIdx]);
  });
  groups.spinsInstanceBySrcIndex = instanceBySrcIndex;
  groups.spinsArrowByInstance = arrowByInstance;
  groups.spinShaftMesh.userData.arrowStylesByInstance = arrowByInstance;

  const dummy = new THREE.Object3D();

  arrows.forEach(({ origin, dir, shaftHalfLen, color }, i) => {
    const quat = new THREE.Quaternion();
    if (dir.dot(UP) < -0.9999) {
      quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      quat.setFromUnitVectors(UP, dir);
    }

    // The shaft alone is symmetric about `origin` (shaftHalfLen either way),
    // but the tip cone only adds length past its + end — so without this
    // shift, the atom sat at the midpoint of the shaft, not of the whole
    // visible arrow (shaft + tip), which visually reads as off-center toward
    // the tail by half the tip's length. Shifting the whole assembly's
    // reference point back by tipLength/2 puts the atom at the true midpoint
    // of the full shaft+tip span instead.
    const center = origin.clone().addScaledVector(dir, -tipLength / 2);

    // Shaft+
    dummy.position.copy(center).addScaledVector(dir, shaftHalfLen / 2);
    dummy.scale.set(shaftDiameter, shaftHalfLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinShaftMesh.setMatrixAt(i * 2, dummy.matrix);
    groups.spinShaftMesh.instanceColor.setXYZ(i * 2, color.r, color.g, color.b);

    // Shaft-
    dummy.position.copy(center).addScaledVector(dir, -shaftHalfLen / 2);
    dummy.scale.set(shaftDiameter, shaftHalfLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinShaftMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    groups.spinShaftMesh.instanceColor.setXYZ(i * 2 + 1, color.r, color.g, color.b);

    // Tip cone
    dummy.position.copy(center).addScaledVector(dir, shaftHalfLen + tipLength / 2);
    dummy.scale.set(tipDiameter, tipLength, tipDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinTipMesh.setMatrixAt(i, dummy.matrix);
    groups.spinTipMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);

    // Reset any selection glow from a previous highlight — a redraw that
    // reuses the mesh (no count change) would otherwise leave a stale
    // highlighted arrow glowing after its atom is deselected or the arrows
    // are rebuilt for an unrelated reason (scale/colormap change).
    groups.spinShaftMesh.geometry.attributes.instanceEmissive.setXYZ(i * 2, 0, 0, 0);
    groups.spinShaftMesh.geometry.attributes.instanceEmissive.setXYZ(i * 2 + 1, 0, 0, 0);
    groups.spinShaftMesh.geometry.attributes.instanceEmissiveIntensity.setX(i * 2, 0);
    groups.spinShaftMesh.geometry.attributes.instanceEmissiveIntensity.setX(i * 2 + 1, 0);
    groups.spinTipMesh.geometry.attributes.instanceEmissive.setXYZ(i, 0, 0, 0);
    groups.spinTipMesh.geometry.attributes.instanceEmissiveIntensity.setX(i, 0);
  });

  // Update matrices and colors
  groups.spinShaftMesh.instanceMatrix.needsUpdate = true;
  groups.spinShaftMesh.instanceColor.needsUpdate = true;
  groups.spinShaftMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.spinShaftMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.spinTipMesh.instanceMatrix.needsUpdate = true;
  groups.spinTipMesh.instanceColor.needsUpdate = true;
  groups.spinTipMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.spinTipMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  applyFocusToArrows(structure, 'spins');
}
