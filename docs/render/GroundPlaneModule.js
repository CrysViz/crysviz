// Raster ground-plane disc — a permanent fixture of every RASTER and PREVIEW
// frame, visually matched to the ray/path tracers' analytic ground disc so the
// floor no longer disappears while the view is manipulated in mixed (interactive
// raster preview under a tracer) mode.
//
// The tracers draw their own analytic disc in the scene shader and never render
// the raster scene, so there is NO doubling: a traced frame shows the analytic
// disc, a raster/preview frame shows this mesh — never both in the same frame.
// The mesh therefore stays visible whenever the ground is enabled.
//
// Visual parity with the tracer disc:
//   - placement: exact driver formulas (RayTracingPipeline.js) — position at
//     (center.x, minY - offset, center.z), scale = max(size * structureRadius, 5);
//   - bounds: computeGroundPlacement() DUPLICATES the SceneEncoder atom-AABB
//     pass (kept in lockstep — see the comments there and in
//     SceneEncoder._encodeAtoms), sharing only the cut-plane filter via the
//     exported activeAtomCutPlanes();
//   - pattern: groundPatternColor GLSL copied byte-for-byte from
//     raytrace/sceneFragment.js (solid / checker / grid, world-unit tiles);
//   - colors: follow the scene background (with an auto-darkened color2) unless
//     the user set explicit colors — refreshed per drawn frame in onBeforeRender.
//
// The material is an unlit MeshBasicMaterial (there is no raster shadow/tone-map
// system to match, and the follow-background solid is meant to blend into the
// backdrop). It is opaque and carries NO transparencySpec, so pipeline-switch
// policy traversals never touch it and it joins the opaque stage (the depth-peel
// fast path is preserved).

import * as THREE from '../external/three/three.module.js';
import { groups, general, app } from '../state/store.js';
import { activeAtomCutPlanes } from './pipeline/raytrace/SceneEncoder.js';

// Ground surface color at a plane point — byte-for-byte copy of the tracer's
// groundPatternColor (raytrace/sceneFragment.js): solid / checkerboard / grid of
// the two ground colors, in a tangent frame of the plane (world-unit tiles).
const GROUND_PATTERN_GLSL = /* glsl */`
vec3 groundPatternColor(vec3 p)
{
	if (uGroundPattern == 0) return uGroundColor1;
	vec3 tangent = normalize(abs(uGroundNormal.y) < 0.9
		? cross(uGroundNormal, vec3(0, 1, 0)) : cross(uGroundNormal, vec3(1, 0, 0)));
	vec3 bitangent = cross(uGroundNormal, tangent);
	vec2 uv = vec2(dot(p, tangent), dot(p, bitangent)) / uGroundScale;
	if (uGroundPattern == 1) // checkerboard
	{
		float ck = mod(floor(uv.x) + floor(uv.y), 2.0);
		return ck < 0.5 ? uGroundColor1 : uGroundColor2;
	}
	// grid: thin lines of color2 on color1
	vec2 f = abs(fract(uv) - 0.5);
	return min(f.x, f.y) < 0.03 ? uGroundColor2 : uGroundColor1;
}
`;

// Three keys custom shader programs by onBeforeCompile.toString(); the injected
// source is constant across all ground meshes, so a constant key is correct (and
// avoids the "variant silently reuses another's program" pitfall documented in
// MaterialStyles.js).
const GROUND_CACHE_KEY = 'cv-ground-plane';

/**
 * Compute the ground disc placement from the live atoms mesh, DUPLICATING the
 * SceneEncoder atom-AABB pass (SceneEncoder._encodeAtoms — KEEP IN LOCKSTEP):
 * radius>0 skip, cut-plane filtering honoring instanceCutPlaneImmune, expand each
 * bound by the instance radius, then minY / center / half-diagonal exactly as the
 * encoder derives minY / structureCenter / structureRadius. Fallback (no atoms) =
 * the encoder defaults: minY -5, center origin, radius 5.
 *
 * Deliberate simplification: the instanceMatrix is scanned regardless of
 * mesh.visible — the encoder early-returns keeping stale minY/center/radius while
 * hidden, and the matrices are unchanged while hidden, so the results match.
 *
 * @returns {{ posX:number, posY:number, posZ:number, scale:number }}
 */
export function computeGroundPlacement() {
  const mesh = groups.atomsMesh;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  if (mesh && mesh.instanceMatrix) {
    // ----- KEEP IN LOCKSTEP with SceneEncoder._encodeAtoms atom AABB loop -----
    const cutPlanes = activeAtomCutPlanes();
    const matrices = mesh.instanceMatrix.array;
    const immune = mesh.geometry.attributes.instanceCutPlaneImmune?.array;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      const radius = matrices[o]; // uniform scale; 0 = hidden instance
      if (!(radius > 0)) continue;
      const cx = matrices[o + 12], cy = matrices[o + 13], cz = matrices[o + 14];
      if (cutPlanes.length && !(immune && immune[i] >= 0.5)) {
        let cut = false;
        for (const p of cutPlanes) {
          if ((cx * p.nx + cy * p.ny + cz * p.nz - p.w) * p.sign > 0) { cut = true; break; }
        }
        if (cut) continue;
      }
      if (cx - radius < minX) minX = cx - radius;
      if (cx + radius > maxX) maxX = cx + radius;
      if (cy - radius < minY) minY = cy - radius;
      if (cy + radius > maxY) maxY = cy + radius;
      if (cz - radius < minZ) minZ = cz - radius;
      if (cz + radius > maxZ) maxZ = cz + radius;
    }
    // ----- END LOCKSTEP -----
  }
  const structMinY = Number.isFinite(minY) ? minY : -5;
  let centerX = 0, centerZ = 0, structureRadius = 5;
  if (Number.isFinite(minX)) {
    centerX = (minX + maxX) / 2;
    centerZ = (minZ + maxZ) / 2;
    structureRadius = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2;
  }
  // Exact driver placement formulas (RayTracingPipeline.js).
  const offset = general.rtGroundOffset ?? 0.75;
  const scale = Math.max((general.rtGroundSize ?? 2.5) * structureRadius, 5);
  return { posX: centerX, posY: structMinY - offset, posZ: centerZ, scale };
}

