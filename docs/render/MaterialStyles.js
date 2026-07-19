// Shared material factory for the atom/bond instanced meshes, switching on
// general.renderStyle ('metallic' | 'matte' | 'cel'). Metallic and matte are
// MeshPhysicalMaterial parameter presets (see getAtom/BondVisSettings in
// defaults/color_texture_defaults.js); cel shading swaps the material class to
// MeshToonMaterial with a stepped gradient map. The custom onBeforeCompile
// shader patches applied by the callers target chunks (begin_vertex, the
// diffuseColor line, emissivemap_fragment) present in both material types.
//
// Cel-style black outlines come in two selectable flavours
// (general.celOutlineMode): 'screen' is a post-process (CelOutlinePass.js);
// 'hull' is the classic inverted-hull geometry implemented at the bottom of
// this file — a fatter black back-face copy per mesh. The hull look fades
// with distance (world-space width) but its shells are depth-tested in 3D
// and interpenetrate closely packed objects; screen space gives uniform
// pixel-width lines and clean shared contours.

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

/** Set which uAlphaPass an instanced atoms/bonds material draws (0 all /
 *  1 opaque-only / 2 transparent-only instances) — works before and after
 *  shader compile. The uniform is declared by the material factories in
 *  Atoms/BondsFracUpdateModule; pipelines drive it (render/pipeline/). */
export function setAlphaPass(material, pass) {
  material.userData.alphaPass = pass;
  const uniform = material.userData.shader?.uniforms?.uAlphaPass;
  if (uniform) uniform.value = pass;
}

// ---- 'hull' outline mode (inverted hull) -------------------------------------
//
// A second InstancedMesh per atoms/bonds mesh: same geometry, SHARED
// instanceMatrix attribute (so every position/scale update — trajectory
// frames, bond culling via zero-scaled matrices — carries over for free),
// drawn back-face-only in solid black with the vertices pushed out along the
// instance-transformed normal by a fixed world-space width. Two singleton
// materials are reused across rebuilds and never disposed: the "atoms"
// variant additionally replicates the main atom mesh's per-instance opacity
// and cut-plane discards (those attributes only exist on that geometry).

let atomsOutlineMaterial = null; // opacity + cut-plane discards (main atoms)
let bondsOutlineMaterial = null; // opacity discards only (main bonds)
let plainOutlineMaterial = null; // comparison atoms (no instanceOpacity attribute)

/** @param {{opacityDiscard?: boolean, cutPlanes?: boolean, onCompiled?: (material: any) => void}} [opts] */
function makeOutlineMaterial({ opacityDiscard = false, cutPlanes = false, onCompiled } = {}) {
  const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  // Three keys custom shader programs by onBeforeCompile.toString(); the
  // variants share that source text (the flags are closed-over, invisible to
  // toString), so without a distinct key a variant silently reuses another's
  // program — and a discard program discards everything on geometry that
  // lacks the instanceOpacity attribute (the comparison atoms).
  material.customProgramCacheKey = () => `cv-cel-outline-${opacityDiscard ? 'o' : ''}${cutPlanes ? 'c' : ''}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlineWidth = { value: general.celHullWidth };

    shader.vertexShader = `
      uniform float uOutlineWidth;
      ${opacityDiscard ? `
      attribute float instanceOpacity;
      varying float vInstanceOpacity;` : ''}
      ${cutPlanes ? `
      attribute float instanceCutPlaneImmune;
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
        ${opacityDiscard ? `
        vInstanceOpacity = instanceOpacity;` : ''}
        ${cutPlanes ? `
        vec4 outlineWorldCenter = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        vInstanceWorldCenter = outlineWorldCenter.xyz;
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

    if (opacityDiscard || cutPlanes) {
      shader.fragmentShader = `
        ${opacityDiscard ? 'varying float vInstanceOpacity;' : ''}
        ${cutPlanes ? `
        uniform int uCutPlaneCount;
        uniform vec4 uCutPlanes[${MAX_CUT_PLANES}];
        uniform float uCutPlaneMaskSide[${MAX_CUT_PLANES}];
        varying float vInstanceCutPlaneImmune;
        varying vec3 vInstanceWorldCenter;` : ''}
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
        vec4 diffuseColor = vec4( diffuse, opacity );
        ${opacityDiscard ? `
        // Transparent instances get no hull outline: the opaque inverted-hull
        // shell would otherwise black out everything behind them.
        if (vInstanceOpacity < 0.999) discard;` : ''}
        ${cutPlanes ? `
        if (vInstanceCutPlaneImmune < 0.5) {
          for (int i = 0; i < ${MAX_CUT_PLANES}; i++) {
            if (i >= uCutPlaneCount) break;
            vec4 cutPlane = uCutPlanes[i];
            float planeSide = (dot(vInstanceWorldCenter, cutPlane.xyz) - cutPlane.w) * uCutPlaneMaskSide[i];
            if (planeSide > 0.0) {
              discard;
            }
          }
        }` : ''}
        `
      );

      if (cutPlanes) {
        shader.uniforms.uCutPlaneCount = { value: 0 };
        shader.uniforms.uCutPlanes = {
          value: Array.from({ length: MAX_CUT_PLANES }, () => new THREE.Vector4(0, 0, 0, 0)),
        };
        shader.uniforms.uCutPlaneMaskSide = {
          value: new Float32Array(MAX_CUT_PLANES),
        };
      }
    }

    material.userData.shader = shader;
    if (onCompiled) onCompiled(material);
  };
  return material;
}

