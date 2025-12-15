import * as THREE from '../backend/three/three.module.js';
import { app, groups, general, structureData, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';
import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped} from './LatticeModule.js'
import { createColorPicker } from '../old_style/color-picker.js';


import {forceLengthToColor} from '../panels/ColorPanel.js'


export function removeForces(){
if (groups.forceGroup) {
    groups.forceGroup.children.forEach(child => {
      child.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    });
    disposeGroup(groups.forceGroup);
  }
}


export function updateForces(forceFactor = 1.0) {

  console.warn("Calling update forces")

  // Dispose old force arrows
  if (groups.forceGroup) {
    groups.forceGroup.children.forEach(child => {
      child.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    });
    disposeGroup(groups.forceGroup);
  }


  if (structureData.forces=== null){
    return;
    }
  groups.forceGroup = new THREE.Group();

  if (!structureData || !structureData.positions || !structureData.lattice) return;

  // Wrap atomic positions periodically
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice);

  // Get lattice vectors for ghost cell replication (like bonds)
  const lattice = structureData.lattice;
  const a = new THREE.Vector3(...lattice[0]);
  const b = new THREE.Vector3(...lattice[1]);
  const c = new THREE.Vector3(...lattice[2]);
  for (let i = 0; i < wrappedCart.length; i++) {
    const atomIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const vector = structureData.forces[atomIndex]
    const scalingFactor = 1.0

    if ( !vector || vector.length !== 3) continue;
    const origin = new THREE.Vector3(...wrappedCart[i]);
    const dirVec = new THREE.Vector3(...vector);
    const baseLen = dirVec.length();
    const color = forceLengthToColor(baseLen)

    const logValue = Math.log10(baseLen);
    // Map log10(1e-4) to 0, log10(1e-3) to 0.5, log10(2) to 1 (or higher if needed)
    const mapped = (logValue + 4) / 3; // log10(1e-4) = -4 → 0, log10(1e-3) = -3 → 0.333...
    // Adjust so 1e-3 → 0.5
    const adjusted = mapped * 1.5; // Now 1e-3 → 0.5, 1e-4 → 0, 2 → ~1.3


    const totalLength = adjusted * scalingFactor * forceFactor; // add a factor five here otherwise reasonable forces are too small

    if (totalLength < 0.5) {
      //console.warn("Force vector too small (<0.5)", totalLength)
      continue};
     
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

    //  Tip (only positive direction)
    const tipLength = 0.8;
    const tipRadius = 0.3;
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(tipRadius, tipLength, 16),
      material
    );
    tip.position.set(0, shaftLength / 2 + tipLength / 2, 0);

    // Create an arrowGroup
    const arrowGroup = new THREE.Group();
    arrowGroup.add(shaftPos);
    arrowGroup.add(shaftNeg);
    arrowGroup.add(tip);

    const arrowAxis = new THREE.Vector3(0, 1, 0);
    arrowGroup.quaternion.setFromUnitVectors(arrowAxis, dir);
    arrowGroup.position.copy(origin);

    groups.forceGroup.add(arrowGroup);
  }

  app.scene.add(groups.forceGroup);
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
