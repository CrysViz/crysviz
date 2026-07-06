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
   both the chained `onBeforeCompile` and the WBOIT outputs. `wboitEnabled` is
   now set immediately in `patch()` (also fixes the mesh being misclassified by
   `WboitPass.gatherMeshes` until the first compile), and the `renderStage`
   property definition is guarded to keep the body idempotent.
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
7. **`WboitPass.js`: tone mapping / color space for three r152+.** Modern
   three forces `NoToneMapping` + linear output when rendering into offscreen
   targets, so the scene stages lost the renderer's ACES tone mapping and
   washed out. `baseTarget` is marked `isXRRenderTarget` with the renderer's
   output color space (the only renderer paths that flag touches are the
   tone-mapping/color-space gates), making scene stages render into it exactly
   like the default framebuffer; the copy/composite shaders' manual `uGamma`
   conversion is correspondingly disabled.
