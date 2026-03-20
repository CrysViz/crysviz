import * as THREE from '../external/three/three.module.js';
import {periodic,structureShip, app, groups,fileBrowser, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';
import {Atom} from '../classes/Atom.js';
import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {periodicWrapped,runPeriodicWrapped,cartToFrac,fracToCart} from './LatticeModule.js'

import {setAtomColor}  from './ColorModule.js';

import {generateID} from './UUIDModule.js' 


export function getUUIDFromGeometry(index) {
  const mesh = groups.atomsMesh;
  const attr = mesh.geometry.attributes.instanceUUID;

  // Each instance = 4 floats = 16 bytes
  const floatOffset = index * 4;

  // View directly into the attribute buffer
  const floatView = attr.array.subarray(floatOffset, floatOffset + 4);

  // Reinterpret the same memory as bytes
  const byteView = new Uint8Array(floatView.buffer, floatView.byteOffset, 16);

  // Decode to string
  const decoder = new TextDecoder();
  const rawUUID = decoder.decode(byteView);

  // Remove padding nulls
  const cleanedUUID = rawUUID.replace(/\0/g, '');

  // Now, cleanedUUID = stored UUID WITHOUT dashes
  return cleanedUUID;
}



export function updateAtomByUUID(mesh, uuid, newPosition, newColor) {
  const index = mesh.userData.uuidToIndex.get(uuid);
  if (index !== undefined) {
    // Get the UUID from the geometry
    const geometryUUID = getUUIDFromGeometry(mesh, index);

    // Failsafe: Check that the UUID in the geometry matches the lookup
    if (geometryUUID === uuid) {
      updateSingleAtomPosition(index, newPosition);
      if (newColor) {
        mesh.setColorAt(index, new THREE.Color(newColor));
        mesh.instanceColor.needsUpdate = true;
      }
    } else {
      console.error(`UUID mismatch at index ${index}: Expected ${uuid}, got ${geometryUUID}`);
    }
  } else {
    console.error(`No sphere found for UUID: ${uuid}`);
  }
}



//-------------------------------------------------------------------------------


export function rebuildAtoms(opacity) {
  if (groups.atomsMesh) {
    groups.atomsMesh.geometry.dispose();
    groups.atomsMesh.material.dispose();
    app.scene.remove(groups.atomsMesh);
    groups.atomsMesh = null;
  }
  fileBrowser.selectedStructure.atomImages={}
  console.log("Rebuilding periodic")
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  let elements = [...fileBrowser.selectedStructure.elements];
  let _ = runPeriodicWrapped(fileBrowser.selectedStructure.periodic, positions, elements,lattice)

  console.log("Building atoms")
  buildAtoms();
  console.log("updating atoms")
  let ok = updateAtoms(opacity);
  console.log("status updateAtoms", ok)
 }

export function buildAtoms() {
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  let elements = [...fileBrowser.selectedStructure.elements];
  let atoms=fileBrowser.selectedStructure.atoms
  let structure = fileBrowser.selectedStructure
  //perdic.wrapped

  let wrapped = fileBrowser.selectedStructure.periodic.wrapped

  const atomCount = wrapped.elements.length;
  console.log("Building mesh for",atomCount,"atoms")

  // Geometry: unit sphere, scaled per instance
  const geometry = new THREE.SphereGeometry(1, 32, 24);

  // Material: visualization-mode dependent
  const atomVisSettings = getAtomVisSettings();
  const material = new THREE.MeshPhysicalMaterial({
    transparent: false,
    opacity: 1.0,
    roughness: atomVisSettings.roughness,
    metalness: atomVisSettings.metalness,
    clearcoat: atomVisSettings.clearcoat,
    clearcoatRoughness: atomVisSettings.clearcoatRoughness,
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

  // Instanced mesh
  const mesh = new THREE.InstancedMesh(geometry, material, atomCount);

  // Initialize instance color buffer with a default color (e.g., grey)
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(atomCount * 3), 3, false);

  for (let i = 0; i < atomCount; i++) {
    mesh.setColorAt(i, new THREE.Color(0x808080)); // Default grey color
  }

  const instanceElementIndices = new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1);

  // Store UUIDs in mesh.userData as an array
  mesh.userData.uuids = [];
  const uuidToIndex = new Map();

  wrapped.elements.forEach((element, index) => {
    //console.log("index",index)
    //console.log("srcIndex",wrapped.srcIndex)
    const atom = atoms[wrapped.srcIndex[index]];
    mesh.userData.uuids.push(atom.uuid);
    uuidToIndex.set(atom.uuid, index);
    instanceElementIndices.setX(index, index);
  });

  // Store the lookup table in mesh.userData
  mesh.userData.uuidToIndex = uuidToIndex;

  // Encode UUIDs as a vec4 and store them in the geometry
  const uuidByteLength = 16; // 16 bytes = 4 floats
  const uuidAttributeData = new Float32Array(atomCount * 4); // 4 floats per UUID
  wrapped.elements.forEach((element, index) => {
    let key = wrapped.srcIndex[index]
    if (!structure.atomImages[key]) {
        structure.atomImages[key] = []; // Initialize with an empty array
    }
    structure.atomImages[key].push(index)



    const atom = atoms[wrapped.srcIndex[index]];
    const cleanedUUID = atom.uuid.replace(/-/g, '');

    const encoder = new TextEncoder();
    const encodedUUID = encoder.encode(cleanedUUID);

    if (encodedUUID.length > 16) {
      console.warn("UUID too long, will be truncated:", atom.uuid);
    }

    const padded = new Uint8Array(16);
    padded.set(encodedUUID.subarray(0, 16));

    const floatView = new Float32Array(padded.buffer);
    uuidAttributeData.set(floatView, index * 4);
  });


  // Add the UUID attribute to the geometry
  const instanceUUIDs = new THREE.InstancedBufferAttribute(uuidAttributeData, 4);

  mesh.geometry.setAttribute('instanceUUID', instanceUUIDs);
  mesh.geometry.setAttribute('instanceElementIndex', instanceElementIndices);

  // Existing attributes
  mesh.geometry.setAttribute(
    'instanceEmissive',
    new THREE.InstancedBufferAttribute(new Float32Array(atomCount * 3), 3)
  );
  mesh.geometry.setAttribute(
    'instanceEmissiveIntensity',
    new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
  );

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);


  // Mark instanceColor as needing update
  mesh.instanceColor.needsUpdate = true;

  // Add to scene & store reference
  app.scene.add(mesh);
  groups.atomsMesh = mesh;
  groups.atomsMesh.userData.elementNames = wrapped.elements;
}




