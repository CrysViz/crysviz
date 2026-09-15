// Displacement arrows for the phonon panel: one arrow per atom showing the
// selected mode's displacement pattern, drawn with the same instanced
// shaft+tip geometry and PBR arrow material as the force/spin arrows
// (ForceModule.js / SpinModule.js). Kept separate from those modules because
// they are bound to structure.forces / structure.spins and their panels'
// per-species toggles; a phonon pattern is transient per-frame data owned by
// the phonon session (phonon/phononSession.js), which calls updatePhononArrows
// every animation tick and removePhononArrows when the mode is deselected.

import * as THREE from '../external/three/three.module.js';
import { app, groups } from '../state/store.js';
import { createArrowMaterial, addArrowEmissiveAttributes } from './ArrowMaterial.js';
import { getColorFromMap } from '../defaults/color_texture_defaults.js';

const SHAFT_SEGS = 12;
const TIP_SEGS = 12;
const UP = new THREE.Vector3(0, 1, 0);

let shaftMesh = null;
let tipMesh = null;
const dummy = new THREE.Object3D();
const quat = new THREE.Quaternion();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();
const color = new THREE.Color();

function dispose() {
  for (const mesh of [shaftMesh, tipMesh]) {
    if (!mesh) continue;
    mesh.geometry.dispose();
    mesh.material.dispose();
    app.scene?.remove(mesh);
  }
  shaftMesh = null;
  tipMesh = null;
  groups.phononShaftMesh = null;
  groups.phononTipMesh = null;
}

export function removePhononArrows() {
  dispose();
}

function ensureMeshes(count) {
  if (shaftMesh && shaftMesh.count === count) return;
  dispose();
  if (count === 0 || !app.scene) return;
  const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, SHAFT_SEGS, 1);
  shaftMesh = new THREE.InstancedMesh(shaftGeo, createArrowMaterial(), count);
  shaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  shaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  addArrowEmissiveAttributes(shaftMesh, count);
  shaftMesh.frustumCulled = false;
  app.scene.add(shaftMesh);

  const tipGeo = new THREE.ConeGeometry(1, 1, TIP_SEGS);
  tipMesh = new THREE.InstancedMesh(tipGeo, createArrowMaterial(), count);
  tipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  tipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  addArrowEmissiveAttributes(tipMesh, count);
  tipMesh.frustumCulled = false;
  app.scene.add(tipMesh);
  groups.phononShaftMesh = shaftMesh;
  groups.phononTipMesh = tipMesh;
}

// Same length window ForceModule.js maps magnitudes into, so a phonon arrow
// and a force arrow of "the same normalised magnitude" look alike.
const ARROW_LEN_MIN = 0.3;
const ARROW_LEN_MAX = 2.0;
const TIP_LENGTH = 0.8;
const TIP_RADIUS = 0.3;
const LOG_EPS = 1e-6;
const SCALAR_MAPS = new Set(['batlow', 'hawaii', 'managua', 'viridis', 'plasma', 'spectralR', 'heatmap', 'jet']);

/** Is this colour-map name a scalar (magnitude) map that needs a range/bar? */
export function isScalarArrowMap(name) {
  return SCALAR_MAPS.has(String(name));
}

/**
 * Draw (or refresh) arrows for `vectors` — Cartesian displacement per atom in
 * structure.atoms order (3 numbers each, Å) — starting at each atom's
 * rendered position and pointing along its displacement. Length and colour
 * follow the Forces panel's conventions (render/ForceModule.js): the
 * magnitude is normalised against [min, max] (linearly or on a log scale)
 * into [ARROW_LEN_MIN, ARROW_LEN_MAX] × lengthFactor, and coloured by a
 * scalar colour map of that normalised value, by direction, by sign
 * (plus-minus), or with one solid colour. Positions come from
 * structure.periodic.visibleWrapped (all drawn periodic images), so arrows
 * follow the atoms through the fast-frame path.
 *
 * @param {any} structure
 * @param {Float64Array|number[]} vectors
 * @param {{ lengthFactor?: number, radius?: number, colorMap?: string, colorHex?: number|string,
 *           min?: number, max?: number, logColor?: boolean, logLength?: boolean, minLength?: number }} [opts]
 */
