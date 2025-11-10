import * as THREE from 'three';
import { app, groups, general,spinsData, structureData, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';
import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped} from './LatticeModule.js'
import { createColorPicker } from '../old_style/color-picker.js';

export function updateSpins(spinFactor = 1) {

  // Dispose old spin arrows
  if (groups.spinGroup) {
    groups.spinGroup.children.forEach(child => {
      child.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    });
    disposeGroup(groups.spinGroup);
  }

  if (spinsData === null){
    return;
    }

  groups.spinGroup = new THREE.Group();

  if (!structureData || !structureData.positions || !structureData.lattice) return;

  // --- 1️⃣ Wrap atomic positions periodically ---
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);

  // --- 2️⃣ Get lattice vectors for ghost cell replication (like bonds) ---
  const lattice = structureData.lattice;
  const a = new THREE.Vector3(...lattice[0]);
  const b = new THREE.Vector3(...lattice[1]);
  const c = new THREE.Vector3(...lattice[2]);

  // --- 3️⃣ Render arrows per atom ---
  for (let i = 0; i < wrappedCart.length; i++) {
    const atomIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const spin = spinsData.find(s => s.atomIndex === atomIndex);
    if (!spin || !spin.vector || spin.vector.length !== 3) continue;

    const { vector, scalingFactor = 1.0, color = "#000000" } = spin;

    const origin = new THREE.Vector3(...wrappedCart[i]);
    const dirVec = new THREE.Vector3(...vector);

    const norm = Math.sqrt(vector[0]**2 + vector[1]**2 + vector[2]**2);
    if (norm < 0.05) {
      console.warn("Spin vector too small (<0.05)", norm)
      continue};

    const baseLen = dirVec.length();
    const totalLength = baseLen * scalingFactor * spinFactor;
    const dir = dirVec.clone().normalize();

    // --- Material (match atom style) ---
    const material = new THREE.MeshPhysicalMaterial(getAtomVisSettings(color,1.0));

    // --- Shaft geometry (extends both directions) ---
    const shaftRadius = 0.1;
    const shaftLength = totalLength;

    const shaftPos = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength / 2, 16),
      material
    );
    shaftPos.position.set(0, shaftLength / 4, 0);

    const shaftNeg = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength / 2, 16),
      material
    );
    shaftNeg.position.set(0, -shaftLength / 4, 0);

    // --- Tip (only positive direction) ---
    const tipLength = 0.8;
    const tipRadius = 0.3;
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(tipRadius, tipLength, 16),
      material
    );
    tip.position.set(0, shaftLength / 2 + tipLength / 2, 0);

    // --- Combine into arrowGroup ---
    const arrowGroup = new THREE.Group();
    arrowGroup.add(shaftPos);
    arrowGroup.add(shaftNeg);
    arrowGroup.add(tip);

    // --- Orientation ---
    const arrowAxis = new THREE.Vector3(0, 1, 0);
    arrowGroup.quaternion.setFromUnitVectors(arrowAxis, dir);
    arrowGroup.position.copy(origin);

    // --- Add to main group ---
    groups.spinGroup.add(arrowGroup);
  }

  // --- 4️⃣ Add to scene ---
  app.scene.add(groups.spinGroup);
}


export function deleteSpins(){
    console.log("deletingSpins")
     if (!spinsData){
       console.warn("no spins data to delete")
       return};
     spinsData.length = 0;
     updateSpins(0.0);
     const textarea = document.getElementById("textArea");
      if (textarea) {
        textarea.value = "";
      } else {
        console.warn('No element with id="textArea" found');
      }

     //populateSpinViewer()
  }


function fracToCart(frac, lattice) {
  return frac.map(fc => [
    fc[0] * lattice[0][0] + fc[1] * lattice[1][0] + fc[2] * lattice[2][0],
    fc[0] * lattice[0][1] + fc[1] * lattice[1][1] + fc[2] * lattice[2][1],
    fc[0] * lattice[0][2] + fc[1] * lattice[1][2] + fc[2] * lattice[2][2]
  ]);
}

function distance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getBondCutoff(elem1, elem2) {
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  return general.bondLengths[pair1] || general.bondLengths[pair2] || 0.0;
}

function isOutsideUnitCell(cart, lattice, eps = 1e-6) {
  const f = cartToFractional(cart, lattice);
  return (f[0] < -eps || f[0] >= 1 + eps ||
          f[1] < -eps || f[1] >= 1 + eps ||
          f[2] < -eps || f[2] >= 1 + eps);
}
