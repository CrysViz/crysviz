# Marching cubes (WASM)

A marching-cubes isosurface extractor compiled to WebAssembly, used to render
volumetric fields (charge density, etc.).

- Algorithm/source: Paul Bourke, *"Polygonising a scalar field"*
  (http://paulbourke.net/geometry/polygonise/), implemented in
  `marching_cubes.cpp`.
- Build: `make wasm-marching-cubes` in this directory (produces
  `MarchCubes.wasm` + `MarchCubes.js`). Only rebuild if you change the `.cpp`.
  The build used to live in a `compile.sh` of its own under
  `docs/external/marching_cubes_wasm/`; it is now a target in the same Makefile
  as the other two WASM modules.

## Files
- `marching_cubes.cpp` — C++ source.
- `MarchCubes.wasm`, `MarchCubes.js` — compiled output + JS glue.

## Beyond marching cubes

`MarchingCubes::default_isovalue(fraction)` returns a starting isosurface level:
the magnitude exceeded by `fraction` of the grid points, from a log-spaced
histogram in one pass over the field. It lives here because this module already
holds the field values in its own memory, so the panel's default costs no copy
and no sort — see `model/CompositeField.js` for the fallback and the reasoning
behind the rule.

## Memory budget and downsampling

The module is wasm32 (`MAXIMUM_MEMORY=4GB`), and each `MarchingCubes`
instance preallocates its output for the worst case: 136 bytes per grid point
(field, per-point normal cache, and vertex/normal lists sized for 5 vertices
per point; `marchingCubesBytes(nx, ny, nz)` returns the total). A 300x300x324
CHGCAR is ~3.7 GB of that, and before the normal cache was trimmed to one
normal per point it was more than wasm32 can address, which aborted the module.

`model/marchingCubesMemory.js` therefore budgets every instance (2 GB each,
3 GB across live instances, never below 256 MB) and, when a field is over,
plans the largest grid with the same aspect that fits. `resampleSlab()` fills
that grid by trilinear interpolation from a few source z-planes at a time
(64 MB slabs overlapping by one plane), so the full-resolution field never
enters the module's memory. Both grids span the same [0,1] grid fractions, so
the mesh lands in the same place. Allocation uses `new (std::nothrow)`:
`isAllocated()` is false when the heap cannot grow, and JS retries on a smaller
budget. `updateVertices()` stops at the list capacity and sets `isTruncated()`
instead of writing past the end. Tests: `tools/unittest/marchingcubesmemory.test.mjs`
(the last one runs `wav_data/CHGCAR` when it is present).
