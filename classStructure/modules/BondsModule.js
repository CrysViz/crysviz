import * as THREE from '../backend/three/three.module.js';
import {allAtoms, bondLengths, app, groups, structureData, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';
import {Atom} from '../../classes/Atom.js';

import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {cartToFractional } from '../old_style/structure-input.js';

import {createAtomMesh} from './AtomsModule.js'
import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'

import {loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor,getElementColor } from './ColorModule.js';
import {updateAtoms} from './AtomsModule.js'

import {bondLengthToColor} from '../panels/ColorPanel.js'

export function initBonds(){
  if (!structureData) {
    console.warn("Could not init bonds!")
    return;

  }

  console.log("initBonds")

  const uniqueElements = [...new Set(structureData.elements)];
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] + '-' + uniqueElements[j];
      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = defaultValue;
        general.defaultBondLengths[pair] = defaultValue; // Store default
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }
  updateBonds()

} 

export function createBond(pos1, pos2, elem1, elem2, atomIndex1, atomIndex2,opacity=1.0) {

  // Make sure the order is always the same
  let pair1 = { elem: elem1, pos: pos1, atomIndex: atomIndex1 };
  let pair2 = { elem: elem2, pos: pos2, atomIndex: atomIndex2 };
  const [firstPair, secondPair] = pair1.elem.localeCompare(pair2.elem) <= 0 ? [pair1, pair2] : [pair2, pair1];

  elem1 = firstPair.elem
  elem2 = secondPair.elem

  pos1 = firstPair.pos
  pos2 = secondPair.pos

  atomIndex1 = firstPair.atomIndex
  atomIndex2 = secondPair.atomIndex
  
  const key = `${elem1}-${elem2}`;

   

 // check if this has does already exist. If so, just update and do not create a new bond  


    function getAtomRadius(element) {
    return (atomicRadii[element] || 1.0) * general.atomSize;
  }

  const p1 = new THREE.Vector3(pos1[0], pos1[1], pos1[2]);
  const p2 = new THREE.Vector3(pos2[0], pos2[1], pos2[2]);
  const dist = distance(p1, p2);
  const cutoff = getBondCutoff(elem1, elem2);

  // If bond length is set to 0 or very small, don't create any bonds
  if (cutoff <= 0.01 || dist > cutoff || dist < 0.005) return null;

  // Check bond visibility
  pair1 = elem1 + '-' + elem2;
  pair2 = elem2 + '-' + elem1;
  const isVisible = general.bondVisibility[pair1] !== false && general.bondVisibility[pair2] !== false;

  if (!isVisible) return null;
  if (!(key in bondLengths)) {
    bondLengths[key] = [];
  }
  bondLengths[key].push(dist)

  
  const direction = new THREE.Vector3().subVectors(p2, p1);
  const midpoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);

  // Build VESTA-style split bond, but start at atom surfaces
  const bondGroup = new THREE.Group();

  let color1
  let color2
  if (general.bondsColor === "length"){
  color1= bondLengthToColor(dist)
  color2 = color1
  }
  else if (general.bondsColor === "white"){
    color1="#ccc"
    color2="#ccc"
  }
  else { 
    color1 = getIndividualAtomColor(elem1,atomIndex1);
    color2 = getIndividualAtomColor(elem2,atomIndex2);
  }

  // Compute visible segment between atom surfaces
  const r1 = getAtomRadius(elem1)-0.2*getAtomRadius(elem1);
  const r2 = getAtomRadius(elem2)-0.2*getAtomRadius(elem2);
  const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
  const visibleLen = Math.max(dist - (r1 + r2), 0);
  if (visibleLen <= 1e-3) return null; // spheres overlap or touch; skip bond

  const halfLen = visibleLen * 0.5;
  const radius = general.bondRadius;

  const geometryHalf = new THREE.CylinderGeometry(radius, radius, halfLen, 20);


  const material1 = new THREE.MeshPhysicalMaterial(getBondVisSettings(color1,opacity));
  const material2 = new THREE.MeshPhysicalMaterial(getBondVisSettings(color2,opacity));

  // Centers for the two halves: start from each surface and end at the
  // midpoint between surfaces, so centers are offset by r + halfLen/2
  const center1 = p1.clone().add(dir.clone().multiplyScalar(r1 + halfLen / 2));
  const center2 = p2.clone().add(dir.clone().multiplyScalar(-r2 - halfLen / 2));

  const half1 = new THREE.Mesh(geometryHalf, material1);
  half1.position.copy(center1);
  half1.lookAt(p2);
  half1.rotateX(Math.PI / 2);
  half1.name =`${atomIndex1}-${atomIndex2}`

  const half2 = new THREE.Mesh(geometryHalf, material2);
  half2.position.copy(center2);
  half2.lookAt(p2);
  half2.rotateX(Math.PI / 2);
  half2.name =`${atomIndex1}-${atomIndex2}`

  bondGroup.add(half1);
  bondGroup.add(half2);
  // create a hash that has the composition at the beginning for qick lookup
  // we need to be sure that the composition is always the same, let's go alphabetically. 
  return bondGroup;
}