export function updatePhononArrows(structure, vectors, {
  lengthFactor = 1, radius = 0.08, colorMap = 'solid', colorHex = 0xff8c00,
  min = 0, max = 1, logColor = false, logLength = false, minLength = 1e-4,
} = {}) {
  const wrapped = structure?.periodic?.visibleWrapped || structure?.periodic?.wrapped;
  if (!wrapped || !wrapped.cart || !vectors) { dispose(); return; }
  const cart = wrapped.cart;
  const srcIndex = wrapped.srcIndex;
  const count = cart.length;
  ensureMeshes(count);
  if (!shaftMesh) return;

  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const normalize = (mag, useLog) => {
    if (useLog) {
      const a = Math.log10(Math.max(lo, LOG_EPS));
      const b = Math.log10(Math.max(hi, LOG_EPS));
      const v = Math.log10(Math.max(mag, LOG_EPS));
      return b > a ? Math.min(Math.max((v - a) / (b - a), 0), 1) : 0;
    }
    return hi > lo ? Math.min(Math.max((mag - lo) / (hi - lo), 0), 1) : 0;
  };
  const scalar = isScalarArrowMap(colorMap);
  const solid = new THREE.Color(/** @type {any} */ (colorHex));
  const shaftDiameter = radius;
  const tipDiameter = TIP_RADIUS * (radius / 0.08);
  const tipLength = TIP_LENGTH * (radius / 0.08);

  for (let i = 0; i < count; i++) {
    const src = srcIndex ? srcIndex[i] : i;
    const vx = vectors[src * 3];
    const vy = vectors[src * 3 + 1];
    const vz = vectors[src * 3 + 2];
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (!(len > minLength)) {
      // Collapse the instance to nothing rather than reallocating the mesh
      // when an atom's displacement vanishes for a frame.
      dummy.position.set(0, 0, 0);
      dummy.scale.set(0, 0, 0);
      dummy.quaternion.identity();
      dummy.updateMatrix();
      shaftMesh.setMatrixAt(i, dummy.matrix);
      tipMesh.setMatrixAt(i, dummy.matrix);
      continue;
    }
    origin.set(cart[i][0], cart[i][1], cart[i][2]);
    dir.set(vx / len, vy / len, vz / len);
    if (dir.dot(UP) < -0.9999) quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    else quat.setFromUnitVectors(UP, dir);

    if (scalar) color.copy(getColorFromMap(normalize(len, logColor), colorMap));
    else if (colorMap === 'direction') color.setRGB(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z));
    else if (colorMap === 'plusminus') {
      let r = 0, g = 0, b = 0;
      if (dir.x > 0) r += dir.x; else b += -dir.x;
      if (dir.y > 0) g += dir.y; else { r += -dir.y; b += -dir.y; }
      if (dir.z > 0) b += dir.z; else g += -dir.z;
      color.setRGB(Math.min(1, r), Math.min(1, g), Math.min(1, b));
    } else color.copy(solid);

    const totalLen = (ARROW_LEN_MIN + normalize(len, logLength) * (ARROW_LEN_MAX - ARROW_LEN_MIN)) * lengthFactor;
    const shaftLen = Math.max(totalLen - tipLength, totalLen * 0.35);
    dummy.position.copy(origin).addScaledVector(dir, shaftLen / 2);
    dummy.scale.set(shaftDiameter, shaftLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    shaftMesh.setMatrixAt(i, dummy.matrix);
    shaftMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);

    dummy.position.copy(origin).addScaledVector(dir, shaftLen + tipLength / 2);
    dummy.scale.set(tipDiameter, tipLength, tipDiameter);
    dummy.updateMatrix();
    tipMesh.setMatrixAt(i, dummy.matrix);
    tipMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
  }
  shaftMesh.instanceMatrix.needsUpdate = true;
  shaftMesh.instanceColor.needsUpdate = true;
  tipMesh.instanceMatrix.needsUpdate = true;
  tipMesh.instanceColor.needsUpdate = true;
}

export function hasPhononArrows() {
  return !!shaftMesh;
}
