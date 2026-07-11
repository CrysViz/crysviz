# Marching cubes (WASM)

A marching-cubes isosurface extractor compiled to WebAssembly, used to render
volumetric fields (charge density, etc.).

- Algorithm/source: Paul Bourke, *"Polygonising a scalar field"*
  (http://paulbourke.net/geometry/polygonise/), implemented in
  `marching_cubes.cpp`.
- Build: Emscripten — see `compile.sh` (produces `MarchCubes.wasm` +
  `MarchCubes.js`). Only rebuild if you change the `.cpp`.

## Files
- `marching_cubes.cpp` — C++ source.
- `MarchCubes.wasm`, `MarchCubes.js` — compiled output + JS glue.
- `compile.sh` — Emscripten build script.
