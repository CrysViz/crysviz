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
// the texel layouts (3 texels/atom, 6/cylinder, material in the poly header/
// AABB w slots). The area light sits along the app key-light direction at
// uLightPosition with radius uLightRadius (the "Light softness" slider).

import { DATA_TEX_WIDTH } from '../raytrace/sceneFragment.js';

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
uniform vec3 uLightDirection; // updated by the shared driver (unused directly)
uniform vec3 uLightColor;
uniform vec3 uBackgroundColor;
uniform float uReflectivity;
uniform vec3 uLightPosition; // area-light centre (world)
uniform float uLightRadius;  // area-light radius (world; soft-shadow spread)

#define DATA_W ${DATA_TEX_WIDTH}

// globals used by the chunks / loop
vec3 rayOrigin, rayDirection;
vec3 hitNormal, hitEmission, hitColor;
float hitObjectID = -INFINITY;
float hitRoughness = 0.0;
float hitIor = 1.5;
float hitReflectivity = -1.0; // < 0 = use the global uReflectivity
int hitType = -100;

// encoded material texel (type, roughness, typeParam, reflectivity) + surface
// alpha -> path-tracer hit type; also sets hitEmission/hitRoughness/hitIor/
// hitReflectivity (codes: 0 std, 1 metal, 2 glass, 3 emissive; typeParam is
// the IoR for glass or the intensity for emissive)
int resolveHitType(vec4 mat, vec3 color, float alpha)
{
	hitRoughness = mat.y;
	hitReflectivity = mat.w;
	hitEmission = vec3(0);
	int code = int(mat.x + 0.5);
	if (code == 3)
	{
		hitEmission = color * mat.z; // emissive: an implicit area light
		return LIGHT;
	}
	// per-object IoR only travels for glass; alpha-routed objects use 1.5
	hitIor = code == 2 && mat.z > 1.0 ? mat.z : 1.5;
	if (code == 2 || alpha < 0.999) return REFR; // alpha wins for std/metal
	if (code == 1) return SPEC;
	return COAT;
}

struct Sphere { float radius; vec3 position; vec3 emission; vec3 color; int type; };
Sphere lightSphere;

#include <pathtracing_random_functions>
#include <pathtracing_calc_fresnel_reflectance>
#include <pathtracing_sphere_intersect>
#include <pathtracing_unit_cylinder_intersect>
#include <pathtracing_boundingbox_intersect>
#include <pathtracing_convexpolyhedron_intersect>
#include <pathtracing_sample_sphere_light>

vec4 fetchData(sampler2D tex, int index)
{
	return texelFetch(tex, ivec2(index % DATA_W, index / DATA_W), 0);
}

