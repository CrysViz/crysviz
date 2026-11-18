// Shared material for the force/spin arrow instanced meshes (shaft + tip).
// Same PBR preset atoms/bonds use, plus a per-instance emissive glow layered
// on top of (not replacing) instanceColor — mirrors AtomsFracUpdateModule.js/
// BondsFracUpdateModule.js's own instanceEmissive/instanceEmissiveIntensity
// shader patch. Lets an arrow glow when its atom is selected
// (ui/SelectAndHighlightModule.js) without recoloring it.

import * as THREE from '../external/three/three.module.js';
import { createStyledMaterial, ARROW_MESH_KEYS } from './MaterialStyles.js';
import { CEL_OUTLINE_LAYER, CEL_OCCLUDER_LAYER } from './CelOutlinePass.js';
import { getAtomVisSettings } from '../defaults/color_texture_defaults.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { general, groups } from '../state/store.js';

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

/**
 * Give every arrow mesh a material in the current render style
 * (general.renderStyle: metallic, matte or cel). The arrows are built once
 * and reused while their count stays the same, so without this they kept the
 * style they were created in: shiny arrows among cel-shaded atoms, or toon
 * arrows after switching back. Keeps the transparency a focus region set.
 * Call when the render style changes.
 */
export function restyleArrowMaterials() {
  for (const key of ARROW_MESH_KEYS) {
    const mesh = groups[key];
    if (!mesh?.material) continue;
    const old = mesh.material;
    const material = createArrowMaterial();
    mesh.material = material;
    const spec = old.userData?.transparencySpec;
    if (spec) applyTransparency(material, { ...spec, mesh });
    old.dispose();
    applyArrowCelOutline(mesh);
  }
}

/**
 * The cel outline of one arrow mesh (call when it is built, and when the
 * render style, the outline mode or general.celOutlineArrows changes). The
 * arrow always hides the lines behind it (CEL_OCCLUDER_LAYER) and, outlined,
 * takes part in the screen-space pass (CEL_OUTLINE_LAYER). In 3D-hull mode
 * the arrows get no outline: inverted hulls suit them badly (thin, very
 * unevenly scaled and running through atoms, they showed hairline or
 * missing outlines, spikes, and shells poking through the atoms around
 * them), and lines drawn around them clash with the atoms' and bonds'
 * rings. A hull left from an earlier build is removed.
 */
export function applyArrowCelOutline(mesh) {
  if (!mesh) return;
  mesh.layers.enable(CEL_OCCLUDER_LAYER);
  if (general.celOutlineArrows !== false) mesh.layers.enable(CEL_OUTLINE_LAYER);
  else mesh.layers.disable(CEL_OUTLINE_LAYER);
  const hull = mesh.userData.celOutline;
  if (hull) {
    mesh.remove(hull);
    delete mesh.userData.celOutline;
  }
}

/** applyArrowCelOutline on every arrow mesh. */
export function refreshArrowCelOutlines() {
  for (const key of ARROW_MESH_KEYS) applyArrowCelOutline(groups[key]);
}

export function syncArrowTransparency(mesh, needsTransparency = false) {
  if (!mesh?.material) return;
  applyTransparency(mesh.material, {
    kind: 'arrows', opacity: 1, needsTransparency, perInstanceOpacity: true, mesh,
  });
}
