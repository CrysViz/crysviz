// CrysViz path-tracing scene shader: Monte-Carlo path tracing (global
// illumination, soft area-light shadows) of the crystal scene on top of the
// vendored docs/external/three-pathtracing/ GLSL chunks (CC0, Erich Loftis).
// The CalculateRadiance() loop is adapted from the upstream demos
// (Geometry_Showcase_Fragment.glsl), with one spherical area light and
// per-object materials (from the Structure-window material editors):
//   - LIGHT: the main area light AND any emissive object. Both are DIRECTLY
//     sampled by next-event estimation (ptSampleNEE, up to 64 listed emitters
//     from SceneEncoder) so emissive materials light their neighbours with low
//     variance; emitters beyond the cap fall back to implicit GI arrival (the
//     emission gate in CalculateRadiance keeps exactly one strategy per light);
//   - REFR: glass material, or any alpha < 1 (per-object IoR, tinted);
//   - SPEC: metal material (tinted mirror, roughness blurs the lobe);
//   - COAT: standard material; uReflectivity stochastically blends toward
//     an ideal mirror.
// The scene data comes from the SAME data textures as the raytrace pipeline
// (render/pipeline/raytrace/SceneEncoder.js) — see sceneFragment.js there for
// the texel layouts (3 texels/atom, 8/cylinder with a leading bounding sphere,
// material in the poly header/AABB w slots). The area light sits along the app
// key-light direction at
// uLightPosition with radius uLightRadius (the "Light softness" slider).

import { DATA_TEX_WIDTH } from '../raytrace/sceneFragment.js';
import { fieldChunk } from '../raytrace/fieldChunk.js';
import { planeChunk } from '../raytrace/planeChunk.js';
import { gridChunk } from '../raytrace/gridChunk.js';
import { convexChunk } from '../raytrace/convexChunk.js';

export const ptSceneFragment = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

#include <pathtracing_uniforms_and_defines>

uniform sampler2D uAtomsDataTexture;
uniform sampler2D uCylindersDataTexture;
uniform sampler2D uPolyDataTexture;
uniform sampler2D uEmissiveTex; // emissive NEE list: 2 texels/emitter —
//   (cx,cy,cz,r) bounding sphere, then (objectID, power, 0, 0)
uniform int uEmissiveCount;     // listed emitters directly sampled (0 = fixture only)
uniform int uAtomCount;
uniform int uCylinderCount;
uniform int uPolyCount;
uniform vec3 uSceneMin;      // whole-scene world AABB (interior early-out)
uniform vec3 uSceneMax;
uniform bool uSceneBoundValid; // false = empty scene
uniform bool uShadowAnyHit;  // any-hit shadow early-out (false when the scene
//   has emissive objects: they are LIGHTs a light-sample ray must still reach)
uniform bool uLdsEnabled;    // A2 debug flag: use the app low-discrepancy
//   sampler (ptRand) for the first path decisions; false => byte-identical to
//   the vendored white-noise rng() stream (PathTracingPipeline._ldsEnabled)
uniform vec3 uLightDirection; // updated by the shared driver (unused directly)
uniform vec3 uLightColor;
uniform vec3 uBackgroundColor;
uniform vec3 uBackgroundDisplay; // pre-compensated: primary-miss rays only (see driver)
uniform float uReflectivity;
uniform vec3 uLightPosition; // area-light centre (world)
uniform float uLightRadius;  // area-light radius (world; soft-shadow spread)
uniform float uAmbientStrength; // scales the sky/ambient bounce term
uniform bool uGroundEnabled; // ground plane (shadow catcher)
uniform vec3 uGroundNormal;  // plane: dot(normal, p) = uGroundD
uniform float uGroundD;
uniform vec3 uGroundColor1;
uniform vec3 uGroundColor2;
uniform int uGroundPattern;  // 0 solid, 1 checker, 2 grid
uniform float uGroundScale;  // pattern tile size (world units)
uniform float uGroundReflect; // 0 matte ... 1 mirror floor
uniform vec3 uGroundCenter;   // disc center reference (structure center)
uniform float uGroundRadius;  // finite disc radius (background shows as sky beyond)

#define DATA_W ${DATA_TEX_WIDTH}

// globals used by the chunks / loop
vec3 rayOrigin, rayDirection;
vec3 hitNormal, hitEmission, hitColor;
float hitObjectID = -INFINITY;
float hitRoughness = 0.0;  // metal roughness / glass frost
float hitIor = 1.5;
float hitReflectivity = -1.0; // < 0 = use the global uReflectivity
float hitGloss = 0.6;      // standard: coat reflection tightness
float hitTintDepth = 0.2;  // glass: Beer's-law strength
float hitScatter = 0.5;    // translucent: scatter depth
float hitAlpha = 1.0;      // surface alpha (non-glass: stochastic see-through)
int hitType = -100;
// NEE (B2): objectID of the light ptSampleNEE picked (fixture = 0, emitters =
// their stored objectID). A light-sample (shadow) ray's emission counts only
// when its closest hit's id matches this — hitting a DIFFERENT emitter counts 0
// (that emitter's energy arrives via its own picks; counting it here would
// double-count with the wrong pdf).
float gNeeTargetID = 0.0;
// TRUE when the closest LIGHT hit is the fixture or a LISTED emissive prim
// (set in resolveHitType's emissive branch + the fixture block). On DIFFUSE
// arrival, emission is added only for NON-listed (overflow) emitters, so listed
// ones are never double-counted (they arrive via NEE instead).
int gHitEmissiveListed = FALSE;

