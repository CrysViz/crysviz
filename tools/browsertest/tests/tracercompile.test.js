// Async shader-compile gate for the ray/path tracers (RayTracingPipeline +
// PathTracingPipeline). Switching to a tracer used to freeze the browser for
// SECONDS: the assembled scene-trace ShaderMaterial is thousands of GLSL lines,
// and its synchronous gl.linkProgram fired lazily on the first traced frame one
// RAF after activation, hanging the tab. The gate defers that link off the
// activation frame: the first render() PAINTS feedback (a "Compiling…" strip +,
// when the raster preview is on, an interactive preview frame) and kicks
// renderer.compileAsync in a macrotask; accumulation begins only once the
// program is ready (_shaderState pending -> compiling -> ready). On Chromium
// KHR_parallel_shader_compile makes that genuinely non-blocking; on Firefox
// (this env, no extension) the link is still synchronous but deferred until
// AFTER the compiling frame paints, so the user sees "Compiling…" not a freeze.
//
// This test drives pipeline.render() deterministically inside synchronous
// evaluate blocks (RAF frames cannot interleave) to observe the state machine,
// asserts uSampleCounter never advances during the compile window, that a
// preview frame is drawn (and, with preview OFF, is NOT), that both tracers
// re-enter the gate on a fresh switch, and that disposing mid-compile makes a
// late compile resolve a no-op (no page errors).
'use strict';
const H = require('../harness');

