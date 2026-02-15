import * as THREE from '../backend/three/three.module.js';
import {allAtoms, bondLengths, app, groups, fileBrowser, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';

import {Atom} from '../../classes/Atom.js';


import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {cartToFractional } from '../old_style/structure-input.js';


import {createAtomMesh} from './AtomsModule.js'
import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'


import {loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor,getElementColor } from './ColorModule.js';
import {updateAtoms} from './AtomsFracUpdateModule.js'
import {bondLengthToColor} from '../panels/ColorPanel.js'
import {generateID} from './UUIDModule.js'
import {periodic} from '../store.js'


export function rebuildBonds(opacity) {
  if (groups.bondsMesh) {
    groups.bondsMesh.geometry.dispose();
    groups.bondsMesh.material.dispose();
    app.scene.remove(groups.bondsMesh);
    groups.bondssMesh = null;
  }
  buildBonds();
  renderBonds();
  updateBonds(opacity);
}


export function buildBondObjects(structure){
  wrappedFrac = periodic.wrapped.frac
  wrappedCart = periodic.wrapped.cart
  
  for (let i = 0; i < wrappedCart.length; i++) {
    for (let j = i + 1; j < wrappedCart.length; j++) {

      const ei = wrapped.elements[i];
      const atomIndex_i = wrapped.srcIndex[i];
      const ej = wrapped.elements[j];
      const atomIndex_j = wrapped.srcIndex[j];
      const cutoff = getBondCutoff(elem1, elem2);
      if (cutoff <= 0.01) return null;

      p1 = new THREE.Vector3(...wrappedCart[i]);
      p1 = new THREE.Vector3(...wrappedCart[j]);
      const dist = distance(p1, p2);
      if (dist > cutoff || dist < 0.005) return null;

      let bond = new Bond({
        elements: [ei,ej],
        length: dist,
        positions: [p1,p2],
        uuid: generateID(ei,ej),
        indices: [[-1,-1]]
        });

      structure.bonds.push(bond)
    }
  }    
}




export function renderBonds() {
  const bonds = fileBrowser.selectedStructure.bonds;
  const bondCount = bonds.length;

  // Geometry: unit cylinder, scaled per instance
  const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1, false);
  geometry.rotateX(Math.PI / 2);

  // Material: for bonds
  const bondVisSettings = getBondVisSettings();
  const material = new THREE.MeshPhysicalMaterial({
    transparent: false,
    opacity: 1.0,
    roughness: bondVisSettings.roughness,
    metalness: bondVisSettings.metalness,
    clearcoat: bondVisSettings.clearcoat,
    clearcoatRoughness: bondVisSettings.clearcoatRoughness,
    vertexColors: true,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute mat4 instanceMatrix;
      attribute vec3 instanceColor1;
      attribute vec3 instanceColor2;
      attribute vec4 instanceUUID;

      varying vec3 vColor;
      varying vec4 vInstanceUUID;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vInstanceUUID = instanceUUID;

        // Use the instance matrix for position and orientation
        transformed = instanceMatrix * vec4(position, 1.0);

        // Interpolate vertex color based on position along the bond (Y-axis)
        vColor = mix(instanceColor1, instanceColor2, smoothstep(-1.0, 1.0, position.y));
      `
    );

    shader.fragmentShader = `
      varying vec3 vColor;
      varying vec4 vInstanceUUID;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
        diffuseColor.rgb = vColor;
      `
    );
  };

  // Instanced mesh for bonds
  const mesh = new THREE.InstancedMesh(geometry, material, bondCount);

  // Initialize buffers for bond properties
  const instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(bondCount * 16), 16);
  const instanceColor1 = new THREE.InstancedBufferAttribute(new Float32Array(bondCount * 3), 3);
  const instanceColor2 = new THREE.InstancedBufferAttribute(new Float32Array(bondCount * 3), 3);
  const instanceUUIDs = new THREE.InstancedBufferAttribute(new Float32Array(bondCount * 4), 4);

  // Temporary objects for matrix calculations
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  // Store UUIDs
  mesh.userData.uuids = [];
  const uuidToIndex = new Map();

  bonds.forEach((bond, bondIndex) => {
    const pos1 = new THREE.Vector3().fromArray(bond.positions[0]);
    const pos2 = new THREE.Vector3().fromArray(bond.positions[1]);

    // Calculate bond midpoint and orientation
    const midPoint = new THREE.Vector3().addVectors(pos1, pos2).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(pos2, pos1);
    const length = direction.length();

    // Set up dummy object for matrix calculation
    dummy.position.copy(midPoint);
    dummy.scale.set(bond.diameter || 0.1, length / 2, bond.diameter || 0.1);
    if (length > 0) {
      dummy.lookAt(pos2);
    }
    dummy.updateMatrix();
    matrix.copy(dummy.matrix);

    // Set instance matrix
    instanceMatrix.set(matrix.elements, bondIndex * 16);

    // Set bond colors (no blending)
    const color1 = new THREE.Color().setHex(bond.color[0]);
    const color2 = new THREE.Color().setHex(bond.color[1]);
    instanceColor1.setXYZ(bondIndex, color1.r, color1.g, color1.b);
    instanceColor2.setXYZ(bondIndex, color2.r, color2.g, color2.b);

    // Encode UUID
    const cleanedUUID = bond.uuid.replace(/-/g, '');
    const encoder = new TextEncoder();
    const encodedUUID = encoder.encode(cleanedUUID);
    const padded = new Uint8Array(16);
    padded.set(encodedUUID.subarray(0, 16));
    const floatView = new Float32Array(padded.buffer);
    instanceUUIDs.setXYZW(bondIndex, floatView[0], floatView[1], floatView[2], floatView[3]);

    mesh.userData.uuids.push(bond.uuid);
    uuidToIndex.set(bond.uuid, bondIndex);
  });

  // Add attributes to the geometry
  mesh.geometry.setAttribute('instanceMatrix', instanceMatrix);
  mesh.geometry.setAttribute('instanceColor1', instanceColor1);
  mesh.geometry.setAttribute('instanceColor2', instanceColor2);
  mesh.geometry.setAttribute('instanceUUID', instanceUUIDs);

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  instanceColor1.setUsage(THREE.DynamicDrawUsage);
  instanceColor2.setUsage(THREE.DynamicDrawUsage);

  // Add to scene & store reference
  app.scene.add(mesh);
  groups.bondsMesh = mesh;
}

export function updateBonds() {
  const bonds = fileBrowser.selectedStructure.bonds;
  const bondCount = bonds.length;

  const instanceMatrix = groups.bondsMesh.geometry.attributes.instanceMatrix;
  const instanceColor1 = groups.bondsMesh.geometry.attributes.instanceColor1;
  const instanceColor2 = groups.bondsMesh.geometry.attributes.instanceColor2;

  // Temporary objects for matrix calculations
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  bonds.forEach((bond, bondIndex) => {
    // Skip if bond is not visible
    if (bond.visibleLen <= 1e-3) return;

    // Use precomputed midpoint and direction
    const midPoint = bond.midpoint;
    const direction = bond.direction;
    const length = bond.visibleLen; // Use visible length for rendering

    // Default bond diameter if not provided
    const diameter = bond.diameter || 0.1;

    // Set up dummy object for matrix calculation
    dummy.position.copy(midPoint);
    dummy.scale.set(diameter, length / 2, diameter);
    if (length > 0) {
      dummy.lookAt(direction.clone().add(midPoint));
    }
    dummy.updateMatrix();
    matrix.copy(dummy.matrix);

    // Update instance matrix
    instanceMatrix.set(matrix.elements, bondIndex * 16);

    // Update bond colors (use default if not provided)
    const color1 = new THREE.Color().setHex(bond.color[0] || bond.defaultColor[0]);
    const color2 = new THREE.Color().setHex(bond.color[1] || bond.defaultColor[1]);
    instanceColor1.setXYZ(bondIndex, color1.r, color1.g, color1.b);
    instanceColor2.setXYZ(bondIndex, color2.r, color2.g, color2.b);
  });

  // Mark attributes as needing update
  instanceMatrix.needsUpdate = true;
  instanceColor1.needsUpdate = true;
  instanceColor2.needsUpdate = true;
}


function updateSingleBondPosition(bondIndex, pos1, pos2) {
  const bond = fileBrowser.selectedStructure.bonds[bondIndex];
  const instanceMatrix = groups.bondsMesh.geometry.attributes.instanceMatrix;
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  // Update the bond's positions and recalculate midpoint and direction
  bond.positions = [pos1.toArray(), pos2.toArray()];
  bond.p1 = pos1;
  bond.p2 = pos2;
  bond.midpoint = new THREE.Vector3().addVectors(pos1, pos2).multiplyScalar(0.5);
  bond.direction = new THREE.Vector3().subVectors(pos2, pos1);
  bond.length = bond.direction.length();

  // Use precomputed midpoint and direction
  const midPoint = bond.midpoint;
  const direction = bond.direction;
  const length = bond.visibleLen || bond.length; // Use visible length if available

  // Default bond diameter if not provided
  const diameter = bond.diameter || 0.1;

  // Set up dummy object for matrix calculation
  dummy.position.copy(midPoint);
  dummy.scale.set(diameter, length / 2, diameter);
  if (length > 0) {
    dummy.lookAt(direction.clone().add(midPoint));
  }
  dummy.updateMatrix();
  matrix.copy(dummy.matrix);

  // Update instance matrix
  instanceMatrix.set(matrix.elements, bondIndex * 16);
  instanceMatrix.needsUpdate = true;
}


function updateSingleBondColor(bondIndex, color1, color2) {
  const instanceColor1 = groups.bondsMesh.geometry.attributes.instanceColor1;
  const instanceColor2 = groups.bondsMesh.geometry.attributes.instanceColor2;

  // Update bond colors
  const bond = fileBrowser.selectedStructure.bonds[bondIndex];
  bond.color = [color1, color2];

  const c1 = new THREE.Color().setHex(color1);
  const c2 = new THREE.Color().setHex(color2);

  instanceColor1.setXYZ(bondIndex, c1.r, c1.g, c1.b);
  instanceColor2.setXYZ(bondIndex, c2.r, c2.g, c2.b);

  instanceColor1.needsUpdate = true;
  instanceColor2.needsUpdate = true;
}


function updateSingleBondDiameter(bondIndex, diameter) {
  const bond = fileBrowser.selectedStructure.bonds[bondIndex];
  const instanceMatrix = groups.bondsMesh.geometry.attributes.instanceMatrix;
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  // Update bond diameter
  bond.diameter = diameter;

  // Use precomputed midpoint and direction
  const midPoint = bond.midpoint;
  const direction = bond.direction;
  const length = bond.visibleLen || bond.length; // Use visible length if available

  // Set up dummy object for matrix calculation
  dummy.position.copy(midPoint);
  dummy.scale.set(diameter, length / 2, diameter);
  if (length > 0) {
    dummy.lookAt(direction.clone().add(midPoint));
  }
  dummy.updateMatrix();
  matrix.copy(dummy.matrix);

  // Update instance matrix
  instanceMatrix.set(matrix.elements, bondIndex * 16);
  instanceMatrix.needsUpdate = true;
}

