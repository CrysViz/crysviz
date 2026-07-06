// CrysViz ray-tracing scene shader: Whitted-style ray tracing of the crystal
// scene (atom spheres, bond/cell-edge cylinders, convex polyhedra) on top of
// the vendored docs/external/three-raytracing/ GLSL chunks (CC0, Erich
// Loftis). The RayTrace() loop structure is adapted from the upstream demos
// (InstanceMapping_Fragment.glsl), simplified to two material types:
//   - MAT_OPAQUE: Blinn-Phong diffuse + specular with a hard shadow ray, plus a
//     mirror reflection ray weighted by Fresnel + the "Reflectivity" slider;
//   - TRANSPARENT (alpha < 1): Fresnel-split reflection/refraction (glass-like,
//     IoR 1.5) with color-tinted transmission.
// Scene data arrives in RGBA32F data textures (see SceneEncoder.js):
//   atoms      2 texels/atom:  (pos.xyz, radius), (rgb, alpha)
//   cylinders  5 texels/cyl:   4 rows of the inverse object matrix (unit
//              cylinder y in [-1,1]; direction NOT renormalized in object
//              space so t stays world-valid), (rgb, alpha)
//   polyhedra  header (planeOffset, planeCount, colorTexel, 0), (rgb, alpha),
//              (aabbMin, 0), (aabbMax, 0), then planeCount (normal.xyz, d)
// The single light is directional (the app's camera-relative key light);
// shadow-ray success = the ray escaping to the sky.

export const DATA_TEX_WIDTH = 1024;

export const sceneFragment = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;

#include <raytracing_uniforms_and_defines>

uniform sampler2D uAtomsDataTexture;
uniform sampler2D uCylindersDataTexture;
uniform sampler2D uPolyDataTexture;
uniform int uAtomCount;
uniform int uCylinderCount;
uniform int uPolyCount;
uniform vec3 uLightDirection; // world space, points from the scene TOWARDS the light
uniform vec3 uLightColor;
uniform vec3 uBackgroundColor;
uniform float uReflectivity;

#define DATA_W ${DATA_TEX_WIDTH}

// globals used by the chunks / loop
vec3 rayOrigin, rayDirection;
vec3 intersectionNormal;
vec3 intersectionColor;
float intersectionAlpha;
int intersectionShapeIsClosed;

#define MAT_OPAQUE 0
#define MAT_TRANSP 1
int intersectionMaterialType;

#include <raytracing_core_functions>
#include <raytracing_sphere_intersect>
#include <raytracing_unit_cylinder_intersect>
#include <raytracing_boundingbox_intersect>
#include <raytracing_convexpolyhedron_intersect>

vec4 fetchData(sampler2D tex, int index)
{
	return texelFetch(tex, ivec2(index % DATA_W, index / DATA_W), 0);
}

