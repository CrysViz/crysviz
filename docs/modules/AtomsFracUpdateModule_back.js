import * as THREE from '../backend/three/three.module.js';
import { app, groups,fileBrowser, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';

import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'
import {loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor,getElementColor } from './ColorModule.js';

export function rebuildAtoms(opacity) {
  if (groups.atomsMesh) {
    groups.atomsMesh.geometry.dispose();
    groups.atomsMesh.material.dispose();
    app.scene.remove(groups.atomsMesh);
    groups.atomsMesh = null;
  }
  buildAtoms();
  updateAtoms(opacity);
}


export function buildAtoms() {
  let wrapped;
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  let elements = [...fileBrowser.selectedStructure.elements];

  if (general.showPeriodic) {
    wrapped = periodicWrapped(positions, elements);
  } else {
    wrapped = {
      elements: elements,
      srcIndex: positions.map((_, index) => index),
    };
  }
  const atomCount = wrapped.elements.length;

  // Lookup table for element names
  const elementNames = wrapped.elements.map((element, index) => element);

  // Geometry: unit sphere, scaled per instance
  const geometry = new THREE.SphereGeometry(1, 32, 24);

  // Get material settings from getAtomVisSettings
  const atomVisSettings = getAtomVisSettings();

  // Material: visualization-mode dependent
  const material = new THREE.MeshPhysicalMaterial({
    transparent: false,
    opacity: 1.0,
    roughness: atomVisSettings.roughness,
    metalness: atomVisSettings.metalness,
    clearcoat: atomVisSettings.clearcoat,
    clearcoatRoughness: atomVisSettings.clearcoatRoughness,
  });

  material.onBeforeCompile = (shader) => {
    // ---- VERTEX ----
    shader.vertexShader = `
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      attribute float instanceHash; // Custom hash attribute
      attribute float instanceElementIndex; // Custom element index attribute
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceHash; // Pass hash to fragment shader
      varying float vInstanceElementIndex; // Pass element index to fragment shader
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vInstanceEmissive = instanceEmissive;
        vInstanceEmissiveIntensity = instanceEmissiveIntensity;
        vInstanceHash = instanceHash;
        vInstanceElementIndex = instanceElementIndex;
      `
    );

    // ---- FRAGMENT ----
    shader.fragmentShader = `
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceHash; // Receive hash in fragment shader
      varying float vInstanceElementIndex; // Receive element index in fragment shader
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
        totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
      `
    );
  };

  // Instanced mesh
  const mesh = new THREE.InstancedMesh(geometry, material, atomCount);

  // Per-instance color + alpha
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(atomCount * 3), 3
  );

  // Custom attributes for hash and index
  const instanceHashes = new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1);
  const instanceElementIndices = new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1);

  // Fill custom attributes
  wrapped.elements.forEach((element, index) => {
    // Generate a simple hash (e.g., using index + element name)
    const hash = simpleHash(index + element);
    instanceHashes.setX(index, hash);
    instanceElementIndices.setX(index, index);
  });

  // Add custom attributes to geometry
  geometry.setAttribute('instanceHash', instanceHashes);
  geometry.setAttribute('instanceElementIndex', instanceElementIndices);

  // Existing attributes
  geometry.setAttribute(
    'instanceEmissive',
    new THREE.InstancedBufferAttribute(new Float32Array(atomCount * 3), 3)
  );
  geometry.setAttribute(
    'instanceEmissiveIntensity',
    new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
  );

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // Add to scene & store reference
  app.scene.add(mesh);
  groups.atomsMesh = mesh;

  // Store elementNames for later lookup
  groups.atomsMesh.userData.elementNames = elementNames;
}

// Helper function to generate a simple hash
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}





export function updateSingleAtomPosition(index, position) {
  const a = groups.atomsMesh.instanceMatrix.array;

  const mOffset = index * 16;

  a[mOffset + 12] = position[0];
  a[mOffset + 13] = position[1];
  a[mOffset + 14] = position[2];
}


export function updateSingleAtomColor(originalIndex, index, element, opacity = 1.0) {
  const hex = getElementColor(element);
  // console.log(`Element: ${element}, Hex: ${hex}, RGB: [${((hex >> 16) & 0xFF) / 255}, ${((hex >> 8) & 0xFF) / 255}, ${(hex & 0xFF) / 255}]`);
  groups.atomsMesh.setColorAt(index, new THREE.Color(hex));
}




export function updateSingleAtomDiameter(index, element) {
  
  const mesh = groups.atomsMesh;
  const a = mesh.instanceMatrix.array;

  const atomSize = general.atomSize; // assuming this is a scalar

  const mOffset = index * 16;
  const radius = (atomicRadii[element] || 1.0) * atomSize;

  // uniform scale on diagonal
  a[mOffset + 0]  = radius;
  a[mOffset + 5]  = radius;
  a[mOffset + 10] = radius;

}



export function updateAtoms(opacity=1.0) {
  const a = groups.atomsMesh.instanceMatrix.array;
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position)
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  let elements = [...fileBrowser.selectedStructure.elements];

  let wrapped;
  let wrappedCart;

  if (general.showPeriodic) {
    wrapped = periodicWrapped(positions, elements);
    wrappedCart = fracToCart(wrapped.frac,lattice);
    }
  else {
    wrapped = {
        elements: elements,
        frac: positions,
        srcIndex: positions.map((_, index) => index)
    };
    wrappedCart = fracToCart(positions, lattice);
  }
  for (let i = 0; i < groups.atomsMesh.count; i++) {
     const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
     updateSingleAtomPosition(i, wrappedCart[i])
     updateSingleAtomColor(originalIndex,i, wrapped.elements[i], opacity)
     updateSingleAtomDiameter(i,wrapped.elements[i])
     groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(i, 0, 0, 0);
     groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(i, 0.0); 
  }

  // Mark attributes as needing update
  groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;

  groups.atomsMesh.instanceMatrix.needsUpdate = true;
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.atomsMesh.material.needsUpdate = true;
}






