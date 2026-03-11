import * as THREE from '../external/three/three.module.js';
import { app, fileBrowser, groups, general,spinsData, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';
import {disposeGroup} from '../panels/WindowAndSceneControls.js';
import {periodicWrapped} from './LatticeModule.js';

export function removeSpins(){
if (groups.spinGroup) {
    groups.spinGroup.children.forEach(child => {
      child.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    });
    disposeGroup(groups.spinGroup);
  }
}
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
  let spins = fileBrowser.selectedStructure.spins?.map(spin => spin.vector)
 
  if (spins.length == 0){
    return;
    }
  let elements = [...fileBrowser.selectedStructure.elements];
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  groups.spinGroup = new THREE.Group();

  if (!positions || !lattice) return;

  // Wrap atomic positions periodically
  const wrapped = periodicWrapped(positions, elements);
  const wrappedCart = fracToCart(positions, lattice);

  // Get lattice vectors for ghost cell replication (like bonds)
  const a = new THREE.Vector3(...lattice[0]);
  const b = new THREE.Vector3(...lattice[1]);
  const c = new THREE.Vector3(...lattice[2]);
  console.log("Updating Spins")
  for (let i = 0; i < wrappedCart.length; i++) {
    const atomIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    const vector = spins[atomIndex].vector
    const scalingFactor = 1.0
    const color = "#000000"
    
    if ( !vector || vector.length !== 3) continue;
    console.log("Adding Spin for attom",i)

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

    groups.spinGroup.add(arrowGroup);
  }

  app.scene.add(groups.spinGroup);
}


export function deleteSpins(){
  // dummy: should delete the three objects and not the spins themselved
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
