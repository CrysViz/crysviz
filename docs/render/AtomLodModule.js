/**
 * View-dependent level of detail for the main atoms mesh.
 *
 * A large structure (tens of thousands of atoms and up) cannot be drawn as
 * ~1.5k-triangle instanced spheres at interactive rates. In "imposter" mode
 * the main atoms mesh (`groups.atomsMesh`) keeps every instance buffer it
 * has today — matrices, colours, UUIDs, opacity, cut-plane immunity, emissive
 * — but its geometry is a 2-triangle quad and its material ray-casts a sphere
 * per fragment (render/AtomsFracUpdateModule.js createAtomsMaterial with
 * `imposter: true`). Every consumer that writes into those buffers (playback,
 * highlights, colour edits, cut planes) keeps working untouched, picking goes
 * through an analytic sphere raycast installed on the mesh, and the drawn
 * sphere is pixel-exact at every zoom.
 *
 * The view-dependent part: instances that are LARGE on screen (projected
 * radius ≥ general.atomDetailNearPx, inside the frustum) are handed to a small
 * "near" InstancedMesh of real tessellated spheres — the look the rest of the
 * app is tuned for (cel hull outlines, wedge sites) where the user is looking
 * closely — and the imposter shader collapses those same instances so nothing
 * is drawn twice. The near set is a compacted COPY of the main buffers
 * (O(near) per refresh, near ≤ general.atomDetailNearMax), recomputed when the
 * camera or the positions change, throttled while the camera is in motion.
 * The shader makes the same near/far decision from a single uniform, so the
 * imposter side needs no per-instance attribute and no CPU pass at all.
 *
 * Zoomed out to the whole cell every instance is an imposter (four vertices
 * each); zoomed in, only what is in view and large pays for real geometry.
 * The frustum test therefore only ever runs on the few instances that are big
 * enough to matter — the O(N) scan is one multiply-compare per instance.
 */

import * as THREE from '../external/three/three.module.js';
import { app, groups, general } from '../state/store.js';

/** Selectable values of general.atomDetail. */
export const ATOM_DETAIL_MODES = ['auto', 'spheres', 'imposters'];

/** Minimum wall time between two near-set recomputes while the view changes. */
const LOD_RECOMPUTE_MS = 100;
/** Hysteresis: the CPU includes an instance in the near set slightly below
 *  the threshold the shader collapses at, so a borderline atom is drawn by
 *  both (identical surfaces, harmless) rather than by neither for a frame. */
const NEAR_HYSTERESIS = 0.98;

/** Instanced attributes copied from the main mesh's geometry into the near
 *  mesh, with their item sizes (instanceMatrix / instanceColor are on the
 *  mesh itself and copied separately). */
/** @type {Array<[string, number]>} */
const COPIED_ATTRIBUTES = [
  ['instanceUUID', 4],
  ['instanceElementIndex', 1],
  ['instanceEmissive', 3],
  ['instanceEmissiveIntensity', 1],
  ['instanceOpacity', 1],
  ['instanceCutPlaneImmune', 1],
];

/**
 * Should a main atoms mesh of `instanceCount` instances be built as imposters?
 * @param {number} instanceCount
 */
export function imposterModeFor(instanceCount) {
  const mode = general.atomDetail ?? 'auto';
  if (mode === 'imposters') return true;
  if (mode === 'spheres') return false;
  return instanceCount >= (general.atomDetailImposterMin ?? 20000);
}

/** The billboard: a unit quad in [-1,1]², oriented per instance in the vertex shader. */
export function createImposterGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // The silhouette quad grows past the unit radius under perspective (see the
  // vertex shader); a generous bound keeps three's frustum culling correct.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2));
  return geometry;
}

// ---- shader pieces (spliced in by createAtomsMaterial) ---------------------

export const IMPOSTER_VERTEX_DECL = `
  uniform float uLodNear;
  varying vec3 vImpCenter;
  varying vec3 vImpFrag;
  varying vec4 vImpParams;
`;

/**
 * Replaces three's <project_vertex>. Builds a quad perpendicular to the view
 * direction through the instance centre, large enough to cover the sphere's
 * silhouette (radius r·d/√(d²−r²) under perspective, r under orthographic
 * projection), and collapses instances the near-sphere mesh draws instead.
 * Radius comes from the instance matrix's uniform scale, so the zero-scaled
 * hidden-element convention collapses those too.
 */