/**
 * Attach a black inverted-hull outline to an atoms/bonds InstancedMesh (call
 * only in cel style with celOutlineMode === 'hull'). The outline is a child
 * of the mesh (so visibility toggles and scene removal carry over) sharing
 * its geometry and instanceMatrix. `cutPlanes` selects the material variant
 * that honours per-instance opacity + cut planes; `onCompiled` runs once that
 * variant's shader exists (used to seed the cut-plane uniforms).
 * @param {any} mesh
 * @param {{cutPlanes?: boolean, opacityDiscard?: boolean, onCompiled?: (material: any) => void}} [opts]
 */
export function addCelOutline(mesh, { cutPlanes = false, opacityDiscard = false, onCompiled } = {}) {
  let material;
  if (cutPlanes) {
    if (!atomsOutlineMaterial) atomsOutlineMaterial = makeOutlineMaterial({ opacityDiscard: true, cutPlanes: true, onCompiled });
    material = atomsOutlineMaterial;
  } else if (opacityDiscard) {
    if (!bondsOutlineMaterial) bondsOutlineMaterial = makeOutlineMaterial({ opacityDiscard: true });
    material = bondsOutlineMaterial;
  } else {
    if (!plainOutlineMaterial) plainOutlineMaterial = makeOutlineMaterial({});
    material = plainOutlineMaterial;
  }
  const outline = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
  outline.instanceMatrix = mesh.instanceMatrix; // shared — follows all updates
  outline.raycast = () => {}; // never intercept picking
  outline.frustumCulled = mesh.frustumCulled;
  outline.visible = general.celHullWidth > 0 && outline.userData.opacitySuppressed !== true;
  outline.name = 'celOutline';
  mesh.userData.celOutline = outline;
  mesh.add(outline);
  return outline;
}

// Polyhedra hulls: the convex hulls are flat-shaded, so inflating along their
// normals would split them open at every edge. The displacement direction is
// instead baked per vertex as an `outlineDir` attribute pointing radially
// away from the polyhedron centre (duplicated flat-shaded vertices at the
// same position get the same direction — the hull stays watertight). The
// singleton material survives disposeGroup()'s dispose (three recompiles it
// on next use, re-seeding the width from `general`).

let polyOutlineMaterial = null;