// encoded material texel with TYPE-MULTIPLEXED slots (see SceneEncoder
// materialTexel) + surface alpha -> path-tracer hit type; also fills the
// per-type hit globals above. Codes: 0 std, 1 metal, 2 glass, 3 emissive,
// 4 translucent.
int resolveHitType(vec4 mat, vec3 color, float alpha)
{
	hitAlpha = alpha;
	hitRoughness = mat.y;
	hitReflectivity = mat.w;
	hitGloss = 0.6;
	hitTintDepth = 0.2;
	hitScatter = 0.5;
	hitEmission = vec3(0);
	int code = int(mat.x + 0.5);
	if (code == 4)
	{
		hitScatter = mat.z;
		return TRANSLUCENT;
	}
	if (code == 3)
	{
		hitEmission = color * mat.z; // emissive: a directly-sampled area light
		gHitEmissiveListed = mat.w > 0.5 ? TRUE : FALSE; // NEE "listed" bit (SceneEncoder)
		return LIGHT;
	}
	// refraction is for the GLASS material only; alpha < 1 on other
	// materials is handled as stochastic (non-refractive) transparency in
	// CalculateRadiance
	hitIor = code == 2 && mat.z > 1.0 ? mat.z : 1.5;
	if (code == 2) { hitTintDepth = mat.w; hitReflectivity = -1.0; return REFR; }
	if (code == 1) return SPEC;
	hitGloss = clamp(mat.z, 0.0, 1.0); // standard
	return COAT;
}

struct Sphere { float radius; vec3 position; vec3 emission; vec3 color; int type; };
Sphere lightSphere;
// TRUE while the current ray is an unredirected camera ray: the key light is
// a FIXTURE — it lights the scene, casts soft shadows and appears in mirror
// reflections, but is never directly visible (matching the raster key light,
// and keeping the sphere out of view in perspective mode when the camera is
// farther out than the light distance).
int gCameraRay = TRUE;
// TRUE while the current ray is a light-sample (shadow) ray — set from
// sampleLight before each SceneIntersect. Enables the any-hit shadow early-out.
int gShadowRay = FALSE;
// "ray is leaving a closed shape" flag of the closest hit (was SceneIntersect's
// out-param; a global so the grid's per-primitive tests can set it too).
int gRayExiting = FALSE;

#include <pathtracing_random_functions>
#include <pathtracing_calc_fresnel_reflectance>
#include <pathtracing_sphere_intersect>
#include <pathtracing_unit_cylinder_intersect>
#include <pathtracing_boundingbox_intersect>
#include <pathtracing_convexpolyhedron_intersect>
#include <pathtracing_plane_intersect>
#include <pathtracing_sample_sphere_light>

// ===========================================================================
// App-owned low-discrepancy sampler (A2) — variance reduction
// ---------------------------------------------------------------------------
// Replaces the vendored white-noise rng() for the first ~12 decisions of each
// camera path with a per-pixel-scrambled stratified sequence (provably the same
// converged image, lower variance). Dimension d's value at sample index s is
//   (s * PT_LDS_INC[d] + cpRot[d]) mod 2^32   in EXACT uint32 (no float drift),
// with PT_LDS_INC[d] = round(fract(sqrt(prime_d)) * 2^32) — distinct irrational
// increments decorrelate the dimensions — plus a per-pixel Cranley-Patterson
// rotation cpRot[d] from a lowbias32 hash of gl_FragCoord (keeps neighbouring
// pixels' sequences independent, so the estimator is unbiased and the residual
// is high-frequency / denoiser-friendly). It NEVER touches the vendored seed /
// rng() state. When uLdsEnabled is false, or a path exhausts the 12 tabulated
// dimensions (deep bounces / divergent paths), ptRand() falls back to rng() —
// with the flag off it is bitwise today's stream. Keyed on gLdsSampleIndex =
// uint(uFrameCounter + 0.5): uFrameCounter advances exactly once per sample and
// is frozen across a tiled round's tiles (uSampleCounter lags during tiling).

// lowbias32 integer hash (Chris Wellons) — app-owned, distinct from the
// vendored rng()/seed machinery (GLSL forbids redefining included names).
uint ptHashLowbias32(uint x)
{
	x ^= x >> 16; x *= 0x7feb352dU;
	x ^= x >> 15; x *= 0x846ca68bU;
	x ^= x >> 16;
	return x;
}

// round(fract(sqrt(prime_i)) * 2^32) for the first 12 primes (2,3,5,7,11,13,
// 17,19,23,29,31,37) — precomputed exactly on the CPU (no runtime sqrt).
const uint PT_LDS_INC[12] = uint[12](
	1779033704u,  // sqrt(2)
	3144134278u,  // sqrt(3)
	1013904243u,  // sqrt(5)
	2773480762u,  // sqrt(7)
	1359893120u,  // sqrt(11)
	2600822924u,  // sqrt(13)
	528734636u,   // sqrt(17)
	1541459225u,  // sqrt(19)
	3418070366u,  // sqrt(23)
	1654270250u,  // sqrt(29)
	2438529370u,  // sqrt(31)
	355462361u    // sqrt(37)
);

