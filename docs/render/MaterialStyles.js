// Shared material factory for the atom/bond instanced meshes, switching on
// general.renderStyle ('metallic' | 'matte' | 'cel'). Metallic and matte are
// MeshPhysicalMaterial parameter presets (see getAtom/BondVisSettings in
// defaults/color_texture_defaults.js); cel shading swaps the material class to
// MeshToonMaterial with a stepped gradient map. The custom onBeforeCompile
// shader patches applied by the callers target chunks (begin_vertex, the
// diffuseColor line, emissivemap_fragment) present in both material types.

import * as THREE from '../external/three/three.module.js';
import { general } from '../state/store.js';

let toonGradientMap = null;

/** Shared stepped luminance ramp that gives MeshToonMaterial its banding. */
function getToonGradientMap() {
  if (!toonGradientMap) {
    const steps = new Uint8Array([55, 110, 200, 255]);
    toonGradientMap = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
    toonGradientMap.minFilter = THREE.NearestFilter;
    toonGradientMap.magFilter = THREE.NearestFilter;
    toonGradientMap.generateMipmaps = false;
    toonGradientMap.needsUpdate = true;
  }
  return toonGradientMap;
}

/**
 * Base material for an atoms/bonds instanced mesh in the current render style.
 * `settings` comes from getAtomVisSettings()/getBondVisSettings(), optionally
 * overridden (the meshes are built opaque and get transparency synced later).
 */
export function createStyledMaterial(settings = {}) {
  const common = {
    transparent: settings.transparent ?? false,
    opacity: settings.opacity ?? 1.0,
  };
  if (settings.color !== undefined) common.color = settings.color;
  if (general.renderStyle === 'cel') {
    return new THREE.MeshToonMaterial({
      ...common,
      gradientMap: getToonGradientMap(),
    });
  }
  return new THREE.MeshPhysicalMaterial({
    ...common,
    roughness: settings.roughness,
    metalness: settings.metalness,
    clearcoat: settings.clearcoat,
    clearcoatRoughness: settings.clearcoatRoughness,
  });
}