export function updateSingleAtomPosition(index, position) {
  //console.log("Updatng atom",index,"to",position)
  const a = groups.atomsMesh.instanceMatrix.array;
  const mOffset = index * 16;
  a[mOffset + 12] = position[0];
  a[mOffset + 13] = position[1];
  a[mOffset + 14] = position[2];

 // console.log("Matrix array length:", groups.atomsMesh.instanceMatrix.array.length);
 // console.log("Expected length:", 16 * groups.atomsMesh.count);
}

export function updateSingleAtomColor(originalIndex, index, element, hex=null) {
  //console.log("Updating color of atom",index)
  let structure = fileBrowser.selectedStructure
  let atom = structure.atoms[originalIndex]
  if (hex == null){
    hex = structure.atoms[originalIndex].getColor(originalIndex)
  }
  else{
    setAtomColor(atom, hex);
  }
  // console.log(`Element: ${element}, Hex: ${hex}, RGB: [${((hex >> 16) & 0xFF) / 255}, ${((hex >> 8) & 0xFF) / 255}, ${(hex & 0xFF) / 255}]`);
  groups.atomsMesh.setColorAt(index, new THREE.Color(hex));
  groups.atomsMesh.instanceColor.needsUpdate = true;
}

export function updateSingleAtomDiameter(index, element) {
  const mesh = groups.atomsMesh;
  const a = mesh.instanceMatrix.array;
  const atomSize = general.atomSize;
  const radius = (atomicRadii[element] || 1.0) * atomSize;
  const mOffset = index * 16;
  a[mOffset + 0] = radius;
  a[mOffset + 5] = radius;
  a[mOffset + 10] = radius;
}


export async function updateAtoms(opacity = 1.0) {
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  let atoms = [...fileBrowser.selectedStructure.atoms];
  let elements = [...fileBrowser.selectedStructure.elements];
  let periodic = fileBrowser.selectedStructure.periodic;

  let wrapped;
  let wrappedCart;

  wrapped = periodic.wrapped
  wrappedCart = wrapped.cart

  for (let i = 0; i < groups.atomsMesh.count; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    updateSingleAtomPosition(i, wrappedCart[i])
    //updateSingleAtomColor(originalIndex,i, wrapped.elements[i])
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


