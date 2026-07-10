// CrysViz path-tracing scene shader: Monte-Carlo path tracing (global
// illumination, soft area-light shadows) of the crystal scene on top of the
// vendored docs/external/three-pathtracing/ GLSL chunks (CC0, Erich Loftis).
// The CalculateRadiance() loop is adapted from the upstream demos
// (Geometry_Showcase_Fragment.glsl), with one spherical area light and
// per-object materials (from the Structure-window material editors):
//   - LIGHT: the main area light AND any emissive object (implicit area
//     lights — they glow and illuminate the scene through GI, but are not
//     directly sampled, so they converge slower than the main light);
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

export const ptSceneFragment = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

#include <pathtracing_uniforms_and_defines>

uniform sampler2D uAtomsDataTexture;
uniform sampler2D uCylindersDataTexture;
uniform sampler2D uPolyDataTexture;
uniform int uAtomCount;
uniform int uCylinderCount;
uniform int uPolyCount;
uniform vec3 uSceneMin;      // whole-scene world AABB (interior early-out)
uniform vec3 uSceneMax;
uniform bool uSceneBoundValid; // false = empty scene
uniform bool uShadowAnyHit;  // any-hit shadow early-out (false when the scene
//   has emissive objects: they are LIGHTs a light-sample ray must still reach)
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
		hitEmission = color * mat.z; // emissive: an implicit area light
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

vec4 fetchData(sampler2D tex, int index)
{
	return texelFetch(tex, ivec2(index % DATA_W, index / DATA_W), 0);
}

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
// exact. hitObjectID divergence from the early-out is inert: every consumer is
// diffuseCount==0-gated and a sampleLight ray always follows a diffuseCount++.
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
	vec4 planes[20];
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
		for (int k = 0; k < 20; k++)
		{
			planes[k] = k < planeCount ? fetchData(uPolyDataTexture, planeOffset + k) : vec4(0, 1, 0, INFINITY);
		}
		d = ConvexPolyhedronIntersect(rayOrigin, rayDirection, n, planeCount, planes);
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
			hitType = COAT;
			hitAlpha = uFieldAlpha;
			hitEmission = vec3(0);
			hitGloss = 0.6;          // default coat reflection tightness
			hitReflectivity = -1.0;  // use the global Reflectivity slider
			hitRoughness = 0.0;
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
		if (hitType != REFR && hitAlpha < 0.999 && rng() >= hitAlpha)
		{
			rayOrigin = x + (rayDirection * uEPS_intersect);
			continue;
		}

		if (hitType == LIGHT)
		{
			if (diffuseCount == 0 && isReflectionTime == FALSE)
				pixelSharpness = 1.0;

			if (bounceIsSpecular == TRUE || sampleLight == TRUE)
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
			if (rng() < metalReflect)
			{
				mask *= hitColor;
				mask *= (1.0 - (hitRoughness * 0.8));
				rayDirection = randomDirectionInSpecularLobe(nl, reflect(rayDirection, nl), hitRoughness);
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
				diffuseBounceRayDirection = randomCosWeightedDirectionInHemisphere(nl);
				willNeedDiffuseBounceRay = TRUE;
			}
			rayDirection = sampleSphereLight(x, nl, lightSphere, weight);
			mask *= weight;
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
				rayDirection = randomDirectionInSpecularLobe(-nl, rayDirection, hitRoughness);
			rayOrigin = x - (nl * uEPS_intersect);

			if (diffuseCount == 1 && isDiffuseBounceTime == TRUE)
				bounceIsSpecular = TRUE; // refracting caustics

			continue;
		} // end REFR

		if (hitType == COAT) // clear-coated diffuse (opaque objects)
		{
			// reflectivity stochastically upgrades the surface to a mirror
			// (per-object value wins over the global slider when set)
			if (rng() < (hitReflectivity < 0.0 ? uReflectivity : hitReflectivity))
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
				reflectionRayDirection = randomDirectionInSpecularLobe(nl, reflect(rayDirection, nl), 1.0 - hitGloss);
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
				diffuseBounceRayDirection = randomCosWeightedDirectionInHemisphere(nl);
				willNeedDiffuseBounceRay = TRUE;
			}

			rayDirection = sampleSphereLight(x, nl, lightSphere, weight);
			mask *= weight;
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
			int transmit = rng() < 0.5 ? TRUE : FALSE;
			vec3 sideN = transmit == TRUE ? -nl : nl;
			if (transmit == TRUE)
				mask *= exp(log(clamp(hitColor, 0.2, 0.99)) * hitScatter);
			rayOrigin = x + (sideN * uEPS_intersect);
			if (diffuseCount == 1)
			{
				diffuseBounceMask = mask;
				diffuseBounceRayOrigin = rayOrigin;
				diffuseBounceRayDirection = randomCosWeightedDirectionInHemisphere(sideN);
				willNeedDiffuseBounceRay = TRUE;
			}
			rayDirection = sampleSphereLight(x, sideN, lightSphere, weight);
			mask *= weight;
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