export const IMPOSTER_PROJECT_VERTEX = `
  mat4 impMV = modelViewMatrix * instanceMatrix;
  vec3 impCenter = (impMV * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float impRadius = length(impMV[0].xyz);
  bool impOrtho = projectionMatrix[3][3] == 1.0;
  float impDist = length(impCenter);
  vec3 impView = impOrtho ? vec3(0.0, 0.0, -1.0) : impCenter / max(impDist, 1e-6);
  vec3 impRef = abs(impView.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 impRight = normalize(cross(impView, impRef));
  vec3 impUp = cross(impRight, impView);
  float impHalf = impOrtho ? impRadius
    : impRadius * impDist * inversesqrt(max(impDist * impDist - impRadius * impRadius, 1e-6));
  vec3 impFrag = impCenter + (impRight * position.x + impUp * position.y) * impHalf;
  vec4 mvPosition = vec4(impFrag, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float impMeasure = impOrtho ? impRadius : impRadius / max(-impCenter.z, 1e-6);
  if (impRadius <= 0.0 || (uLodNear > 0.0 && impMeasure >= uLodNear)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  vImpCenter = impCenter;
  vImpFrag = impFrag;
  vImpParams = vec4(impRadius, projectionMatrix[2][2], projectionMatrix[3][2], impOrtho ? 1.0 : 0.0);
`;

/** Globals replace the varyings three's lighting chunks read: the fragment
 *  body below assigns the ray-cast sphere's normal and view position. */
export const IMPOSTER_FRAGMENT_DECL = `
  varying vec3 vImpCenter;
  varying vec3 vImpFrag;
  varying vec4 vImpParams;
  vec3 vViewPosition;
  vec3 vNormal;
`;

/** First statements of main(): intersect the eye ray with the sphere, discard
 *  misses, and write the sphere's own depth so imposters occlude and are
 *  occluded exactly like geometry. */
export const IMPOSTER_FRAGMENT_BODY = `
  bool impOrtho = vImpParams.w > 0.5;
  vec3 impRo = impOrtho ? vec3(vImpFrag.xy, 0.0) : vec3(0.0);
  vec3 impRd = impOrtho ? vec3(0.0, 0.0, -1.0) : normalize(vImpFrag);
  vec3 impOc = impRo - vImpCenter;
  float impB = dot(impOc, impRd);
  float impC = dot(impOc, impOc) - vImpParams.x * vImpParams.x;
  float impDisc = impB * impB - impC;
  if (impDisc < 0.0) discard;
  vec3 impHit = impRo + impRd * (-impB - sqrt(impDisc));
  vNormal = normalize(impHit - vImpCenter);
  vViewPosition = -impHit;
  float impClipW = impOrtho ? 1.0 : -impHit.z;
  gl_FragDepth = ((vImpParams.y * impHit.z + vImpParams.z) / impClipW) * 0.5 + 0.5;
`;

/**
 * Turn a compiled-material shader pair into the imposter variant. Called from
 * createAtomsMaterial's onBeforeCompile after its own instanced-attribute
 * injections, so everything those add (UUID picking, per-instance opacity,
 * emissive highlights, cut-plane discards) is kept.
 * @param {{vertexShader: string, fragmentShader: string, uniforms: any}} shader
 * @param {any} material
 */
export function patchImposterShader(shader, material) {
  shader.vertexShader = IMPOSTER_VERTEX_DECL + shader.vertexShader.replace(
    '#include <project_vertex>', IMPOSTER_PROJECT_VERTEX);
  let fs = shader.fragmentShader;
  // The physical material declares vViewPosition at top level; the toon
  // material inside its lighting chunk. Both become plain globals.
  fs = fs.replace('varying vec3 vViewPosition;', '');
  fs = fs.replace('#include <lights_toon_pars_fragment>',
    THREE.ShaderChunk.lights_toon_pars_fragment.replace('varying vec3 vViewPosition;', ''));
  fs = fs.replace('#include <normal_pars_fragment>', '');
  fs = fs.replace('void main() {', 'void main() {\n' + IMPOSTER_FRAGMENT_BODY);
  shader.fragmentShader = IMPOSTER_FRAGMENT_DECL + fs;
  shader.uniforms.uLodNear = { value: material.userData.lodNear ?? 0 };
}

// ---- picking ---------------------------------------------------------------

const _inverse = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _point = new THREE.Vector3();

