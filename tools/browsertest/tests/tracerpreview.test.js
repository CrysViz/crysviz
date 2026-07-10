// Interactive raster preview for the ray/path tracers (general.rtRasterPreview,
// default ON): while the user drives the view — camera motion OR a CORE scene
// edit (geometry/colors/planes/field) — the tracer renders cheap depth-peeled
// preview frames via a private persistent DepthPeelPipeline instead of tracing,
// and resumes accumulating once the scene has rested for
// general.rtPreviewRestDelay seconds. Tracer-only material/look edits never
// trigger it. Preview frames are gated on ctx.interactive (set only by the
// animate loop) so PNG export / manual render() always trace. This test drives
// pipeline.render() deterministically inside synchronous evaluate blocks (RAF
// frames cannot interleave), asserting the preview state machine, the trigger
// vs no-trigger split, transparency-policy routing through the preview
// instance, and — via the real RAF loop — that the rest timer re-enters
// tracing without further user input.
'use strict';
const H = require('../harness');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Decode a `data:image/png;base64,...` URL captured from the canvas. */
function decodeDataUrl(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Fraction of pixels that differ from the top-left (background) pixel by more
 *  than `thresh` in summed RGB — a crude "has rendered content" probe. */
function contentFraction(png, thresh = 40) {
  const bg = [png.data[0], png.data[1], png.data[2]];
  let n = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(png.data[o] - bg[0]) + Math.abs(png.data[o + 1] - bg[1])
      + Math.abs(png.data[o + 2] - bg[2]);
    if (d > thresh) n++;
  }
  return n / total;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- (1) Default ON + GUI visibility (both tracers, hidden under forward) --------
  const gui = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtPreviewToggle'));
    const delay = /** @type {HTMLInputElement|null} */ (document.getElementById('rtPreviewDelay'));
    const rtBlock = document.getElementById('rtResolutionScale')?.parentElement?.parentElement;
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    const disp = () => getComputedStyle(rtBlock).display;
    select.value = 'raytrace'; select.dispatchEvent(new Event('change'));
    const shownUnderRaytrace = disp() !== 'none';
    select.value = 'pathtrace'; select.dispatchEvent(new Event('change'));
    const shownUnderPathtrace = disp() !== 'none';
    select.value = 'forward'; select.dispatchEvent(new Event('change'));
    const hiddenUnderForward = disp() === 'none';
    return {
      setting: general.rtRasterPreview,
      toggleExists: !!toggle, toggleChecked: toggle?.checked === true,
      delayExists: !!delay, delayValue: delay ? parseFloat(delay.value) : null,
      shownUnderRaytrace, shownUnderPathtrace, hiddenUnderForward,
    };
  });
  H.check('raster preview defaults ON (general.rtRasterPreview + #rtPreviewToggle checked + #rtPreviewDelay=2)',
    gui.setting === true && gui.toggleExists && gui.toggleChecked
      && gui.delayExists && Math.abs(gui.delayValue - 2) < 1e-9, JSON.stringify(gui));
  H.check('preview controls show for both tracers and hide under forward',
    gui.shownUnderRaytrace && gui.shownUnderPathtrace && gui.hiddenUnderForward, JSON.stringify(gui));

  // Speed up software-GL tracing, then activate the ray tracer and wait for it
  // to be fully initialized (blue noise loads asynchronously).
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25;
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  {
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        return !!p?._blueNoise?.image && p?._initialized === true && !!p?._previewPipeline;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(1000);
    }
  }
  H.check('tracer holds a private preview pipeline instance', await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.pipeline?._previewPipeline?.id === 'depthpeel';
  }));

  // --- (3) Deterministic drive: camera motion -> preview frame (raster look) -------
  const move = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    // Settle (non-interactive traces), then clear any preview-window carryover.
    p.render(ctx); p.render(ctx);
    p._lastInteractionAt = 0;
    // Move the camera and render an INTERACTIVE frame -> preview.
    app.camera.position.x += 6; app.camera.updateMatrixWorld();
    p.render({ ...ctx, interactive: true });
    const shot = canvas.toDataURL('image/png');
    return {
      previewActive: p._previewActive,
      samples: p._uniforms.uSampleCounter.value,
      shot,
    };
  });
  const movePng = decodeDataUrl(move.shot);
  H.check('camera motion under a tracer renders a preview frame (not a trace)',
    move.previewActive === true && move.samples === 0,
    JSON.stringify({ previewActive: move.previewActive, samples: move.samples }));
  H.check('the preview frame draws raster content to the canvas',
    contentFraction(movePng) > 0.02, `content=${contentFraction(movePng).toFixed(4)}`);

  // --- (4) Export guard: a frame WITHOUT interactive:true always traces ------------
  const exportGuard = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx);
    p._lastInteractionAt = 0;
    // Move the camera but render WITHOUT the interactive flag (export / manual).
    app.camera.position.x += 6; app.camera.updateMatrixWorld();
    p.render(ctx); // no interactive flag -> traces despite the motion
    return { previewActive: p._previewActive, samples: p._uniforms.uSampleCounter.value };
  });
  H.check('a non-interactive render always traces (export guard)',
    exportGuard.previewActive === false && exportGuard.samples >= 1, JSON.stringify(exportGuard));

  // --- (5) CORE scene edit triggers the preview -----------------------------------
  const coreEdit = await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx);
    p._lastInteractionAt = 0;
    // Baseline: an interactive frame with NO edit and no motion must NOT preview.
    const noEdit = (() => { p.render({ ...ctx, interactive: true }); return p._previewActive; })();
    p._lastInteractionAt = 0;
    // Now bump the atom instance colors (a CORE scene change) and render interactive.
    if (groups.atomsMesh?.instanceColor) groups.atomsMesh.instanceColor.needsUpdate = true;
    p.render({ ...ctx, interactive: true });
    return { noEditPreview: noEdit, editPreview: p._previewActive };
  });
  H.check('a core scene edit triggers the preview; an idle interactive frame does not',
    coreEdit.noEditPreview === false && coreEdit.editPreview === true, JSON.stringify(coreEdit));

  // --- (6) Tracer-material edit does NOT trigger the preview (stays traced) --------
  const matEdit = await page.evaluate(async () => {
    const { app, fileBrowser } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx);
    p._lastInteractionAt = 0;
    // A per-atom TRACER material edit changes only the tracer-material fingerprint.
    const structure = fileBrowser.selectedStructure;
    structure.atomUserMaterials = structure.atomUserMaterials || {};
    structure.atomUserMaterials[0] = { type: 'glass', ior: 1.5 };
    p.render({ ...ctx, interactive: true });
    return {
      previewActive: p._previewActive,
      lastCore: p._encoder.lastChangeWasCoreScene,
      samples: p._uniforms.uSampleCounter.value,
    };
  });
  H.check('a tracer-only material edit stays live-traced (no preview)',
    matEdit.previewActive === false && matEdit.lastCore === false && matEdit.samples >= 1,
    JSON.stringify(matEdit));

  // --- (7) Transparency-policy routing through the preview instance ----------------
  const routing = await page.evaluate(async () => {
    const { app, groups, general, fileBrowser } = await import('./state/store.js');
    const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const structure = fileBrowser.selectedStructure;
    // Per-atom (not global) transparency: needsTransparency=true, opacity 1 ->
    // the staged split path creates a scene-root transparent overlay.
    structure.atoms[0].setOpacity(0.5);
    updateSingleAtomOpacity(0, 0.5);
    const overlay = groups.atomsMesh?.userData?.transparentOverlay;
    const overlayPresent = !!overlay && app.scene.children.includes(overlay);
    // Toggle the preview OFF: the next render()'s lifecycle sync tears the
    // preview down (disposing the overlay); a moving frame then routes via the
    // tracer's own motion-low-res path (no preview).
    general.rtRasterPreview = false;
    p.render(ctx); // fires _syncPreviewLifecycle -> teardown (disposes the overlay)
    const overlayGone = !groups.atomsMesh?.userData?.transparentOverlay;
    const previewInstanceGone = !p._previewPipeline;
    // Moving frame now traces through the motion-low-res path (no preview).
    app.camera.position.y += 6; app.camera.updateMatrixWorld();
    p.render({ ...ctx, interactive: true });
    const movedTraced = p._previewActive === false;
    // Restore the default for the persistence round-trip below.
    general.rtRasterPreview = true;
    return { overlayPresent, overlayGone, previewInstanceGone, movedTraced };
  });
  H.check('per-atom transparency routes through the preview instance (scene-root overlay exists)',
    routing.overlayPresent, JSON.stringify(routing));
  H.check('toggling the preview OFF disposes the overlay + instance; motion then traces',
    routing.overlayGone && routing.previewInstanceGone && routing.movedTraced, JSON.stringify(routing));

  // --- (8) Rest-delay expiry: the tracer resumes without further input -------------
  const before = await page.evaluate(async () => {
    const { app, general, groups } = await import('./state/store.js');
    general.rtRasterPreview = true;
    general.rtPreviewRestDelay = 0.5; // short window
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p._syncPreviewLifecycle(); // recreate the preview instance (toggled off in step 7)
    p.render(ctx); p.render(ctx); // settle
    p.resetAccumulation();
    p._lastInteractionAt = 0;
    // Enter the preview via a core edit; this arms the rearming rest timer.
    if (groups.atomsMesh?.instanceColor) groups.atomsMesh.instanceColor.needsUpdate = true;
    p.render({ ...ctx, interactive: true });
    return { previewActive: p._previewActive, samples: p._uniforms.uSampleCounter.value };
  });
  await page.waitForTimeout(1600); // > rest delay: the timer wakes the loop, which traces
  const after = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { previewActive: app.pipeline._previewActive, samples: app.pipeline._uniforms.uSampleCounter.value };
  });
  H.check('after the rest delay the tracer resumes and accumulates without user input',
    before.previewActive === true && before.samples === 0 && after.samples > 0,
    JSON.stringify({ before, after }));

  // --- (2) Persistence round trip (both keys, v2.11, DOM restore) ------------------
  const persist = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    general.rtRasterPreview = true;
    general.rtPreviewRestDelay = 2;
    const saved = captureState();
    const savedHasKeys = saved.style.rtRasterPreview === true
      && typeof saved.style.rtPreviewRestDelay === 'number';
    // Craft a restore with the preview OFF and a distinct delay, then apply it.
    const restoreState = JSON.parse(JSON.stringify(saved));
    restoreState.style.rtRasterPreview = false;
    restoreState.style.rtPreviewRestDelay = 3.5;
    applySharedState(restoreState);
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtPreviewToggle'));
    const delay = /** @type {HTMLInputElement|null} */ (document.getElementById('rtPreviewDelay'));
    const options = delay?.parentElement?.parentElement; // rtPreviewOptions wrapper
    return {
      version: saved.version, savedHasKeys,
      generalPreview: general.rtRasterPreview,
      generalDelay: general.rtPreviewRestDelay,
      toggleChecked: toggle?.checked === true,
      delayValue: delay ? parseFloat(delay.value) : null,
      optionsHidden: options ? getComputedStyle(options).display === 'none' : null,
    };
  });
  H.check('captureState persists both preview keys at v2.11',
    persist.version === '2.11' && persist.savedHasKeys, JSON.stringify(persist));
  H.check('applySharedState restores the preview toggle + delay to the DOM (row hidden when off)',
    persist.generalPreview === false && Math.abs(persist.generalDelay - 3.5) < 1e-9
      && persist.toggleChecked === false && Math.abs(persist.delayValue - 3.5) < 1e-9
      && persist.optionsHidden === true, JSON.stringify(persist));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
