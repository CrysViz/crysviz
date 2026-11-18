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
import { app, general, groups } from '../state/store.js';

// Every arrow mesh in groups: forces, spins (and the compared structure's),
// phonon modes. Their cel outlines follow general.celOutlineArrows
// (ArrowMaterial.js applyArrowCelOutline); listed here so the hull width
// slider reaches their hulls too.
export const ARROW_MESH_KEYS = [
  'forcesShaftMesh', 'forcesTipMesh',
  'spinShaftMesh', 'spinTipMesh', 'spin2ShaftMesh', 'spin2TipMesh',
  'phononShaftMesh', 'phononTipMesh',
];

// Cut-plane uniform array size, shared with the mesh shaders that declare the
// same uniforms (see AtomsFracUpdateModule.js, which imports it from here).
export const MAX_CUT_PLANES = 8;

/**
 * Resolve the configured cel-outline color to a '#rrggbb' string. 'auto' picks
 * black or white for maximum contrast against the current scene background
 * (same luminance test the lattice/border uses); the fixed modes return their
 * color and 'custom' the user-picked hex. Shared by the hull materials here and
 * the screen-space pass (CelOutlinePass.js), so both modes stay in sync.
 */
export function resolveCelOutlineColor() {
  switch (general.celOutlineColorMode) {
    case 'black': return '#000000';
    case 'white': return '#ffffff';
    case 'custom': return general.celOutlineColor || '#000000';
    default: { // 'auto' — highest contrast against the scene background
      const bg = app?.scene?.background;
      const hex = bg ? '#' + bg.getHexString() : '#000000';
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum > 0.5 ? '#000000' : '#ffffff';
    }
  }
}

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

// A hull is the mesh's back faces pushed out by the width, so the black ring
// around a sphere is not flat: it bulges behind the silhouette, from the
// silhouette's depth at its outer rim to deeper at its inner rim. Anything
// in between — an arrow emerging from the atom tilted away from the viewer,
// a cone's base seen edge-on, a bond leaving the atom away from the viewer,
// an overlapping atom — had the outer rim drawn across it as a thin black
// arc away from the contour. Every hull fragment therefore writes the depth
// of the mesh's silhouette there (the instance centre for a sphere, the axis
// at the vertex's height for a bond cylinder), making the ring flat: whatever
// is in front of the silhouette hides the whole ring, whatever is behind it
// gets the whole ring drawn over it, like a contour.
//
// The arrows' depth of the frame being drawn (CelOutlinePass.js
// prepareCelOutlinePass renders it, and the scene's, before the main
// render), shared by every hull material: a hull shell skips every pixel
// where a visible arrow is nearer than the mesh's silhouette there (plus a
// small slack: an arrow emerging from its atom, however it is tilted). The
// arrows are not part of the atoms' and bonds' outlines — in front of the
// silhouette they pop out of the ring, behind it the ring crosses them like
// a contour — and get no outline of their own in this mode.
const hullArrowDepth = {
  tArrowDepth: { value: null },
  tSceneDepth: { value: null }, // the outlined objects, arrows included: an arrow counts only where it is visible
  uArrowTexel: { value: new THREE.Vector2(1, 1) },
  uArrowNear: { value: 0.1 },
  uArrowFar: { value: 1000 },
  uArrowOrtho: { value: 1 },
  uArrowSlack: { value: 0 }, // world units behind the silhouette that still count
  uArrowDepthOn: { value: 0 },
};

/**
 * Give the hull materials this frame's arrow depth (null: none, no pixels
 * are skipped). Called by CelOutlinePass.js before every main render.
 * @param {{texture: any, sceneTexture: any, texelSize: number[], near: number, far: number, ortho: boolean, slack: number} | null} depth
 */
export function setCelHullArrowDepth(depth) {
  if (!depth) {
    hullArrowDepth.uArrowDepthOn.value = 0;
    hullArrowDepth.tArrowDepth.value = null;
    hullArrowDepth.tSceneDepth.value = null;
    return;
  }
  hullArrowDepth.tArrowDepth.value = depth.texture;
  hullArrowDepth.tSceneDepth.value = depth.sceneTexture;
  hullArrowDepth.uArrowTexel.value.set(depth.texelSize[0], depth.texelSize[1]);
  hullArrowDepth.uArrowNear.value = depth.near;
  hullArrowDepth.uArrowFar.value = depth.far;
  hullArrowDepth.uArrowOrtho.value = depth.ortho ? 1 : 0;
  hullArrowDepth.uArrowSlack.value = depth.slack;
  hullArrowDepth.uArrowDepthOn.value = 1;
}

/**
 * @param {{opacityDiscard?: boolean, cutPlanes?: boolean, axis?: 'point'|'y', onCompiled?: (material: any) => void}} [opts]
 *   axis: where the mesh's silhouette depth is taken (the flat ring) — the
 *   instance centre ('point', spheres) or the instance's local y axis at the
 *   vertex's height ('y', the bond cylinders).
 */
