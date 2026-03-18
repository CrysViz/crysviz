import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general } from '../store.js';
import { forceLengthToColor } from '../panels/ColorPanel.js';

const SHAFT_SEGS = 12;
const TIP_SEGS = 12;
const TIP_LENGTH = 0.8;
const TIP_RADIUS = 0.3;
const UP = new THREE.Vector3(0, 1, 0);

function computeArrowLength(magnitude, forceFactor) {
  if (magnitude < 1e-5) return 0;
  const logVal = Math.max(-4, Math.min(Math.log10(magnitude), 0.301));
  const mapped = (logVal + 4) / 4.301;
  return mapped * 1.5 * forceFactor;
}

function disposeForceMeshes() {
  for (const key of ['forcesShaftMesh', 'forcesTipMesh']) {
    if (groups[key]) {
      groups[key].geometry.dispose();
      groups[key].material.dispose();
      app.scene.remove(groups[key]);
      groups[key] = null;
    }
  }
}

export function removeForces() {
  disposeForceMeshes();
}

export function updateForces(forceFactor = general.forceScale ?? 1.0) {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.forces?.length || !structure.periodic?.wrapped) return;

  const wrapped = structure.periodic.wrapped;
  const shaftRadius = general.forceRadius ?? 0.08;

  // Collect valid arrows — one per original atom (skip periodic images)
  const arrows = [];
  const seen = new Set();
  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (seen.has(srcIdx)) continue; // skip periodic image duplicates
    seen.add(srcIdx);

    const force = structure.forces[srcIdx];
    if (!force?.vector) continue;
    const v = force.vector;
    const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    const totalLen = computeArrowLength(mag, forceFactor);
    if (totalLen < 0.1) continue;

    arrows.push({
      origin: new THREE.Vector3(...wrapped.cart[i]),
      dir: new THREE.Vector3(...v).normalize(),
      shaftHalfLen: totalLen / 2,
      color: new THREE.Color(forceLengthToColor(mag)),
    });
  }

  const count = arrows.length;

  // Rebuild InstancedMesh if count changed or meshes missing
  if (!groups.forcesShaftMesh || groups.forcesShaftMesh.count !== count * 2) {
    disposeForceMeshes();
    if (count === 0) return;

    const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, SHAFT_SEGS, 1);
    const shaftMat = new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0.2 });
    groups.forcesShaftMesh = new THREE.InstancedMesh(shaftGeo, shaftMat, count * 2);
    groups.forcesShaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 2 * 3), 3);
    groups.forcesShaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.forcesShaftMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    app.scene.add(groups.forcesShaftMesh);

    const tipGeo = new THREE.ConeGeometry(1, 1, TIP_SEGS);
    const tipMat = new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0.2 });
    groups.forcesTipMesh = new THREE.InstancedMesh(tipGeo, tipMat, count);
    groups.forcesTipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    groups.forcesTipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.forcesTipMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    app.scene.add(groups.forcesTipMesh);
  }

  const dummy = new THREE.Object3D();

  arrows.forEach(({ origin, dir, shaftHalfLen, color }, i) => {
    // Safe quaternion: handle near-antiparallel to UP
    const quat = new THREE.Quaternion();
    if (dir.dot(UP) < -0.9999) {
      quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      quat.setFromUnitVectors(UP, dir);
    }

    // Shaft+ (from origin toward tip)
    dummy.position.copy(origin).addScaledVector(dir, shaftHalfLen / 2);
    dummy.scale.set(shaftRadius, shaftHalfLen, shaftRadius);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.forcesShaftMesh.setMatrixAt(i * 2, dummy.matrix);
    groups.forcesShaftMesh.instanceColor.setXYZ(i * 2, color.r, color.g, color.b);

    // Shaft- (from origin away from tip)
    dummy.position.copy(origin).addScaledVector(dir, -shaftHalfLen / 2);
    dummy.scale.set(shaftRadius, shaftHalfLen, shaftRadius);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.forcesShaftMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    groups.forcesShaftMesh.instanceColor.setXYZ(i * 2 + 1, color.r, color.g, color.b);

    // Tip cone
    dummy.position.copy(origin).addScaledVector(dir, shaftHalfLen + TIP_LENGTH / 2);
    dummy.scale.set(TIP_RADIUS, TIP_LENGTH, TIP_RADIUS);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.forcesTipMesh.setMatrixAt(i, dummy.matrix);
    groups.forcesTipMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
  });

  groups.forcesShaftMesh.instanceMatrix.needsUpdate = true;
  groups.forcesShaftMesh.instanceColor.needsUpdate = true;
  groups.forcesTipMesh.instanceMatrix.needsUpdate = true;
  groups.forcesTipMesh.instanceColor.needsUpdate = true;
}
