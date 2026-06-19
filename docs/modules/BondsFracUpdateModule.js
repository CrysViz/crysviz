import * as THREE from '../external/three/three.module.js';

import {bondLengths,structureShip, app, groups,fileBrowser, general,mode} from '../store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings,getColorFromMap,getHeatMapColors,getBatlowColors,getHawaiiColors,getManaguaColors,getViridisColors,getPlasmaColors,getSpectralRColors} from '../defaults/color_texture_defaults.js'
import {Atom} from '../model/Atom.js';
import {Bond} from '../model/Bond.js';


import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'


import {updateAtoms} from './AtomsFracUpdateModule.js'
//import {bondLengthToColor} from '../panels/ColorPanel.js'
import {refreshHistogram} from '../panels/AnalysisPanels/BondAnalysisPanel.js'
import {generateID} from './UUIDModule.js'
import {periodic} from '../store.js'
//import {getBondCutoff} from './BondsModule.js'
//
export function initBondsLengths(){
  if (!fileBrowser.selectedStructure) {
    console.warn("Could not init bonds!")
    return;

  }
  let elements = [...fileBrowser.selectedStructure.elements];
  const uniqueElements = [...new Set(elements)]; // there is a object variable for this!
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
}

export function disposeBondsMesh(clearBondData = false) {
  if (groups.bondsMesh) {
    groups.bondsMesh.geometry.dispose();
    groups.bondsMesh.material.dispose();
    app.scene.remove(groups.bondsMesh);
    groups.bondsMesh = null;
  }
  if (clearBondData && fileBrowser.selectedStructure) {
    fileBrowser.selectedStructure.bonds = [];
    fileBrowser.selectedStructure.bondMapping = {};
    fileBrowser.selectedStructure.bondObjectMapping = {};
    fileBrowser.selectedStructure.bondhalfToAtom = {};
  }
  for (const key in bondLengths) delete bondLengths[key];
  refreshHistogram([], []);
}


export function rebuildBonds(opacity=1.0) {
  initBondsLengths() // this needs to be called once in general. Otherwise the sliders do nothing
  if (!general.showBonds) {
    disposeBondsMesh(true);
    return;
  }
  disposeBondsMesh(true);
  buildBondObjects(fileBrowser.selectedStructure)
  renderBonds();
  updateBonds(opacity);
  if (groups.bondsMesh) {
    groups.bondsMesh.visible = !!general.showBonds;
  }
  // Refresh histogram if it's open
  refreshHistogram(Object.values(bondLengths), Object.keys(bondLengths));
}

export function getBondCutoff(elem1, elem2) {
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  const isVisible = general.bondVisibility[pair1] !== false && general.bondVisibility[pair2] !== false;
  if (!isVisible) return 0.0;
  return general.bondLengths[pair1] || general.bondLengths[pair2] || 0.0;
}

