// Tracer PNG-export quality-of-life fixes (branch rickard_more_rendering_improvements):
//   1. Paced tiled export (general.rtTiledRender ON): progress is MONOTONICALLY
//      non-decreasing and reaches the convergence target; a PNG is produced.
//      This is the regression guard for the old "Rendering… 4/8/4…" oscillation
//      (dual render drivers — the animate loop fighting the export's paced
//      renders and abandoning the in-flight tiled round every iteration).
//   2. Untiled export (rtTiledRender OFF): completes too, also monotonic.
//   3. Instant button feedback: the crop overlay's confirm button text changes
//      away from 'Download' promptly after the click (before any long render).
//   4. The crop overlay is locked while rendering: Escape does NOT dismiss it,
//      its Cancel button is relabelled "Abort", and clicking Abort cleanly
//      cancels (button back to 'Download', overlay still open, no alert, no
//      page errors) with the live view still rendering afterwards.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Keep interactive frames cheap; activate the ray tracer and wait for it to
  // fully initialize (blue noise loads asynchronously).
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.3;
    general.rtRasterPreview = false; // export traces regardless, but keep it simple
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  {
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        return !!p?._blueNoise?.image && p?._initialized === true;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(1000);
    }
  }

  // A live UI switch must not replace the tracer while export owns the shared
  // renderer/pipeline. The short target keeps this a delayed, deterministic
  // race test without waiting for a production-length convergence.
  const pipelineRace = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app, general } = await import('./state/store.js');
    const p = app.pipeline;
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    const view = document.getElementById('view');
    const previous = {
      pipeline: p,
      background: app.scene.background,
      pixelRatio: app.renderer.getPixelRatio(),
      alpha: app.renderer.getClearAlpha(),
      rtScale: general.rtResolutionScale,
      targetSamples: p._cfg.targetSamples,
      tiled: general.rtTiledRender,
    };
    p._cfg.targetSamples = 2;
    general.rtTiledRender = false;
    app.renderer.setPixelRatio(1.25);
    app.renderer.setClearAlpha(0.31);
    general.rtResolutionScale = 0.47;
    try {
      const capture = captureSceneToPng({ width: 180, height: 120, margin: 0, transparent: false });
      while (!app.offscreenRenderHold) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const controllerAttempt = await window.crysvizHost.dispatch({
        command: 'set_render_pipeline', args: { pipelineId: 'forward' },
      });
      select.value = 'forward';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const during = {
        controllerAttempt,
        pipelineUnchanged: app.pipeline === p,
        generalPipeline: general.renderPipeline,
        selected: select.value,
      };
      const blob = await capture;
      const size = app.renderer.getSize(new (await import('./external/three/three.module.js')).Vector2());
      const restored = {
        blobType: blob.type,
        pipelineUnchanged: app.pipeline === previous.pipeline,
        pixelRatio: app.renderer.getPixelRatio(),
        background: app.scene.background === previous.background,
        alpha: app.renderer.getClearAlpha(),
        rtScale: general.rtResolutionScale,
        hold: app.offscreenRenderHold,
        paced: p._pacedExternally,
        size: [Math.round(size.x), Math.round(size.y)],
        view: [view.clientWidth, view.clientHeight],
      };
      p._cfg.targetSamples = previous.targetSamples;
      general.rtTiledRender = previous.tiled;
      select.value = 'forward';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const switchedAfter = {
        pipeline: app.pipeline.id,
        selected: select.value,
        tracerBody: document.body.classList.contains('tracer-pipeline'),
      };
      select.value = 'raytrace';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { during, restored, switchedAfter, blobSize: blob.size };
    } finally {
      general.rtTiledRender = previous.tiled;
      if (app.pipeline === p) p._cfg.targetSamples = previous.targetSamples;
    }
  });
  H.check('UI pipeline switch is refused while tracer capture owns the pipeline',
    !pipelineRace.during.controllerAttempt.ok
      && pipelineRace.during.controllerAttempt.error.code === 'PNG_CAPTURE_IN_PROGRESS'
      && pipelineRace.during.pipelineUnchanged
      && pipelineRace.during.generalPipeline === 'raytrace'
      && pipelineRace.during.selected === 'raytrace', JSON.stringify(pipelineRace.during));
  H.check('tracer capture completes with renderer state restored',
    pipelineRace.restored.blobType === 'image/png'
      && pipelineRace.restored.pipelineUnchanged
      && pipelineRace.restored.pixelRatio === 1.25
      && pipelineRace.restored.background
      && Math.abs(pipelineRace.restored.alpha - 0.31) < 1e-6
      && pipelineRace.restored.rtScale === 0.47
      && pipelineRace.restored.hold === false
      && pipelineRace.restored.paced === false
      && pipelineRace.restored.size[0] === pipelineRace.restored.view[0]
      && pipelineRace.restored.size[1] === pipelineRace.restored.view[1]
      && pipelineRace.blobSize > 32, JSON.stringify(pipelineRace.restored));
  H.check('pipeline switching works again after capture releases ownership',
    pipelineRace.switchedAfter.pipeline === 'forward'
      && pipelineRace.switchedAfter.selected === 'forward'
      && pipelineRace.switchedAfter.tracerBody === false, JSON.stringify(pipelineRace.switchedAfter));

  // ============ (1) Paced TILED export: monotonic progress, reaches target =====
  const tiled = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app, general } = await import('./state/store.js');
    general.rtTiledRender = true;
    const p = app.pipeline;
    // Force a multi-tile grid so the tiled round path is actually exercised at
    // these small export sizes (production floor is 64px / 200k-px budget).
    p._tilePixelBudget = 64 * 64;
    p._minTileSizePx = 16;
    const vals = [];
    let target = 0;
    const blob = await captureSceneToPng({
      width: 200, height: 150, margin: 0, transparent: false,
      onProgress: ({ current, target: t }) => { vals.push(current); target = t; },
    });
    let mono = true;
    for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) mono = false;
    const maxV = vals.reduce((a, b) => Math.max(a, b), 0);
    return { type: blob.type, target, mono, maxV, ticks: vals.length,
      holdCleared: app.offscreenRenderHold === false, paced: p._pacedExternally };
  });
  H.check('tiled export: progress is monotonically non-decreasing (no 4/8/4 oscillation)',
    tiled.mono, JSON.stringify(tiled));
  H.check('tiled export: reaches the 64-sample target and produces an image/png',
    tiled.target === 64 && tiled.maxV >= 64 && tiled.type === 'image/png', JSON.stringify(tiled));
  H.check('tiled export: hold + paced mode cleared afterwards',
    tiled.holdCleared === true && tiled.paced === false, JSON.stringify(tiled));

  // ============ (2) Paced UNTILED export: also completes, also monotonic =======
  const untiled = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app, general } = await import('./state/store.js');
    general.rtTiledRender = false;
    const p = app.pipeline;
    const vals = [];
    let target = 0;
    const blob = await captureSceneToPng({
      width: 200, height: 150, margin: 0, transparent: false,
      onProgress: ({ current, target: t }) => { vals.push(current); target = t; },
    });
    let mono = true;
    for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) mono = false;
    const maxV = vals.reduce((a, b) => Math.max(a, b), 0);
    return { type: blob.type, target, mono, maxV, roundActive: p._roundActive };
  });
  H.check('untiled export: completes to target and produces an image/png (monotonic)',
    untiled.type === 'image/png' && untiled.target === 64 && untiled.maxV >= 64 && untiled.mono,
    JSON.stringify(untiled));

  // ============ (3)+(4) Instant feedback + overlay lock + Abort ================
  // The settings modal itself closes as soon as the crop overlay opens (it
  // doesn't own the busy/Abort state) — that state lives on the crop
  // overlay's own confirm/cancel buttons (ui/CropOverlay.js).
  // Make the export effectively unbounded (never converges) so it is still
  // running while we probe the overlay's button state and then abort it.
  await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    general.rtTiledRender = true;
    app.pipeline._cfg.targetSamples = 100000; // won't converge before we abort
  });

  // Open the modal, set a size, click Download → opens the crop overlay.
  await page.evaluate(() => {
    document.getElementById('saveImageButton').click();
    document.getElementById('pngWidth').value = '400';
    document.getElementById('pngHeight').value = '300';
    document.getElementById('pngDownloadBtn').click();
  });
  // Start the capture via the crop overlay's own confirm button.
  await page.evaluate(() => document.querySelector('.cv-crop-confirm').click());

  // (3) The button label changes away from 'Download' promptly after the click.
  let changedFast = false;
  {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const txt = await page.evaluate(() => document.querySelector('.cv-crop-confirm')?.textContent);
      if (txt !== 'Download') { changedFast = true; break; }
      await page.waitForTimeout(20);
    }
  }
  H.check('Download button text changes away from "Download" promptly after click', changedFast);

  // (4a) While rendering: Escape must NOT dismiss the overlay, and Cancel is
  //      relabelled "Abort".
  const locked = await page.evaluate(() => {
    const overlay = document.querySelector('.cv-crop-overlay');
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return {
      present: !!document.querySelector('.cv-crop-overlay'),
      cancelTxt: document.querySelector('.cv-crop-cancel').textContent,
    };
  });
  H.check('Escape does NOT close the crop overlay while rendering', locked.present === true,
    JSON.stringify(locked));
  H.check('the abort control is present (Cancel relabelled "Abort")', locked.cancelTxt === 'Abort',
    JSON.stringify(locked));

  // (4b) Click Abort → export cancels: button back to 'Download', overlay
  //      stays open, Cancel label restored. Then restore the real target.
  await page.evaluate(() => document.querySelector('.cv-crop-cancel').click());
  let aborted = false, overlayOpen = false, cancelRestored = false;
  {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => ({
        txt: document.querySelector('.cv-crop-confirm')?.textContent,
        present: !!document.querySelector('.cv-crop-overlay'),
        cancelTxt: document.querySelector('.cv-crop-cancel')?.textContent,
      }));
      if (st.txt === 'Download') {
        aborted = true; overlayOpen = st.present; cancelRestored = st.cancelTxt === 'Cancel'; break;
      }
      await page.waitForTimeout(30);
    }
  }
  H.check('Abort returns the button to "Download" and restores the Cancel label',
    aborted && cancelRestored, JSON.stringify({ aborted, cancelRestored }));
  H.check('the crop overlay stays OPEN after Abort (not dismissed)', overlayOpen);

  // (4c) The live view still renders after an abort: restore the target, then a
  //      manual trace accumulates and the hold flag is clear.
  const live = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    p._cfg.targetSamples = 64; // restore
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.resetAccumulation();
    const before = p._uniforms.uSampleCounter.value;
    p.render(ctx);
    const after = p._uniforms.uSampleCounter.value;
    return { before, after, hold: app.offscreenRenderHold, paced: p._pacedExternally };
  });
  H.check('live view renders after Abort (accumulates; hold + paced cleared)',
    live.after > live.before && live.hold === false && live.paced === false, JSON.stringify(live));

  // Close the overlay cleanly (not busy now → Cancel closes it).
  await page.evaluate(() => document.querySelector('.cv-crop-cancel')?.click());

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
