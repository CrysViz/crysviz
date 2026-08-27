// Shared material for the force/spin arrow instanced meshes (shaft + tip).
// Same PBR preset atoms/bonds use, plus a per-instance emissive glow layered
// on top of (not replacing) instanceColor — mirrors AtomsFracUpdateModule.js/
// BondsFracUpdateModule.js's own instanceEmissive/instanceEmissiveIntensity
// shader patch. Lets an arrow glow when its atom is selected
// (ui/SelectAndHighlightModule.js) without recoloring it.

import * as THREE from '../external/three/three.module.js';
import { createStyledMaterial } from './MaterialStyles.js';
import { getAtomVisSettings } from '../defaults/color_texture_defaults.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';

export function createArrowMaterial() {
  const material = createStyledMaterial(getAtomVisSettings());
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `
      attribute vec3 instanceEmissive;
      attribute float instanceEmissiveIntensity;
      attribute float instanceOpacity;
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceOpacity;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vInstanceEmissive = instanceEmissive;
      vInstanceEmissiveIntensity = instanceEmissiveIntensity;
      vInstanceOpacity = instanceOpacity;
    `);
    shader.fragmentShader = `
      varying vec3 vInstanceEmissive;
      varying float vInstanceEmissiveIntensity;
      varying float vInstanceOpacity;
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      totalEmissiveRadiance += vInstanceEmissive * vInstanceEmissiveIntensity;
    `);
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      'vec4 diffuseColor = vec4( diffuse, opacity * vInstanceOpacity );',
    );
    material.userData.shader = shader;
  };
  return material;
}

/** Allocate + attach the per-instance emissive attributes a freshly-built
 *  arrow mesh (shaft or tip) needs — zero-filled, matching "not glowing". */
export function addArrowEmissiveAttributes(mesh, instanceCount) {
  mesh.geometry.setAttribute('instanceEmissive', new THREE.InstancedBufferAttribute(new Float32Array(instanceCount * 3), 3));
  mesh.geometry.setAttribute('instanceEmissiveIntensity', new THREE.InstancedBufferAttribute(new Float32Array(instanceCount), 1));
  const opacity = new Float32Array(instanceCount);
  opacity.fill(1);
  mesh.geometry.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(opacity, 1));
}

export function syncArrowTransparency(mesh, needsTransparency = false) {
  if (!mesh?.material) return;
  applyTransparency(mesh.material, {
    kind: 'arrows', opacity: 1, needsTransparency, perInstanceOpacity: true, mesh,
  });
}
