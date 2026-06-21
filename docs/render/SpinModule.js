import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general } from '../state/store.js';



const SHAFT_SEGS = 20;
const TIP_SEGS = 20;
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
  disposeSpinMeshes();
}




export function updateSpins(spinFactor = 1.0, useManualSpins = false, manualSpins = [], colorMap = "none") {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.periodic?.wrapped) { disposeSpinMeshes(); return; }

  const wrapped = structure.periodic.wrapped;
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

  spins.forEach(spin => {
    if (!spin.vector) return;

    const mag = Math.sqrt(spin.vector[0] ** 2 + spin.vector[1] ** 2 + spin.vector[2] ** 2);
    const totalLen = mag * (spin.scaling ?? 1.0) * spinFactor;

    if (colorMap !== "none" && colorMap !== "direction" && colorMap !== "plusminus") {
      // Normalize the spin magnitude to [0, 1] using UI min/max
      const normalizedValue = maxValue > minValue ? Math.min(Math.max((totalLen - minValue) / (maxValue - minValue), 0), 1) : 0;
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

    const element = structure.elements[srcIdx];
    if (!speciesVisibility[element]) continue;

    const v = spin.vector;
    const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    if (mag < 0.05) continue;

    const totalLen = mag * (spin.scaling ?? 1.0) * spinFactor;
    if (totalLen < 0.05) continue;

    arrows.push({
      origin: new THREE.Vector3(...wrapped.cart[i]),
      dir: new THREE.Vector3(...v).normalize(),
      shaftHalfLen: totalLen / 2,
      color: spin.color, // Use the updated color from Spin class
    });
  }

  // --- Rendering logic ---
  const count = arrows.length;

  if (!groups.spinShaftMesh || groups.spinShaftMesh.count !== count * 2) {
    disposeSpinMeshes();
    if (count === 0) return;

    const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, SHAFT_SEGS, 1);
    const shaftMat = new THREE.MeshPhysicalMaterial({
      roughness: 0.4,
      metalness: 0.2,
      //vertexColors: true // Enable vertex colors for instanced mesh
    });
    groups.spinShaftMesh = new THREE.InstancedMesh(shaftGeo, shaftMat, count * 2);
    groups.spinShaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 2 * 3), 3);
    groups.spinShaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    groups.spinShaftMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    app.scene.add(groups.spinShaftMesh);

    const tipGeo = new THREE.ConeGeometry(1, 1, TIP_SEGS);
    const tipMat = new THREE.MeshPhysicalMaterial({
      roughness: 0.4,
      metalness: 0.2,
      //vertexColors: true
    });
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
    dummy.scale.set(shaftDiameter, shaftHalfLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinShaftMesh.setMatrixAt(i * 2, dummy.matrix);
    groups.spinShaftMesh.instanceColor.setXYZ(i * 2, color.r, color.g, color.b);

    // Shaft-
    dummy.position.copy(origin).addScaledVector(dir, -shaftHalfLen / 2);
    dummy.scale.set(shaftDiameter, shaftHalfLen, shaftDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinShaftMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    groups.spinShaftMesh.instanceColor.setXYZ(i * 2 + 1, color.r, color.g, color.b);

    // Tip cone
    dummy.position.copy(origin).addScaledVector(dir, shaftHalfLen + tipLength / 2);
    dummy.scale.set(tipDiameter, tipLength, tipDiameter);
    dummy.quaternion.copy(quat);
    dummy.updateMatrix();
    groups.spinTipMesh.setMatrixAt(i, dummy.matrix);
    groups.spinTipMesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
  });

  // Update matrices and colors
  groups.spinShaftMesh.instanceMatrix.needsUpdate = true;
  groups.spinShaftMesh.instanceColor.needsUpdate = true;
  groups.spinTipMesh.instanceMatrix.needsUpdate = true;
  groups.spinTipMesh.instanceColor.needsUpdate = true;
}