/** Poll a page.evaluate predicate closure until true or the deadline elapses. */
async function pollTrue(page, evalFn, timeoutMs = 120000, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(evalFn)) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(stepMs);
  }
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Keep software-GL tracing cheap for the accumulation asserts.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25;
  });

  // --- (1) A fresh pipeline instance starts in _shaderState 'pending' -----------
  const initialState = await page.evaluate(async () => {
    const { RayTracingPipeline } = await import('./render/pipeline/RayTracingPipeline.js');
    const p = new RayTracingPipeline();
    const s = p._shaderState;
    p.dispose(); // no render happened: pure field check, then clean up
    return s;
  });
  H.check('a fresh RayTracingPipeline starts in _shaderState "pending"',
    initialState === 'pending', JSON.stringify({ initialState }));

  // --- (2) Fresh switch to raytrace: pending -> compiling, counter stays 0 ------
  // Drive render() manually so no RAF frame can steal the first (pending) frame;
  // setActivePipeline itself does not render synchronously.
  const fresh = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { setActivePipeline } = await import('./render/pipeline/index.js');
    setActivePipeline('forward');
    const p = setActivePipeline('raytrace');
    const s0 = p._shaderState; // 'pending' — no frame rendered yet
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: true };
    p.render(ctx); // pending -> compiling (paints, schedules compileAsync in a macrotask)
    const s1 = p._shaderState;
    const cnt1 = p._uniforms.uSampleCounter.value;
    const previewDrawn = p._previewActive;
    p.render(ctx); // still compiling: paints again, no accumulation, no new compile
    const s2 = p._shaderState;
    const cnt2 = p._uniforms.uSampleCounter.value;
    return { s0, s1, s2, cnt1, cnt2, previewDrawn };
  });
  H.check('fresh raytrace switch: pending -> compiling on the first frame, then stays compiling',
    fresh.s0 === 'pending' && fresh.s1 === 'compiling' && fresh.s2 === 'compiling',
    JSON.stringify(fresh));
  H.check('uSampleCounter stays 0 through the compile window',
    fresh.cnt1 === 0 && fresh.cnt2 === 0, JSON.stringify(fresh));
  H.check('a preview frame is drawn during the compile window (preview ON)',
    fresh.previewDrawn === true, JSON.stringify(fresh));

  // --- (3) The macrotask compile resolves -> ready, then accumulation starts ----
  const reachedReady = await pollTrue(page, async () => {
    const { app } = await import('./state/store.js');
    return app.pipeline?._shaderState === 'ready';
  });
  H.check('compileAsync resolves and the raytracer becomes ready', reachedReady);
  const accumulates = await pollTrue(page, async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return p?._shaderState === 'ready' && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 1;
  });
  H.check('accumulation starts (uSampleCounter >= 1) only once ready', accumulates);

  // --- (4) Forced compile window (deterministic hook): preview frame, no accum --
  const forced = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline; // ready raytrace, preview ON
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: true };
    p.render(ctx); // one settled traced frame
    const counterBefore = p._uniforms.uSampleCounter.value;
    // Force the compile window and drive a single frame: a preview must be drawn
    // and uSampleCounter must NOT advance. Setting 'compiling' (not 'pending')
    // means no new compileAsync is scheduled — just the paint path.
    p._previewActive = false;
    p._shaderState = 'compiling';
    p.render(ctx);
    const stateStill = p._shaderState;
    const previewDrawn = p._previewActive;
    const counterAfter = p._uniforms.uSampleCounter.value;
    p._shaderState = 'ready'; // restore
    p._previewActive = false; // avoid a spurious resume-flush on the next frame
    return { counterBefore, counterAfter, previewDrawn, stateStill };
  });
  H.check('a forced-compiling render draws a preview frame and does not accumulate',
    forced.previewDrawn === true && forced.counterAfter === forced.counterBefore
      && forced.stateStill === 'compiling', JSON.stringify(forced));

  // --- (5) Compile window with preview OFF: canvas untouched, still no accum ----
  const noPreview = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: true };
    general.rtRasterPreview = false;
    p.render(ctx); // _syncPreviewLifecycle tears the preview instance down
    const previewGone = !p._previewPipeline;
    const counterBefore = p._uniforms.uSampleCounter.value;
    p._previewActive = false;
    p._shaderState = 'compiling';
    p.render(ctx); // no preview instance: paints only the strip, leaves the canvas
    const counterAfter = p._uniforms.uSampleCounter.value;
    const previewDrawn = p._previewActive;
    p._shaderState = 'ready'; // restore
    general.rtRasterPreview = true;
    p._syncPreviewLifecycle(); // recreate the preview instance for later parts
    return { previewGone, counterBefore, counterAfter, previewDrawn };
  });
  H.check('compile window with preview OFF: no preview frame, no accumulation, no crash',
    noPreview.previewGone && noPreview.previewDrawn === false
      && noPreview.counterAfter === noPreview.counterBefore, JSON.stringify(noPreview));

  // --- (6) Fresh switch raytrace -> pathtrace re-enters the gate (own programs) --
  const pt = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { setActivePipeline } = await import('./render/pipeline/index.js');
    const p = setActivePipeline('pathtrace');
    const s0 = p._shaderState;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: true };
    p.render(ctx); // pending -> compiling for PT's own program set
    const s1 = p._shaderState;
    const cnt = p._uniforms.uSampleCounter.value;
    return { id: p.id, s0, s1, cnt };
  });
  H.check('switching raytrace -> pathtrace re-enters the compile gate (pending -> compiling)',
    pt.id === 'pathtrace' && pt.s0 === 'pending' && pt.s1 === 'compiling' && pt.cnt === 0,
    JSON.stringify(pt));
  const ptReady = await pollTrue(page, async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return p?.id === 'pathtrace' && p?._shaderState === 'ready'
      && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 1;
  });
  H.check('pathtrace compiles its own program set and then accumulates', ptReady);

  // --- (7) Dispose mid-compile: a late compile resolve must no-op ------------------
  const disposeGuard = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { setActivePipeline } = await import('./render/pipeline/index.js');
    const p = setActivePipeline('raytrace');
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: true };
    p.render(ctx); // -> compiling, schedules compileAsync in a macrotask
    const wasCompiling = p._shaderState === 'compiling';
    // Switch away BEFORE the macrotask fires (disposes p synchronously).
    const q = setActivePipeline('forward');
    const disposed = p._disposed === true;
    return { wasCompiling, disposed, activeId: q.id };
  });
  H.check('switching away mid-compile disposes the tracer (late resolve will no-op)',
    disposeGuard.wasCompiling && disposeGuard.disposed && disposeGuard.activeId === 'forward',
    JSON.stringify(disposeGuard));
  // Let the orphaned macrotask compile fire; the _disposed guard must swallow it.
  await page.waitForTimeout(2000);

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