/** Refresh the per-frame ground uniforms from `general` + the scene background.
 *  Runs in the mesh's onBeforeRender (fires per drawn raster/preview frame), so
 *  theme / dark-mode / BackgroundPicker changes are followed with zero wiring.
 *  The follow-background read keeps its last known color when the background is
 *  nulled (transparent PNG export), matching the tracer. rtGroundReflect is
 *  ignored here (tracer-only). */
function refreshGroundUniforms(material) {
  const ud = material.userData;
  const bg = app.scene?.background;
  if (general.rtGroundColor1) ud.color1.set(general.rtGroundColor1);
  else if (bg && bg.isColor) ud.color1.copy(bg);
  // else: keep the last known color1 (background nulled for transparent export)
  if (general.rtGroundColor2) ud.color2.set(general.rtGroundColor2);
  else ud.color2.copy(ud.color1).multiplyScalar(0.7);
  ud.pattern = general.rtGroundPattern === 'checker' ? 1
    : general.rtGroundPattern === 'grid' ? 2 : 0;
  ud.scale = Math.max(0.25, general.rtGroundScale ?? 2);
  const shader = ud.shader;
  if (shader) {
    shader.uniforms.uGroundColor1.value.copy(ud.color1);
    shader.uniforms.uGroundColor2.value.copy(ud.color2);
    shader.uniforms.uGroundPattern.value = ud.pattern;
    shader.uniforms.uGroundScale.value = ud.scale;
  }
}

function createGroundMaterial() {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  // Last-known / staged uniform values (onBeforeRender fires BEFORE the shader
  // compiles on the first frame, so onBeforeCompile seeds from these).
  material.userData.color1 = new THREE.Color(0xe8e8e8);
  material.userData.color2 = new THREE.Color(0xa0a0a0);
  material.userData.pattern = 0;
  material.userData.scale = 2;
  material.userData.shader = null;
  material.customProgramCacheKey = () => GROUND_CACHE_KEY;
  material.onBeforeCompile = (shader) => {
    const ud = material.userData;
    shader.uniforms.uGroundNormal = { value: new THREE.Vector3(0, 1, 0) };
    shader.uniforms.uGroundColor1 = { value: ud.color1.clone() };
    shader.uniforms.uGroundColor2 = { value: ud.color2.clone() };
    shader.uniforms.uGroundPattern = { value: ud.pattern };
    shader.uniforms.uGroundScale = { value: ud.scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      // `transformed` is the local position (no morph on a static circle), so the
      // model matrix gives the world position the pattern function needs.
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader =
      'uniform vec3 uGroundNormal;\n'
      + 'uniform vec3 uGroundColor1;\n'
      + 'uniform vec3 uGroundColor2;\n'
      + 'uniform int uGroundPattern;\n'
      + 'uniform float uGroundScale;\n'
      + 'varying vec3 vGroundWorld;\n'
      + GROUND_PATTERN_GLSL
      + shader.fragmentShader.replace('#include <color_fragment>',
        'diffuseColor.rgb = groundPatternColor(vGroundWorld);');
    ud.shader = shader;
  };
  return material;
}

/** Lazily create the persistent ground mesh, add it to the scene, and return it.
 *  It lives for the app lifetime (no whole-scene clears exist; structure switches
 *  only reposition it). Never raycast (SceneInteraction only intersects the atom
 *  / bond / polyhedra groups) and on the default layer (auto-excluded from the
 *  layer-gated cel-outline pass). */
function ensureGroundMesh() {
  if (groups.groundMesh) return groups.groundMesh;
  const geometry = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2); // normal = +Y baked in
  const mesh = new THREE.Mesh(geometry, createGroundMaterial());
  mesh.name = 'groundPlane';
  mesh.raycast = () => {}; // never pickable
  mesh.renderOrder = 0;
  mesh.onBeforeRender = () => refreshGroundUniforms(mesh.material);
  groups.groundMesh = mesh;
  app.scene?.add(mesh);
  return mesh;
}

/** Full ground refresh: reposition/rescale from the live atoms when enabled,
 *  else hide and return (the disabled path is O(1) — no atom scan). Call from
 *  every user-action-driven re-render (updateVisualization / FastFrameModule /
 *  the ground GUI handlers / share-restore). */
export function updateGroundPlane() {
  if (!general.rtGroundPlane) {
    if (groups.groundMesh) groups.groundMesh.visible = false;
    return;
  }
  const mesh = ensureGroundMesh();
  mesh.visible = true;
  const p = computeGroundPlacement();
  mesh.position.set(p.posX, p.posY, p.posZ);
  mesh.scale.setScalar(p.scale);
}

/** O(1) per-frame visibility sync (called from the animate loop just before the
 *  pipeline render) so a direct `general.rtGroundPlane` write takes effect —
 *  onBeforeRender cannot un-hide a hidden mesh. If the mesh does not exist yet
 *  but the ground is enabled, create + place it once (steady state stays O(1)). */
export function syncGroundPlaneVisibility() {
  const mesh = groups.groundMesh;
  if (mesh) mesh.visible = !!general.rtGroundPlane;
  else if (general.rtGroundPlane) updateGroundPlane();
}
