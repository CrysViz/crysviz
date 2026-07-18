import * as THREE from '../external/three/three.module.js';

import { app, groups, general} from '../state/store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {getAtomVisSettings} from '../defaults/color_texture_defaults.js'

import {runPeriodicWrapped} from './LatticeModule.js'
import {finishAtomsMesh} from './AtomsFracUpdateModule.js'
import {createStyledMaterial, syncCelHullOpacitySuppression} from './MaterialStyles.js'
import { applyTransparency } from '../utils/TransparencyPolicy.js';


export function rebuildSecondAtoms(structure, opacity) {
  if (!structure) {
    console.error("rebuildSecondAtoms:Comparison structure not found")
    return;
    }
  if (groups.secondAtomsMesh) {
    groups.secondAtomsMesh.geometry.dispose();
    groups.secondAtomsMesh.material.dispose();
    app.scene.remove(groups.secondAtomsMesh);
    groups.secondAtomsMesh = null;
  }
  structure.atomImages={}
  let positions = structure.atoms.map(a => a.position);
  let lattice = structure.lattice.map(r => [...r]);
  let elements = [...structure.elements];
  let _ = runPeriodicWrapped(structure.periodic, positions, elements,lattice)

  buildSecondAtoms(structure);
  updateSecondAtoms(structure,opacity);
 }

export function buildSecondAtoms(structure) {
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

  finishAtomsMesh({ geometry, material, structure, wrapped, atoms, meshKey: 'secondAtomsMesh', cutPlanes: false });
}




export function updateSecondSingleAtomPosition(index, position) {
  //console.log("Updatng atom",index,"to",position)
  const a = groups.secondAtomsMesh.instanceMatrix.array;
  const mOffset = index * 16;
  a[mOffset + 12] = position[0];
  a[mOffset + 13] = position[1];
  a[mOffset + 14] = position[2];

 // console.log("Matrix array length:", groups.atomsMesh.instanceMatrix.array.length);
 // console.log("Expected length:", 16 * groups.atomsMesh.count);
}

export function updateSecondSingleAtomColor(index, hex) {
  groups.secondAtomsMesh.setColorAt(index, new THREE.Color(hex));
  groups.secondAtomsMesh.instanceColor.needsUpdate = true;
}

export function updateSecondSingleAtomDiameter(index, element, scale = 1) {
  const mesh = groups.secondAtomsMesh;
  const a = mesh.instanceMatrix.array;
  const atomSize = general.atomSize;
  const radius = (atomicRadii[element] || 1.0) * atomSize * scale;
  const mOffset = index * 16;
  a[mOffset + 0] = radius;
  a[mOffset + 5] = radius;
  a[mOffset + 10] = radius;
}


export function updateSecondAtoms(structure, opacity = 1.0) {
  let periodic = structure.periodic;

  let wrapped;
  let wrappedCart;

  wrapped = periodic.wrapped
  wrappedCart = wrapped.cart
  const mesh = groups.secondAtomsMesh;

  mesh.material.opacity = opacity;
  applyTransparency(mesh.material, { kind: 'compAtoms', opacity, mesh });
  syncCelHullOpacitySuppression(mesh, opacity);

  // Iterate the COMPARISON mesh's own instance count, not the main
  // structure's — the two structures can (and usually do) have different
  // atom/periodic-image counts, and indexing wrappedCart/wrapped.elements
  // (both sized to the comparison structure) past its own length reads
  // undefined and crashes updateSecondSingleAtomPosition.
  for (let i = 0; i < mesh.count; i++) {
    const originalIndex = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
    updateSecondSingleAtomPosition(i, wrappedCart[i])
    // Read the color from the comparison structure's own atom — never from
    // the main structure — so editing a main-structure atom's color never
    // bleeds into the comparison rendering.
    updateSecondSingleAtomColor(i, structure.atoms?.[originalIndex]?.getColor?.() ?? structure.atoms?.[originalIndex]?.defaultColor)
    updateSecondSingleAtomDiameter(i, wrapped.elements[i],
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

