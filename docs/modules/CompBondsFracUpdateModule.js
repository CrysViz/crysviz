import * as THREE from '../external/three/three.module.js';

import {structureShip, app, groups,fileBrowser, general,mode} from '../store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings,getColorFromMap,getHeatMapColors,getBatlowColors,getHawaiiColors,getManaguaColors,getViridisColors,getPlasmaColors,getSpectralRColors} from '../defaults/color_texture_defaults.js'

import {Atom} from '../classes/Atom.js';
import {Bond} from '../classes/Bond.js';


import {disposeGroup} from '../panels/WindowAndSceneControls.js'


import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'


import {updateAtoms} from './AtomsFracUpdateModule.js'
import {generateID} from './UUIDModule.js'
import {periodic} from '../store.js'
//import {getBondCutoff} from './BondsModule.js'
//
//
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

      const pair = uniqueElements[i] < uniqueElements[j]
        ? `${uniqueElements[i]}-${uniqueElements[j]}`
        : `${uniqueElements[j]}-${uniqueElements[i]}`;

      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = {};
        general.bondLengths[pair]["max"] = defaultValue;
        general.bondLengths[pair]["min"] = 0.0;
        general.defaultBondLengths[pair]={};
        general.defaultBondLengths[pair]["max"] = defaultValue; // Store default
        general.defaultBondLengths[pair]["min"] = 0.0; // Store default
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }
}


export function rebuildSecondBonds(structure, opacity) {
  initBondsLengths() // this needs to be called once in general. Otherwise the sliders do nothing
  if (groups.secondBondsMesh) {
    groups.secondBondsMesh.geometry.dispose();
    groups.secondBondsMesh.material.dispose();
    app.scene.remove(groups.secondBondsMesh);
    groups.secondBondssMesh = null;
  }
  console.log("Building bond objects");
  buildSecondBondObjects(structure)
  console.log("Rendering bond objects");
  renderSecondBonds(structure);
  console.log("Updating bond positions");
  updateSecondBonds(structure,opacity);
  if (groups.secondBondsMesh) {
    groups.secondBondsMesh.visible = general.showSecondBond;
  }
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


export function buildSecondBondObjects(structure){
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
      const minCutoff = getBondMinCutoff(ei, ej);
      if (cutoff <= 0.01) {
        console.log("Bond Cutoff too small for", ei, ej, cutoff)
        continue;
      }


      const p1 = new THREE.Vector3(...wrappedCart[i]);
      const p2 = new THREE.Vector3(...wrappedCart[j]);

      const dist = p1.distanceTo(p2);
      if (dist > cutoff || dist < 0.005 || dist < minCutoff) {
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
}
export function renderSecondBonds(structure) {
  const bonds = structure.bonds;
  const validBonds = bonds.filter(b => b.visibleLen > 1e-3);
  const bondCount = validBonds.length;
  console.log("Rendering", bondCount, "bonds");

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

    let key = bond.indices[0];
    if (!structure.bondMapping[key]) {
        structure.bondMapping[key] = []; // Initialize with an empty array
    }
    structure.bondMapping[key].push(i * 2);    


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
    key = bond.indices[1];
    if (!structure.bondMapping[key]) {
        structure.bondMapping[key] = []; // Initialize with an empty array
    }
    structure.bondMapping[key].push(i * 2 + 1);

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
  groups.secondBondsMesh = mesh;
}

// change the color of a bond "half  cylinder" with index bondMeshIndex to color "color" (hex)
export function updateSecondSingleBondColor(bondMeshIndex, color) {
  const mesh = groups.secondBondsMesh;
  mesh.instanceColor.setXYZ(
    bondMeshIndex,
    new THREE.Color(color).r,
    new THREE.Color(color).g,
    new THREE.Color(color).b
  );
  //mesh.instanceColor.needsUpdate = true;
}



export function updateSecondSingleBondPosition(index, bond) {
  const mesh = groups.secondBondsMesh;
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

export function updateSecondSingleBondDiameter(instanceIndex, newRadius) {
  const mesh = groups.secondBondsMesh;
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




export function updateSecondSingleBond(index, bond) {
  const mesh = groups.secondBondsMesh;
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

export function updateSecondBonds(structure, opacity) {
  const mesh = groups.secondBondsMesh;
  if (!mesh) return;
  if (!general.showSecondBond) {
    groups.secondBondsMesh.visible = general.showSecondBond
    return;
  }
  else {
     groups.secondBondsMesh.visible = general.showSecondBond
  }
  let bonds = structure.bonds.filter(b => b.visibleLen > 1e-3); 

  bonds.forEach((bond, i) => {
    updateSecondSingleBond(i, bond);
  });
  mesh.material.opacity = opacity;
  if (opacity == 1.0) {
    console.log("Switching of transparency for main bonds")
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
