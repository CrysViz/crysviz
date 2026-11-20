// Depth of field for both tracers: a thin lens focused on a PLANE, plus a
// sharp slab around it ("Focus depth").
//
// The vendored main chunks (raytracing_main / pathtracing_main) build the
// camera ray with a thin lens whose focal point lies at uFocusDistance along
// each pixel's own direction — a focal SPHERE around the camera, which at the
// edge of a 45° view is ~8 % nearer than at the centre. patchMainChunkDof()
// swaps that block for one focused on the plane perpendicular to the view at
// uFocusDistance, so the Visual window's focal-plane marker (render/
// FocusPlaneModule.js) shows exactly what is sharp.
//
// Focus depth (uFocusDepth, world units) keeps everything within
// ±uFocusDepth of the focal plane sharp — a large structure can be in focus
// as a whole while the foreground and background still blur. A single lens
// cannot do that (its blur grows linearly away from the focal plane), so the
// primary ray is traced in up to three segments, all passing through the same
// points of the pinhole ray: in front of the slab a lens ray focused on the
// slab's near face (blur grows towards the camera), inside the slab the
// pinhole ray itself (sharp), beyond it a lens ray focused on the far face
// (blur grows with distance). dofFocusZone() finds the first segment whose
// hit lies inside its depth range and leaves rayOrigin/rayDirection on that
// segment; the tracer's own loop then re-traces it. Costs at most two extra
// SceneIntersect calls per sample, and nothing at all while the aperture or
// the depth is 0.
//
// This file is original CrysViz work licensed under AGPL-3.0 (see the
// repository LICENSE).

/** Uniform + the globals the patched main block fills in. */
export const DOF_DECLARATIONS = /* glsl */`
uniform float uFocusDepth; // half-depth of the sharp slab around the focal plane (world units; 0 = thin lens)
vec3 gDofPinholeOrigin;    // the pinhole ray: origin (per-pixel offset for an orthographic camera) …
vec3 gDofPinholeDir;       // … and direction (unit)
vec3 gDofForward;          // camera forward (unit): depth is measured along it
vec3 gDofAperture;         // this sample's point on the lens, relative to the pinhole origin
`;

/**
 * The functions; `sceneIntersectCall` is the tracer's closest-hit call for a
 * camera ray (the two tracers' SceneIntersect signatures differ).
 * @param {string} sceneIntersectCall
 */
export function dofFunctions(sceneIntersectCall) {
  return /* glsl */`
// Direction from this sample's lens point to the pinhole ray's point on the
// plane at depth planeDepth (perpendicular to the view).
vec3 dofLensDirection(float planeDepth)
{
	float cosF = max(dot(gDofPinholeDir, gDofForward), 1e-4);
	vec3 focalPoint = gDofPinholeOrigin + gDofPinholeDir * (planeDepth / cosF);
	return normalize(focalPoint - (gDofPinholeOrigin + gDofAperture));
}

// Depth of a point along the view axis, from the pinhole origin.
float dofDepthOf(vec3 p) { return dot(p - gDofPinholeOrigin, gDofForward); }

// Focus depth: pick the segment of the bent primary ray the first hit lies
// on (see the file header). On entry rayOrigin/rayDirection are the lens ray
// focused on the slab's near face (set up by the patched main block).
void dofFocusZone()
{
	if (uApertureSize <= 0.0 || uFocusDepth <= 0.0) return;
	float nearDepth = uFocusDistance - uFocusDepth;
	float farDepth = uFocusDistance + uFocusDepth;
	float cosF = max(dot(gDofPinholeDir, gDofForward), 1e-4);
	float t;
	if (nearDepth > 0.0)
	{
		t = ${sceneIntersectCall};
		if (t < INFINITY && dofDepthOf(rayOrigin + rayDirection * t) < nearDepth) return;
		rayOrigin = gDofPinholeOrigin + gDofPinholeDir * (nearDepth / cosF);
	}
	else rayOrigin = gDofPinholeOrigin; // the slab starts at the camera: sharp from the start
	// inside the slab: the pinhole ray
	rayDirection = gDofPinholeDir;
	t = ${sceneIntersectCall};
	if (t < INFINITY && dofDepthOf(rayOrigin + rayDirection * t) <= farDepth) return;
	// beyond the slab: a lens ray focused on the far face, from the far face
	rayOrigin = gDofPinholeOrigin + gDofPinholeDir * (farDepth / cosF);
	rayDirection = dofLensDirection(farDepth);
}
`;
}

// The vendored block, from its comment to the assignment of rayDirection.
const VENDORED_DOF_BLOCK = /\t\/\/ depth of field\n[\s\S]*?\trayDirection = finalRayDir;\n/;

const PATCHED_DOF_BLOCK = `\t// depth of field (CrysViz: focal PLANE + sharp slab, raytrace/dofChunk.js)
\tfloat randomAngle = rng() * TWO_PI; // pick random point on aperture
\tfloat randomRadius = rng() * uApertureSize; // uniform disk of radius sqrt(uApertureSize)
\tvec3  randomAperturePos = ((camRight * cos(randomAngle)) + (camUp * sin(randomAngle))) * sqrt(randomRadius);
\tgDofPinholeOrigin = cameraPosition + (!uUseOrthographicCamera ? vec3(0) :
\t\t     (camRight * pixelPos.x * uULen * 100.0) + (camUp * pixelPos.y * uVLen * 100.0));
\tgDofPinholeDir = rayDir;
\tgDofForward = camForward;
\tgDofAperture = randomAperturePos;
\trayOrigin = gDofPinholeOrigin + randomAperturePos;
\t// a lens focused on the sharp slab's near face (the focal plane itself when
\t// uFocusDepth is 0); a slab reaching back to the camera starts sharp
\trayDirection = (uFocusDistance - uFocusDepth > 0.0) ? dofLensDirection(uFocusDistance - uFocusDepth) : gDofPinholeDir;
`;

/**
 * The vendored main chunk with the thin-lens block replaced and the focus
 * zone applied right after SetupScene(). Throws when the vendored text no
 * longer matches, so a vendor update cannot silently drop the patch.
 * @param {string} chunk  THREE.ShaderChunk['raytracing_main' | 'pathtracing_main']
 */
export function patchMainChunkDof(chunk) {
  if (!VENDORED_DOF_BLOCK.test(chunk)) throw new Error('dofChunk: vendored depth-of-field block not found');
  let out = chunk.replace(VENDORED_DOF_BLOCK, PATCHED_DOF_BLOCK);
  const setup = '\tSetupScene();\n';
  if (!out.includes(setup)) throw new Error('dofChunk: SetupScene() call not found');
  out = out.replace(setup, `${setup}\tdofFocusZone();\n`);
  return out;
}