uint gLdsSampleIndex = 0u; // uint(uFrameCounter+0.5), set in CalculateRadiance
uint gLdsPixelHash = 0u;   // lowbias32(gl_FragCoord), set in CalculateRadiance
int gLdsDim = 0;           // dimension counter, consumed in path order

// One low-discrepancy draw in [0,1). Uses the tabulated dimension while the
// path stays within the first 12 draws and the flag is on; otherwise white
// noise (never biased — divergent/deep paths only degrade toward rng()).
float ptRand()
{
	if (uLdsEnabled && gLdsDim < 12)
	{
		uint d = uint(gLdsDim);
		uint cpRot = ptHashLowbias32(gLdsPixelHash + d * 0x9e3779b9u);
		uint v = (gLdsSampleIndex * PT_LDS_INC[gLdsDim]) + cpRot;
		gLdsDim++;
		return float(v) * ONE_OVER_MAX_INT;
	}
	return rng();
}

// App copies of the vendored samplers with rng() -> ptRand() (byte-identical
// math otherwise). GLSL forbids redefining the included names, hence the pt*
// aliases.
vec3 ptCosHemisphere(vec3 nl)
{
	float phi = ptRand() * TWO_PI;
	float theta = (ptRand() * 2.0) - 1.0;
	float r = sqrt(1.0 - (theta * theta));
	return normalize(nl + vec3(r * cos(phi), r * sin(phi), theta));
}

vec3 ptSpecLobe(vec3 normal, vec3 reflectionDir, float roughness)
{
	float phi = ptRand() * TWO_PI;
	float theta = (ptRand() * 2.0) - 1.0;
	float r = sqrt(1.0 - (theta * theta));
	vec3 cosDiffuseDir = normalize(reflectionDir + vec3(r * cos(phi), r * sin(phi), theta));
	vec3 sampleDirection = normalize(mix(reflectionDir, cosDiffuseDir, roughness * roughness));
	return dot(sampleDirection, normal) > 0.0 ? sampleDirection : reflect(sampleDirection, reflectionDir);
}

// App copy of sampleSphereLight (2 rng draws -> ptRand) with two changes:
// returns the RAW estimator weight (the caller clamps per-strategy), and an
// INSIDE-SPHERE fallback — from inside the light's bounding sphere the cone
// solid-angle construction is undefined/biased, so sample the FULL sphere of
// directions uniformly with the matching weight 4*max(0, n.w). Both branches
// consume exactly 2 ptRand draws, so the LDS dimension alignment is identical
// either way. Keeps the 0.75 sin_alpha precision fudge (vendored parity).
vec3 ptSampleSphereCone(vec3 x, vec3 nl, Sphere light, out float weight)
{
	vec3 dirToLight = light.position - x; // no normalize (distance below)
	float dist2 = dot(dirToLight, dirToLight);
	if (dist2 <= light.radius * light.radius)
	{
		float phi = ptRand() * TWO_PI;
		float cosT = (ptRand() * 2.0) - 1.0;
		float r = sqrt(max(0.0, 1.0 - (cosT * cosT)));
		vec3 sampleDir = normalize(vec3(r * cos(phi), r * sin(phi), cosT));
		weight = 4.0 * max(0.0, dot(nl, sampleDir));
		return sampleDir;
	}
	float cos_alpha_max = sqrt(1.0 - clamp((light.radius * light.radius) / dist2, 0.0, 1.0));
	float r0 = ptRand();
	float cos_alpha = (1.0 - r0) + (r0 * cos_alpha_max);
	float sin_alpha = sqrt(max(0.0, 1.0 - (cos_alpha * cos_alpha))) * 0.75;
	float phi = ptRand() * TWO_PI;
	dirToLight = normalize(dirToLight);
	vec3 U = normalize(cross(abs(dirToLight.y) < 0.9 ? vec3(0, 1, 0) : vec3(0, 0, 1), dirToLight));
	vec3 V = cross(dirToLight, U);
	vec3 sampleDir = normalize((U * cos(phi) * sin_alpha) + (V * sin(phi) * sin_alpha) + (dirToLight * cos_alpha));
	weight = 2.0 * (1.0 - cos_alpha_max) * max(0.0, dot(nl, sampleDir));
	return sampleDir;
}
// ===========================================================================

vec4 fetchData(sampler2D tex, int index)
{
	return texelFetch(tex, ivec2(index % DATA_W, index / DATA_W), 0);
}

