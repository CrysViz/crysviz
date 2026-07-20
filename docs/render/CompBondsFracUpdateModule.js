import * as THREE from '../external/three/three.module.js';

import { app, groups,fileBrowser, general} from '../state/store.js';
import {getElementRadius} from '../defaults/radii_defaults.js'

import {Bond} from '../model/index.js';




import {createBondsMesh} from './BondsFracUpdateModule.js'
import {generateID} from '../utils/index.js'
import { applyTransparency } from '../utils/TransparencyPolicy.js';
//import {getBondCutoff} from './BondsModule.js'
//
export function initBondsLengths(){
  if (!fileBrowser.selectedStructure) {
    console.warn("Could not init bonds!")
    return;

  }
  // Include every overlay structure's elements too: this only ever runs ahead
  // of building OVERLAY bonds, and an overlaid structure commonly has at least
  // one element the main structure doesn't — any pair missing from
  // general.bondLengths gets a cutoff of 0 (getBondCutoff falls back to
  // `?.max || 0.0`), which silently drops every bond that pair could form.
  let elements = [
    ...fileBrowser.selectedStructure.elements,
    ...fileBrowser.overlayEntries.flatMap((entry) => entry.structure?.elements ?? []),
  ];
  const uniqueElements = [...new Set(elements)]; // there is a object variable for this!
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] < uniqueElements[j]
        ? `${uniqueElements[i]}-${uniqueElements[j]}`
        : `${uniqueElements[j]}-${uniqueElements[i]}`;
      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        const defaultRadius = getElementRadius(uniqueElements[i]) + getElementRadius(uniqueElements[j]);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = { min: 0.0, max: defaultValue };
        general.defaultBondLengths[pair] = { min: 0.0, max: defaultValue }; // Store default
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }
}


export function rebuildOverlayBonds(key, structure, opacity, visible = true) {
  initBondsLengths() // this needs to be called once in general. Otherwise the sliders do nothing
  const entry = groups.overlayMeshes.get(key);
  if (entry?.bondsMesh) {
    entry.bondsMesh.geometry.dispose();
    entry.bondsMesh.material.dispose();
    app.scene.remove(entry.bondsMesh);
    entry.bondsMesh = null;
  }
  console.log("Building bond objects");
  buildOverlayBondObjects(structure)
  console.log("Rendering bond objects");
  renderOverlayBonds(key, structure);
  console.log("Updating bond positions");
  updateOverlayBonds(key, structure, opacity, visible);
}

export function getBondCutoff(elem1, elem2) {
  const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
  const isVisible = general.bondVisibility[pair] !== false;
  if (!isVisible) return 0.0;
  return general.bondLengths[pair]?.max || 0.0;
}

export function getBondMinCutoff(elem1, elem2) {
  const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
  const isVisible = general.bondVisibility[pair] !== false;
  if (!isVisible) return 0.0;
  return general.bondLengths[pair]?.min || 0.0;
}

export function buildOverlayBondObjects(structure){
  structure.bonds = [];
  structure.bondMapping ={};

  const wrapped = structure.periodic.wrapped;
  const wrappedCart = wrapped.cart;

  for (let i = 0; i < wrappedCart.length; i++) {
    for (let j = i + 1; j < wrappedCart.length; j++) {

      const ei = wrapped.elements[i];
      const ej = wrapped.elements[j];

      const cutoff = getBondCutoff(ei, ej);
      const minCutoff = getBondMinCutoff(ei, ej);
      if (cutoff <= 0.01) {
        console.log("Bond Cutoff too small for",ei,ej, cutoff)
        continue;
      }
      const p1 = new THREE.Vector3(...wrappedCart[i]);
      const p2 = new THREE.Vector3(...wrappedCart[j]);

      const dist = p1.distanceTo(p2);
      if (dist > cutoff || dist < 0.005 || dist < minCutoff) {
        // console.log("Skipping bond with dist",dist, "due to cutoff", cutoff)
        continue;
      }
      const bond = new Bond({
        elements: [ei, ej],
        positions: [p1.toArray(), p2.toArray()],
        uuid: generateID([ei, ej]),
        srcIndices: [wrapped.srcIndex[i], wrapped.srcIndex[j]],
        indices: [i, j]
      });

      // bond.color is never set by the Bond constructor itself (it only
      // computes defaultColor) — the main buildBondObjects assigns it right
      // after construction based on the active color mode; this path never
      // did, so every overlay bond rendered white regardless of element
      // (new THREE.Color(undefined) from an empty bond.color array).
      const atoms = structure.atoms;
      if (general.bondsColor === "white") {
        bond.color = ["#ffffff", "#ffffff"];
      } else if (general.bondsColor === "solid") {
        bond.color = [general.solidBondColor || "#ffffff", general.solidBondColor || "#ffffff"];
      } else if (atoms && bond.srcIndices[0] < atoms.length && bond.srcIndices[1] < atoms.length) {
        // Default (including "elements"/"length" — length-based colormap
        // grading isn't implemented for overlay bonds, so they fall back
        // to element/atom colors instead of a gradient).
        bond.color = [atoms[bond.srcIndices[0]].color, atoms[bond.srcIndices[1]].color];
      } else {
        bond.color = bond.defaultColor;
      }

      structure.bonds.push(bond);
    }
  }
}

