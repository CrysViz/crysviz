// Shared material factory for the atom/bond instanced meshes, switching on
// general.renderStyle ('metallic' | 'matte' | 'cel'). Metallic and matte are
// MeshPhysicalMaterial parameter presets (see getAtom/BondVisSettings in
// defaults/color_texture_defaults.js); cel shading swaps the material class to
// MeshToonMaterial with a stepped gradient map. The custom onBeforeCompile
// shader patches applied by the callers target chunks (begin_vertex, the
// diffuseColor line, emissivemap_fragment) present in both material types.

import * as THREE from '../external/three/three.module.js';
import { general, groups } from '../state/store.js';

// Cut-plane uniform array size, shared with the mesh shaders that declare the
// same uniforms (see AtomsFracUpdateModule.js, which imports it from here).
export const MAX_CUT_PLANES = 8;

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

// ---- cel-shading outline (inverted hull) ------------------------------------
//
// The outline is a second InstancedMesh per atoms/bonds mesh: same geometry,
// SHARED instanceMatrix attribute (so every position/scale update — trajectory
// frames, bond culling via zero-scaled matrices — carries over for free), drawn
// back-face-only in solid black with the vertices pushed out along the
// instance-transformed normal by a fixed world-space width. Two singleton
// materials are reused across rebuilds and never disposed: the "atoms" variant
// additionally replicates the main atom mesh's per-instance opacity and
// cut-plane discards (those attributes only exist on that geometry).

let atomsOutlineMaterial = null; // with opacity/cut-plane discards
let plainOutlineMaterial = null; // comparison atoms + bonds

function makeOutlineMaterial(withDiscards, onCompiled) {
  const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlineWidth = { value: general.celOutlineWidth };

    shader.vertexShader = `
      uniform float uOutlineWidth;
      ${withDiscards ? `
      attribute float instanceOpacity;
      attribute float instanceCutPlaneImmune;
      varying float vInstanceOpacity;
      varying float vInstanceCutPlaneImmune;
      varying vec3 vInstanceWorldCenter;` : ''}
    ` + shader.vertexShader;

    // Inflate along the (instance-transformed) normal by a fixed world width.
    // Zero-length normals (zero-scaled instances used to cull bonds) skip the
    // displacement so the degenerate instance stays invisible.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      vec4 outlinePos = vec4( transformed, 1.0 );
      vec3 outlineNrm = normal;
      #ifdef USE_INSTANCING
        ${withDiscards ? `
        vec4 outlineWorldCenter = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        vInstanceWorldCenter = outlineWorldCenter.xyz;
        vInstanceOpacity = instanceOpacity;
        vInstanceCutPlaneImmune = instanceCutPlaneImmune;` : ''}
        outlinePos = instanceMatrix * outlinePos;
        outlineNrm = mat3( instanceMatrix ) * outlineNrm;
      #endif
      float outlineLen = length( outlineNrm );
      if ( outlineLen > 0.0 ) outlinePos.xyz += ( outlineNrm / outlineLen ) * uOutlineWidth;
      vec4 mvPosition = modelViewMatrix * outlinePos;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    if (withDiscards) {
      shader.fragmentShader = `
        uniform int uCutPlaneCount;
        uniform vec4 uCutPlanes[${MAX_CUT_PLANES}];
        uniform float uCutPlaneMaskSide[${MAX_CUT_PLANES}];
        varying float vInstanceOpacity;
        varying float vInstanceCutPlaneImmune;
        varying vec3 vInstanceWorldCenter;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
        vec4 diffuseColor = vec4( diffuse, opacity );
        if (vInstanceOpacity < 0.05) discard;
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

      shader.uniforms.uCutPlaneCount = { value: 0 };
      shader.uniforms.uCutPlanes = {
        value: Array.from({ length: MAX_CUT_PLANES }, () => new THREE.Vector4(0, 0, 0, 0)),
      };
      shader.uniforms.uCutPlaneMaskSide = {
        value: new Float32Array(MAX_CUT_PLANES),
      };
    }

    material.userData.shader = shader;
    if (onCompiled) onCompiled(material);
  };
  return material;
}

/**
 * Attach a black inverted-hull outline to an atoms/bonds InstancedMesh (call
 * only when general.renderStyle === 'cel'). The outline is a child of the mesh
 * (so visibility toggles and scene removal carry over) sharing its geometry
 * and instanceMatrix. `cutPlanes` selects the material variant that honours
 * per-instance opacity + cut planes; `onCompiled` runs once that variant's
 * shader exists (used to seed the cut-plane uniforms).
 * @param {any} mesh
 * @param {{cutPlanes?: boolean, onCompiled?: (material: any) => void}} [opts]
 */
export function addCelOutline(mesh, { cutPlanes = false, onCompiled } = {}) {
  let material;
  if (cutPlanes) {
    if (!atomsOutlineMaterial) atomsOutlineMaterial = makeOutlineMaterial(true, onCompiled);
    material = atomsOutlineMaterial;
  } else {
    if (!plainOutlineMaterial) plainOutlineMaterial = makeOutlineMaterial(false);
    material = plainOutlineMaterial;
  }
  const outline = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
  outline.instanceMatrix = mesh.instanceMatrix; // shared — follows all updates
  outline.raycast = () => {}; // never intercept picking
  outline.frustumCulled = mesh.frustumCulled;
  outline.visible = general.celOutlineWidth > 0;
  outline.name = 'celOutline';
  mesh.userData.celOutline = outline;
  mesh.add(outline);
  return outline;
}

/** The outline material carrying the cut-plane uniforms (null until built). */
export function getAtomsOutlineMaterial() {
  return atomsOutlineMaterial;
}

/** Live-update the outline width; 0 hides the outline meshes entirely. */
export function setCelOutlineWidth(width) {
  general.celOutlineWidth = width;
  for (const material of [atomsOutlineMaterial, plainOutlineMaterial]) {
    const shader = material?.userData?.shader;
    if (shader) shader.uniforms.uOutlineWidth.value = width;
  }
  for (const key of ['atomsMesh', 'secondAtomsMesh', 'bondsMesh', 'secondBondsMesh']) {
    const outline = groups[key]?.userData?.celOutline;
    if (outline) outline.visible = width > 0;
  }
}