// Next-event estimation (B2): pick ONE light uniformly among {fixture} ∪ {M
// listed emissive prims} (M = uEmissiveCount), cone-sample its bounding sphere,
// and correct for the 1/(M+1) selection probability. Sets gNeeTargetID to the
// picked light's objectID so the caller's shadow ray counts its emission only
// on an exact target-id match (an occluder or a DIFFERENT emitter contributes
// 0 — unbiased, no double counting). When M == 0 this consumes NO extra draw
// and reduces EXACTLY to the vendored fixture estimator (emissive-free
// identity). Weight clamps: fixture [0,1] (vendored parity), emitters [0,4]
// (firefly guard). Returns the fully pdf-corrected weight (caller: mask*=w).
vec3 ptSampleNEE(vec3 x, vec3 nl, out float weight)
{
	int M = uEmissiveCount;
	if (M == 0)
	{
		gNeeTargetID = 0.0; // fixture only — no pick draw, vendored estimator
		vec3 dir = ptSampleSphereCone(x, nl, lightSphere, weight);
		weight = clamp(weight, 0.0, 1.0);
		return dir;
	}
	int idx = int(ptRand() * float(M + 1)); // 0..M ; idx>=M -> fixture
	vec3 dir;
	if (idx >= M)
	{
		gNeeTargetID = 0.0;
		dir = ptSampleSphereCone(x, nl, lightSphere, weight);
		weight = clamp(weight, 0.0, 1.0);
	}
	else
	{
		vec4 sph = fetchData(uEmissiveTex, idx * 2);       // (cx,cy,cz,r)
		vec4 meta = fetchData(uEmissiveTex, (idx * 2) + 1); // (objectID, power,..)
		Sphere em = Sphere(sph.w, sph.xyz, vec3(0), vec3(0), LIGHT);
		gNeeTargetID = meta.x;
		dir = ptSampleSphereCone(x, nl, em, weight);
		weight = clamp(weight, 0.0, 4.0); // emitter firefly guard
	}
	weight *= float(M + 1); // undo the uniform 1/(M+1) selection probability
	return dir;
}

${convexChunk}

${fieldChunk}

${planeChunk}

// Ground surface color at a plane point: solid / checkerboard / grid of the
// two ground colors, in a tangent frame of the plane (world-unit tiles).
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

// Per-primitive tests shared by the brute loops, the any-hit shadow path and
// (step 6) the uniform grid, so all callers run byte-identical per-primitive
// code. Each updates the hit globals + t on a NEW CLOSEST hit and returns 1
// only for a light-sample (shadow) ray, when uShadowAnyHit is set, whose new
// closest hit DEFINITELY occludes the light: glass (code 2) OR opaque
// (alpha>=1). In PT a light-sample ray that hits glass counts as occluded
// (SceneIntersect's sampleLight branch precedes the type branches), so glass is
// a valid early-out too. The light sphere is intersected first and seeds t, so
// d<t already ignores anything beyond the light — free light-distance bounding.
// uShadowAnyHit is false whenever the scene has emissive objects (they are
// LIGHTs a light-sample ray must be able to add), which makes the early-out
// exact. The NEE target-id match (B2) consumes hitObjectID, but only when
// emitters exist — and then uShadowAnyHit is false, so the early-out never
// runs; when it DOES run (no emitters) the id consumer is inert (gNeeTargetID
// is always 0 and the fixture is the only reachable LIGHT).
int testAtom(int i, inout float t)
{
	vec4 posRad = fetchData(uAtomsDataTexture, i * 3);
	float d = SphereIntersect(posRad.w, posRad.xyz, rayOrigin, rayDirection);
	if (d >= t) return 0;
	t = d;
	vec4 colA = fetchData(uAtomsDataTexture, (i * 3) + 1);
	vec4 mat = fetchData(uAtomsDataTexture, (i * 3) + 2);
	hitNormal = (rayOrigin + (t * rayDirection)) - posRad.xyz;
	hitColor = colA.rgb;
	hitType = resolveHitType(mat, colA.rgb, colA.a);
	hitObjectID = float(1 + i);
	gRayExiting = dot(hitNormal, rayDirection) > 0.0 ? TRUE : FALSE;
	return (gShadowRay == TRUE && uShadowAnyHit
		&& (int(mat.x + 0.5) == 2 || colA.a >= 0.999)) ? 1 : 0;
}

int testCylinder(int i, inout float t)
{
	int o = i * 8;
	vec4 sph = fetchData(uCylindersDataTexture, o); // (center.xyz, radius)
	vec3 L = sph.xyz - rayOrigin;
	float tca = dot(L, rayDirection);
	float r2 = sph.w * sph.w;
	float d2 = dot(L, L) - tca * tca;
	if (d2 > r2) return 0;            // ray line misses the sphere
	float thc = sqrt(r2 - d2);
	if (tca + thc <= 0.0) return 0;   // sphere fully behind (origin-inside passes)
	if (tca - thc >= t) return 0;     // nearest possible entry can't beat best
	mat4 invM = mat4(
		fetchData(uCylindersDataTexture, o + 1),
		fetchData(uCylindersDataTexture, o + 2),
		fetchData(uCylindersDataTexture, o + 3),
		fetchData(uCylindersDataTexture, o + 4));
	vec3 ro = (invM * vec4(rayOrigin, 1.0)).xyz;
	vec3 rd = (invM * vec4(rayDirection, 0.0)).xyz;
	vec3 cn;
	float d = UnitCylinderIntersect(ro, rd, cn);
	if (d >= t) return 0;
	t = d;
	vec4 colA = fetchData(uCylindersDataTexture, o + 5);
	vec4 mat = fetchData(uCylindersDataTexture, o + 6);
	hitNormal = transpose(mat3(invM)) * cn;
	hitColor = colA.rgb;
	hitType = resolveHitType(mat, colA.rgb, colA.a);
	hitObjectID = float(1 + uAtomCount + i);
	gRayExiting = FALSE; // open cylinders are not closed shapes
	return (gShadowRay == TRUE && uShadowAnyHit
		&& (int(mat.x + 0.5) == 2 || colA.a >= 0.999)) ? 1 : 0;
}

