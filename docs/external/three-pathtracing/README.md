# THREE.js-PathTracing-Renderer (vendored, adapted)

Real-time path tracing GLSL library for three.js — global illumination, soft
area-light shadows, progressive accumulation and an edge-aware denoiser. Used
by the `pathtrace` rendering pipeline
(`docs/render/pipeline/PathTracingPipeline.js`); sibling of the vendored
`docs/external/three-raytracing/` (same author/architecture — see that README).

- Upstream: https://github.com/erichlof/THREE.js-PathTracing-Renderer
- Version: commit `a86260d22d14f6ab26c6058e0a8f40a902005075` (branch `gh-pages`)
- License: **CC0 1.0 (public domain)** — see `LICENSE` in this directory.
- The CC0 dedication covers the upstream snapshot only. CrysViz's
  modifications in the adapted JavaScript files in this directory (the
  LOCAL ADAPTATIONS documented below) are licensed under the project's
  AGPL-3.0 (see the repository LICENSE); incorporated upstream material
  remains CC0 public domain, and the unmodified upstream assets (the
  LICENSE text and blue-noise texture) are untouched CC0 material.
  Attribution is not required by CC0; credited here and in the root
  NOTICE/README as a courtesy to Erich Loftis (@erichlof).

## Files

- `PathTracingCommon.js` — the GLSL chunk library: registers `pathtracing_*`
  chunks on `THREE.ShaderChunk` (camera-ray `pathtracing_main` with jittered
  progressive accumulation, native orthographic support and fwidth-based edge
  flags in the accumulation alpha; RNG/blue-noise core; analytic intersectors
  incl. spheres, unit cylinders, `ConvexPolyhedronIntersect`, bounding boxes;
  `sampleSphereLight` area-light sampling; Fresnel utilities). Chunk GLSL is
  byte-identical to upstream.
- `common_PathTracing_Vertex.js`, `ScreenCopy_Fragment.js`,
  `ScreenOutput_Fragment.js` — the pass shaders (fullscreen triangle vertex,
  accumulation ping-pong copy, edge-aware 37-tap denoise + sample averaging +
  tone-mapped screen output).
- `BlueNoise_R_128.png` — blue-noise texture required by the RNG chunk.

Upstream files NOT vendored: `js/InitCommon.js` and the per-demo js/html
(demo scaffolding — replaced by the app's rendering-pipeline driver), demo
fragment shaders (the app supplies its own scene shader:
`docs/render/pipeline/pathtrace/ptSceneFragment.js`), models/textures other
than the blue noise, loaders/BVH builders (triangle-model support — unused).

## Local adaptations

1. **`PathTracingCommon.js` is an ES module**: upstream assumes a global
   `THREE`; the vendored copy imports the vendored core
   (`../three/three.module.js`) and registers the chunks on it. `@ts-nocheck`
   headers per repo convention.
2. **`.glsl` files wrapped as exported template-literal strings** — this app
   has no bundler and does not fetch shader files at runtime.
3. **`ScreenOutput_Fragment`**: (a) source coordinates are mapped via new
   `uAccumResolution`/`uOutputResolution` uniforms (instead of 1:1
   `gl_FragCoord`) so the internal path-tracing resolution can be a fraction
   of the canvas ("RT resolution" control); (b) new `uUseDenoiser` uniform —
   when false the 37-tap edge-aware kernel is bypassed and the plain averaged
   sample is output (raw-convergence comparison, the "Denoiser" toggle).
4. **`ScreenOutput_Fragment` tone-mapping grade**: the upstream Reinhard
   operator is replaced by `ACESFilmicToneMapping` (from three's
   ShaderMaterial tone-mapping prelude, which already applies the renderer's
   toneMappingExposure) plus a `uExposure` extra multiplier (default 1) and a
   post-tone-map `uSaturation` control, so the traced image matches the
   raster pipelines' ACES color grade instead of Reinhard's desaturated
   midtones. A `uToneMapLegacy` bool restores the upstream Reinhard operator
   (skipping `uExposure`) — the app's "Legacy tone mapping" Advanced toggle.
