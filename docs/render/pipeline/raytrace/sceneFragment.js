// CrysViz ray-tracing scene shader: Whitted-style ray tracing of the crystal
// scene (atom spheres, bond/cell-edge cylinders, convex polyhedra) on top of
// the vendored docs/external/three-raytracing/ GLSL chunks (CC0, Erich
// Loftis). The RayTrace() loop structure is adapted from the upstream demos
// (InstanceMapping_Fragment.glsl), with four material types (per-object,
// from the Structure-window material editors):
//   - MAT_OPAQUE (standard): Blinn-Phong diffuse + specular with a hard
//     shadow ray, plus a mirror reflection ray weighted by Fresnel + the
//     "Reflectivity" slider;
//   - MAT_TRANSP (the GLASS material): Fresnel-split reflection/refraction
//     with per-object IoR and color-tinted transmission. Alpha < 1 on any
//     OTHER material is non-refractive stochastic transparency (raster-like
//     see-through, resolved by the accumulation);
//   - MAT_METAL: tinted mirror, roughness blurs the reflection lobe;
//   - MAT_EMISSIVE: additive glow (color x intensity) in this Whitted tracer.
// Scene data arrives in RGBA32F data textures (see SceneEncoder.js):
//   atoms      3 texels/atom:  (pos.xyz, radius), (rgb, alpha),
//              (matType, roughness, typeParam, reflectivity)
//   cylinders  6 texels/cyl:   4 columns of the inverse object matrix (unit
//              cylinder y in [-1,1]; direction NOT renormalized in object
//              space so t stays world-valid), (rgb, alpha),
//              (matType, roughness, typeParam, reflectivity)
//   polyhedra  header (planeOffset, planeCount, matType, roughness),
//              (rgb, alpha), (aabbMin, typeParam), (aabbMax, reflectivity),
//              then planeCount (normal.xyz, d)
// typeParam = IoR for glass / intensity for emissive; reflectivity < 0 means
// "use the global uReflectivity slider".
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
uniform vec3 uBackgroundDisplay; // pre-compensated: primary-miss rays only (see driver)
uniform float uReflectivity;
uniform float uLightSoftness; // 0 = hard shadows; >0 jitters shadow rays (penumbra via accumulation)
uniform float uAmbientStrength; // ambient/fill light level (classic look: 0.25)
uniform bool uGroundEnabled;  // background-colored ground plane (shadow catcher)
uniform float uGroundY;

#define DATA_W ${DATA_TEX_WIDTH}

// globals used by the chunks / loop
vec3 rayOrigin, rayDirection;
vec3 intersectionNormal;
vec3 intersectionColor;
float intersectionAlpha;
float intersectionRoughness;
float intersectionTypeParam; // IoR (glass) or intensity (emissive)
float intersectionReflectivity; // < 0 = use uReflectivity
int intersectionShapeIsClosed;

#define MAT_OPAQUE 0
#define MAT_TRANSP 1
#define MAT_METAL 2
#define MAT_EMISSIVE 3
#define MAT_TRANSLUCENT 4
int intersectionMaterialType;
int intersectionMatCode; // raw encoder code (slot meanings are per-type)

// encoded material texel + surface alpha -> tracer material type
// (codes from SceneEncoder MATERIAL_CODES: 0 std, 1 metal, 2 glass,
//  3 emissive, 4 translucent)
int resolveMaterialType(float matCode, float alpha)
{
	int code = int(matCode + 0.5);
	intersectionMatCode = code;
	if (code == 4) return MAT_TRANSLUCENT;
	if (code == 3) return MAT_EMISSIVE;
	if (code == 2) return MAT_TRANSP; // refraction is for the GLASS material only;
	if (code == 1) return MAT_METAL;  // alpha < 1 on other materials is handled
	return MAT_OPAQUE;                // as stochastic (non-refractive) transparency
}

