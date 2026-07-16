import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general } from '../state/store.js';
import { getColorFromMap } from '../defaults/color_texture_defaults.js';
import { createArrowMaterial, addArrowEmissiveAttributes } from './ArrowMaterial.js';

const SHAFT_SEGS = 20;
const TIP_SEGS = 20;
const TIP_LENGTH = 0.8;
const TIP_RADIUS = 0.3;
const UP = new THREE.Vector3(0, 1, 0);
const LOG_EPS = 1e-6;
// Rendered arrow length range (Å-ish scene units) that a force's normalized
// [0,1] magnitude (color's own log/linear mapping, reused for length) is
// spread across — see the arrow-length comment below for why this replaced
// raw-magnitude-as-length.
const ARROW_LEN_MIN = 0.3;
const ARROW_LEN_MAX = 2.0;

function disposeForceMeshes() {
  for (const key of ['forcesShaftMesh', 'forcesTipMesh']) {
    if (groups[key]) {
      groups[key].geometry.dispose();
      groups[key].material.dispose();
      app.scene.remove(groups[key]);
      groups[key] = null;
    }
  }
  groups.forcesInstanceBySrcIndex = null;
}

export function removeForces() {
  disposeForceMeshes();
}

/**
 * The exact color a force vector gets from the given colormap/range — the
 * same math updateForces()'s own per-frame recolor loop below uses, pulled
 * out so StructureInfoPanel's Spin/Force row editor ("Color" button) can
 * compute one atom's color without duplicating (or drifting from) it.
 * Returns null for colorMap "none" — there's nothing to compute, the caller
 * should leave whatever color is already there alone.
 */
