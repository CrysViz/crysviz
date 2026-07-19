import * as THREE from '../external/three/three.module.js';

import { app, groups, general} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {getAtomVisSettings} from '../defaults/color_texture_defaults.js'

import {runPeriodicWrapped} from './LatticeModule.js'
import {finishAtomsMesh} from './AtomsFracUpdateModule.js'
import {createStyledMaterial, syncCelHullOpacitySuppression} from './MaterialStyles.js'
import { applyTransparency } from '../utils/TransparencyPolicy.js';

// Structure Overlay module: each overlaid structure (fileBrowser.overlayEntries)
// gets its own InstancedMesh, tracked in groups.overlayMeshes (Map: entry.key ->
// { atomsMesh, bondsMesh }) instead of the old single groups.secondAtomsMesh slot.
function getOverlayMeshEntry(key) {
  let entry = groups.overlayMeshes.get(key);
  if (!entry) {
    entry = { atomsMesh: null, bondsMesh: null };
    groups.overlayMeshes.set(key, entry);
  }
  return entry;
}

function disposeOverlayAtomsMesh(key) {
  const entry = groups.overlayMeshes.get(key);
  if (entry?.atomsMesh) {
    entry.atomsMesh.geometry.dispose();
    entry.atomsMesh.material.dispose();
    app.scene.remove(entry.atomsMesh);
    entry.atomsMesh = null;
  }
}

/** Dispose both meshes (atoms + bonds) of one overlay entry and drop it from
 *  the registry — called when a row is unchecked/deleted/the structure is no
 *  longer overlaid. */
export function disposeOverlayMeshes(key) {
  const entry = groups.overlayMeshes.get(key);
  if (!entry) return;
  if (entry.atomsMesh) {
    entry.atomsMesh.geometry.dispose();
    entry.atomsMesh.material.dispose();
    app.scene.remove(entry.atomsMesh);
  }
  if (entry.bondsMesh) {
    entry.bondsMesh.geometry.dispose();
    entry.bondsMesh.material.dispose();
    app.scene.remove(entry.bondsMesh);
  }
  groups.overlayMeshes.delete(key);
}

export function rebuildOverlayAtoms(key, structure, opacity) {
  if (!structure) {
    console.error("rebuildOverlayAtoms: overlay structure not found")
    return;
    }
  disposeOverlayAtomsMesh(key);
  structure.atomImages={}
  let positions = structure.atoms.map(a => a.position);
  let lattice = structure.lattice.map(r => [...r]);
  let elements = [...structure.elements];
  let _ = runPeriodicWrapped(structure.periodic, positions, elements,lattice)

  buildOverlayAtoms(key, structure);
  updateOverlayAtoms(key, structure, opacity);
 }

export function buildOverlayAtoms(key, structure) {
  if (!structure) return;

  let atoms= structure.atoms

  //perdic.wrapped

  let wrapped = structure.periodic.wrapped

  // Geometry: unit sphere, scaled per instance
  const geometry = new THREE.SphereGeometry(1, 32, 24);

  // Material: visualization-mode dependent
  const atomVisSettings = getAtomVisSettings();
  const material = createStyledMaterial({
    ...atomVisSettings,
    transparent: false,
    opacity: 1.0,
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

  // meshKey is a namespaced, unique flat property on `groups` (finishAtomsMesh's
  // generic storage side effect) — the actual lookup used everywhere else goes
  // through groups.overlayMeshes, populated from the returned mesh below.
  const mesh = finishAtomsMesh({ geometry, material, structure, wrapped, atoms, meshKey: `overlayAtoms:${key}`, cutPlanes: false });
  getOverlayMeshEntry(key).atomsMesh = mesh;
}




export function updateOverlaySingleAtomPosition(key, index, position) {
  const mesh = groups.overlayMeshes.get(key)?.atomsMesh;
  if (!mesh) return;
  const a = mesh.instanceMatrix.array;
  const mOffset = index * 16;
  a[mOffset + 12] = position[0];
  a[mOffset + 13] = position[1];
  a[mOffset + 14] = position[2];
}

export function updateOverlaySingleAtomColor(key, index, hex) {
  const mesh = groups.overlayMeshes.get(key)?.atomsMesh;
  if (!mesh) return;
  mesh.setColorAt(index, new THREE.Color(hex));
  mesh.instanceColor.needsUpdate = true;
}

export function updateOverlaySingleAtomDiameter(key, index, element, scale = 1) {
  const mesh = groups.overlayMeshes.get(key)?.atomsMesh;
  if (!mesh) return;
  const atomSize = general.atomSize;
  const radius = (atomicRadii[element] || 1.0) * atomSize * scale;
  const mOffset = index * 16;
  const a = mesh.instanceMatrix.array;
  a[mOffset + 0] = radius;
  a[mOffset + 5] = radius;
  a[mOffset + 10] = radius;
}


export function updateOverlayAtoms(key, structure, opacity = 1.0) {
  const mesh = groups.overlayMeshes.get(key)?.atomsMesh;
  if (!mesh) return;

  let periodic = structure.periodic;

  let wrapped;
  let wrappedCart;

  wrapped = periodic.wrapped
  wrappedCart = wrapped.cart

  mesh.material.opacity = opacity;
  applyTransparency(mesh.material, { kind: 'compAtoms', opacity, mesh });
  syncCelHullOpacitySuppression(mesh, opacity);

  // Iterate this OVERLAY mesh's own instance count, not the main structure's
  // (or any other overlay's) — each overlaid structure can have a different
  // atom/periodic-image count, and indexing wrappedCart/wrapped.elements past
  // its own length reads undefined and crashes updateOverlaySingleAtomPosition.
  for (let i = 0; i < mesh.count; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    updateOverlaySingleAtomPosition(key, i, wrappedCart[i])
    // Read the color from this overlay structure's own atom — never from the
    // main structure or another overlay — so editing one structure's atom
    // color never bleeds into another's rendering.
    updateOverlaySingleAtomColor(key, i, structure.atoms?.[originalIndex]?.getColor?.() ?? structure.atoms?.[originalIndex]?.defaultColor)
    updateOverlaySingleAtomDiameter(key, i, wrapped.elements[i],
      structure.atoms?.[originalIndex]?.getRadiusScale?.() ?? 1)

    mesh.geometry.attributes.instanceEmissive.setXYZ(i, 0, 0, 0);
    mesh.geometry.attributes.instanceEmissiveIntensity.setX(i, 0.0);
  }

  // Mark attributes as needing update
  mesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  mesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.material.needsUpdate = true;

}
