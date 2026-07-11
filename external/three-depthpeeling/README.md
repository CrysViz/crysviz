# three-depthpeeling (adapted, vendored)

Depth peeling — exact order-independent transparency up to N peel layers.
Used by the `depthpeel` rendering pipeline
(`docs/render/pipeline/DepthPeelPipeline.js`).

- Upstream: https://github.com/gkjohnson/three-depthpeeling-demo
- Version: commit `e6b57e1f38d4adcabd8c594feb7a671731289c18` (2025)
- License: **MIT** — see `LICENSE` in this directory (Copyright (c) 2025
  Garrett Johnson).

**This is an adaptation, not a verbatim vendoring.** The upstream project is a
demo (one `index.js` mixing the technique with model loading, GUI and stats),
not an importable library. The two reusable pieces were extracted and adapted
to this app's rendering-pipeline architecture:

## Files

- `DepthPeelUtils.js` — adapted from the demo's `DepthPeelMaterialMixin`:
  patches existing material *instances* with the peel discard prologue.
- `DepthPeelPass.js` — adapted from the demo's `depthPeelRender()` +
  `onWindowResize()`: opaque stage (depth captured) → N peel passes with
  ping-ponged `DepthTexture`s → back-to-front composite blits.

## Local adaptations

1. **Instance patcher instead of a class mixin.** The demo subclasses material
   classes; this app patches configured material instances, chaining any
   existing `onBeforeCompile` and re-running the body on every shader compile
   so program rebuilds never drop the app's own shader injections.
2. **Uniform-driven peel state instead of `#define DEPTH_PEELING`/`FIRST_PASS`.**
   The demo's defines force a program rebuild on every peel-state change and
   require replacing `customProgramCacheKey` (which would collide with other
   patches, e.g. the WBOIT pipeline's). One program serves all states via
   `uPeelEnabled`/`uFirstPass` int uniforms; the discard conditions use nested
   ifs (GLSL need not short-circuit `&&`, and `nearDepth` is null on the first
   peel). `customProgramCacheKey` is composed (appended to), not replaced.
3. **Mesh gathering by material flags** (`depthPeelEnabled && transparent`)
   with cached blending/depth/forceSinglePass state restored after the frame —
   the demo used two fixed scene groups instead. Stage gating uses **layer
   masks rather than `visible`**: hiding a mesh would also hide its children,
   so an opaque child of a transparent mesh (e.g. a cel-shading hull-outline
   shell on a transparent polyhedron) could never render in any stage; a
   zeroed `layers.mask` skips only the object itself.
4. **`scene.background` handled once** (same fix as the vendored three-wboit):
   stages render with no background; it arrives via the opaque stage's clear
   color. A null background stays a transparent capture (PNG export).
5. **Tone mapping / color space for three r152+** (same fix as three-wboit):
   the color targets are XR-flagged with the renderer's output color space so
   scene renders into them tone-map/encode exactly like the default
   framebuffer (HalfFloat type avoids the hardware-sRGB internal-format path).
6. **Blits use a bare copy `ShaderMaterial`** instead of the demo's
   `MeshBasicMaterial`, which — rendered to the screen — would re-apply the
   renderer's tone mapping and output color-space conversion to
   already-encoded content.
7. **Lazy, renderer-driven sizing**: targets/depth textures resize from
   `renderer.getDrawingBufferSize()` inside `render()` (covers window resize
   and the PNG export's temporary size changes); peel layer targets grow/trim
   to `layerCount` (driven by the app's "Peel layers" slider).
- **Opaque-scene fast path (CrysViz)**: when the per-frame gather finds no
  transparent meshes at all, `DepthPeelPass.render()` renders one plain direct
  pass (identical to the forward pipeline) and skips the opaque-target, peel
  and composite passes entirely (`lastFrameFastPath` flags which path ran).
  This lets depth peeling be the app's default pipeline without taxing
  all-opaque scenes.
