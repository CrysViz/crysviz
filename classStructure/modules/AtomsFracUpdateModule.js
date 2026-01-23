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

  // Geometry: unit sphere, scaled per instance
  const geometry = new THREE.SphereGeometry(1, 32, 24);

  // Get material settings from getAtomVisSettings
  const atomVisSettings = getAtomVisSettings();

  // Material: visualization-mode dependent
  const material = new THREE.MeshPhysicalMaterial({
    transparent: false, // Use transparency setting
    opacity:  1.0,   // Use opacity setting
    roughness: atomVisSettings.roughness,     // Use roughness setting
    metalness: atomVisSettings.metalness,     // Use metalness setting
    clearcoat: atomVisSettings.clearcoat,     // Use clearcoat setting
    clearcoatRoughness: atomVisSettings.clearcoatRoughness, // Use clearcoat roughness
  });

  material.onBeforeCompile = (shader) => {
    // ---- VERTEX ----
    shader.vertexShader = `
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vInstanceEmissive = instanceEmissive;
        vInstanceEmissiveIntensity = instanceEmissiveIntensity;
      `
    );

    // ---- FRAGMENT ----
    shader.fragmentShader = `
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
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
  mesh.geometry.setAttribute(
   'instanceEmissive',
   new THREE.InstancedBufferAttribute(
     new Float32Array(atomCount * 3),
    3
    )
  );
  mesh.geometry.setAttribute(
  'instanceEmissiveIntensity',
  new THREE.InstancedBufferAttribute(
    new Float32Array(mesh.count),
    1
   )
  );


  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // Add to scene & store reference
  app.scene.add(mesh);
  groups.atomsMesh = mesh;
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
  }


  groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(5, 1, 0.549, 0);
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(5, 2.0);
  groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.atomsMesh.setColorAt(5, new THREE.Color(0xFF8C00));

  groups.atomsMesh.instanceMatrix.needsUpdate = true;
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.atomsMesh.material.needsUpdate = true;
}



//export function updateAtomsPerElement
//  const a = groups.atomsMesh.instanceMatrix.array;
//  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position)
//  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
//  let elements = [...fileBrowser.selectedStructure.elements];

  