#include <raytracing_core_functions>
#include <raytracing_sphere_intersect>
#include <raytracing_unit_cylinder_intersect>
#include <raytracing_boundingbox_intersect>
#include <raytracing_convexpolyhedron_intersect>
#include <raytracing_plane_intersect>

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
		vec4 posRad = fetchData(uAtomsDataTexture, i * 3);
		d = SphereIntersect(posRad.w, posRad.xyz, rayOrigin, rayDirection);
		if (d < t)
		{
			t = d;
			vec4 colA = fetchData(uAtomsDataTexture, (i * 3) + 1);
			vec4 mat = fetchData(uAtomsDataTexture, (i * 3) + 2);
			intersectionNormal = (rayOrigin + (t * rayDirection)) - posRad.xyz;
			intersectionColor = colA.rgb;
			intersectionAlpha = colA.a;
			intersectionMaterialType = resolveMaterialType(mat.x, colA.a);
			intersectionRoughness = mat.y;
			intersectionTypeParam = mat.z;
			intersectionReflectivity = mat.w;
			intersectionShapeIsClosed = TRUE;
		}
	}

	// ---- bonds + unit-cell edges: unit cylinders via inverse matrices ----
	for (int i = 0; i < uCylinderCount; i++)
	{
		int o = i * 6;
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
			vec4 mat = fetchData(uCylindersDataTexture, o + 5);
			intersectionNormal = transpose(mat3(invM)) * n;
			intersectionColor = colA.rgb;
			intersectionAlpha = colA.a;
			intersectionMaterialType = resolveMaterialType(mat.x, colA.a);
			intersectionRoughness = mat.y;
			intersectionTypeParam = mat.z;
			intersectionReflectivity = mat.w;
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
			// material packed into the spare header/AABB w slots
			intersectionMaterialType = resolveMaterialType(header.z, colA.a);
			intersectionRoughness = header.w;
			intersectionTypeParam = fetchData(uPolyDataTexture, o + 2).w;
			intersectionReflectivity = fetchData(uPolyDataTexture, o + 3).w;
			intersectionShapeIsClosed = TRUE;
		}
	}

	// ---- optional ground plane (background-colored matte shadow catcher) --
	if (uGroundEnabled)
	{
		d = PlaneIntersect(vec4(0.0, 1.0, 0.0, uGroundY), rayOrigin, rayDirection);
		if (d < t)
		{
			t = d;
			intersectionNormal = vec3(0, 1, 0);
			intersectionColor = uBackgroundColor;
			intersectionAlpha = 1.0;
			intersectionMaterialType = MAT_OPAQUE;
			intersectionMatCode = 0;
			intersectionRoughness = 0.0;
			intersectionTypeParam = 0.0; // gloss 0: pure matte, shadows only
			intersectionReflectivity = 0.0;
			intersectionShapeIsClosed = FALSE;
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
	float ambientIntensity = uAmbientStrength;
	float diffuseIntensity;
	float reflectance, transmittance, IoR_ratio;

	int isShadowRay = FALSE;
	int willNeedReflectionRay = FALSE;
	// TRUE until the ray is redirected (reflection/refraction/shadow); alpha
	// pass-throughs keep it — so the backdrop seen through transparent
	// objects blends against the same display-exact background color.
	int isPrimaryRay = TRUE;

	for (int bounces = 0; bounces < 6; bounces++)
	{
		t = SceneIntersect(isShadowRay);

		if (t == INFINITY) // ray escaped the scene
		{
			if (isPrimaryRay == TRUE && isShadowRay == FALSE)
			{
				// unredirected camera ray: the display-exact background
				accumulatedColor += rayColorMask * uBackgroundDisplay;
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
				isPrimaryRay = FALSE;
				continue;
			}
			break;
		}

		// Non-refractive alpha transparency (raster-like "see-through"): any
		// non-glass surface with alpha < 1 lets the ray pass STRAIGHT through
		// with probability (1 - alpha). The accumulation averages this into
		// the classic alpha blend; shadow rays inherit partial shadows.
		if (intersectionMaterialType != MAT_TRANSP && intersectionAlpha < 0.999
			&& rand() >= intersectionAlpha)
		{
			rayOrigin = rayOrigin + ((t + uEPS_intersect) * rayDirection);
			continue;
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
				isPrimaryRay = FALSE;
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
			// gloss (typeParam, default 0.6 = the classic look) sets the Blinn
			// highlight tightness; 0 = pure matte Lambert
			float gloss = clamp(intersectionTypeParam, 0.0, 1.0);
			// specular + reflections are TINTED by the surface color (like the
			// raster metallic style's metalness) — an untinted white sheen +
			// background reflections wash the saturation out
			vec3 specularTint = mix(vec3(1), intersectionColor, 0.6);
			accumulatedColor += doAmbientLighting(rayColorMask, intersectionColor, ambientIntensity);
			diffuseContribution = doDiffuseDirectLighting(rayColorMask, intersectionColor, uLightColor, diffuseIntensity);
			specularContribution = doBlinnPhongSpecularLighting(rayColorMask * specularTint, shadingNormal, halfwayVector, uLightColor, 1.0 - gloss, diffuseIntensity) * step(0.01, gloss);

			// mirror reflections, weighted by Fresnel + the Reflectivity slider
			reflectance = calcFresnelReflectance(rayDirection, shadingNormal, 1.0, 1.4, IoR_ratio);
			float effReflectivity = intersectionReflectivity < 0.0 ? uReflectivity : intersectionReflectivity;
			float reflectWeight = clamp((reflectance * 0.5) + effReflectivity, 0.0, 1.0);
			if (bounces == 0 && reflectWeight > 0.01)
			{
				willNeedReflectionRay = TRUE;
				reflectionRayColorMask = rayColorMask * reflectWeight * specularTint;
				reflectionRayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
				reflectionRayDirection = reflect(rayDirection, shadingNormal);
			}
			// shadow ray towards the (directional) light; jittered inside a cone
			// when Light softness > 0 (accumulation averages into a penumbra)
			isShadowRay = TRUE;
			isPrimaryRay = FALSE;
			rayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
			rayDirection = uLightSoftness > 0.0
				? randomDirectionInSpecularLobe(directionToLight, uLightSoftness * 0.5)
				: directionToLight;
			continue;
		}

		if (intersectionMaterialType == MAT_TRANSLUCENT)
		{
			// waxy/jade approximation: wrapped (soft) diffuse plus light bleeding
			// through from behind; scatterDepth (typeParam) sets how much of the
			// back-light survives. No specular, no reflections.
			float scatterDepth = max(intersectionTypeParam, 0.05);
			float wrapDiffuse = clamp((dot(shadingNormal, directionToLight) + 0.6) / 1.6, 0.0, 1.0);
			float backLight = max(0.0, dot(-shadingNormal, directionToLight)) * clamp(1.0 - (scatterDepth * 0.5), 0.1, 1.0);
			accumulatedColor += doAmbientLighting(rayColorMask, intersectionColor, ambientIntensity * 1.6);
			diffuseContribution = doDiffuseDirectLighting(rayColorMask, intersectionColor, uLightColor, wrapDiffuse + backLight);
			specularContribution = vec3(0);
			isShadowRay = TRUE;
			isPrimaryRay = FALSE;
			rayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
			rayDirection = uLightSoftness > 0.0
				? randomDirectionInSpecularLobe(directionToLight, uLightSoftness * 0.5)
				: directionToLight;
			continue;
		}

		if (intersectionMaterialType == MAT_EMISSIVE)
		{
			// additive glow: the object is its own light source; a small diffuse
			// term keeps the shape readable at low intensities
			accumulatedColor += rayColorMask * intersectionColor * (intersectionTypeParam * 0.5 + 0.25);
			if (willNeedReflectionRay == TRUE)
			{
				rayColorMask = reflectionRayColorMask;
				rayOrigin = reflectionRayOrigin;
				rayDirection = reflectionRayDirection;
				willNeedReflectionRay = FALSE;
				isShadowRay = FALSE;
				isPrimaryRay = FALSE;
				continue;
			}
			break;
		}

		if (intersectionMaterialType == MAT_METAL)
		{
			// tinted mirror (upstream METAL): roughness blurs the reflection lobe
			// (resolved by accumulation); reflectivity is the mirrored fraction
			// (unset/-1 = 1.0, an ideal mirror) — the remainder shades as diffuse
			// (no shadow ray, keeping metal single-bounce cheap)
			float metalReflect = intersectionReflectivity < 0.0 ? 1.0 : intersectionReflectivity;
			rayColorMask *= intersectionColor;
			if (metalReflect < 1.0)
			{
				accumulatedColor += doAmbientLighting(rayColorMask, vec3(1), ambientIntensity) * (1.0 - metalReflect);
				accumulatedColor += doDiffuseDirectLighting(rayColorMask, vec3(1), uLightColor, diffuseIntensity) * (1.0 - metalReflect);
			}
			specularContribution = doBlinnPhongSpecularLighting(rayColorMask, shadingNormal, halfwayVector, uLightColor, intersectionRoughness, diffuseIntensity);
			accumulatedColor += specularContribution;
			rayColorMask *= (1.0 - intersectionRoughness);
			rayColorMask *= metalReflect;
			rayOrigin = intersectionPoint + (uEPS_intersect * shadingNormal);
			rayDirection = reflect(rayDirection, shadingNormal);
			rayDirection = randomDirectionInSpecularLobe(rayDirection, intersectionRoughness * intersectionRoughness);
			isPrimaryRay = FALSE;
			continue;
		}

		if (intersectionMaterialType == MAT_TRANSP)
		{
			// per-object IoR travels in typeParam (0 when the material is not glass
			// but alpha routed us here -> fall back to the classic 1.5)
			float ior = intersectionTypeParam > 1.0 ? intersectionTypeParam : 1.5;
			reflectance = calcFresnelReflectance(rayDirection, geometryNormal, 1.0, ior, IoR_ratio);
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
				isPrimaryRay = FALSE;
				continue;
			}

			// transmitted (refracted) portion, tinted towards the object color
			// by the inverse of its alpha (alpha 1 would be fully colored glass);
			// tintDepth (glass slot, default 0.2) sets how strongly color
			// saturates with the path length through the medium
			float tintDepth = intersectionMatCode == 2 ? intersectionReflectivity : 0.2;
			vec3 tintColor = mix(vec3(1), intersectionColor, clamp(1.0 - intersectionAlpha, 0.05, 0.95));
			if (intersectionShapeIsClosed == FALSE)
				rayColorMask *= tintColor;
			else if (distance(geometryNormal, shadingNormal) > 0.1) // exiting a closed shape
				rayColorMask *= exp(log(clamp(tintColor, 0.01, 0.99)) * tintDepth * t); // Beer's law

			rayColorMask *= transmittance;

			isPrimaryRay = FALSE;
			if (isShadowRay == FALSE) // refract; frost (glass roughness slot)
			{                         // blurs the transmission lobe
				rayOrigin = intersectionPoint - (uEPS_intersect * shadingNormal);
				rayDirection = refract(rayDirection, shadingNormal, IoR_ratio);
				if (intersectionRoughness > 0.0)
					rayDirection = randomDirectionInSpecularLobe(rayDirection, intersectionRoughness * intersectionRoughness);
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
