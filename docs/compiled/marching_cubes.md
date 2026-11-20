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
