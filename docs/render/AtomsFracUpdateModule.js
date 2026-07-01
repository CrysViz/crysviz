import * as THREE from '../external/three/three.module.js';

import { app, groups,fileBrowser, general} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {getAtomVisSettings} from '../defaults/color_texture_defaults.js'

import { getCutPlaneMaskSign } from '../model/Plane.js';
import {runPeriodicWrapped} from './LatticeModule.js'

import {setAtomColor}  from '../utils/ColorModule.js';


const MAX_CUT_PLANES = 8;

function normalizePlaneNormal(x = 1, y = 0, z = 0) {
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const nz = Number(z) || 0;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) {
    return [1, 0, 0];
  }
  return [nx / length, ny / length, nz / length];
}

function getActiveCutPlanes() {
  return (general.atomCutPlanes || [])
    .filter((plane) => plane?.enabled)
    .slice(0, MAX_CUT_PLANES);
}

function applyAtomCutPlaneUniforms(material = groups.atomsMesh?.material) {
  const shader = material?.userData?.shader;
  if (!shader?.uniforms?.uCutPlanes || !shader.uniforms.uCutPlaneCount || !shader.uniforms.uCutPlaneMaskSide) return;
  const activePlanes = getActiveCutPlanes();
  shader.uniforms.uCutPlaneCount.value = activePlanes.length;
  activePlanes.forEach((plane, index) => {
    const [nx, ny, nz] = normalizePlaneNormal(plane.x, plane.y, plane.z);
    shader.uniforms.uCutPlanes.value[index].set(nx, ny, nz, Number(plane.r) || 0);
    shader.uniforms.uCutPlaneMaskSide.value[index] = getCutPlaneMaskSign(plane.side);
  });
  for (let index = activePlanes.length; index < MAX_CUT_PLANES; index++) {
    shader.uniforms.uCutPlanes.value[index].set(0, 0, 0, 0);
    shader.uniforms.uCutPlaneMaskSide.value[index] = 0;
  }
}


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
    const geometryUUID = getUUIDFromGeometry(index);

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

// Shared mesh finalization for atom InstancedMeshes (main + comparison/"second").
// The caller (buildAtoms / buildSecondAtoms) creates the geometry + material
// (incl. its own onBeforeCompile shader) and passes them in; this fills the
// instance color / UUID / emissive (+ cut-plane) buffers, adds the mesh to the
// scene, and stores it at groups[meshKey]. Only meshKey, the structure source,
// and the two cut-plane-only attributes (gated by `cutPlanes`) differ.
export function finishAtomsMesh({ geometry, material, structure, wrapped, atoms, meshKey, cutPlanes = false }) {
  const atomCount = wrapped.elements.length;

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
    const atom = atoms[wrapped.srcIndex[index]];
    mesh.userData.uuids.push(atom.uuid);
    uuidToIndex.set(atom.uuid, index);
    instanceElementIndices.setX(index, index);
  });

  // Store the lookup table in mesh.userData
  mesh.userData.uuidToIndex = uuidToIndex;

  // Encode UUIDs as a vec4 and store them in the geometry
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

  // Cut-plane attributes (main atoms mesh only)
  if (cutPlanes) {
    mesh.geometry.setAttribute(
      'instanceOpacity',
      new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
    );
    mesh.geometry.setAttribute(
      'instanceCutPlaneImmune',
      new THREE.InstancedBufferAttribute(new Float32Array(atomCount), 1)
    );
  }

  // Mark buffers as dynamic
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);


  // Mark instanceColor as needing update
  mesh.instanceColor.needsUpdate = true;

  // Add to scene & store reference
  app.scene.add(mesh);
  groups[meshKey] = mesh;
  groups[meshKey].userData.elementNames = wrapped.elements;
  // Honour the "Show Atoms" toggle on (re)build — the toggle only flips visibility on the
  // live mesh, so a rebuild (e.g. Complete Polyhedra appending atoms) would otherwise
  // reset the main atoms to visible. Comparison atoms keep their own visibility logic.
  if (meshKey === 'atomsMesh') mesh.visible = general.showAtoms !== false;
  return mesh;
}

