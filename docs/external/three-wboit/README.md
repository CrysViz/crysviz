# three-wboit (vendored)

Weighted, blended order-independent transparency (WBOIT) for three.js. Used by
the `wboit` rendering pipeline (`docs/render/pipeline/WboitPipeline.js`).

- Upstream: https://github.com/stevinz/three-wboit
- Version: **v1.0.15** (commit `d44c9450f8b240154cb840cb2bf503b1491b92eb`)
- License: **MIT** — see `LICENSE` in this directory. Portions © mrdoob and
  three.js authors, © Alexander Rose (see the notice at the end of
  `WboitPass.js`). Algorithm: McGuire & Bavoil, *Weighted Blended
  Order-Independent Transparency*, JCGT 2013.

## Files

- `WboitPass.js` — the multi-stage render pass (opaque → transparent → WBOIT
  accumulation → revealage → composite). Replaces a `renderer.render()` call.
- `WboitUtils.js` — `WboitUtils.patch(material)`: retrofits any material with
  the WBOIT stage outputs (chains an existing `onBeforeCompile`).
- `shaders/FillShader.js`, `shaders/WboitCompositeShader.js` — helper shaders
  used by the pass.
- `materials/MeshWboitMaterial.js` — upstream's WBOIT-enabled basic material;
  vendored for the `WboitStages` enum it exports (the app patches its own
  materials instead of using this material directly).

Upstream files not vendored: `src/index.js`, `src/shaders/MeshBasicShaderMaterial.js`,
`src/shaders/sRGBShader.js` (unused here), `build/`, `example/`.

## Local modifications

All marked with `LOCAL MODIFICATION (CrysViz)` comments in the sources:

1. **Imports rewritten** for the no-bundler app: `'three'` →
   `../three/three.module.js` (the bare specifier would resolve to the CDN
   import map in `docs/index.html`, mismatching the vendored core), and
   `'three/addons/postprocessing/{Pass,ShaderPass}.js'` →
   `../three/{Pass,ShaderPass}.js` (vendored alongside the other three.js
   addons). `// @ts-nocheck` headers added per repo convention.
2. **`WboitUtils.js`: stage outputs appended before the *last* `}`** instead of
   upstream's `replace(/}$/gm, ...)`, which injects at every line-final `}` and
   corrupts shaders whose chained `onBeforeCompile` already added braced GLSL
   (the app's instanced atom/bond shader patches).
3. **`WboitUtils.js`: patch body runs on every shader compile.** Upstream ran
   it once (guarded by `wboitEnabled`), so any later program rebuild dropped
   both the chained `onBeforeCompile` and the WBOIT outputs. `wboitEnabled` and
   the `renderStage` property are now set immediately in `patch()` — upstream
   defined both lazily at first compile, so (a) `WboitPass.gatherMeshes`
   misclassified the mesh until then, and (b) on the first frame after
   patching, `prepareWboitBlending` could not set the render stage, making the
   accumulation pass render plain additive colors — one garbage frame (visible
   on always-transparent content such as polyhedra, and sticky under
   on-demand rendering).
4. **`WboitPass.js`: fixed swapped depth-flag restoration** in
   `resetVisible()` — upstream restored `depthWrite` from the `depthTest`
   cache and vice versa, corrupting any material whose two flags differ.
5. **`WboitPass.js`: scene.background handled once.** Upstream repainted a
   `scene.background` in every stage render, and the stage blits force
   alpha=1 wherever anything was drawn — so later stages blitted the
   full-screen background over the opaque stage's content and polluted the
   accumulation buffer. Stages now render with `scene.background = null`; the
   background arrives via the opaque stage's clear color (null background
   stays a transparent capture, as the PNG export relies on).
6. **`WboitUtils.js`: revealage without the `gl_FragCoord.z` factor.** The
   paper's revealage term is the plain product of `(1 - alpha)`; upstream
   multiplied alpha by `gl_FragCoord.z`, which with this app's orthographic
   camera (far plane 1000, content at z≈0.02–0.04) collapsed transparent
   coverage to ~1%. Note the accumulation *weight* function still uses
   `gl_FragCoord.z`; over such a shallow depth range it saturates, so depth
   discrimination between overlapping transparent surfaces is weak (the blend
   approaches an alpha-weighted average — inherent to WBOIT here).
7. **Composite preserves the drawing buffer's alpha.** Upstream's composite
   shader output `alpha = revealage` and blended it into the canvas alpha,
   driving it towards ~0 wherever WBOIT content covered — invisible on an
   opaque canvas, but this app's canvas is `alpha:true` (transparent PNG
   export), so the page background bled through all WBOIT content (dark
   polyhedra picked up the dark-green page theme and looked translucent even
   at alpha 1). The composite now outputs COVERAGE (`1 - revealage`) with
   standard over color factors and separate alpha blend factors
   (`blendSrcAlpha = One`, `blendDstAlpha = OneMinusSrcAlpha`), which also
   makes the exported PNG alpha correct for WBOIT-only content.
8. **`WboitPass.js`: explicit `EXT_float_blend`.** The accumulation stage
   blends into the render target; blending with 32-bit float color buffers
   requires `EXT_float_blend`, which the upstream render-target probe never
   requested (browsers warn about the implicit enable, and `FloatType` could
   be selected on hardware without float blending). The extension is now
   requested explicitly and `FloatType` is only considered when it is present
   (half-float blending is core WebGL2).
9. **`WboitPass.js`: tone mapping / color space for three r152+.** Modern
   three forces `NoToneMapping` + linear output when rendering into offscreen
   targets, so the scene stages lost the renderer's ACES tone mapping and
   washed out. `baseTarget` is marked `isXRRenderTarget` with the renderer's
   output color space (the only renderer paths that flag touches are the
   tone-mapping/color-space gates), making scene stages render into it exactly
   like the default framebuffer; the copy/composite shaders' manual `uGamma`
   conversion is correspondingly disabled.