// grid-chunk dispatch wrappers (uniform signature the shared GridTraverse calls;
// PT ignores shadowFlag — the per-primitive tests read the gShadowRay global)
int gridTestAtom(int i, int shadowFlag, inout float t) { return testAtom(i, t); }
int gridTestCylinder(int i, int shadowFlag, inout float t) { return testCylinder(i, t); }

${gridChunk}

//---------------------------------------------------------------------------
float SceneIntersect()
{
	vec3 n;
	float d;
	float t = INFINITY;
	gRayExiting = FALSE;

	// ---- the area light (a fixture: invisible to camera rays) --------------
	d = gCameraRay == TRUE ? INFINITY
		: SphereIntersect(lightSphere.radius, lightSphere.position, rayOrigin, rayDirection);
	if (d < t)
	{
		t = d;
		hitNormal = (rayOrigin + (t * rayDirection)) - lightSphere.position;
		hitEmission = lightSphere.emission;
		hitColor = lightSphere.color;
		hitType = LIGHT;
		hitAlpha = 1.0;
		hitObjectID = 0.0;
		gHitEmissiveListed = TRUE; // the fixture is always a listed (NEE) light
	}

	// Whole-scene AABB early-out (AFTER the light block — the light sits
	// outside the structure and must never be gated): skip every interior
	// primitive loop when the ray misses the structure box. Ground/background
	// stay OUTSIDE. inverseDir is hoisted (the polyhedra AABB test reuses it).
	vec3 inverseDir = 1.0 / rayDirection;
	if (!uSceneBoundValid || BoundingBoxIntersect(uSceneMin, uSceneMax, rayOrigin, inverseDir) < INFINITY)
	{

	// ---- atoms + cylinders: uniform grid (>= GRID_MIN_PRIMS) or brute loops.
	// Either path threads t into the polyhedra/field/plane tests below. A
	// light-sample occluder early-out returns t.
	if (uGridEnabled)
	{
		if (GridTraverse(rayOrigin, rayDirection, gShadowRay, t) == 1) return t;
	}
	else
	{
		for (int i = 0; i < uAtomCount; i++)
			if (testAtom(i, t) == 1) return t;      // occluding shadow hit
		for (int i = 0; i < uCylinderCount; i++)
			if (testCylinder(i, t) == 1) return t;  // occluding shadow hit
	}

	// ---- polyhedra: convex plane sets with an AABB quick reject ------------
	for (int p = 0; p < uPolyCount; p++)
	{
		int o = p * 4;
		// AABB texels FIRST: slab-reject before touching header/colA. The .w
		// slots (typeParam/reflectivity) stay in registers for the hit block,
		// so a hit needs no re-fetch and a miss skips 2 fetches (header+colA).
		vec4 aabbMinT = fetchData(uPolyDataTexture, o + 2);
		vec4 aabbMaxT = fetchData(uPolyDataTexture, o + 3);
		if (BoundingBoxIntersect(aabbMinT.xyz, aabbMaxT.xyz, rayOrigin, inverseDir) >= t)
			continue;
		vec4 header = fetchData(uPolyDataTexture, o);
		int planeOffset = int(header.x);
		int planeCount = int(header.y);
		// streaming convex intersector (raytrace/convexChunk.js): fetches
		// planes straight from uPolyDataTexture — no local array, no plane cap
		d = ConvexPolyStreamIntersect(rayOrigin, rayDirection, planeOffset, planeCount, n);
		if (d < t)
		{
			t = d;
			vec4 colA = fetchData(uPolyDataTexture, o + 1);
			hitNormal = n;
			hitColor = colA.rgb;
			// material packed into the spare header/AABB w slots
			hitType = resolveHitType(
				vec4(header.z, header.w, aabbMinT.w, aabbMaxT.w),
				colA.rgb, colA.a);
			hitObjectID = float(1 + uAtomCount + uCylinderCount + p);
			gRayExiting = dot(n, rayDirection) > 0.0 ? TRUE : FALSE;
			// any-hit shadow early-out — same gate as testAtom/testCylinder:
			// under uShadowAnyHit a glass (code==2) or opaque (alpha>=0.999)
			// poly hit blocks the light-sample ray. uShadowAnyHit is false when
			// the scene has emissives, so the listed-bit / NEE id-match path is
			// unaffected. Same statistical-identity argument as the other prims.
			if (gShadowRay == TRUE && uShadowAnyHit
				&& (int(header.z + 0.5) == 2 || colA.a >= 0.999))
				return t;
		}
	}

	// ---- volumetric field isosurface: ray-marched implicit surface ---------
	if (uFieldEnabled)
	{
		float fT; vec3 fN, fCol;
		if (intersectField(rayOrigin, rayDirection, t, fT, fN, fCol) && fT < t)
		{
			t = fT;
			hitNormal = fN;
			hitColor = fCol;
			hitType = resolveHitType(uFieldMaterial, fCol, uFieldAlpha); // fills hitAlpha/roughness/reflectivity/gloss/emission/gHitEmissiveListed
			hitObjectID = -3.0;      // distinct id (light 0, ground -2)
			gRayExiting = FALSE;    // double-sided implicit surface
		}
	}

	// ---- crystallographic lattice planes: analytic, cell-clipped -----------
	if (uPlaneCount > 0)
	{
		float pT; vec3 pN, pCol; float pAlpha;
		if (intersectPlanes(rayOrigin, rayDirection, t, pT, pN, pCol, pAlpha) && pT < t)
		{
			t = pT;
			hitNormal = pN;
			hitColor = pCol;
			hitType = COAT;
			hitAlpha = pAlpha;       // None: 0.70 stochastic see-through; Field: 1
			hitEmission = vec3(0);
			hitGloss = 0.6;          // default coat reflection tightness
			hitReflectivity = -1.0;  // use the global Reflectivity slider
			hitRoughness = 0.0;
			hitObjectID = -4.0;      // distinct id (light 0, ground -2, field -3)
			gRayExiting = FALSE;    // double-sided flat surface
		}
	}

	} // end whole-scene AABB gate

	// ---- optional ground plane (patterned shadow catcher) ------------------
	if (uGroundEnabled)
	{
		d = PlaneIntersect(vec4(uGroundNormal, uGroundD), rayOrigin, rayDirection);
		// finite disc: skip hits beyond the ground radius (sky shows around it)
		vec3 gRel = (rayOrigin + (d * rayDirection)) - uGroundCenter;
		gRel -= uGroundNormal * dot(gRel, uGroundNormal);
		if (d < t && dot(gRel, gRel) < (uGroundRadius * uGroundRadius))
		{
			t = d;
			hitNormal = uGroundNormal;
			hitEmission = vec3(0);
			hitColor = groundPatternColor(rayOrigin + (d * rayDirection));
			hitType = COAT;
			hitAlpha = 1.0;
			hitGloss = 1.0;          // sharp fresnel floor reflections
			hitReflectivity = uGroundReflect; // stochastic mirror fraction
			hitObjectID = -2.0;
			gRayExiting = FALSE;
		}
	}

	return t;
} // end SceneIntersect