export function updateBonds() {
  disposeGroup(groups.bondsGroup);
  groups.bondsGroup = new THREE.Group();

  if (!general.showBonds) return;

  for (const key in bondLengths) {
    delete bondLengths[key];
   }

  let wrapped;
  let wrappedCart;
  if (general.showPeriodic) {
    wrapped = periodicWrapped(structureData.positions, structureData.elements);
    wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
    } 
  else {
    wrapped = {
        elements: structureData.elements,
        frac: structureData.positions,
        srcIndex: structureData.positions.map((_, index) => index)
    };
    wrappedCart = fracToCart(wrapped.frac, structureData.lattice);
  } 


  // 1) Bonds entirely inside the unit cell among the wrapped atoms
  for (let i = 0; i < wrappedCart.length; i++) {
    for (let j = i + 1; j < wrappedCart.length; j++) {
      const ei = wrapped.elements[i];
      const atomIndex_i = wrapped.srcIndex[i];
      const ej = wrapped.elements[j];
      const atomIndex_j = wrapped.srcIndex[j];
      const bond = createBond(wrappedCart[i], wrappedCart[j], ei, ej, atomIndex_i, atomIndex_j);
      if (bond) groups.bondsGroup.add(bond);
    }
  }

  if (!general.showPeriodic) {
       console.log("No periodic images")
       app.scene.add(groups.bondsGroup);
       updateAtoms();
       console.log(groups.bondsGroup)
  }

  // 2) Neighbor bonds to atoms outside the cell (ghosts)
  const lattice = structureData.lattice;
  const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
  const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
  const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);

  const primCarts = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const primElems = wrapped.elements;

  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {dummy:0.0}));


  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
  const shifts = [];
  for (let dx = -ax; dx <= ax; dx++)
    for (let dy = -by; dy <= by; dy++)
      for (let dz = -cz; dz <= cz; dz++)
        shifts.push([dx, dy, dz]);

  const ghostAdded = new Map();
  const bondDedupe = new Set();

  for (let i = 0; i < primCarts.length; i++) {
    const pi = primCarts[i];
    const ei = primElems[i];
    const atomIndex_i = wrapped.srcIndex[i]; 
    for (let j = 0; j < primCarts.length; j++) {
      if (j === i) continue;
      const pj = primCarts[j];
      const ej = primElems[j];
      const atomIndex_j = wrapped.srcIndex[j];

      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 0.01) continue;

      for (const [dx, dy, dz] of shifts) {
        const shiftVec = new THREE.Vector3()
          .addScaledVector(a, dx)
          .addScaledVector(b, dy)
          .addScaledVector(c, dz);
        const candidate = pj.clone().add(shiftVec);
        const d = pi.distanceTo(candidate);
        if (d > cutoff || d < 0.005) continue;

        if (dx === 0 && dy === 0 && dz === 0) {
          // already handled in step (1)
        } else if (general.showPBCBonds) {
          const candidateArr = [candidate.x, candidate.y, candidate.z];
          if (!isOutsideUnitCell(candidateArr, lattice)) continue;

          const gkey = `${j}:${dx},${dy},${dz}`;
          let ghostMesh = ghostAdded.get(gkey);
          if (!ghostMesh) {
            ghostMesh = createAtomMesh(ej, [candidate.x, candidate.y, candidate.z]);
            ghostMesh.userData.isGhost = true;
            ghostMesh.material.opacity = 1.0;
            ghostMesh.material.transparent = true;
            ghostMesh.material.depthWrite = false;
            groups.atomsGroup.add(ghostMesh);
            ghostAdded.set(gkey, ghostMesh);
          }

          const bkey = `${i}-${j}-${dx},${dy},${dz}`;
          if (!bondDedupe.has(bkey)) {
            const bond = createBond([pi.x, pi.y, pi.z], [candidate.x, candidate.y, candidate.z], ei, ej,atomIndex_i,atomIndex_j);
            if (bond) {
              if (bond.children && bond.children[1] && bond.children[1].material) {
                bond.children[1].material.transparent = true;
                bond.children[1].material.opacity = 1.0;
              }
              groups.bondsGroup.add(bond);
            }
            bondDedupe.add(bkey);
          }

          // Symmetric ghost on opposite side
          const opposite = pi.clone().sub(shiftVec);
          if (isOutsideUnitCell([opposite.x, opposite.y, opposite.z], lattice)) {
            const gkey2 = `${i}:${-dx},${-dy},${-dz}`;
            if (!ghostAdded.has(gkey2)) {
              const ghostMesh2 = createAtomMesh(ei, [opposite.x, opposite.y, opposite.z]);
              ghostMesh2.userData.isGhost = true;
              ghostMesh2.material.opacity = 1.0;
              ghostMesh2.material.transparent = true;
              ghostMesh2.material.depthWrite = false;
              groups.atomsGroup.add(ghostMesh2);
              ghostAdded.set(gkey2, ghostMesh2);
            }
            const bkey2 = `sym-${i}-${j}-${dx},${dy},${dz}`;
            if (!bondDedupe.has(bkey2)) {
              const bond2 = createBond([opposite.x, opposite.y, opposite.z], [pj.x, pj.y, pj.z], ei, ej,atomIndex_i,atomIndex_j );
              if (bond2) {
                if (bond2.children && bond2.children[0] && bond2.children[0].material) {
                  bond2.children[0].material.transparent = true;
                  bond2.children[0].material.opacity = 1.0;
                }
                groups.bondsGroup.add(bond2);
              }
              bondDedupe.add(bkey2);
            }
          }
        }
      }
    }
  }

  app.scene.add(groups.bondsGroup);
  console.log(groups.bondsGroup)
}


