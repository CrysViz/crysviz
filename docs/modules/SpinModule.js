import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general } from '../store.js';
import { disposeGroup } from '../panels/WindowAndSceneControls.js';
import {
  getHeatMapColors,
  getBatlowColors,
  getHawaiiColors,
  getManaguaColors,
  getViridisColors,
  getPlasmaColors,
  getSpectralRColors
} from '../panels/ColorPanel.js'; // Update the path accordingly

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

  const arrows = [];
  const seen = new Set();

  // Get all species visibility checkboxes
  const speciesVisibility = {};
  const checkboxes = document.querySelectorAll('#speciesVisibilityContainer input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    const element = checkbox.id.replace('species-', '');
    speciesVisibility[element] = checkbox.checked;
  });

  for (let i = 0; i < wrapped.cart.length; i++) {
    const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    if (seen.has(srcIdx)) continue;
    seen.add(srcIdx);

    let spin;
    if (useManualSpins) {
      spin = spins.find(s => s.atomIndex === srcIdx);
    } else {
      spin = spins[srcIdx];
    }

    if (!spin?.vector) continue;

    // Get the element type for this atom
    const element = structure.elements[srcIdx];

    // Skip if the species is not visible
    if (!speciesVisibility[element]) continue;

    const v = spin.vector;
    const scalingFactor = spin.scaling ?? 1.0;
    let color;

    const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    if (mag < 0.05) continue;

    const totalLen = mag * scalingFactor * spinFactor;
    if (totalLen < 0.05) continue;

    if (colorMap === "none") {
      color = new THREE.Color(spin.color ?? '#008080');
    } else if (colorMap === "heatmap") {
      const colors = getHeatMapColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    } else if (colorMap === "direction") {
      color = new THREE.Color(Math.abs(v[0]) / mag, Math.abs(v[1]) / mag, Math.abs(v[2]) / mag);
    } else if (colorMap === "batlow") {
      const colors = getBatlowColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    } else if (colorMap === "hawaii") {
      const colors = getHawaiiColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    } else if (colorMap === "managua") {
      const colors = getManaguaColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    } else if (colorMap === "viridis") {
      const colors = getViridisColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    } else if (colorMap === "plasma") {
      const colors = getPlasmaColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    } else if (colorMap === "spectralR") {
      const colors = getSpectralRColors();
      const nBins = colors.length;
      const t = Math.min(totalLen / (general.spinMax || 2), 1);
      const bin = Math.min(Math.floor(t * nBins), nBins - 1);
      color = colors[bin];
    }

    arrows.push({
      origin: new THREE.Vector3(...wrapped.cart[i]),
      dir: new THREE.Vector3(...v).normalize(),
      shaftHalfLen: totalLen / 2,
      color,
    });
  }

  const count = arrows.length;

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

  groups.spinShaftMesh.instanceMatrix.needsUpdate = true;
  groups.spinShaftMesh.instanceColor.needsUpdate = true;
  groups.spinTipMesh.instanceMatrix.needsUpdate = true;
  groups.spinTipMesh.instanceColor.needsUpdate = true;
}