//---------------------------------------------------------------------------
vec3 CalculateRadiance( out vec3 objectNormal, out vec3 objectColor, out float objectID, out float pixelSharpness )
{
	vec3 accumCol = vec3(0);
	vec3 mask = vec3(1);
	vec3 reflectionMask = vec3(1);
	vec3 reflectionRayOrigin = vec3(0);
	vec3 reflectionRayDirection = vec3(0);
	vec3 diffuseBounceMask = vec3(1);
	vec3 diffuseBounceRayOrigin = vec3(0);
	vec3 diffuseBounceRayDirection = vec3(0);
	vec3 skyColor = uBackgroundColor * (uAmbientStrength * 4.0); // 0.3 default = the classic 1.2
	vec3 x, n, nl;

	float t;
	float nc, nt, ratioIoR, Re, Tr;
	float weight;
	float thickness = 0.1;
	float previousObjectID;

	int diffuseCount = 0;
	hitType = -100;

	// low-discrepancy sampler state (A2): sample index from uFrameCounter (not
	// uSampleCounter, which lags across tiled rounds), per-pixel scramble hash,
	// dimension counter reset for this camera path.
	gLdsSampleIndex = uint(uFrameCounter + 0.5);
	gLdsPixelHash = ptHashLowbias32(uint(gl_FragCoord.x) + ptHashLowbias32(uint(gl_FragCoord.y)));
	gLdsDim = 0;

	int bounceIsSpecular = TRUE;
	int sampleLight = FALSE;
	int willNeedReflectionRay = FALSE;
	int isReflectionTime = FALSE;
	int willNeedDiffuseBounceRay = FALSE;
	int isDiffuseBounceTime = FALSE;
	// TRUE until the ray is redirected; alpha pass-throughs keep it, so the
	// backdrop behind transparent objects uses the same display-exact color.
	int isPrimaryRay = TRUE;

	for (int bounces = 0; bounces < 8; bounces++)
	{
		previousObjectID = hitObjectID;

		gCameraRay = isPrimaryRay;
		gShadowRay = sampleLight; // enables the any-hit shadow early-out
		t = SceneIntersect();

		if (t == INFINITY) // ray escaped into the background
		{
			if (isPrimaryRay == TRUE)
			{
				// unredirected camera ray: the display-exact background
				pixelSharpness = 1.0;
				accumCol += mask * uBackgroundDisplay;
				break;
			}
			// diffuse/reflection rays that miss pick up a soft sky/ambient term
			if (bounceIsSpecular == TRUE || isDiffuseBounceTime == TRUE)
				accumCol += mask * skyColor;

			if (willNeedDiffuseBounceRay == TRUE)
			{
				mask = diffuseBounceMask;
				rayOrigin = diffuseBounceRayOrigin;
				rayDirection = diffuseBounceRayDirection;
				willNeedDiffuseBounceRay = FALSE;
				bounceIsSpecular = FALSE;
				sampleLight = FALSE;
				isDiffuseBounceTime = TRUE;
				isReflectionTime = FALSE;
				diffuseCount = 1;
				isPrimaryRay = FALSE;
				continue;
			}
			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;
				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				isDiffuseBounceTime = FALSE;
				isPrimaryRay = FALSE;
				continue;
			}
			break;
		}

		// useful data
		n = normalize(hitNormal);
		nl = dot(n, rayDirection) < 0.0 ? n : -n;
		x = rayOrigin + (rayDirection * t);

		if (bounces == 0)
		{
			objectID = hitObjectID;
		}
		if (isReflectionTime == FALSE && diffuseCount == 0 && hitObjectID != previousObjectID)
		{
			objectNormal += n;
			objectColor += hitColor;
		}

		// Non-refractive alpha transparency (raster-like "see-through"): any
		// non-glass surface with alpha < 1 lets the ray (including light-
		// sample rays) pass STRAIGHT through with probability (1 - alpha).
		if (hitType != REFR && hitAlpha < 0.999 && ptRand() >= hitAlpha)
		{
			rayOrigin = x + (rayDirection * uEPS_intersect);
			continue;
		}

		if (hitType == LIGHT)
		{
			if (diffuseCount == 0 && isReflectionTime == FALSE)
				pixelSharpness = 1.0;

			// Emission gate (B2) — exactly ONE strategy per (emitter, vertex):
			//   NEE (shadow) ray  -> count only if it hit the PICKED target id
			//                        (a different emitter / occluder counts 0);
			//   specular / camera -> count (implicit glow + mirror reflections);
			//   diffuse arrival   -> count only for NON-listed (overflow)
			//                        emitters — listed ones arrive via NEE, so
			//                        counting here would double-count.
			// Emissive-free scenes: gNeeTargetID is always 0 and the only LIGHT
			// is the fixture (id 0), so this reduces to today's behaviour.
			int addEmission;
			if (sampleLight == TRUE)
				addEmission = hitObjectID == gNeeTargetID ? TRUE : FALSE;
			else if (bounceIsSpecular == TRUE)
				addEmission = TRUE;
			else
				addEmission = gHitEmissiveListed == FALSE ? TRUE : FALSE;
			if (addEmission == TRUE)
				accumCol += mask * hitEmission;

			if (willNeedDiffuseBounceRay == TRUE)
			{
				mask = diffuseBounceMask;
				rayOrigin = diffuseBounceRayOrigin;
				rayDirection = diffuseBounceRayDirection;
				willNeedDiffuseBounceRay = FALSE;
				bounceIsSpecular = FALSE;
				sampleLight = FALSE;
				isDiffuseBounceTime = TRUE;
				isReflectionTime = FALSE;
				diffuseCount = 1;
				isPrimaryRay = FALSE;
				continue;
			}
			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;
				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				isDiffuseBounceTime = FALSE;
				isPrimaryRay = FALSE;
				continue;
			}
			break;
		} // end LIGHT

		// shadow ray was occluded on its way to the light
		if (sampleLight == TRUE)
		{
			if (willNeedDiffuseBounceRay == TRUE)
			{
				mask = diffuseBounceMask;
				rayOrigin = diffuseBounceRayOrigin;
				rayDirection = diffuseBounceRayDirection;
				willNeedDiffuseBounceRay = FALSE;
				bounceIsSpecular = FALSE;
				sampleLight = FALSE;
				isDiffuseBounceTime = TRUE;
				isReflectionTime = FALSE;
				diffuseCount = 1;
				isPrimaryRay = FALSE;
				continue;
			}
			if (willNeedReflectionRay == TRUE)
			{
				mask = reflectionMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;
				willNeedReflectionRay = FALSE;
				bounceIsSpecular = TRUE;
				sampleLight = FALSE;
				isReflectionTime = TRUE;
				isDiffuseBounceTime = FALSE;
				isPrimaryRay = FALSE;
				continue;
			}
			break;
		}

		if (hitType == SPEC) // metal: tinted mirror, roughness blurs the lobe
		{
			// reflectivity = mirrored fraction (unset/-1 = 1.0, ideal mirror);
			// the rest of the energy shades as a diffuse surface (brushed metal)
			float metalReflect = hitReflectivity < 0.0 ? 1.0 : hitReflectivity;
			if (ptRand() < metalReflect)
			{
				mask *= hitColor;
				mask *= (1.0 - (hitRoughness * 0.8));
				rayDirection = ptSpecLobe(nl, reflect(rayDirection, nl), hitRoughness);
				rayOrigin = x + (nl * uEPS_intersect);
				isPrimaryRay = FALSE;
				continue;
			}
			// diffuse fraction: same bookkeeping as COAT's diffuse part
			diffuseCount++;
			mask *= hitColor;
			bounceIsSpecular = FALSE;
			rayOrigin = x + (nl * uEPS_intersect);
			if (diffuseCount == 1)
			{
				diffuseBounceMask = mask;
				diffuseBounceRayOrigin = rayOrigin;
				diffuseBounceRayDirection = ptCosHemisphere(nl);
				willNeedDiffuseBounceRay = TRUE;
			}
			rayDirection = ptSampleNEE(x, nl, weight);
			mask *= weight; // NEE: fully pdf-corrected weight
			sampleLight = TRUE;
			isPrimaryRay = FALSE;
			continue;
		}

		if (hitType == REFR) // glass (glass material, or transparent objects)
		{
			nc = 1.0;
			nt = hitIor;
			Re = calcFresnelReflectance(rayDirection, n, nc, nt, ratioIoR);
			Tr = 1.0 - Re;

			if (Re == 1.0)
			{
				rayDirection = reflect(rayDirection, nl);
				rayOrigin = x + (nl * uEPS_intersect);
				isPrimaryRay = FALSE;
				continue;
			}

			if (diffuseCount == 0 && hitObjectID != previousObjectID && n == nl)
			{
				reflectionMask = mask * Re;
				reflectionRayDirection = reflect(rayDirection, nl);
				reflectionRayOrigin = x + (nl * uEPS_intersect);
				willNeedReflectionRay = TRUE;
			}

			// tint towards the object color by the inverse of its alpha;
			// tintDepth (glass slot) scales the Beer's-law saturation
			vec3 tintColor = mix(vec3(1), hitColor, 0.7);
			if (gRayExiting == TRUE)
			{
				gRayExiting = FALSE;
				mask *= exp(log(clamp(tintColor, 0.01, 0.99)) * hitTintDepth * t);
			}
			else
				mask *= tintColor;

			mask *= Tr;

			isPrimaryRay = FALSE;
			rayDirection = refract(rayDirection, nl, ratioIoR);
			// frost (glass roughness slot) blurs the transmission lobe
			if (hitRoughness > 0.0)
				rayDirection = ptSpecLobe(-nl, rayDirection, hitRoughness);
			rayOrigin = x - (nl * uEPS_intersect);

			if (diffuseCount == 1 && isDiffuseBounceTime == TRUE)
				bounceIsSpecular = TRUE; // refracting caustics

			continue;
		} // end REFR

		if (hitType == COAT) // clear-coated diffuse (opaque objects)
		{
			// reflectivity stochastically upgrades the surface to a mirror
			// (per-object value wins over the global slider when set)
			if (ptRand() < (hitReflectivity < 0.0 ? uReflectivity : hitReflectivity))
			{
				mask *= hitColor;
				rayDirection = reflect(rayDirection, nl);
				rayOrigin = x + (nl * uEPS_intersect);
				continue;
			}

			nc = 1.0;
			nt = 1.4;
			Re = calcFresnelReflectance(rayDirection, nl, nc, nt, ratioIoR);
			Tr = 1.0 - Re;

			if (diffuseCount == 0 && hitObjectID != previousObjectID)
			{
				// gloss (standard slot, default 0.6) sets how tight the coat
				// reflection is; 0 = fully blurred (matte), 1 = mirror-sharp.
				// Tinted by the surface color (raster-metalness parity: an
				// untinted background reflection washes saturation out).
				reflectionMask = mask * Re * clamp(hitGloss * 1.4, 0.0, 1.0) * mix(vec3(1), hitColor, 0.6);
				reflectionRayDirection = ptSpecLobe(nl, reflect(rayDirection, nl), 1.0 - hitGloss);
				reflectionRayOrigin = x + (nl * uEPS_intersect);
				willNeedReflectionRay = hitGloss > 0.02 ? TRUE : FALSE;
			}

			diffuseCount++;
			mask *= Tr;
			mask *= hitColor;
			bounceIsSpecular = FALSE;
			rayOrigin = x + (nl * uEPS_intersect);

			if (diffuseCount == 1)
			{
				diffuseBounceMask = mask;
				diffuseBounceRayOrigin = rayOrigin;
				diffuseBounceRayDirection = ptCosHemisphere(nl);
				willNeedDiffuseBounceRay = TRUE;
			}

			rayDirection = ptSampleNEE(x, nl, weight);
			mask *= weight; // NEE: fully pdf-corrected weight
			sampleLight = TRUE;
			isPrimaryRay = FALSE;
			continue;
		} // end COAT

		if (hitType == TRANSLUCENT) // waxy diffuse transmitter (subsurface look)
		{
			diffuseCount++;
			mask *= hitColor;
			bounceIsSpecular = FALSE;
			// scatter into the front OR back hemisphere (diffuse both ways);
			// transmitted energy is attenuated by the scatter depth
			int transmit = ptRand() < 0.5 ? TRUE : FALSE;
			vec3 sideN = transmit == TRUE ? -nl : nl;
			if (transmit == TRUE)
				mask *= exp(log(clamp(hitColor, 0.2, 0.99)) * hitScatter);
			rayOrigin = x + (sideN * uEPS_intersect);
			if (diffuseCount == 1)
			{
				diffuseBounceMask = mask;
				diffuseBounceRayOrigin = rayOrigin;
				diffuseBounceRayDirection = ptCosHemisphere(sideN);
				willNeedDiffuseBounceRay = TRUE;
			}
			rayDirection = ptSampleNEE(x, sideN, weight);
			mask *= weight; // NEE: fully pdf-corrected weight
			sampleLight = TRUE;
			isPrimaryRay = FALSE;
			continue;
		} // end TRANSLUCENT

	} // end bounces loop

	return max(vec3(0), accumCol);
} // end CalculateRadiance

//---------------------------------------------------------------------------
void SetupScene(void)
{
	lightSphere = Sphere(uLightRadius, uLightPosition, uLightColor * 12.0, vec3(0), LIGHT);
}

#include <pathtracing_main>
`;