export function renderOverlayBonds(key, structure) {
  const bonds = structure.bonds;
  const validBonds = bonds.filter(b => b.visibleLen > 1e-3);
  const bondCount = validBonds.length;
  console.log("Rendering", bondCount, "bonds");

  const mesh = createBondsMesh(bondCount);

  // UUIDs
  const uuidAttr = new Float32Array(bondCount*2*4);
  const encoder = new TextEncoder();
  const paddedUUID = new Uint8Array(16);

  const dummy = new THREE.Object3D();

  validBonds.forEach((bond, i) => {
    if (!bond.center1 || !bond.center2) return;

    const dirNorm = bond.dir.clone().normalize();

    // ---- first half ----
    dummy.position.copy(bond.center1);
    dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
    dummy.lookAt(bond.center1.clone().add(dirNorm));
    dummy.rotateX(Math.PI / 2);
    dummy.updateMatrix();
    mesh.setMatrixAt(i*2 , dummy.matrix);

    let key2 = bond.indices[0];
    if (!structure.bondMapping[key2]) {
        structure.bondMapping[key2] = []; // Initialize with an empty array
    }
    structure.bondMapping[key2].push(i * 2);


    // color
    mesh.instanceColor.setXYZ(i*2,
      new THREE.Color(bond.color[0]).r,
      new THREE.Color(bond.color[0]).g,
      new THREE.Color(bond.color[0]).b
    );

    // emissive
    mesh.geometry.attributes.instanceEmissive.setXYZ(i*2, 0, 0, 0);
    mesh.geometry.attributes.instanceEmissiveIntensity.setX(i*2, 0);
    mesh.geometry.attributes.instanceElementIndex.setX(i*2, 0);

    const uuid1 = `1${bond.uuid}`.replace(/-/g,'');
    paddedUUID.fill(0);
    paddedUUID.set(encoder.encode(uuid1).subarray(0,16));
    uuidAttr.set(new Float32Array(paddedUUID.buffer), i*8+0);

    // ---- second half ----
    dummy.position.copy(bond.center2);
    dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
    dummy.lookAt(bond.center2.clone().add(dirNorm));
    dummy.rotateX(Math.PI / 2);
    dummy.updateMatrix();
    mesh.setMatrixAt(i*2 + 1, dummy.matrix);
    key2 = bond.indices[1];
    if (!structure.bondMapping[key2]) {
        structure.bondMapping[key2] = []; // Initialize with an empty array
    }
    structure.bondMapping[key2].push(i * 2 + 1);

    // color
    mesh.instanceColor.setXYZ(i*2 + 1,
      new THREE.Color(bond.color[1]).r,
      new THREE.Color(bond.color[1]).g,
      new THREE.Color(bond.color[1]).b
    );

    // emissive
    mesh.geometry.attributes.instanceEmissive.setXYZ(i*2+1, 0,0,0);
    mesh.geometry.attributes.instanceEmissiveIntensity.setX(i*2+1, 0);
    mesh.geometry.attributes.instanceElementIndex.setX(i*2+1, 0);

    const uuid2 = `2${bond.uuid}`.replace(/-/g,'');
    paddedUUID.fill(0);
    paddedUUID.set(encoder.encode(uuid2).subarray(0,16));
    uuidAttr.set(new Float32Array(paddedUUID.buffer), i*8+4);
  });

  // Assign UUID attribute
  mesh.geometry.setAttribute('instanceUUID', new THREE.InstancedBufferAttribute(uuidAttr, 4));

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.needsUpdate = true;

  mesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  mesh.geometry.attributes.instanceElementIndex.needsUpdate = true;

  // Add to scene
  app.scene.add(mesh);
  let entry = groups.overlayMeshes.get(key);
  if (!entry) {
    entry = { atomsMesh: null, bondsMesh: null };
    groups.overlayMeshes.set(key, entry);
  }
  entry.bondsMesh = mesh;
}