export function buildBondObjects(structure){
  structure.bonds = [];
  structure.bondMapping = {};
  structure.bondObjectMapping = {};

  const wrapped = structure.periodic.wrapped;
  const wrappedCart = wrapped.cart;
  const atoms = fileBrowser.selectedStructure?.atoms;

  // First pass: create all bonds
  for (let i = 0; i < wrappedCart.length; i++) {
    for (let j = i + 1; j < wrappedCart.length; j++) {
      const ei = wrapped.elements[i];
      const ej = wrapped.elements[j];

      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 0.01) {
        console.log("Bond Cutoff too small for", ei, ej, cutoff)
        continue;
      }

      const p1 = new THREE.Vector3(...wrappedCart[i]);
      const p2 = new THREE.Vector3(...wrappedCart[j]);

      const dist = p1.distanceTo(p2);
      if (dist > cutoff || dist < 0.005) {
        continue;
      }

      const bond = new Bond({
        elements: [ei, ej],
        length: dist,
        positions: [p1.toArray(), p2.toArray()],
        uuid: generateID([ei, ej]),
        srcIndices: [wrapped.srcIndex[i], wrapped.srcIndex[j]],
        indices: [i, j]
      });

      // Set bond colors based on current color mode
      if (general.bondsColor === "white") {
        bond.color = ["#ffffff", "#ffffff"];
      } else if (general.bondsColor === "solid") {
        bond.color = [general.solidBondColor || "#ffffff", general.solidBondColor || "#ffffff"];
      } else if (general.bondsColor === "length") {
        // Temporary color, will be updated in second pass
        bond.color = bond.defaultColor;
      } else {
        // Default to element colors or atom colors
        if (atoms && bond.srcIndices[0] < atoms.length && bond.srcIndices[1] < atoms.length) {
          bond.color = [atoms[bond.srcIndices[0]].color, atoms[bond.srcIndices[1]].color];
        } else {
          bond.color = bond.defaultColor;
        }
      }

      structure.bonds.push(bond);
    }
  }

  // Second pass: handle length-based coloring if in length mode
  if (general.bondsColor === "length" && structure.bonds.length > 0) {
    // Calculate min/max bond lengths if not already set
    let minLength = general.BondMin;
    let maxLength = general.BondMax;

    if (minLength >= maxLength) {
      // Auto-calculate range from actual bond lengths
      minLength = Infinity;
      maxLength = -Infinity;
      structure.bonds.forEach(bond => {
        if (bond.dist < minLength) minLength = bond.dist;
        if (bond.dist > maxLength) maxLength = bond.dist;
      });
      // Ensure we don't have division by zero
      if (minLength === maxLength) {
        maxLength = minLength + 1;
      }
      general.BondMin = minLength;
      general.BondMax = maxLength;
    }

    // Apply color mapping based on bond lengths
    const colorMap = general.bondsColorMap || "heatmap";
    let colors;
    switch (colorMap) {
      case "batlow": colors = getBatlowColors(); break;
      case "hawaii": colors = getHawaiiColors(); break;
      case "managua": colors = getManaguaColors(); break;
      case "viridis": colors = getViridisColors(); break;
      case "plasma": colors = getPlasmaColors(); break;
      case "spectralR": colors = getSpectralRColors(); break;
      default: colors = getHeatMapColors();
    }

    if (colors && colors.length > 0) {
      const nBins = colors.length;
      structure.bonds.forEach(bond => {
        const clamped = Math.max(minLength, Math.min(maxLength, bond.dist));
        const t = (maxLength > minLength) ? (clamped - minLength) / (maxLength - minLength) : 0.5;
        const bin = Math.min(Math.max(0, Math.floor(t * nBins)), nBins - 1);
        const color = `#${(colors[bin].r * 255 | 0).toString(16).padStart(2, '0')}${(colors[bin].g * 255 | 0).toString(16).padStart(2, '0')}${(colors[bin].b * 255 | 0).toString(16).padStart(2, '0')}`;
        bond.color = [color, color];
      });
    }
  }

  // Populate global bondLengths for histogram
  for (const key in bondLengths) delete bondLengths[key];
  for (const bond of structure.bonds) {
    const [a, b] = bond.elements[0].localeCompare(bond.elements[1]) <= 0
      ? [bond.elements[0], bond.elements[1]]
      : [bond.elements[1], bond.elements[0]];
    const key = `${a}-${b}`;
    if (!bondLengths[key]) bondLengths[key] = [];
    bondLengths[key].push(bond.dist);
  }
}
export function renderBonds() {
  const structure = fileBrowser.selectedStructure;
  const bonds = fileBrowser.selectedStructure.bonds;
  const validBonds = bonds.filter(b => b.visibleLen > 1e-3);
 // console.warn("bonds",bonds,"validBonds",validBonds)
  const bondCount = validBonds.length;
 // console.log("Rendering", bondCount, "bonds");

  // Geometry: unit cylinder along +Y
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);

  // Material: copy atom material logic
  const bondVisSettings = getBondVisSettings()
  const material = new THREE.MeshPhysicalMaterial({
    transparent: false,
    opacity: 1.0,
    roughness: bondVisSettings.roughness,
    metalness: bondVisSettings.metalness,
    clearcoat: bondVisSettings.clearcoat,
    clearcoatRoughness: bondVisSettings.clearcoatRoughness,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute vec4 instanceUUID;
      varying vec4 vInstanceUUID;
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      attribute float instanceElementIndex;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceElementIndex;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vInstanceEmissive = instanceEmissive;
        vInstanceEmissiveIntensity = instanceEmissiveIntensity;
        vInstanceUUID = instanceUUID;
        vInstanceElementIndex = instanceElementIndex;
      `
    );

    shader.fragmentShader = `
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying vec4 vInstanceUUID;
      varying float vInstanceElementIndex;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
        totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
      `
    );
  };

  // Instanced mesh: 2 halves per bond
  const mesh = new THREE.InstancedMesh(geometry, material, bondCount * 2);

  // Instance colors
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2*3), 3, false);

  // Emissive attributes
  mesh.geometry.setAttribute(
    'instanceEmissive',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2*3), 3)
  );
  mesh.geometry.setAttribute(
    'instanceEmissiveIntensity',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2), 1)
  );

  // Element index per half (optional, can be 0 for all)
  mesh.geometry.setAttribute(
    'instanceElementIndex',
    new THREE.InstancedBufferAttribute(new Float32Array(bondCount*2), 1)
  );

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

    if (!structure.bondhalfToAtom) structure.bondhalfToAtom = {};
      structure.bondhalfToAtom[i * 2] = bond.srcIndices[0];

    let key = bond.indices[0];
    if (!structure.bondMapping[key]) {
        structure.bondMapping[key] = []; // Initialize with an empty array
    }
    structure.bondMapping[key].push(i * 2);    


    // Lookup table from bondHalf to the actual bond objects stored in the structure
    //  mainly necessary for color changes
    key = i*2
    if (!structure.bondObjectMapping[key]){
      structure.bondObjectMapping[key] = [];
    }
    structure.bondObjectMapping[key] = [i,0]

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

    structure.bondhalfToAtom[i * 2 + 1] = bond.srcIndices[1];

    key = bond.indices[1];
    if (!structure.bondMapping[key]) {
        structure.bondMapping[key] = []; // Initialize with an empty array
    }
    structure.bondMapping[key].push(i * 2 + 1);

    // Lookup table from bondHalf to the actual bond objects stored in the structure
    //  mainly necessary for color changes

    key = i*2+1
    if (!structure.bondObjectMapping[key]){
      structure.bondObjectMapping[key] = [];
    }
    structure.bondObjectMapping[key]=[i,1];

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
  groups.bondsMesh = mesh;
}

// change the color of a bond "half  cylinder" with index bondMeshIndex to color "color" (hex)
export function updateSingleBondColor(bondMeshIndex, color, overwriteAtom = false) {
  const mesh = groups.bondsMesh;
  const structure = fileBrowser.selectedStructure;

  // Ensure bondhalfToAtom and atoms exist; good check but not really necessary to improve performance
  //if (!structure.bondhalfToAtom || !structure.atoms) {
  //  console.warn("bondhalfToAtom or atoms not initialized.");
  //  return;
   // }
  //

  const atomIndex = structure.bondhalfToAtom[bondMeshIndex];
  const atom = structure.atoms[atomIndex];

  // Determine the color to use
  let targetColor = overwriteAtom || atom.userColor == null ? color : atom.userColor;

  //console.log(bondMeshIndex,atom.userColor, overwriteAtom, targetColor)

  // Update bond half color
  const threeColor = new THREE.Color(targetColor);
  mesh.instanceColor.setXYZ(bondMeshIndex, threeColor.r, threeColor.g, threeColor.b);
  mesh.instanceColor.needsUpdate = true;

}


export function updateSingleBondPosition(index, bond) {
  const mesh = groups.bondsMesh;
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

export function updateSingleBondDiameter(instanceIndex, newRadius) {
  const mesh = groups.bondsMesh;
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




export function updateSingleBond(index, bond, overwriteAtom=false){
  const mesh = groups.bondsMesh;
  const dummy = new THREE.Object3D();
  const dirNorm = bond.dir.clone().normalize();

  // ---- first half ----
  dummy.position.copy(bond.center1);
  dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirNorm); // precise alignment
  dummy.updateMatrix();
  mesh.setMatrixAt(index*2, dummy.matrix);

  updateSingleBondColor(index*2, bond.color[0],overwriteAtom)

  mesh.geometry.attributes.instanceEmissive.setXYZ(index*2, 0,0,0);
  mesh.geometry.attributes.instanceEmissiveIntensity.setX(index*2, 0);
  mesh.geometry.attributes.instanceElementIndex.setX(index*2, 0);

  // ---- second half ----
  dummy.position.copy(bond.center2);
  dummy.scale.set(bond.radius, bond.halfLen, bond.radius);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirNorm);
  dummy.updateMatrix();
  mesh.setMatrixAt(index*2 + 1, dummy.matrix);

  updateSingleBondColor(index*2+1, bond.color[1],overwriteAtom)

  mesh.geometry.attributes.instanceEmissive.setXYZ(index*2 + 1, 0,0,0);
  mesh.geometry.attributes.instanceEmissiveIntensity.setX(index*2 + 1, 0);
  mesh.geometry.attributes.instanceElementIndex.setX(index*2 + 1, 0);
}

export async function updateBonds(opacity=1.0) {
  const mesh = groups.bondsMesh;
  if (!mesh) return;
  mesh.visible = !!general.showBonds;
  if (!general.showBonds) return;

  const bonds = fileBrowser.selectedStructure.bonds.filter(b => b.visibleLen > 1e-3);

  bonds.forEach((bond, i) => {
    updateSingleBond(i, bond);
  });
  mesh.material.opacity = opacity;
  if (opacity === 1) {
    //console.log("Switching of transparency for comp bonds")
    mesh.material.transparent = false;
    mesh.material.depthWrite = true;
  }
  else {
    mesh.material.transparent = true;
    mesh.material.depthWrite = true;
  }

  // mark all attributes as needing update
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  mesh.geometry.attributes.instanceElementIndex.needsUpdate = true;
  mesh.material.needsUpdate = true;
}