export function buildAtoms() {
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
      attribute float instanceOpacity;
      attribute float instanceCutPlaneImmune;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceElementIndex;
      varying float vInstanceOpacity;
      varying float vInstanceCutPlaneImmune;
      varying vec3 vInstanceWorldCenter;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        #include <begin_vertex>
        vec4 instanceWorldCenter = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vInstanceEmissive = instanceEmissive;
        vInstanceEmissiveIntensity = instanceEmissiveIntensity;
        vInstanceUUID = instanceUUID;
        vInstanceElementIndex = instanceElementIndex;
        vInstanceOpacity = instanceOpacity;
        vInstanceCutPlaneImmune = instanceCutPlaneImmune;
        vInstanceWorldCenter = instanceWorldCenter.xyz;
      `
    );

    shader.fragmentShader = `
      uniform int uCutPlaneCount;
      uniform vec4 uCutPlanes[${MAX_CUT_PLANES}];
      uniform float uCutPlaneMaskSide[${MAX_CUT_PLANES}];
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying vec4 vInstanceUUID;
      varying float vInstanceElementIndex;
      varying float vInstanceOpacity;
      varying float vInstanceCutPlaneImmune;
      varying vec3 vInstanceWorldCenter;
    ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `
      vec4 diffuseColor = vec4( diffuse, opacity * vInstanceOpacity );
      if (vInstanceCutPlaneImmune < 0.5) {
        for (int i = 0; i < ${MAX_CUT_PLANES}; i++) {
          if (i >= uCutPlaneCount) break;
          vec4 cutPlane = uCutPlanes[i];
          float planeSide = (dot(vInstanceWorldCenter, cutPlane.xyz) - cutPlane.w) * uCutPlaneMaskSide[i];
          if (planeSide > 0.0) {
            discard;
          }
        }
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      ` 
        totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
      `
    );

    shader.uniforms.uCutPlaneCount = { value: 0 };
    shader.uniforms.uCutPlanes = {
      value: Array.from({ length: MAX_CUT_PLANES }, () => new THREE.Vector4(0, 0, 0, 0)),
    };
    shader.uniforms.uCutPlaneMaskSide = {
      value: new Float32Array(MAX_CUT_PLANES),
    };
    material.userData.shader = shader;
    applyAtomCutPlaneUniforms(material);
  };

  finishAtomsMesh({ geometry, material, structure, wrapped, atoms, meshKey: 'atomsMesh', cutPlanes: true });
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

export function updateSingleAtomColor(originalIndex, index, element, hex=null,userColor=null) {
  //console.log("Updating color of atom",index)
  let structure = fileBrowser.selectedStructure
  let atom = structure.atoms[originalIndex]
  if (hex == null){
    hex = structure.atoms[originalIndex].getColor(originalIndex)
  }
  else{
    if (userColor==null){
      setAtomColor(atom, hex);
    }
    else{
      structure.atoms[originalIndex].userColor = userColor
      setAtomColor(atom, userColor);
    }
  }
  // console.log(`Element: ${element}, Hex: ${hex}, RGB: [${((hex >> 16) & 0xFF) / 255}, ${((hex >> 8) & 0xFF) / 255}, ${(hex & 0xFF) / 255}]`);
  groups.atomsMesh.setColorAt(index, new THREE.Color(hex));
  groups.atomsMesh.instanceColor.needsUpdate = true;
}

export function updateSingleAtomOpacity(index, opacity = 1.0) {
  const normalizedOpacity = Math.max(0, Math.min(1, Number(opacity) || 0));
  groups.atomsMesh.geometry.attributes.instanceOpacity.setX(index, normalizedOpacity);
  groups.atomsMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  syncAtomMaterialTransparency(general.mainOpacity);
}

export function updateSingleAtomCutPlaneImmunity(index, immune = false) {
  groups.atomsMesh.geometry.attributes.instanceCutPlaneImmune.setX(index, immune ? 1 : 0);
  groups.atomsMesh.geometry.attributes.instanceCutPlaneImmune.needsUpdate = true;
}

export function updateAtomCutPlaneState() {
  const mesh = groups.atomsMesh;
  if (!mesh || !fileBrowser.selectedStructure) return;
  const wrapped = fileBrowser.selectedStructure.periodic?.wrapped;
  if (!wrapped?.srcIndex) {
    applyAtomCutPlaneUniforms(mesh.material);
    return;
  }
  for (let i = 0; i < wrapped.srcIndex.length; i++) {
    const atom = fileBrowser.selectedStructure.atoms[wrapped.srcIndex[i]];
    updateSingleAtomCutPlaneImmunity(i, atom?.cutPlaneImmune);
  }
  applyAtomCutPlaneUniforms(mesh.material);
}

function syncAtomMaterialTransparency(baseOpacity = 1.0) {
  const mesh = groups.atomsMesh;
  if (!mesh?.material) return;
  const hasTransparentInstances = fileBrowser.selectedStructure?.atoms?.some((atom) => (atom.getOpacity?.() ?? atom.opacity ?? 1) < 0.999) ?? false;
  const needsTransparency = baseOpacity < 0.999 || hasTransparentInstances;
  mesh.material.transparent = needsTransparency;
  mesh.material.depthWrite = !needsTransparency;
  mesh.material.needsUpdate = true;
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


export function updateAtoms(opacity = 1.0) {
  //console.error("Update main opacity", opacity)
  let atoms = [...fileBrowser.selectedStructure.atoms];
  let periodic = fileBrowser.selectedStructure.periodic;

  let wrapped;
  let wrappedCart;

  wrapped = periodic.wrapped
  wrappedCart = wrapped.cart
  const mesh = groups.atomsMesh

  mesh.material.opacity = opacity;
  syncAtomMaterialTransparency(opacity);

  for (let i = 0; i < wrappedCart.length; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    updateSingleAtomPosition(i, wrappedCart[i])
    updateSingleAtomColor(originalIndex,i, wrapped.elements[i])
    updateSingleAtomDiameter(i,wrapped.elements[i])    
    updateSingleAtomOpacity(i, atoms[originalIndex].getOpacity?.() ?? atoms[originalIndex].opacity ?? 1)
    updateSingleAtomCutPlaneImmunity(i, atoms[originalIndex].cutPlaneImmune)

    groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(i, 0, 0, 0);
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(i, 0.0);
  }

  // Mark attributes as needing update
  groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceCutPlaneImmune.needsUpdate = true;
  applyAtomCutPlaneUniforms(mesh.material);

  groups.atomsMesh.instanceMatrix.needsUpdate = true;
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.atomsMesh.material.needsUpdate = true;
  
}