function distance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function getBondCutoff(elem1, elem2) {
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

function hashObject(obj) {
  const str = JSON.stringify(obj);
  return simpleHash(str);
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString();
}


export function updateNeighborMap(structure){
  const wrapped = periodicWrapped(structure.atoms.map(a => a.position), structure.elements);
  const wrappedCart = fracToCart(wrapped.frac, structure.lattice);

  for (let i = 0; i < wrappedCart.length; i++) {
    for (let j = i + 1; j < wrappedCart.length; j++) {

      const ei = wrapped.elements[i];
      const atomIndex_i = wrapped.srcIndex[i];
      const ej = wrapped.elements[j];
      const atomIndex_j = wrapped.srcIndex[j];

      const posi = wrappedCart[i]
      const posj = wrappedCart[j]
      const pi = new THREE.Vector3(posi[0], posi[1], posi[2]);
      const pj = new THREE.Vector3(posj[0], posj[1], posj[2]);

      // Make sure the order is always the same
      const atomi = { elem: ei, pos: pi, atomIndex: i };
      const atomj = { elem: ej, pos: pj, atomIndex: j };

      const [firstElement, secondElement] = atomi.elem.localeCompare(atomj.elem) <= 0 ? [atomi, atomj] : [atomj, atomi];

      const dist = distance(firstElement.pos, secondElement.pos);
      const cutoff = getBondCutoff(firstElement.elem, secondElement.elem);
      let isBond = null;

      if (cutoff <= 0.01 || dist > cutoff || dist < 0.005){
         isBond = false;
      }
      else{
         isBond = true;
      }

      const key = `${firstElement.atomIndex}-${secondElement.atomIndex}`;
      const periodic = false;
      if (isOutsideUnitCell(firstElement.pos,structure.lattice) || isOutsideUnitCell(secondElement.pos,structure.lattice)){
         periodic = true;
      }

      structure.NeighborMap[key]={
          isBond:isBond,
          distance:dist,
          periodic:periodic
      }
    }
  }
  console.log(structure.NeighborMap)
}




export function getAllPeriodicImages(structure){
  allAtoms.length=0
  const lattice = structure.lattice;
  const wrapped = periodicWrapped(structure.atoms.map(a => a.position), structure.elements);
  const wrappedCart = fracToCart(wrapped.frac, lattice);

  const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
  const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
  const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);

  const [ax,by,cz] = [2,2,2]

  const shifts = [];
  for (let dx = -ax; dx <= ax; dx++)
    for (let dy = -by; dy <= by; dy++)
      for (let dz = -cz; dz <= cz; dz++)
        shifts.push([dx, dy, dz]);
  console.warn([ax,by,cz])
  const primCarts = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const primElems = wrapped.elements;
  for (let i = 0; i < primCarts.length; i++) {
    const pi = primCarts[i];
    const ei = primElems[i];
    const atomIndex_i = wrapped.srcIndex[i]; 
    for (const [dx, dy, dz] of shifts) {
            let atom = null;
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const shiftVec = new THREE.Vector3()
              .addScaledVector(a, dx)
              .addScaledVector(b, dy)
              .addScaledVector(c, dz);
            const periodicImage= pi.clone().add(shiftVec);
            atom = new Atom({
               position:[periodicImage.x, periodicImage.y, periodicImage.z],
               element:ei, 
               image: [dx, dy, dz]
            });
      allAtoms.push(atom)
      }
    }
}