/**
 * Analytic sphere raycast for an imposter atoms mesh, installed as
 * `mesh.raycast`. three's InstancedMesh.raycast would intersect the quad
 * geometry in object space (unoriented — the billboard turn happens in the
 * shader); this intersects the spheres the shader actually draws. Same
 * result shape as the default: {distance, point, object, instanceId}.
 * @this {THREE.InstancedMesh}
 * @param {THREE.Raycaster} raycaster
 * @param {Array<any>} intersects
 */
export function imposterRaycast(raycaster, intersects) {
  const mesh = this;
  const arr = mesh.instanceMatrix.array;
  _inverse.copy(mesh.matrixWorld).invert();
  _ray.copy(raycaster.ray).applyMatrix4(_inverse);
  const ox = _ray.origin.x, oy = _ray.origin.y, oz = _ray.origin.z;
  const dx = _ray.direction.x, dy = _ray.direction.y, dz = _ray.direction.z;
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16;
    const r = arr[o];
    if (!(r > 0)) continue; // hidden element: zero-scaled, never picked
    const cx = ox - arr[o + 12], cy = oy - arr[o + 13], cz = oz - arr[o + 14];
    const b = cx * dx + cy * dy + cz * dz;
    const c = cx * cx + cy * cy + cz * cz - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const s = Math.sqrt(disc);
    let t = -b - s;
    if (t < 0) t = -b + s; // ray starts inside the sphere
    if (t < 0) continue;
    _point.set(ox + dx * t, oy + dy * t, oz + dz * t).applyMatrix4(mesh.matrixWorld);
    const distance = raycaster.ray.origin.distanceTo(_point);
    if (distance < raycaster.near || distance > raycaster.far) continue;
    intersects.push({ distance, point: _point.clone(), object: mesh, instanceId: i, face: null });
  }
}

// ---- near spheres -----------------------------------------------------------

/**
 * Create the near-sphere mesh as a child of an imposter main mesh (children
 * follow visibility toggles and scene removal). Its instance buffers are
 * sized to the near cap and filled by syncAtomLod.
 * @param {THREE.InstancedMesh} mesh the imposter main atoms mesh
 * @param {any} material the regular (tessellated-sphere) atoms material
 * @param {THREE.BufferGeometry} geometry a unit sphere geometry
 * @returns {THREE.InstancedMesh}
 */
export function installNearSpheres(mesh, material, geometry) {
  const cap = Math.max(0, Math.min(mesh.count, Number(general.atomDetailNearMax ?? 4096))) | 0;
  const near = new THREE.InstancedMesh(geometry, material, cap);
  near.count = 0;
  near.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3, false);
  near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  near.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (const [name, size] of COPIED_ATTRIBUTES) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }
  near.frustumCulled = false; // the set is already view-selected
  near.raycast = () => {}; // the main mesh's analytic raycast covers every atom
  near.name = 'nearSpheres';
  near.layers.mask = mesh.layers.mask;
  near.userData.slotOf = new Int32Array(cap);
  near.userData.capacity = cap;
  mesh.userData.nearSpheres = near;
  mesh.add(near);
  lastKey = null; // force a recompute for the new mesh
  return near;
}

/**
 * Drop a main mesh's near-sphere child and its GPU buffers. The material is
 * persistent (MaterialStyles) and is left alone.
 * @param {THREE.InstancedMesh | null} mesh
 */
export function disposeNearSpheres(mesh) {
  const near = mesh?.userData?.nearSpheres;
  if (!near) return;
  near.parent?.remove(near);
  const outline = near.userData.celOutline;
  if (outline) {
    near.remove(outline);
    outline.dispose?.();
  }
  near.geometry.dispose();
  near.dispose();
  mesh.userData.nearSpheres = null;
}

// ---- per-render sync --------------------------------------------------------

/** @type {Float64Array | null} camera + viewport fingerprint of the last near-set computation */
let lastKey = null;
let lastComputeAt = -Infinity;
let lastMatrixVersion = -1;
let lastCopiedVersions = null;
let lastNearCount = 0;
let lastLodNear = 0;
const stats = {
  mode: 'spheres', instances: 0, near: 0, nearCap: 0, overflow: false, computeMs: 0, copyMs: 0, computes: 0,
};

/** Live figures for the Debug window and tests. */
export function atomLodStats() {
  return { ...stats };
}

