// Shared GLSL chunk: ray-marched implicit isosurface of a volumetric field,
// used by BOTH the ray-tracing (sceneFragment.js) and path-tracing
// (pathtrace/ptSceneFragment.js) scene shaders. It renders the SAME field the
// raster pipelines draw as a marching-cubes mesh (groups.isosurfaceGroup), but
// as an implicit surface found by ray marching — no mesh, no CPU triangles.
//
// The field values live in a Data3DTexture (RedFormat/FloatType, uploaded by
// SceneEncoder._encodeField). sampleField() does trilinear reconstruction
// MANUALLY (8 texelFetch taps), mirroring model/Field.getValueAtPoint (which
// clamps at the grid boundary — the raster marching cubes reconstructs the
// same clamped grid, so we match it; for typical decaying fields the boundary
// behaviour is moot). intersectField() transforms the ray into fractional
// [0,1]^3 cube space via uFieldWorldToFrac (the INVERSE of the same
// origin+voxel*dims mapping the Isosurface group uses), slab-tests the cube,
// coarse-marches for a sign change of (f - iso), then refines by bisection.
//
// Because this function is also reached through each shader's SceneIntersect
// (used for shadow / reflection / GI rays too), the field casts shadows and
// appears in reflections for free. The per-shader glue (setting the shader's
// own hit globals + material type) stays in each scene shader; everything
// physical lives here so the two shaders share one implementation.
//
// The field surface honors the per-structure tracer material
// (structure.fieldMaterial, encoded into uFieldMaterial) for every material
// type EXCEPT glass; alpha < 1 still gives the existing stochastic see-through
// (raster-like translucency, resolved by the accumulation). Glass/refraction
// is NOT supported on the field surface (it falls back to the default).

