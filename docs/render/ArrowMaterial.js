// Shared material for the force/spin arrow instanced meshes (shaft + tip).
// Same PBR preset atoms/bonds use, plus a per-instance emissive glow layered
// on top of (not replacing) instanceColor — mirrors AtomsFracUpdateModule.js/
// BondsFracUpdateModule.js's own instanceEmissive/instanceEmissiveIntensity
// shader patch. Lets an arrow glow when its atom is selected
// (ui/SelectAndHighlightModule.js) without recoloring it.

import * as THREE from '../external/three/three.module.js';
import { createStyledMaterial } from './MaterialStyles.js';
import { getAtomVisSettings } from '../defaults/color_texture_defaults.js';

export function createArrowMaterial() {
  const material = createStyledMaterial(getAtomVisSettings());
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vInstanceEmissive = instanceEmissive;
      vInstanceEmissiveIntensity = instanceEmissiveIntensity;
    `);
    shader.fragmentShader = `
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
    `);
    material.userData.shader = shader;
  };
  return material;
}

/** Allocate + attach the per-instance emissive attributes a freshly-built
 *  arrow mesh (shaft or tip) needs — zero-filled, matching "not glowing". */
export function addArrowEmissiveAttributes(mesh, instanceCount) {
  mesh.geometry.setAttribute('instanceEmissive', new THREE.InstancedBufferAttribute(new Float32Array(instanceCount * 3), 3));
  mesh.geometry.setAttribute('instanceEmissiveIntensity', new THREE.InstancedBufferAttribute(new Float32Array(instanceCount), 1));
}