function makeOutlineMaterial({ opacityDiscard = false, cutPlanes = false, axis = 'point', onCompiled } = {}) {
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(resolveCelOutlineColor()), side: THREE.BackSide });
  // Three keys custom shader programs by onBeforeCompile.toString(); the
  // variants share that source text (the flags are closed-over, invisible to
  // toString), so without a distinct key a variant silently reuses another's
  // program — and a discard program discards everything on geometry that
  // lacks the instanceOpacity attribute (the comparison atoms).
  material.customProgramCacheKey = () => `cv-cel-outline-${opacityDiscard ? 'o' : ''}${cutPlanes ? 'c' : ''}${axis === 'y' ? 'y' : ''}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlineWidth = { value: Math.max(general.celHullWidth, hullPixelFloor) };
    Object.assign(shader.uniforms, hullArrowDepth);

    shader.vertexShader = `
      uniform float uOutlineWidth;
      varying vec4 vCelAxisClip;
      varying float vCelAxisDist;
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
      // The mesh's axis point for this vertex (unit sphere: the centre; unit
      // cylinder: on its y axis): the silhouette's depth (see hullArrowDepth).
      vec4 outlineAxis = vec4( 0.0, ${axis === 'y' ? 'transformed.y' : '0.0'}, 0.0, 1.0 );
      #ifdef USE_INSTANCING
        ${opacityDiscard ? `
        vInstanceOpacity = instanceOpacity;` : ''}
        ${cutPlanes ? `
        vec4 outlineWorldCenter = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        vInstanceWorldCenter = outlineWorldCenter.xyz;
        vInstanceCutPlaneImmune = instanceCutPlaneImmune;` : ''}
        outlinePos = instanceMatrix * outlinePos;
        outlineNrm = mat3( instanceMatrix ) * outlineNrm;
        outlineAxis = instanceMatrix * outlineAxis;
      #endif
      float outlineLen = length( outlineNrm );
      if ( outlineLen > 0.0 ) outlinePos.xyz += ( outlineNrm / outlineLen ) * uOutlineWidth;
      vec4 mvPosition = modelViewMatrix * outlinePos;
      vec4 outlineAxisView = modelViewMatrix * outlineAxis;
      vCelAxisClip = projectionMatrix * outlineAxisView;
      vCelAxisDist = -outlineAxisView.z;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    shader.fragmentShader = `
      uniform sampler2D tArrowDepth;
      uniform sampler2D tSceneDepth;
      uniform vec2 uArrowTexel;
      uniform float uArrowNear;
      uniform float uArrowFar;
      uniform float uArrowOrtho;
      uniform float uArrowSlack;
      uniform float uArrowDepthOn;
      varying vec4 vCelAxisClip;
      varying float vCelAxisDist;
      // Depth-buffer value -> view distance (CelOutlinePass.js toViewDist).
      float cvViewDist( float d ) {
        if ( uArrowOrtho > 0.5 ) return mix( uArrowNear, uArrowFar, d );
        return -( uArrowNear * uArrowFar ) / ( ( uArrowFar - uArrowNear ) * d - uArrowFar );
      }
      // The distance of the arrow visible at a pixel (far if none).
      float cvArrowDist( vec2 px ) {
        vec2 uv = px * uArrowTexel;
        float a = cvViewDist( texture2D( tArrowDepth, uv ).x );
        float s = cvViewDist( texture2D( tSceneDepth, uv ).x );
        return a <= s * ( 1.0 + 1e-4 ) ? a : uArrowFar;
      }
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
      // The flat ring: every fragment at the silhouette's depth (see hullArrowDepth).
      gl_FragDepth = clamp( 0.5 * vCelAxisClip.z / vCelAxisClip.w + 0.5, 0.0, 1.0 );
      // No ring over an arrow in front of the silhouette (see hullArrowDepth).
      if ( uArrowDepthOn > 0.5 && cvArrowDist( gl_FragCoord.xy ) < vCelAxisDist + uArrowSlack ) discard;
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
 * (Arrows get no hull: the screen-space pass outlines them in both modes,
 * see ArrowMaterial.js applyArrowCelOutline.)
 * @param {any} mesh
 * @param {{cutPlanes?: boolean, opacityDiscard?: boolean, onCompiled?: (material: any) => void}} [opts]
 */
export function addCelOutline(mesh, { cutPlanes = false, opacityDiscard = false, onCompiled } = {}) {
  let material;
  if (cutPlanes) {
    if (!atomsOutlineMaterial) atomsOutlineMaterial = makeOutlineMaterial({ opacityDiscard: true, cutPlanes: true, onCompiled });
    material = atomsOutlineMaterial;
  } else if (opacityDiscard) {
    // The bonds: cylinders along their local y axis.
    if (!bondsOutlineMaterial) bondsOutlineMaterial = makeOutlineMaterial({ opacityDiscard: true, axis: 'y' });
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
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(resolveCelOutlineColor()), side: THREE.BackSide });
  material.customProgramCacheKey = () => 'cv-cel-outline-poly';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlineWidth = { value: Math.max(general.celHullPolyWidth, hullPixelFloor) };
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

// Hull shells narrower than this on screen (world units, set per frame from
// the zoom level by CelOutlinePass.js) are drawn this wide instead.
let hullPixelFloor = 0;

function applyHullWidths() {
  const w = general.celHullWidth > 0 ? Math.max(general.celHullWidth, hullPixelFloor) : 0;
  for (const material of [atomsOutlineMaterial, bondsOutlineMaterial, plainOutlineMaterial]) {
    const shader = material?.userData?.shader;
    if (shader) shader.uniforms.uOutlineWidth.value = w;
  }
  const poly = polyOutlineMaterial?.userData?.shader;
  if (poly) poly.uniforms.uOutlineWidth.value = general.celHullPolyWidth > 0 ? Math.max(general.celHullPolyWidth, hullPixelFloor) : 0;
}

/** The hull shells' minimum width on screen, in world units for the current
 *  zoom (CelOutlinePass.js, every frame in 3D-hull mode). */
export function syncCelHullPixelFloor(worldUnits) {
  if (worldUnits === hullPixelFloor) return;
  hullPixelFloor = worldUnits;
  applyHullWidths();
}

/** Live-update the hull outline width (atoms/bonds); 0 hides those hulls. */
export function setCelHullWidth(width) {
  general.celHullWidth = width;
  applyHullWidths();
  // Imposter mode draws the hull on the near-sphere child of the atoms mesh.
  const cellHullMeshes = [groups.atomsMesh, groups.atomsMesh?.userData?.nearSpheres, groups.bondsMesh];
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
  applyHullWidths();
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

/** Live-update the cel hull outline color for all hull materials (atoms,
 *  bonds, comparison atoms, polyhedra) from the current color mode. The
 *  screen-space pass reads the color live each frame, so it needs no
 *  equivalent. Call after changing celOutlineColorMode/celOutlineColor, and
 *  (for 'auto') whenever the scene background changes. */
export function setCelOutlineColor() {
  const hex = resolveCelOutlineColor();
  for (const material of [atomsOutlineMaterial, bondsOutlineMaterial, plainOutlineMaterial, polyOutlineMaterial]) {
    if (material) material.color.set(hex);
  }
}

// ---- persistent (rebuild-surviving) materials -------------------------------
//
// The atoms / bonds / lattice meshes are rebuilt on every trajectory frame, and
// each rebuild used to create a fresh material and dispose the old one. That
// costs a full shader compile + link per material per frame: Material.dispose()
// releases the program from three.js's cache, and the depth-peel/WBOIT patches
// stamp every NEW material with a unique customProgramCacheKey, so the next
// identical material can never hit the cache. Measured: three programs
// recompiled on every frame step — the dominant per-frame cost.
//
// Materials that survive rebuilds are held here, keyed by role, and reused
// while their construction settings (the `signature`) are unchanged. They carry
// userData.persistent = true so the mesh teardown paths skip Material.dispose()
// for them; a changed signature (render style, matte/glossy, lattice colour)
// disposes the old one and builds anew. Per-build state that lives on a
// material (the wedge texture, cut-plane uniforms, alpha pass) is written in
// place by the builders, which already do so for the compiled-shader case.

/** @type {Map<string, {signature: string, material: any}>} */
const persistentMaterials = new Map();

/**
 * The persistent material for `key`, rebuilt by `factory` only when
 * `signature` differs from the one it was built with.
 * @param {string} key
 * @param {string} signature
 * @param {() => any} factory
 */
export function acquirePersistentMaterial(key, signature, factory) {
  const entry = persistentMaterials.get(key);
  if (entry && entry.signature === signature) return entry.material;
  if (entry) {
    entry.material.userData?.wedge?.texture?.dispose?.();
    entry.material.dispose();
  }
  const material = factory();
  material.userData.persistent = true;
  persistentMaterials.set(key, { signature, material });
  return material;
}

/** Whether a teardown path must leave this material alone. */
export function isPersistentMaterial(material) {
  return !!material?.userData?.persistent;
}

/**
 * Pack an ASCII id into 16 bytes for the per-instance `instanceUUID`
 * attribute (zero-padded, truncated). Same bytes a TextEncoder produces for
 * ASCII input; the ids here are element symbols plus base-36 digits. Falls
 * back to TextEncoder for anything non-ASCII so the encoding never differs.
 * @param {string} id
 * @param {Uint8Array} out16
 */
export function packInstanceId(id, out16) {
  out16.fill(0);
  const n = Math.min(16, id.length);
  for (let i = 0; i < n; i++) {
    const c = id.charCodeAt(i);
    if (c > 0x7f) {
      out16.fill(0);
      out16.set(new TextEncoder().encode(id).subarray(0, 16));
      return;
    }
    out16[i] = c;
  }
}