export function computeForceColor(vector, scaling, {
  colorMap = general.forceColorMap ?? "heatmap",
  minValue = general.forceMin || 0,
  maxValue = general.forceMax || 2,
  useLog = general.forceColorScale === "log",
} = {}) {
  if (!vector) return null;
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

export function updateForces(forceFactor = general.forceScale ?? 1.0, colorMap = general.forceColorMap ?? "heatmap") {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.periodic?.wrapped) { disposeForceMeshes(); return; }

  const wrapped = structure.periodic.wrapped;
  const shaftDiameter = general.forceRadius ?? 0.08;
  const tipDiameter = TIP_RADIUS * (shaftDiameter / 0.08);
  const tipLength = TIP_LENGTH * (shaftDiameter / 0.08);

  const forces = structure.forces;
  if (!forces?.length) { disposeForceMeshes(); return; }

  // Update force colors based on colormap
  const minValue = general.forceMin || 0;
  const maxValue = general.forceMax || 2;
  const useLog = general.forceColorScale === "log";
  // Arrow LENGTH can follow its own log/linear switch (Forces panel "log
  // length" toggle), independent of the color scale above — though turning
  // it on also forces+locks useLog on (ui/ForcePanel.js), so in practice the
  // two only ever disagree in the direction of length being linear while
  // color is log.
  const useLogLength = general.forceLengthLogScale === true;

  // Normalizes a force's true magnitude (species scaling included, but NOT
  // forceFactor — the "Global Scaling" slider is a pure display convenience,
  // and letting it shift the [0,1] normalization would mean dragging that
  // slider silently recolors atoms without their actual force values
  // changing at all) to [0, 1] against the UI min/max, linearly or on a log
  // scale. Shared by color (below, always useLog) and by the arrow-length
  // mapping in the second loop (always useLogLength), so both go through the
  // exact same shape, just possibly a different log/linear choice.
  function normalizeMag(mag, useLogScale) {
    if (useLogScale) {
      const lo = Math.log10(Math.max(minValue, LOG_EPS));
      const hi = Math.log10(Math.max(maxValue, LOG_EPS));
      const v = Math.log10(Math.max(mag, LOG_EPS));
      return hi > lo ? Math.min(Math.max((v - lo) / (hi - lo), 0), 1) : 0;
    }
    return maxValue > minValue ? Math.min(Math.max((mag - minValue) / (maxValue - minValue), 0), 1) : 0;
  }

  forces.forEach(force => {
    if (!force?.vector) return;
    // A per-arrow color pick (StructureInfoPanel's Spin/Force row editor)
    // is sticky — it wins over the colormap until the row's Reset clears
    // it, so this loop leaves force.color (and userColor) untouched here.
    if (force.userColor) return;

    const mag = Math.sqrt(force.vector[0] ** 2 + force.vector[1] ** 2 + force.vector[2] ** 2);
    const colorMag = mag * (force.scaling ?? 1.0);

    if (colorMap !== "none" && colorMap !== "direction" && colorMap !== "plusminus") {
      force.updateColor(normalizeMag(colorMag, useLog), colorMap);
    } else if (colorMap === "direction") {
      // Direction-based coloring
      const normalizedDir = new THREE.Vector3(...force.vector).normalize();
      force.color = new THREE.Color(
        Math.abs(normalizedDir.x),
        Math.abs(normalizedDir.y),
        Math.abs(normalizedDir.z)
      );
    } else if (colorMap === "plusminus") {
      // Plus/minus coloring
      const normalizedDir = new THREE.Vector3(...force.vector).normalize();
      let r = 0, g = 0, b = 0;
      if (normalizedDir.x > 0) r += normalizedDir.x;
      else if (normalizedDir.x < 0) b += -normalizedDir.x;
      if (normalizedDir.y > 0) g += normalizedDir.y;
      else if (normalizedDir.y < 0) { r += -normalizedDir.y; b += -normalizedDir.y; }
      if (normalizedDir.z > 0) b += normalizedDir.z;
      else if (normalizedDir.z < 0) g += -normalizedDir.z;
      force.color = new THREE.Color(r, g, b);
    }
    // "none" case: force.color is already set (default or manual), same as SpinModule.js
  });

  // --- Prepare arrows for rendering ---
  const arrows = [];
  const seen = new Set();

  // Get species visibility from this panel's own toggles (falls back to
  // "show everything" if the Forces panel hasn't been built yet).
  const speciesVisibility = {};
  const checkboxes = document.querySelectorAll('#forceSpeciesVisibilityContainer input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    const element = checkbox.id.replace('force-species-', '');
    speciesVisibility[element] = /** @type {HTMLInputElement} */ (checkbox).checked;
  });
  const hasToggles = checkboxes.length > 0;

  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (seen.has(srcIdx)) continue;
    seen.add(srcIdx);

    const force = forces[srcIdx];
    if (!force?.vector) continue;
    if (force.hidden) continue; // that atom's own row "Hide" checkbox

    const element = structure.elements[srcIdx];
    if (hasToggles && !speciesVisibility[element]) continue;

    const v = force.vector;
    const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    if (mag <= 0) continue; // a zero vector has no direction to draw

    // Length follows the same normalizeMag() shape color does (log or
    // linear, against forceMin/forceMax — though "log length" can pick log
    // independently of the color scale) instead of raw magnitude — a tiny
    // residual force used to shrink to a near-invisible sliver (or get
    // skipped below a hardcoded 0.05 cutoff entirely, copied over from
    // SpinModule.js where "too small to show" means "no spin", which isn't
    // true of forces: every atom in a real calculation has SOME force on
    // it, and it should always be shown). Mapping through normalizeMag()
    // into [ARROW_LEN_MIN, ARROW_LEN_MAX] instead keeps every nonzero force
    // clearly visible while still reading larger forces as visibly longer.
    // forceFactor (Global Scaling) is applied after, as a pure display
    // multiplier — unlike colorMag above, it never feeds normalizeMag()
    // itself, so it can't shift the length mapping the way it used to.
    const colorMag = mag * (force.scaling ?? 1.0);
    const totalLen = (ARROW_LEN_MIN + normalizeMag(colorMag, useLogLength) * (ARROW_LEN_MAX - ARROW_LEN_MIN)) * forceFactor;

    arrows.push({
      srcIdx,
      origin: new THREE.Vector3(...wrapped.cart[i]),
      dir: new THREE.Vector3(...v).normalize(),
      shaftHalfLen: totalLen / 2,
      color: force.getColor(), // userColor (if pinned) or the colormap-driven one
    });
  }

  // --- Rendering logic ---
  const count = arrows.length;

  if (!groups.forcesShaftMesh || groups.forcesShaftMesh.count !== count * 2) {
    disposeForceMeshes();
    if (count === 0) return;

    const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, SHAFT_SEGS, 1);
    // Same PBR preset atoms/bonds use (render/MaterialStyles.js) — a
    // hardcoded material here previously gave the arrows different
    // roughness/metalness and no clearcoat, so the same per-instance color
    // as an atom's rendered visibly duller/paler instead of matching it.
    const shaftMat = createArrowMaterial();
    groups.forcesShaftMesh = new THREE.InstancedMesh(shaftGeo, shaftMat, count * 2);
    groups.forcesShaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 2 * 3), 3);
    groups.forcesShaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.forcesShaftMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    addArrowEmissiveAttributes(groups.forcesShaftMesh, count * 2);
    app.scene.add(groups.forcesShaftMesh);

    const tipGeo = new THREE.ConeGeometry(1, 1, TIP_SEGS);
    const tipMat = createArrowMaterial();
    groups.forcesTipMesh = new THREE.InstancedMesh(tipGeo, tipMat, count);
    groups.forcesTipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    groups.forcesTipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.forcesTipMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    addArrowEmissiveAttributes(groups.forcesTipMesh, count);
    app.scene.add(groups.forcesTipMesh);
  }

  // Which arrow-instance index (shaft i*2/i*2+1, tip i) belongs to which
  // atom (structure.atoms order) — SelectAndHighlightModule.js uses this to
  // highlight a selected atom's own force arrow along with the atom itself.
  // AFTER the mesh-rebuild block above, not before: disposeForceMeshes()
  // (called from inside it, on a rebuild) unconditionally nulls this out —
  // setting it earlier would just have it wiped again immediately.
  const instanceBySrcIndex = new Map();
  arrows.forEach(({ srcIdx }, i) => instanceBySrcIndex.set(srcIdx, i));
  groups.forcesInstanceBySrcIndex = instanceBySrcIndex;

  const dummy = new THREE.Object3D();

  arrows.forEach(({ origin, dir, shaftHalfLen, color }, i) => {
    const quat = new THREE.Quaternion();
    if (dir.dot(UP) < -0.9999) {
      quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      quat.setFromUnitVectors(UP, dir);
    }

    // Shaft+
    dummy.position.copy(origin).addScaledVector(dir, shaftHalfLen / 2);
    dummy.scale.set(shaftDiameter, shaftHalfLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.forcesShaftMesh.setMatrixAt(i * 2, dummy.matrix);
    groups.forcesShaftMesh.instanceColor.setXYZ(i * 2, color.r, color.g, color.b);

    // Shaft-
    dummy.position.copy(origin).addScaledVector(dir, -shaftHalfLen / 2);
    dummy.scale.set(shaftDiameter, shaftHalfLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.forcesShaftMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    groups.forcesShaftMesh.instanceColor.setXYZ(i * 2 + 1, color.r, color.g, color.b);

    // Tip cone
    dummy.position.copy(origin).addScaledVector(dir, shaftHalfLen + tipLength / 2);
    dummy.scale.set(tipDiameter, tipLength, tipDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.forcesTipMesh.setMatrixAt(i, dummy.matrix);
    groups.forcesTipMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);

    // Reset any selection glow from a previous highlight — a redraw that
    // reuses the mesh (no count change) would otherwise leave a stale
    // highlighted arrow glowing after its atom is deselected or the arrows
    // are rebuilt for an unrelated reason (scale/colormap change).
    groups.forcesShaftMesh.geometry.attributes.instanceEmissive.setXYZ(i * 2, 0, 0, 0);
    groups.forcesShaftMesh.geometry.attributes.instanceEmissive.setXYZ(i * 2 + 1, 0, 0, 0);
    groups.forcesShaftMesh.geometry.attributes.instanceEmissiveIntensity.setX(i * 2, 0);
    groups.forcesShaftMesh.geometry.attributes.instanceEmissiveIntensity.setX(i * 2 + 1, 0);
    groups.forcesTipMesh.geometry.attributes.instanceEmissive.setXYZ(i, 0, 0, 0);
    groups.forcesTipMesh.geometry.attributes.instanceEmissiveIntensity.setX(i, 0);
  });

  // Update matrices and colors
  groups.forcesShaftMesh.instanceMatrix.needsUpdate = true;
  groups.forcesShaftMesh.instanceColor.needsUpdate = true;
  groups.forcesShaftMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.forcesShaftMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.forcesTipMesh.instanceMatrix.needsUpdate = true;
  groups.forcesTipMesh.instanceColor.needsUpdate = true;
  groups.forcesTipMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.forcesTipMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
}