export const fieldChunk = /* glsl */`
uniform bool uFieldEnabled;
uniform highp sampler3D uFieldTex;
uniform mat4 uFieldWorldToFrac; // world -> fractional [0,1]^3 cube
uniform ivec3 uFieldDims;
// Periodic display boundary (general.periodicBounds) in that fractional space.
// [0,1] is the plain unit cell; wider bounds march the neighbouring cells too
// and uFieldWrap makes the sample coordinate periodic, which is the tracer's
// equivalent of the raster pipelines' translated + clipped mesh copies.
uniform vec3 uFieldBoundsMin;
uniform vec3 uFieldBoundsMax;
uniform bool uFieldWrap;
uniform float uFieldIso;
uniform bool uFieldAbsMode; // true: two lobes at +/-|iso| (pos/neg colours)
uniform vec3 uFieldPosColor;
uniform vec3 uFieldNegColor;
uniform float uFieldAlpha;
uniform vec4 uFieldMaterial; // encoded tracer material texel (type, roughness, typeParam, reflectivity)

// Trilinear reconstruction of the field at a fractional-space point. Mirrors
// model/Field.getValueAtPoint: continuous index = frac * (dims - 1), floor,
// upper neighbour clamped to dims - 1 (grid-boundary clamp, not periodic).
float sampleField(vec3 frac)
{
	ivec3 maxIdx = uFieldDims - ivec3(1);
	// Outside the unit cell the field simply repeats (that is what makes the
	// display boundary meaningful for it), so fold the coordinate back in.
	// Guarded by uFieldWrap so the in-cell case keeps the exact clamp above.
	vec3 fw = uFieldWrap ? frac - floor(frac) : frac;
	vec3 g = clamp(fw, 0.0, 1.0) * vec3(maxIdx);
	ivec3 i0 = ivec3(floor(g));
	vec3 f = g - vec3(i0);
	i0 = clamp(i0, ivec3(0), maxIdx);
	ivec3 i1 = min(i0 + ivec3(1), maxIdx);
	float v000 = texelFetch(uFieldTex, ivec3(i0.x, i0.y, i0.z), 0).r;
	float v100 = texelFetch(uFieldTex, ivec3(i1.x, i0.y, i0.z), 0).r;
	float v010 = texelFetch(uFieldTex, ivec3(i0.x, i1.y, i0.z), 0).r;
	float v110 = texelFetch(uFieldTex, ivec3(i1.x, i1.y, i0.z), 0).r;
	float v001 = texelFetch(uFieldTex, ivec3(i0.x, i0.y, i1.z), 0).r;
	float v101 = texelFetch(uFieldTex, ivec3(i1.x, i0.y, i1.z), 0).r;
	float v011 = texelFetch(uFieldTex, ivec3(i0.x, i1.y, i1.z), 0).r;
	float v111 = texelFetch(uFieldTex, ivec3(i1.x, i1.y, i1.z), 0).r;
	float v00 = mix(v000, v100, f.x);
	float v10 = mix(v010, v110, f.x);
	float v01 = mix(v001, v101, f.x);
	float v11 = mix(v011, v111, f.x);
	float v0 = mix(v00, v10, f.y);
	float v1 = mix(v01, v11, f.y);
	return mix(v0, v1, f.z);
}

// Ray-march the implicit isosurface. Returns true and fills outT (world-valid
// distance along rayDirection), outNormal (world, faces the ray) and outColor
// (pos/neg lobe colour) on the first crossing before bestT.
bool intersectField(vec3 ro, vec3 rd, float bestT, out float outT, out vec3 outNormal, out vec3 outColor)
{
	// into fractional cube space; direction NOT renormalized so t stays
	// world-valid (same trick the cylinders use)
	vec3 fo = (uFieldWorldToFrac * vec4(ro, 1.0)).xyz;
	vec3 fd = (uFieldWorldToFrac * vec4(rd, 0.0)).xyz;

	// slab-test the display-boundary box (the unit cube [0,1]^3 by default)
	vec3 invD = 1.0 / fd;
	vec3 tA = (uFieldBoundsMin - fo) * invD;
	vec3 tB = (uFieldBoundsMax - fo) * invD;
	vec3 tsm = min(tA, tB);
	vec3 tbg = max(tA, tB);
	float tNear = max(max(tsm.x, tsm.y), tsm.z);
	float tFar = min(min(tbg.x, tbg.y), tbg.z);
	tNear = max(tNear, 0.0);
	tFar = min(tFar, bestT);
	if (tFar <= tNear) return false;

	float A = abs(uFieldIso);
	// Step count follows the grid resolution AND how many cells the display
	// boundary spans, so a widened boundary is marched as finely as one cell
	// (still capped by the loop bound below).
	vec3 span = uFieldBoundsMax - uFieldBoundsMin;
	float cells = max(max(max(span.x, span.y), span.z), 1.0);
	int steps = int(clamp(1.5 * float(max(max(uFieldDims.x, uFieldDims.y), uFieldDims.z)) * cells, 64.0, 384.0));
	float dt = (tFar - tNear) / float(steps);

	float tPrev = tNear;
	float fPrev = sampleField(fo + fd * tPrev);
	bool found = false;
	float thr = uFieldIso;
	vec3 lobeColor = uFieldIso >= 0.0 ? uFieldPosColor : uFieldNegColor;

	for (int s = 1; s <= 384; s++)
	{
		if (s > steps) break;
		float tc = min(tNear + dt * float(s), tFar);
		float fc = sampleField(fo + fd * tc);
		if (uFieldAbsMode)
		{
			if ((fPrev - A) * (fc - A) < 0.0) { thr = A; lobeColor = uFieldPosColor; found = true; }
			else if ((fPrev + A) * (fc + A) < 0.0) { thr = -A; lobeColor = uFieldNegColor; found = true; }
		}
		else if ((fPrev - uFieldIso) * (fc - uFieldIso) < 0.0)
		{
			found = true;
		}
		if (found)
		{
			// bisection refine between tPrev and tc on (sampleField - thr)
			float ta = tPrev, tb = tc;
			float fa = fPrev - thr;
			for (int b = 0; b < 8; b++)
			{
				float tm = 0.5 * (ta + tb);
				float fm = sampleField(fo + fd * tm) - thr;
				if (fa * fm <= 0.0) { tb = tm; } else { ta = tm; fa = fm; }
			}
			outT = 0.5 * (ta + tb);
			break;
		}
		tPrev = tc;
		fPrev = fc;
		if (tc >= tFar) break;
	}
	if (!found) return false;

	outColor = lobeColor;

	// central-difference gradient (one voxel step per axis) in fractional
	// space; the world normal is transpose(worldToFrac 3x3) * gradFrac
	// (normals transform by the inverse-transpose of the model matrix, and
	// fracToWorld = inverse(worldToFrac))
	vec3 fh = fo + fd * outT;
	vec3 h = 1.0 / vec3(uFieldDims);
	vec3 gradFrac = vec3(
		sampleField(fh + vec3(h.x, 0.0, 0.0)) - sampleField(fh - vec3(h.x, 0.0, 0.0)),
		sampleField(fh + vec3(0.0, h.y, 0.0)) - sampleField(fh - vec3(0.0, h.y, 0.0)),
		sampleField(fh + vec3(0.0, 0.0, h.z)) - sampleField(fh - vec3(0.0, 0.0, h.z)));
	vec3 nWorld = transpose(mat3(uFieldWorldToFrac)) * gradFrac;
	if (dot(nWorld, nWorld) < 1e-20) nWorld = -rd; // degenerate gradient guard
	nWorld = normalize(nWorld);
	if (dot(nWorld, rd) > 0.0) nWorld = -nWorld; // double-sided: face the ray
	outNormal = nWorld;
	return true;
}
`;
