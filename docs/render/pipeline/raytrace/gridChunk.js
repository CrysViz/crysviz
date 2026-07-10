// Shared GLSL chunk: a uniform-grid (3D-DDA) accelerator over the atom +
// cylinder primitives, used by BOTH the ray-tracing (sceneFragment.js) and
// path-tracing (pathtrace/ptSceneFragment.js) scene shaders. It replaces the
// two brute-force primitive loops with an Amanatides-Woo grid walk when the
// scene is large enough (SceneEncoder builds the grid only above
// GRID_MIN_PRIMS; below that the brute loops stay). Polyhedra/planes/field
// keep their own analytic paths — the grid holds atoms + cylinders only.
//
// INCLUDE-ORDER CONTRACT: the including shader must define, BEFORE `${gridChunk}`:
//   - `fetchData(sampler2D, int) -> vec4` (the data-texture texel fetch),
//   - `gridTestAtom(int prim, int shadowFlag, inout float t) -> int` and
//     `gridTestCylinder(int prim, int shadowFlag, inout float t) -> int`
//     (thin wrappers over the shader's own per-primitive testAtom/testCylinder
//     — the SAME functions the brute loops call, so grid and brute execute
//     byte-identical per-primitive code; they return 1 on a shadow-opaque
//     early-out).
// The grid textures (SceneEncoder): gridCellsTexture = 1 texel/cell
// (offset, count, 0, 0); gridIndexTexture = 4 entries/texel (RGBA), each entry
// = primIndex*2 + typeBit (0 atom, 1 cylinder), stored as a float.

export const gridChunk = /* glsl */`
uniform bool uGridEnabled;
uniform vec3 uGridMin;          // grid box min corner (world)
uniform vec3 uGridInvCellSize;  // dims / extent, per axis (world -> cell units)
uniform ivec3 uGridDims;        // cell counts per axis (<= 64)
uniform sampler2D uGridCellsTex; // 1 texel/cell: (offset, count, 0, 0)
uniform sampler2D uGridIndexTex; // 4 entries/texel: primIndex*2 + typeBit

// Test every primitive registered in one grid cell against the ray. Returns 1
// on a shadow-opaque early-out (propagated up to stop the whole traversal).
int gridTestCell(int cellIdx, int shadowFlag, inout float t)
{
	vec4 cellData = fetchData(uGridCellsTex, cellIdx);
	int offset = int(cellData.x + 0.5);
	int count = int(cellData.y + 0.5);
	for (int e = 0; e < count; e++)
	{
		int gi = offset + e;
		int te = gi / 4;
		int ch = gi - te * 4;         // 0..3 channel within the RGBA texel
		float entry = fetchData(uGridIndexTex, te)[ch];
		int packed = int(entry + 0.5);
		int prim = packed / 2;
		int typeBit = packed - prim * 2;
		if (typeBit == 0)
		{
			if (gridTestAtom(prim, shadowFlag, t) == 1) return 1;
		}
		else
		{
			if (gridTestCylinder(prim, shadowFlag, t) == 1) return 1;
		}
	}
	return 0;
}

// Amanatides-Woo 3D-DDA over the uniform grid. Slab-clips the ray to the grid
// box, then walks cell by cell front-to-back, testing each cell's primitives
// (t threads through so later cells early-out). EXACT termination: once the
// best hit t is <= the current cell's exit distance, no later cell can hold a
// closer hit, so stop (a multi-cell primitive's true intersection is found the
// first time it is tested — in the earliest cell along the ray that holds it).
// Returns 1 on a shadow-opaque early-out. On a plain miss it leaves t/globals
// untouched, exactly like the brute loops finishing with no hit.
int GridTraverse(vec3 ro, vec3 rd, int shadowFlag, inout float t)
{
	vec3 invDir = 1.0 / rd;
	vec3 cellSize = 1.0 / uGridInvCellSize;
	vec3 gridMax = uGridMin + vec3(uGridDims) * cellSize;
	// slab-clip to the grid box
	vec3 ta = (uGridMin - ro) * invDir;
	vec3 tb = (gridMax - ro) * invDir;
	vec3 tsm = min(ta, tb);
	vec3 tbg = max(ta, tb);
	float tEnter = max(max(tsm.x, tsm.y), max(tsm.z, 0.0));
	float tExit = min(min(tbg.x, tbg.y), min(tbg.z, t));
	if (tEnter > tExit) return 0; // ray misses the grid box (within [0, t])

	vec3 pEnter = ro + rd * tEnter;
	vec3 rel = (pEnter - uGridMin) * uGridInvCellSize;
	ivec3 cell = clamp(ivec3(floor(rel)), ivec3(0), uGridDims - 1);

	// per-axis DDA setup
	ivec3 stepDir;
	vec3 tMax, tDelta;
	for (int a = 0; a < 3; a++)
	{
		if (rd[a] > 0.0)
		{
			stepDir[a] = 1;
			float boundary = uGridMin[a] + float(cell[a] + 1) * cellSize[a];
			tMax[a] = tEnter + (boundary - pEnter[a]) * invDir[a];
			tDelta[a] = cellSize[a] * invDir[a];
		}
		else if (rd[a] < 0.0)
		{
			stepDir[a] = -1;
			float boundary = uGridMin[a] + float(cell[a]) * cellSize[a];
			tMax[a] = tEnter + (boundary - pEnter[a]) * invDir[a];
			tDelta[a] = -cellSize[a] * invDir[a];
		}
		else
		{
			stepDir[a] = 0;
			tMax[a] = INFINITY;
			tDelta[a] = INFINITY;
		}
	}

	int maxSteps = uGridDims.x + uGridDims.y + uGridDims.z + 3;
	for (int iter = 0; iter < maxSteps; iter++)
	{
		int cellIdx = (cell.z * uGridDims.y + cell.y) * uGridDims.x + cell.x;
		if (gridTestCell(cellIdx, shadowFlag, t) == 1) return 1;

		float cellExit = min(tMax.x, min(tMax.y, tMax.z));
		if (t <= cellExit) return 0; // no later cell can beat the current best

		// step to the next cell along the nearest boundary
		if (tMax.x <= tMax.y && tMax.x <= tMax.z)
		{
			cell.x += stepDir.x;
			if (cell.x < 0 || cell.x >= uGridDims.x) return 0;
			tMax.x += tDelta.x;
		}
		else if (tMax.y <= tMax.z)
		{
			cell.y += stepDir.y;
			if (cell.y < 0 || cell.y >= uGridDims.y) return 0;
			tMax.y += tDelta.y;
		}
		else
		{
			cell.z += stepDir.z;
			if (cell.z < 0 || cell.z >= uGridDims.z) return 0;
			tMax.z += tDelta.z;
		}
	}
	return 0;
}
`;