function makePolyOutlineMaterial() {
  const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  material.customProgramCacheKey = () => 'cv-cel-outline-poly';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlineWidth = { value: general.celHullPolyWidth };
    shader.vertexShader = `
      uniform float uOutlineWidth;
      attribute vec3 outlineDir;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      vec4 outlinePos = vec4( transformed + outlineDir * uOutlineWidth, 1.0 );
      vec4 mvPosition = modelViewMatrix * outlinePos;
      gl_Position = projectionMatrix * mvPosition;
      `
    );
    material.userData.shader = shader;
  };
  return material;
}

/**
 * Attach a black hull outline to one polyhedron mesh (call only in cel style
 * with celOutlineMode === 'hull'). `center` is the polyhedron centre the
 * per-vertex displacement directions point away from.
 * @param {any} mesh
 * @param {any} center THREE.Vector3
 */
export function addCelPolyOutline(mesh, center) {
  if (!polyOutlineMaterial) polyOutlineMaterial = makePolyOutlineMaterial();
  const pos = mesh.geometry.attributes.position;
  const dirs = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i) - center.x, pos.getY(i) - center.y, pos.getZ(i) - center.z);
    const len = v.length();
    if (len > 0) v.multiplyScalar(1 / len);
    dirs[i * 3] = v.x;
    dirs[i * 3 + 1] = v.y;
    dirs[i * 3 + 2] = v.z;
  }
  mesh.geometry.setAttribute('outlineDir', new THREE.BufferAttribute(dirs, 3));

  const outline = new THREE.Mesh(mesh.geometry, polyOutlineMaterial);
  outline.raycast = () => {}; // never intercept picking
  // Transparent polyhedra get no hull outline (the opaque shell would black
  // out everything behind them); alpha edits re-sync via updatePolyhedraColors.
  outline.visible = general.celHullPolyWidth > 0 && (mesh.material?.opacity ?? 1) >= 0.999;
  outline.name = 'celOutline';
  mesh.add(outline);
  return outline;
}

/** Whole-mesh transparency (the opacity sliders) suppresses a mesh's cel hull
 *  outline child — transparent objects get no outlines (the opaque shell
 *  would black out everything behind them). Called from the atoms/bonds/
 *  comparison transparency syncs, which know the base opacity. */
export function syncCelHullOpacitySuppression(mesh, baseOpacity) {
  const outline = mesh?.userData?.celOutline;
  if (!outline) return;
  outline.userData.opacitySuppressed = baseOpacity < 0.999;
  outline.visible = general.celHullWidth > 0 && !outline.userData.opacitySuppressed;
}

/** Live-update the hull outline width (atoms/bonds); 0 hides those hulls. */
export function setCelHullWidth(width) {
  general.celHullWidth = width;
  for (const material of [atomsOutlineMaterial, bondsOutlineMaterial, plainOutlineMaterial]) {
    const shader = material?.userData?.shader;
    if (shader) shader.uniforms.uOutlineWidth.value = width;
  }
  const cellHullMeshes = [groups.atomsMesh, groups.bondsMesh];
  for (const entry of groups.overlayMeshes.values()) {
    cellHullMeshes.push(entry.atomsMesh, entry.bondsMesh);
  }
  for (const mesh of cellHullMeshes) {
    const outline = mesh?.userData?.celOutline;
    // opacitySuppressed: whole-mesh transparency (opacity sliders) drops the
    // hull — transparent objects get no outlines (see makeOutlineMaterial).
    if (outline) outline.visible = width > 0 && outline.userData.opacitySuppressed !== true;
  }
}

/** Live-update the polyhedra hull outline width; 0 hides those hulls. */
export function setCelHullPolyWidth(width) {
  general.celHullPolyWidth = width;
  const shader = polyOutlineMaterial?.userData?.shader;
  if (shader) shader.uniforms.uOutlineWidth.value = width;
  if (groups.polyhedraGroup) {
    groups.polyhedraGroup.traverse((obj) => {
      // Transparent polyhedra get no hull outline: the opaque inverted-hull
      // shell would black out everything behind them.
      if (obj.name === 'celOutline') {
        obj.visible = width > 0 && (obj.parent?.material?.opacity ?? 1) >= 0.999;
      }
    });
  }
}