const _viewProj = new THREE.Matrix4();
const _modelView = new THREE.Matrix4();

/**
 * Fingerprint of everything the near set depends on besides the positions:
 * camera pose and projection, viewport height, threshold. Compared per render
 * with a tight loop — no allocation unless it changed.
 */
function viewKeyChanged(camera, heightPx, mesh) {
  const cw = camera.matrixWorld.elements, pr = camera.projectionMatrix.elements;
  const key = lastKey ?? new Float64Array(36);
  let changed = lastKey === null;
  for (let i = 0; i < 16; i++) {
    if (key[i] !== cw[i]) { changed = true; key[i] = cw[i]; }
    if (key[16 + i] !== pr[i]) { changed = true; key[16 + i] = pr[i]; }
  }
  const extras = [heightPx, general.atomDetailNearPx ?? 28, mesh.count, mesh.id];
  for (let i = 0; i < extras.length; i++) {
    if (key[32 + i] !== extras[i]) { changed = true; key[32 + i] = extras[i]; }
  }
  lastKey = key;
  return changed;
}

/** Push the shader-side threshold to the main material and its overlay pass. */
function setLodNear(mesh, value) {
  const materials = [mesh.material, mesh.userData.transparentOverlay?.material];
  for (const material of materials) {
    if (!material) continue;
    material.userData.lodNear = value;
    const uniform = material.userData.shader?.uniforms?.uLodNear;
    if (uniform) uniform.value = value;
  }
}

/**
 * Decide which instances are near: projected radius at or above the pixel
 * threshold and inside the (radius-padded) frustum. Writes near.userData.slotOf
 * and returns the count, or -1 when more than the cap qualify (then every
 * instance stays an imposter — still pixel-exact, just without hull outlines).
 */
function computeNearSet(mesh, near, camera, heightPx) {
  const arr = mesh.instanceMatrix.array;
  const n = mesh.count;
  const slotOf = near.userData.slotOf;
  const cap = near.userData.capacity;
  const P = camera.projectionMatrix.elements;
  const ortho = P[15] === 1;
  const p00 = P[0], p11 = P[5];
  const nearPx = general.atomDetailNearPx ?? 28;
  const threshold = nearPx / (p11 * heightPx * 0.5);
  const cutoff = threshold * NEAR_HYSTERESIS;
  _modelView.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  _viewProj.multiplyMatrices(camera.projectionMatrix, _modelView);
  const mv = _modelView.elements, vp = _viewProj.elements;
  // Uniform model scale (the scene never scales the atoms mesh, but be exact).
  const modelScale = Math.hypot(mesh.matrixWorld.elements[0], mesh.matrixWorld.elements[1], mesh.matrixWorld.elements[2]);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const r = arr[o] * modelScale;
    if (!(r > 0)) continue;
    const x = arr[o + 12], y = arr[o + 13], z = arr[o + 14];
    let measure = r;
    if (!ortho) {
      const vz = mv[2] * x + mv[6] * y + mv[10] * z + mv[14];
      if (vz >= 0) continue; // behind the camera
      measure = r / -vz;
    }
    if (measure < cutoff) continue; // the common exit: small on screen
    // Large enough — now the frustum test, padded by the projected radius.
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0) continue;
    const cx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw;
    const cy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
    if (Math.abs(cx) > 1 + measure * p00 || Math.abs(cy) > 1 + measure * p11) continue;
    if (count >= cap) return -1;
    slotOf[count++] = i;
  }
  return count;
}

/** Copy the near instances' buffers out of the main mesh (compaction). */
function copyNearInstances(mesh, near, count) {
  const slotOf = near.userData.slotOf;
  const srcM = mesh.instanceMatrix.array, dstM = near.instanceMatrix.array;
  const srcC = mesh.instanceColor?.array, dstC = near.instanceColor.array;
  for (let j = 0; j < count; j++) {
    const i = slotOf[j];
    dstM.set(srcM.subarray(i * 16, i * 16 + 16), j * 16);
    if (srcC) { dstC[j * 3] = srcC[i * 3]; dstC[j * 3 + 1] = srcC[i * 3 + 1]; dstC[j * 3 + 2] = srcC[i * 3 + 2]; }
  }
  near.instanceMatrix.needsUpdate = true;
  near.instanceColor.needsUpdate = true;
  for (const [name, size] of COPIED_ATTRIBUTES) {
    const src = mesh.geometry.attributes[name];
    const dst = near.geometry.attributes[name];
    if (!src || !dst) continue;
    const s = src.array, d = dst.array;
    for (let j = 0; j < count; j++) {
      const i = slotOf[j];
      for (let k = 0; k < size; k++) d[j * size + k] = s[i * size + k];
    }
    dst.needsUpdate = true;
  }
  near.count = count;
  const outline = near.userData.celOutline;
  if (outline) outline.count = count;
}

