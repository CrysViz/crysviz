// Shared GLSL chunk: analytic ray tracing of crystallographic lattice planes
// (model/Plane.js), used by BOTH the ray-tracing (sceneFragment.js) and
// path-tracing (pathtrace/ptSceneFragment.js) scene shaders. It renders the
// SAME planes the raster pipelines drape over the cell as subdivided quads
// (added to app.scene by ui/PlanesPanel.js), but as exact analytic ray-plane
// intersections trimmed to the unit cell.
//
// Each plane is encoded by SceneEncoder._encodePlanes into 6 texels of a data
// texture (see the layout comment in sceneFragment.js). 'None'-mode planes are
// a flat translucent grey (alpha 0.70 -> the existing stochastic see-through);
// their purple perimeter border is emitted as thin cylinders into the shared
// cylinder bucket, so it is traced for free. 'Field'-mode planes are OPAQUE and
// coloured from a CPU-baked colormap atlas (uPlaneAtlasTex): the encoder bakes
// each plane's colormap into its own atlas tile, so different planes may
// reference different fields with no extra 3D textures.
//
// Cell clipping mirrors the raster material.clippingPlanes exactly: the hit
// point is transformed to fractional cell coordinates via uCellWorldToFrac
// (the inverse of the lattice-vector basis, origin 0) and rejected outside
// [0-eps, 1+eps]^3 (eps 1e-3, matching makeCellClippingPlanes' offset). Because
// intersectPlanes is reached through each shader's SceneIntersect, planes cast
// shadows and appear in reflections for free.
//
// "Scene without planes pays nothing": uPlaneCount == 0 short-circuits the loop
// and a 1x1 dummy atlas is bound. fetchData()/uEPS_intersect are provided by
// the including shader (planeChunk is injected right after fieldChunk).

export const planeChunk = /* glsl */`
uniform int uPlaneCount;
uniform sampler2D uPlanesDataTexture;
uniform sampler2D uPlaneAtlasTex;
uniform mat4 uCellWorldToFrac; // world -> fractional cell coords (for clipping)

// Ray-trace the encoded lattice planes. Returns true and fills the outputs for
// the nearest plane hit strictly before bestT (inside the cell); the normal is
// flipped to face the ray (double-sided). Flat 'None' planes carry their grey
// colour + alpha; 'Field' planes sample the colormap atlas (alpha 1).
bool intersectPlanes(vec3 ro, vec3 rd, float bestT,
	out float outT, out vec3 outNormal, out vec3 outColor, out float outAlpha)
{
	bool hit = false;
	float bt = bestT;
	for (int i = 0; i < uPlaneCount; i++)
	{
		int o = i * 6;
		vec4 nd = fetchData(uPlanesDataTexture, o); // normal.xyz, d
		vec3 n = nd.xyz;
		float denom = dot(n, rd);
		if (abs(denom) < 1e-9) continue; // ray parallel to the plane
		float t = (nd.w - dot(n, ro)) / denom;
		if (t < uEPS_intersect || t >= bt) continue;

		vec3 p = ro + (t * rd);
		// cell clip: fractional cell coordinates must lie in [0-eps, 1+eps]^3
		vec3 fr = (uCellWorldToFrac * vec4(p, 1.0)).xyz;
		if (any(lessThan(fr, vec3(-1e-3))) || any(greaterThan(fr, vec3(1.0 + 1e-3))))
			continue;

		vec4 c1 = fetchData(uPlanesDataTexture, o + 1); // flatColor.rgb, alpha
		vec4 c2 = fetchData(uPlanesDataTexture, o + 2); // centroid.xyz, mode
		vec3 col = c1.rgb;
		float alpha = c1.a;
		if (c2.w > 0.5) // Field mode: colormap atlas lookup
		{
			vec4 uA = fetchData(uPlanesDataTexture, o + 3); // uAxis.xyz, halfU
			vec4 vA = fetchData(uPlanesDataTexture, o + 4); // vAxis.xyz, halfV
			vec4 rect = fetchData(uPlanesDataTexture, o + 5); // atlas uMin,vMin,uSize,vSize
			vec3 rel = p - c2.xyz;
			float su = dot(rel, uA.xyz) / max(uA.w, 1e-6); // [-1, 1] across the rect
			float sv = dot(rel, vA.xyz) / max(vA.w, 1e-6);
			vec2 uv = rect.xy + clamp(vec2(su * 0.5 + 0.5, sv * 0.5 + 0.5), 0.0, 1.0) * rect.zw;
			col = texture(uPlaneAtlasTex, uv).rgb;
			alpha = 1.0;
		}

		bt = t;
		outT = t;
		outNormal = denom < 0.0 ? n : -n; // double-sided: face the ray
		outColor = col;
		outAlpha = alpha;
		hit = true;
	}
	return hit;
}
`;