//---------------------------------------------------------------------------
float SceneIntersect( int isShadowRay )
{
	vec3 n;
	float d;
	float t = INFINITY;

	// ---- atoms: spheres --------------------------------------------------
	for (int i = 0; i < uAtomCount; i++)
	{
		vec4 posRad = fetchData(uAtomsDataTexture, i * 2);
		d = SphereIntersect(posRad.w, posRad.xyz, rayOrigin, rayDirection);
		if (d < t)
		{
			t = d;
			vec4 colA = fetchData(uAtomsDataTexture, (i * 2) + 1);
			intersectionNormal = (rayOrigin + (t * rayDirection)) - posRad.xyz;
			intersectionColor = colA.rgb;
			intersectionAlpha = colA.a;
			intersectionMaterialType = colA.a < 0.999 ? MAT_TRANSP : MAT_OPAQUE;
			intersectionShapeIsClosed = TRUE;
		}
	}

	// ---- bonds + unit-cell edges: unit cylinders via inverse matrices ----
	for (int i = 0; i < uCylinderCount; i++)
	{
		int o = i * 5;
		mat4 invM = mat4(
			fetchData(uCylindersDataTexture, o),
			fetchData(uCylindersDataTexture, o + 1),
			fetchData(uCylindersDataTexture, o + 2),
			fetchData(uCylindersDataTexture, o + 3));
		// transform ray into unit-cylinder object space; direction is NOT
		// renormalized, which keeps t valid in world space
		vec3 ro = (invM * vec4(rayOrigin, 1.0)).xyz;
		vec3 rd = (invM * vec4(rayDirection, 0.0)).xyz;
		d = UnitCylinderIntersect(ro, rd, n);
		if (d < t)
		{
			t = d;
			vec4 colA = fetchData(uCylindersDataTexture, o + 4);
			intersectionNormal = transpose(mat3(invM)) * n;
			intersectionColor = colA.rgb;
			intersectionAlpha = colA.a;
			intersectionMaterialType = colA.a < 0.999 ? MAT_TRANSP : MAT_OPAQUE;
			intersectionShapeIsClosed = FALSE;
		}
	}

	// ---- polyhedra: convex plane sets with an AABB quick reject ----------
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
			intersectionNormal = n;
			intersectionColor = colA.rgb;
			intersectionAlpha = colA.a;
			intersectionMaterialType = colA.a < 0.999 ? MAT_TRANSP : MAT_OPAQUE;
			intersectionShapeIsClosed = TRUE;
		}
	}

	return t;
} // end SceneIntersect

//---------------------------------------------------------------------------
vec3 getSkyColor(vec3 rayDir)
{
	// flat scene background plus a soft glow around the light direction, so
	// mirror reflections have something to catch
	float glow = pow(max(0.0, dot(rayDir, uLightDirection)), 64.0);
	return uBackgroundColor + (uLightColor * glow * 0.4);
}

