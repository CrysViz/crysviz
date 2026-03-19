import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general, spinsData } from '../store.js';
import { disposeGroup } from '../panels/WindowAndSceneControls.js';

const SHAFT_SEGS = 12;
const TIP_SEGS = 12;
const TIP_LENGTH = 0.8;
const TIP_RADIUS = 0.3;
const UP = new THREE.Vector3(0, 1, 0);

function disposeSpinMeshes() {
  for (const key of ['spinShaftMesh', 'spinTipMesh']) {
    if (groups[key]) {
      groups[key].geometry.dispose();
      groups[key].material.dispose();
      app.scene.remove(groups[key]);
      groups[key] = null;
    }
  }
}

export function removeSpins() {
  disposeSpinMeshes();
}

export function deleteSpins() {
  spinsData.length = 0;
  disposeSpinMeshes();
}

export function updateSpins(spinFactor = 1.0) {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.periodic?.wrapped) { disposeSpinMeshes(); return; }

  const wrapped = structure.periodic.wrapped;
  const shaftRadius = general.spinRadius ?? 0.08;

  // Determine spin source: structure.spins (OUTCAR) takes priority over manual spinsData
  const useStructureSpins = structure.spins?.length > 0;
  const useManualSpins = !useStructureSpins && spinsData?.length > 0;

  if (!useStructureSpins && !useManualSpins) { disposeSpinMeshes(); return; }

  // Build manual spin lookup: atomIndex → spin entry
  const manualSpinMap = useManualSpins
    ? new Map(spinsData.map(s => [s.atomIndex, s]))
    : null;

  // Collect valid arrows — one per original atom (skip periodic images)
  const arrows = [];
  const seen = new Set();
  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (seen.has(srcIdx)) continue;
    seen.add(srcIdx);

    let v, scalingFactor, color;
    if (useStructureSpins) {
      const spin = structure.spins[srcIdx];
      if (!spin?.vector) continue;
      v = spin.vector;
      scalingFactor = spin.scaling ?? 1.0;
      // Color non-collinear spins by direction: |x|→r, |y|→g, |z|→b
      const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
      if (mag < 0.001) continue;
      color = new THREE.Color(Math.abs(v[0]) / mag, Math.abs(v[1]) / mag, Math.abs(v[2]) / mag);
    } else {
      const spin = manualSpinMap.get(srcIdx);
      if (!spin?.vector) continue;
      v = spin.vector;
      scalingFactor = spin.scalingFactor ?? 1.0;
      color = new THREE.Color(spin.color ?? '#ffffff');
    }

    const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    if (mag < 0.05) continue;

    const totalLen = mag * scalingFactor * spinFactor;
    if (totalLen < 0.05) continue;

    arrows.push({
      origin: new THREE.Vector3(...wrapped.cart[i]),
      dir: new THREE.Vector3(...v).normalize(),
      shaftHalfLen: totalLen / 2,
      color,
    });
  }

  const count = arrows.length;

  // Rebuild InstancedMesh if count changed or meshes missing
  if (!groups.spinShaftMesh || groups.spinShaftMesh.count !== count * 2) {
    disposeSpinMeshes();
    if (count === 0) return;

    const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, SHAFT_SEGS, 1);
    const shaftMat = new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0.2 });
    groups.spinShaftMesh = new THREE.InstancedMesh(shaftGeo, shaftMat, count * 2);
    groups.spinShaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 2 * 3), 3);
    groups.spinShaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.spinShaftMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    app.scene.add(groups.spinShaftMesh);

    const tipGeo = new THREE.ConeGeometry(1, 1, TIP_SEGS);
    const tipMat = new THREE.MeshPhysicalMaterial({ roughness: 0.4, metalness: 0.2 });
    groups.spinTipMesh = new THREE.InstancedMesh(tipGeo, tipMat, count);
    groups.spinTipMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    groups.spinTipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.spinTipMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    app.scene.add(groups.spinTipMesh);
  }

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
    dummy.scale.set(shaftRadius, shaftHalfLen, shaftRadius);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinShaftMesh.setMatrixAt(i * 2, dummy.matrix);
    groups.spinShaftMesh.instanceColor.setXYZ(i * 2, color.r, color.g, color.b);

    // Shaft-
    dummy.position.copy(origin).addScaledVector(dir, -shaftHalfLen / 2);
    dummy.scale.set(shaftRadius, shaftHalfLen, shaftRadius);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinShaftMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    groups.spinShaftMesh.instanceColor.setXYZ(i * 2 + 1, color.r, color.g, color.b);

    // Tip cone
    dummy.position.copy(origin).addScaledVector(dir, shaftHalfLen + TIP_LENGTH / 2);
    dummy.scale.set(TIP_RADIUS, TIP_LENGTH, TIP_RADIUS);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinTipMesh.setMatrixAt(i, dummy.matrix);
    groups.spinTipMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
  });

  groups.spinShaftMesh.instanceMatrix.needsUpdate = true;
  groups.spinShaftMesh.instanceColor.needsUpdate = true;
  groups.spinTipMesh.instanceMatrix.needsUpdate = true;
  groups.spinTipMesh.instanceColor.needsUpdate = true;
}
