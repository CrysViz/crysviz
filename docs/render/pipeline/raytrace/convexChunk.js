// Shared GLSL chunk: a STREAMING convex-polyhedron ray intersector, used by
// BOTH the ray-tracing (sceneFragment.js) and path-tracing
// (pathtrace/ptSceneFragment.js) scene shaders. It is a byte-equivalent
// re-expression of the vendored ConvexPolyhedronIntersect (identical in both
// libs: docs/external/three-raytracing/RayTracingCommon.js and
// docs/external/three-pathtracing/PathTracingCommon.js, THREE.ShaderChunk
// ['*_convexpolyhedron_intersect']), with ONE change: the fixed
// `vec4 planes[20]` argument is gone — each plane is fetched on demand from
// uPolyDataTexture via fetchData. That removes the 20-plane fixed-array limit
// entirely (arbitrary planeCount, capped only by the encoder's texture/perf
// sanity bound) and lowers register pressure (no local 20-vec4 array), while
// touching NO vendored file.
// This file is part of CrysViz and is licensed under AGPL-3.0 (see the
// repository LICENSE). The CC0 dedication applies only to the original
// upstream material it adapts; the adaptations and all CrysViz additions
// in this file are AGPL-3.0.
//
// Byte-equivalence: the loop body, the t0/n0 (max entering, dot<0) vs t1/n1
// (min exiting, dot>0) bookkeeping, the UNCONDITIONAL division (a parallel
// plane yields ±INF/NaN whose sign-guarded comparisons are inert — NO epsilon
// "fix"), and the return ladder (t0>t1 -> INFINITY; t0>0 -> t0,n0; else t1>0 ->
// t1,n1 [origin-inside -> exit face + exit normal, which glass refraction
// through closed polys depends on]; else INFINITY) are reproduced verbatim.
//
// INCLUDE-ORDER CONTRACT: the including shader must define, BEFORE
// `${convexChunk}`:
//   - `fetchData(sampler2D, int) -> vec4` (the data-texture texel fetch),
//   - the `uPolyDataTexture` sampler uniform,
// and INFINITY must be in scope (the vendored uniforms/core includes provide
// it). The dynamic `planeCount` loop bound is the established shader style
// (uAtomCount / uCylinderCount loops).

export const convexChunk = /* glsl */`
// Streaming byte-equivalent of the vendored ConvexPolyhedronIntersect: clips
// the ray against planeCount planes fetched from uPolyDataTexture starting at
// texel planeOffset. See convexChunk.js header for the equivalence argument.
float ConvexPolyStreamIntersect( vec3 ro, vec3 rd, int planeOffset, int planeCount, out vec3 n )
{
	vec3 n0, n1;
	float t;
	float t0 = -INFINITY;
	float t1 = INFINITY;
	float plane_dot_rayDir;

	for (int i = 0; i < planeCount; i++)
	{
		vec4 plane = fetchData(uPolyDataTexture, planeOffset + i);
		plane_dot_rayDir = dot(plane.xyz, rd);

		t = (-dot(plane.xyz, ro) + plane.w) / plane_dot_rayDir;

		if (plane_dot_rayDir < 0.0 && t > t0)
		{
			t0 = t;
			n0 = plane.xyz;
		}
		if (plane_dot_rayDir > 0.0 && t < t1)
		{
			t1 = t;
			n1 = plane.xyz;
		}
	}

	if (t0 > t1) // check for invalid t0/t1 intersection pair
		return INFINITY;
	if (t0 > 0.0)
	{
		n = n0;
		return t0;
	}
	if (t1 > 0.0)
	{
		n = n1;
		return t1;
	}

	return INFINITY;
}
`;