/** Version stamps of every main-mesh buffer the near copy mirrors. */
function bufferVersions(mesh) {
  const v = [mesh.instanceMatrix.version, mesh.instanceColor?.version ?? 0];
  for (const [name] of COPIED_ATTRIBUTES) v.push(mesh.geometry.attributes[name]?.version ?? 0);
  return v;
}

function versionsChanged(a, b) {
  if (!a || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

/** Mirror the main material's blend state onto the near material. */
function syncNearMaterial(mesh, near) {
  const main = mesh.material, mat = near.material;
  const transparent = !!main.transparent || !!mesh.userData.transparentOverlay?.visible;
  const depthWrite = !transparent;
  if (mat.opacity !== main.opacity || mat.transparent !== transparent || mat.depthWrite !== depthWrite) {
    mat.opacity = main.opacity;
    mat.transparent = transparent;
    mat.depthWrite = depthWrite;
    mat.needsUpdate = true;
  }
  const outline = near.userData.celOutline;
  if (outline) {
    outline.userData.opacitySuppressed = main.opacity < 0.999;
    outline.visible = Number(general.celHullWidth ?? 0) > 0 && !outline.userData.opacitySuppressed;
  }
}

/**
 * Keep the imposter/near split current. Call once per rendered frame, before
 * the pipeline draws. Returns true when a recompute was deferred by the
 * throttle and another render should be requested so it lands soon.
 * @param {THREE.Camera} camera
 * @returns {boolean}
 */
export function syncAtomLod(camera) {
  const mesh = groups.atomsMesh;
  const near = mesh?.userData?.nearSpheres;
  if (!mesh || !mesh.userData.imposter || !near) {
    stats.mode = mesh ? 'spheres' : 'none';
    stats.instances = mesh?.count ?? 0;
    stats.near = 0;
    return false;
  }
  stats.mode = 'imposters';
  stats.instances = mesh.count;
  stats.nearCap = near.userData.capacity;
  const heightPx = app.renderer?.domElement?.clientHeight || 1;
  const matrixVersion = mesh.instanceMatrix.version;
  const viewChanged = viewKeyChanged(camera, heightPx, mesh);
  const positionsChanged = matrixVersion !== lastMatrixVersion;
  let recomputed = false;
  if (viewChanged || positionsChanged || lastCopiedVersions === null) {
    const now = performance.now();
    if (now - lastComputeAt < LOD_RECOMPUTE_MS && lastCopiedVersions !== null) {
      // Throttled: keep the previous set one more frame, ask for a follow-up.
      lastKey = null; // so the next frame sees the change again
      return true;
    }
    const t0 = performance.now();
    const count = computeNearSet(mesh, near, camera, heightPx);
    stats.computeMs = performance.now() - t0;
    stats.computes++;
    stats.overflow = count < 0;
    lastNearCount = Math.max(0, count);
    lastComputeAt = now;
    lastMatrixVersion = matrixVersion;
    recomputed = true;
    lastLodNear = count < 0 ? 0 : Number(general.atomDetailNearPx ?? 28) / (camera.projectionMatrix.elements[5] * heightPx * 0.5);
  }
  // Every frame, not only on recompute: a pipeline may attach its
  // transparent-instance overlay (a fresh material) between recomputes.
  setLodNear(mesh, lastLodNear);
  const versions = bufferVersions(mesh);
  if (recomputed || versionsChanged(lastCopiedVersions, versions)) {
    const t0 = performance.now();
    copyNearInstances(mesh, near, lastNearCount);
    stats.copyMs = performance.now() - t0;
    lastCopiedVersions = versions;
  }
  stats.near = lastNearCount;
  syncNearMaterial(mesh, near);
  return false;
}

/** Forget cached state (a mesh was rebuilt or removed). */
export function resetAtomLod() {
  lastKey = null;
  lastCopiedVersions = null;
  lastMatrixVersion = -1;
  lastNearCount = 0;
  lastLodNear = 0;
}