// change the color of a bond "half  cylinder" with index bondMeshIndex to color "color" (hex)
export function updateOverlaySingleBondColor(key, bondMeshIndex, color) {
  const mesh = groups.overlayMeshes.get(key)?.bondsMesh;
  if (!mesh) return;
  mesh.instanceColor.setXYZ(
    bondMeshIndex,
    new THREE.Color(color).r,
    new THREE.Color(color).g,
    new THREE.Color(color).b
  );
  //mesh.instanceColor.needsUpdate = true;
}



export function updateOverlaySingleBondPosition(key, index, bond) {
  const mesh = groups.overlayMeshes.get(key)?.bondsMesh;
  if (!mesh) return;
  const dummy = new THREE.Object3D();
  const dirNorm = bond.dir.clone().normalize();

  // First half position and orientation
  dummy.position.copy(bond.center1);
  dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirNorm);
  dummy.updateMatrix();
  mesh.setMatrixAt(index * 2, dummy.matrix);

  // Second half position and orientation
  dummy.position.copy(bond.center2);
  dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirNorm);
  dummy.updateMatrix();
  mesh.setMatrixAt(index * 2 + 1, dummy.matrix);
}

export function updateOverlaySingleBondDiameter(key, instanceIndex, newRadius) {
  const mesh = groups.overlayMeshes.get(key)?.bondsMesh;
  if (!mesh) return;
  const dummy = new THREE.Object3D();

  // Get the current matrix for the instance
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(instanceIndex, matrix);

  // Decompose the matrix to extract position, rotation, and scale
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);

  // Update only the x and z components of the scale (diameter)
  scale.set(newRadius, scale.y, newRadius);

  // Recompose the matrix with the updated scale
  dummy.position.copy(position);
  dummy.quaternion.copy(rotation);
  dummy.scale.copy(scale);
  dummy.updateMatrix();

  // Set the updated matrix back to the instance
  mesh.setMatrixAt(instanceIndex, dummy.matrix);

  // Flag the mesh for update
  mesh.instanceMatrix.needsUpdate = true;
}




export function updateOverlaySingleBond(key, index, bond) {
  const mesh = groups.overlayMeshes.get(key)?.bondsMesh;
  if (!mesh) return;
  const dummy = new THREE.Object3D();
  const dirNorm = bond.dir.clone().normalize();

  // ---- first half ----
  dummy.position.copy(bond.center1);
  dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirNorm); // precise alignment
  dummy.updateMatrix();
  mesh.setMatrixAt(index*2, dummy.matrix);

  mesh.instanceColor.setXYZ(index*2,
    new THREE.Color(bond.color[0]).r,
    new THREE.Color(bond.color[0]).g,
    new THREE.Color(bond.color[0]).b
  );

  mesh.geometry.attributes.instanceEmissive.setXYZ(index*2, 0,0,0);
  mesh.geometry.attributes.instanceEmissiveIntensity.setX(index*2, 0);
  mesh.geometry.attributes.instanceElementIndex.setX(index*2, 0);

  // ---- second half ----
  dummy.position.copy(bond.center2);
  dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirNorm);
  dummy.updateMatrix();
  mesh.setMatrixAt(index*2 + 1, dummy.matrix);

  mesh.instanceColor.setXYZ(index*2 + 1,
    new THREE.Color(bond.color[1]).r,
    new THREE.Color(bond.color[1]).g,
    new THREE.Color(bond.color[1]).b
  );

  mesh.geometry.attributes.instanceEmissive.setXYZ(index*2 + 1, 0,0,0);
  mesh.geometry.attributes.instanceEmissiveIntensity.setX(index*2 + 1, 0);
  mesh.geometry.attributes.instanceElementIndex.setX(index*2 + 1, 0);
}

export function updateOverlayBonds(key, structure, opacity, visible = true) {
  const mesh = groups.overlayMeshes.get(key)?.bondsMesh;
  if (!mesh) return;
  if (!visible) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  let bonds = structure.bonds.filter(b => b.visibleLen > 1e-3);

  bonds.forEach((bond, i) => {
    updateOverlaySingleBond(key, i, bond);
  });
  mesh.material.opacity = opacity;
  applyTransparency(mesh.material, { kind: 'compBonds', opacity, mesh });
  // mark all attributes as needing update
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  mesh.geometry.attributes.instanceElementIndex.needsUpdate = true;
  mesh.material.needsUpdate = true;
}