//---------------------------------------------------------------------------
vec3 RayTrace()
{
	vec3 accumulatedColor = vec3(0);
	vec3 rayColorMask = vec3(1);
	vec3 reflectionRayOrigin, reflectionRayDirection, reflectionRayColorMask;
	vec3 geometryNormal, shadingNormal;
	vec3 intersectionPoint, halfwayVector;
	vec3 diffuseContribution = vec3(0);
	vec3 specularContribution = vec3(0);
	vec3 directionToLight = uLightDirection;
	vec3 skyColor;

	float t;
	float ambientIntensity = 0.25;
	float diffuseIntensity;
	float reflectance, transmittance, IoR_ratio;

	int isShadowRay = FALSE;
	int willNeedReflectionRay = FALSE;

	for (int bounces = 0; bounces < 6; bounces++)
	{
		t = SceneIntersect(isShadowRay);

		if (t == INFINITY) // ray escaped the scene
		{
			if (bounces == 0)
			{
				accumulatedColor = uBackgroundColor; // camera ray: flat background
				break;
			}
			if (isShadowRay == TRUE) // directional light: escaping = light visible
			{
				accumulatedColor += diffuseContribution;
				accumulatedColor += specularContribution;
			}
			else // reflection/refraction ray hit the sky
			{
				accumulatedColor += rayColorMask * getSkyColor(rayDirection);
			}
			if (willNeedReflectionRay == TRUE)
			{
				rayColorMask = reflectionRayColorMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;
				willNeedReflectionRay = FALSE;
				isShadowRay = FALSE;
				continue;
			}
			break;
		}

		// shadow ray hit an occluder: surface stays in ambient shadow
		if (isShadowRay == TRUE && intersectionMaterialType != MAT_TRANSP)
		{
			if (willNeedReflectionRay == TRUE)
			{
				rayColorMask = reflectionRayColorMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;
				willNeedReflectionRay = FALSE;
				isShadowRay = FALSE;
				continue;
			}
			break;
		}

		geometryNormal = normalize(intersectionNormal);
		shadingNormal = dot(geometryNormal, rayDirection) < 0.0 ? geometryNormal : -geometryNormal;
		intersectionPoint = rayOrigin + (t * rayDirection);
		halfwayVector = normalize(-rayDirection + directionToLight);
		diffuseIntensity = max(0.0, dot(shadingNormal, directionToLight));

		if (intersectionMaterialType == MAT_OPAQUE)
		{
			accumulatedColor += doAmbientLighting(rayColorMask, intersectionColor, ambientIntensity);
			diffuseContribution = doDiffuseDirectLighting(rayColorMask, intersectionColor, uLightColor, diffuseIntensity);
			specularContribution = doBlinnPhongSpecularLighting(rayColorMask, shadingNormal, halfwayVector, uLightColor, 0.4, diffuseIntensity);

			// mirror reflections, weighted by Fresnel + the Reflectivity slider
			reflectance = calcFresnelReflectance(rayDirection, shadingNormal, 1.0, 1.4, IoR_ratio);
			float reflectWeight = clamp((reflectance * 0.5) + uReflectivity, 0.0, 1.0);
			if (bounces == 0 && reflectWeight > 0.01)
			{
				willNeedReflectionRay = TRUE;
				reflectionRayColorMask = rayColorMask * reflectWeight;
				reflectionRayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
				reflectionRayDirection = reflect(rayDirection, shadingNormal);
			}
			// shadow ray towards the (directional) light
			isShadowRay = TRUE;
			rayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
			rayDirection = directionToLight;
			continue;
		}

		if (intersectionMaterialType == MAT_TRANSP)
		{
			reflectance = calcFresnelReflectance(rayDirection, geometryNormal, 1.0, 1.5, IoR_ratio);
			transmittance = 1.0 - reflectance;

			specularContribution = doBlinnPhongSpecularLighting(rayColorMask, shadingNormal, halfwayVector, uLightColor, 0.1, diffuseIntensity);
			specularContribution = (isShadowRay == TRUE) ? vec3(0) : specularContribution;
			accumulatedColor += specularContribution;

			if (bounces == 0)
			{
				willNeedReflectionRay = TRUE;
				reflectionRayColorMask = rayColorMask * reflectance;
				reflectionRayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
				reflectionRayDirection = reflect(rayDirection, shadingNormal);
			}
			if (reflectance == 1.0 && isShadowRay == FALSE) // total internal reflection
			{
				rayColorMask *= reflectance;
				rayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
				rayDirection = reflect(rayDirection, shadingNormal);
				willNeedReflectionRay = FALSE;
				continue;
			}

			// transmitted (refracted) portion, tinted towards the object color
			// by the inverse of its alpha (alpha 1 would be fully colored glass)
			vec3 tintColor = mix(vec3(1), intersectionColor, clamp(1.0 - intersectionAlpha, 0.05, 0.95));
			if (intersectionShapeIsClosed == FALSE)
				rayColorMask *= tintColor;
			else if (distance(geometryNormal, shadingNormal) > 0.1) // exiting a closed shape
				rayColorMask *= exp(log(clamp(tintColor, 0.01, 0.99)) * 0.2 * t); // Beer's law

			rayColorMask *= transmittance;

			if (isShadowRay == FALSE) // refract
			{
				rayOrigin = intersectionPoint - (uEPS_intersect * shadingNormal);
				rayDirection = refract(rayDirection, shadingNormal, IoR_ratio);
			}
			else // shadow rays pass through transparent surfaces (tinted)
			{
				diffuseContribution *= tintColor;
				diffuseContribution *= max(0.2, transmittance);
				rayOrigin = intersectionPoint + (uEPS_intersect * rayDirection);
			}
			continue;
		}

	} // end bounces loop

	return max(vec3(0), accumulatedColor);
} // end RayTrace

//---------------------------------------------------------------------------
void SetupScene(void)
{
	// scene data lives in the data textures; nothing to set up per-pixel
}

#include <raytracing_main>
`;
