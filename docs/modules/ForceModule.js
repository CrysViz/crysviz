import * as THREE from '../backend/three/three.module.js';
import { app, fileBrowser, groups, general, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';
import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped} from './LatticeModule.js'


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

  const forces = fileBrowser.selectedStructure.forces;

  console.log(forces)
  if (forces.length == 0){
    console.warn("No forces found!")
    return;
    }
  groups.forceGroup = new THREE.Group();

  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let elements = [...fileBrowser.selectedStructure.elements];
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);

  if (!positions || !lattice) return;

  // Wrap atomic positions periodically
  const wrapped = periodicWrapped(positions, elements);
  const wrappedCart = fracToCart(positions, lattice);

  // Get lattice vectors for ghost cell replication (like bonds)
  const a = new THREE.Vector3(...lattice[0]);
  const b = new THREE.Vector3(...lattice[1]);
  const c = new THREE.Vector3(...lattice[2]);
  for (let i = 0; i < wrappedCart.length; i++) {
    const atomIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const vector = forces[atomIndex].vector
    const scalingFactor = 1.0

    if ( !vector || vector.length !== 3) {
      console.warn("Force has wrong format")
      continue;
    }
    const origin = new THREE.Vector3(...wrappedCart[i]);
    const dirVec = new THREE.Vector3(...vector);
    const baseLen = dirVec.length();
    console.log(baseLen)


    const color = forceLengthToColor(baseLen)

    // Treat values below 1e-5 as 0
const clampedBaseLen = baseLen < 1e-5 ? 0 : baseLen;
let totalLength = 0    

// If baseLen is 0, set totalLength to 0 and skip further calculations
if (clampedBaseLen === 0) {
  totalLength = 0;
} else {
  const logValue = Math.log10(clampedBaseLen);

  // Clamp logValue to ensure it's within the expected range
  const clampedLogValue = Math.max(-4, Math.min(logValue, 0.3010)); // log10(2) ≈ 0.3010

  // Map log10(1e-4) to 0, log10(1e-3) to 0.5, log10(2) to 1
  const mapped = (clampedLogValue + 4) / 4.301; // Normalize to map log10(2) to 1
  const adjusted = mapped * 1.5; // Adjust so 1e-3 → 0.5, 1e-4 → 0, 2 → 1

  totalLength = adjusted * scalingFactor 
}


    if (totalLength < 0.5) {
      console.warn("Force vector too small (<0.5)", totalLength)
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
  console.log(groups.forceGroup)
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