//---------------------------------------------------------------------------
float SceneIntersect( out int isRayExiting )
{
	vec3 n;
	float d;
	float t = INFINITY;
	isRayExiting = FALSE;

	// ---- the area light ---------------------------------------------------
	d = SphereIntersect(lightSphere.radius, lightSphere.position, rayOrigin, rayDirection);
	if (d < t)
	{
		t = d;
		hitNormal = (rayOrigin + (t * rayDirection)) - lightSphere.position;
		hitEmission = lightSphere.emission;
		hitColor = lightSphere.color;
		hitType = LIGHT;
		hitObjectID = 0.0;
	}

	// ---- atoms: spheres ---------------------------------------------------
	for (int i = 0; i < uAtomCount; i++)
	{
		vec4 posRad = fetchData(uAtomsDataTexture, i * 3);
		d = SphereIntersect(posRad.w, posRad.xyz, rayOrigin, rayDirection);
		if (d < t)
		{
			t = d;
			vec4 colA = fetchData(uAtomsDataTexture, (i * 3) + 1);
			vec4 mat = fetchData(uAtomsDataTexture, (i * 3) + 2);
			hitNormal = (rayOrigin + (t * rayDirection)) - posRad.xyz;
			hitColor = colA.rgb;
			hitType = resolveHitType(mat, colA.rgb, colA.a);
			hitObjectID = float(1 + i);
			isRayExiting = dot(hitNormal, rayDirection) > 0.0 ? TRUE : FALSE;
		}
	}

	// ---- bonds + unit-cell edges: unit cylinders via inverse matrices ------
	for (int i = 0; i < uCylinderCount; i++)
	{
		int o = i * 6;
		mat4 invM = mat4(
			fetchData(uCylindersDataTexture, o),
			fetchData(uCylindersDataTexture, o + 1),
			fetchData(uCylindersDataTexture, o + 2),
			fetchData(uCylindersDataTexture, o + 3));
		// direction NOT renormalized in object space: t stays world-valid
		vec3 ro = (invM * vec4(rayOrigin, 1.0)).xyz;
		vec3 rd = (invM * vec4(rayDirection, 0.0)).xyz;
		d = UnitCylinderIntersect(ro, rd, n);
		if (d < t)
		{
			t = d;
			vec4 colA = fetchData(uCylindersDataTexture, o + 4);
			vec4 mat = fetchData(uCylindersDataTexture, o + 5);
			hitNormal = transpose(mat3(invM)) * n;
			hitColor = colA.rgb;
			hitType = resolveHitType(mat, colA.rgb, colA.a);
			hitObjectID = float(1 + uAtomCount + i);
			isRayExiting = FALSE; // open cylinders are not closed shapes
		}
	}

	// ---- polyhedra: convex plane sets with an AABB quick reject ------------
	vec4 planes[20];
	vec3 inverseDir = 1.0 / rayDirection;
	for (int p = 0; p < uPolyCount; p++)
	{
		int o = p * 4;
		vec4 header = fetchData(uPolyDataTexture, o);
		vec4 colA = fetchData(uPolyDataTexture, o + 1);
		vec3 aabbMin = fetchData(uPolyDataTexture, o + 2).xyz;
		vec3 aabbMax = fetchData(uPolyDataTexture, o + 3).xyz;
		if (BoundingBoxIntersect(aabbMin, aabbMax, rayOrigin, inverseDir) >= t)
			continue;
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
			hitNormal = n;
			hitColor = colA.rgb;
			// material packed into the spare header/AABB w slots
			hitType = resolveHitType(
				vec4(header.z, header.w, fetchData(uPolyDataTexture, o + 2).w, fetchData(uPolyDataTexture, o + 3).w),
				colA.rgb, colA.a);
			hitObjectID = float(1 + uAtomCount + uCylinderCount + p);
			isRayExiting = dot(n, rayDirection) > 0.0 ? TRUE : FALSE;
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
	vec3 skyColor = uBackgroundColor * 1.2;
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
	int isRayExiting = FALSE;
	int willNeedReflectionRay = FALSE;
	int isReflectionTime = FALSE;
	int willNeedDiffuseBounceRay = FALSE;
	int isDiffuseBounceTime = FALSE;

	for (int bounces = 0; bounces < 8; bounces++)
	{
		previousObjectID = hitObjectID;

		t = SceneIntersect(isRayExiting);

		if (t == INFINITY) // ray escaped into the background
		{
			if (bounces == 0)
			{
				pixelSharpness = 1.0;
				accumCol = uBackgroundColor;
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
				continue;
			}
			break;
		}

		if (hitType == SPEC) // metal: tinted mirror, roughness blurs the lobe
		{
			mask *= hitColor;
			mask *= (1.0 - (hitRoughness * 0.8));
			rayDirection = randomDirectionInSpecularLobe(nl, reflect(rayDirection, nl), hitRoughness);
			rayOrigin = x + (nl * uEPS_intersect);
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
				continue;
			}

			if (diffuseCount == 0 && hitObjectID != previousObjectID && n == nl)
			{
				reflectionMask = mask * Re;
				reflectionRayDirection = reflect(rayDirection, nl);
				reflectionRayOrigin = x + (nl * uEPS_intersect);
				willNeedReflectionRay = TRUE;
			}

			// tint towards the object color by the inverse of its alpha
			vec3 tintColor = mix(vec3(1), hitColor, 0.7);
			if (isRayExiting == TRUE)
			{
				isRayExiting = FALSE;
				mask *= exp(log(clamp(tintColor, 0.01, 0.99)) * thickness * t);
			}
			else
				mask *= tintColor;

			mask *= Tr;

			rayDirection = refract(rayDirection, nl, ratioIoR);
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
				reflectionMask = mask * Re;
				reflectionRayDirection = reflect(rayDirection, nl);
				reflectionRayOrigin = x + (nl * uEPS_intersect);
				willNeedReflectionRay = TRUE;
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
			continue;
		} // end COAT

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
