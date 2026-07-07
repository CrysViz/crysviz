# THREE.js-RayTracing-Renderer (vendored, adapted)

Real-time Whitted-style ray tracing GLSL library for three.js — reflections,
refractions, hard shadows, progressive accumulation. Used by the `raytrace`
rendering pipeline (`docs/render/pipeline/RayTracingPipeline.js`).

- Upstream: https://github.com/erichlof/THREE.js-RayTracing-Renderer
- Version: commit `74ff1e8a304ce1d0cf638069f337634e72a4a817`
- License: **CC0 1.0 (public domain)** — see `LICENSE` in this directory.
  Attribution is not required by CC0; credited here and in the root
  NOTICE/README as a courtesy to Erich Loftis (@erichlof).

## Files

- `RayTracingCommon.js` — the GLSL chunk library: registers `raytracing_*`
  chunks on `THREE.ShaderChunk` (camera-ray `raytracing_main` with jittered
  progressive accumulation and native orthographic support, RNG/blue-noise
  core, and the analytic intersectors: spheres, cylinders/capsules, boxes,
  quadrics, triangles, `ConvexPolyhedronIntersect`, …). Chunk GLSL is
  byte-identical to upstream.
- `CommonRayTracing_Vertex.js`, `ScreenCopy_Fragment.js`,
  `ScreenOutput_Fragment.js` — the pass shaders (fullscreen triangle vertex,
  accumulation ping-pong copy, sample-averaging + tone-mapped screen output).
- `BlueNoise_R_128.png` — blue-noise texture required by the RNG chunk.

Upstream files NOT vendored: `js/InitCommon.js` and the per-demo js/html
(demo scaffolding — pointer-lock controls, fullscreen-on-click, its own
renderer/loop; replaced by the app's rendering-pipeline driver), demo
fragment shaders (the app supplies its own scene shader:
`docs/render/pipeline/raytrace/sceneFragment.js`), `models/`, `textures/`
other than the blue noise, `GLTFLoader`/`BVH_Quick_Builder` (triangle-model
support — not used in v1).

## Local adaptations

1. **`RayTracingCommon.js` is an ES module**: upstream assumes a global
   `THREE`; the vendored copy imports the vendored core
   (`../three/three.module.js`) and registers the chunks on it. `@ts-nocheck`
   headers per repo convention.
2. **`.glsl` files wrapped as exported template-literal strings** — this app
   has no bundler and does not fetch shader files at runtime.
3. **`ScreenOutput_Fragment`**: samples the ray-traced texture via
   `gl_FragCoord / uOutputResolution` (new uniform) instead of a 1:1
   `texelFetch`, so the internal ray-tracing resolution can be a fraction of
   the canvas ("RT resolution" control; linear-filtered upscale).
4. **`ScreenOutput_Fragment` tone-mapping grade**: the upstream Reinhard
   operator is replaced by exposure (1.2) + `ACESFilmicToneMapping` (both from
   three's ShaderMaterial tone-mapping prelude) plus a post-tone-map
   `uSaturation` control, so the traced image matches the raster pipelines'
   ACES color grade instead of Reinhard's desaturated midtones.
