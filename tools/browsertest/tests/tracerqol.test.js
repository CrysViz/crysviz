// Tracer quality-of-life features (branch rickard_more_rendering_improvements):
//   1. The crop overlay's confirm button shows live accumulation progress
//      ("Rendering… N / 64") for the whole capture and the tracer progress
//      strip stacks ABOVE the export modal backdrop.
//   2. Atom/bond highlight under a tracer does NOT restart the accumulation
//      (no instanceColor fingerprint bump) and is shown via a post-present
//      orange overlay; raster pipelines keep the classic recolor.
//   3. Measurements (shell markers + dashed lines) are traced (extra ghost
//      spheres / thin cylinders in the SceneEncoder).
//   4. Selecting a measurement tool holds the interactive raster preview; the
//      tracer resumes once the tool is deselected.
//
// Deterministic pieces run inside single synchronous evaluate blocks (RAF frames
// cannot interleave); convergence is forced with requestBoost() so the animate
// loop goes idle and never fights the manual drive.
'use strict';
const H = require('../harness');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

function decode(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Fraction of pixels that differ between two same-size PNGs (summed-RGB). */
function diffFraction(a, b, thresh = 24) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let n = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > thresh) n++;
  }
  return n / total;
}

/** Fraction of orange-ish pixels (the highlight overlay colour, blended). */
function orangeFraction(png) {
  let n = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (r > 130 && g > 50 && g < 190 && b < 110 && r - b > 60 && r - g > 30) n++;
  }
  return n / total;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Speed up software-GL tracing, then activate the ray tracer and wait for it
  // to fully initialize (blue noise loads asynchronously).
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.3;
    general.rtTiledRender = false; // full-frame accumulation → deterministic counts
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

  // ================= (1) PNG export progress + strip stacking =================
  // Open the export modal via the real UI, set a small size, click Download, and
  // poll the button text for a "/ 64" progress pattern while it renders.
  await page.evaluate(() => {
    document.getElementById('savePngButton').click();
    document.getElementById('pngWidth').value = '400';
    document.getElementById('pngHeight').value = '300';
    // Ensure the strip exists so its computed z-index can be read.
  });
  const zorder = await page.evaluate(() => {
    const strip = document.getElementById('tracerProgress');
    const modal = document.getElementById('pngExportModal');
    const sz = strip ? Number(getComputedStyle(strip).zIndex) : NaN;
    const mz = modal ? Number(getComputedStyle(modal).zIndex) : NaN;
    return { sz, mz, stripInBody: strip?.parentElement === document.body };
  });
  H.check('tracer progress strip z-index sits above the export modal backdrop',
    zorder.sz > zorder.mz && zorder.sz >= 3100 && zorder.mz === 3000, JSON.stringify(zorder));
  H.check('strip is parented to <body> (root stacking context)', zorder.stripInBody === true,
    JSON.stringify(zorder));

  // The settings modal's button only picks the output size: it closes the modal
  // and opens the crop overlay (ui/CropOverlay.js), whose OWN confirm button
  // starts the capture and carries the live progress text. Drive both, then
  // poll the confirm button for progress and the overlay for completion.
  await page.evaluate(() => document.getElementById('pngDownloadBtn').click());
  const opened = await page.evaluate(() => ({
    crop: !!document.querySelector('.cv-crop-confirm'),
    modalHidden: document.getElementById('pngExportModal').hidden,
  }));
  H.check('"Choose area…" closes the settings modal and opens the crop overlay',
    opened.crop === true && opened.modalHidden === true, JSON.stringify(opened));
  await page.evaluate(() => document.querySelector('.cv-crop-confirm').click());

  let sawProgress = false;
  let endedDownload = false;
  {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => ({
        txt: document.querySelector('.cv-crop-confirm')?.textContent ?? '',
        cropGone: !document.querySelector('.cv-crop-overlay'),
        modalHidden: document.getElementById('pngExportModal').hidden,
      }));
      if (/\/\s*64/.test(st.txt)) sawProgress = true;
      // A finished export downloads the PNG and closes the overlay; the
      // settings modal was already closed when the overlay opened.
      if (st.cropGone && st.modalHidden) { endedDownload = true; break; }
      await page.waitForTimeout(40);
    }
  }
  H.check('crop confirm button shows "Rendering… N / 64" progress during the render', sawProgress);
  H.check('a finished export closes the crop overlay (and the modal stays closed)', endedDownload);

  // A PNG is produced, and onProgress reports the 64-sample target (direct call;
  // does not duplicate pngexport.test's full capture assertions).
  const cap = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    let lastTarget = 0, ticks = 0;
    const blob = await captureSceneToPng({
      width: 240, height: 180, margin: 0, transparent: false,
      onProgress: ({ target }) => { lastTarget = target; ticks++; },
    });
    return { type: blob.type, lastTarget, ticks };
  });
  H.check('captureSceneToPng produces an image/png with onProgress target 64',
    cap.type === 'image/png' && cap.lastTarget === 64 && cap.ticks > 0, JSON.stringify(cap));

  // ================= (2) Highlight without accumulation restart ================
  const hl = await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const { applyAtomHighlightIndices, clearHighlightAtom, highlightBondIn3D } =
      await import('./ui/SelectAndHighlightModule.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;

    // Converge, snapshot the clean image and the sample count.
    p.requestBoost(64); p.render(ctx);
    const before = p._uniforms.uSampleCounter.value;
    const shotClean = canvas.toDataURL('image/png');

    // Highlight atom 0 under the tracer, then present.
    applyAtomHighlightIndices([0]);
    p.render(ctx);
    const afterAtom = p._uniforms.uSampleCounter.value;
    const dirtyAfterAtom = p._sceneDirty;
    const shotAtom = canvas.toDataURL('image/png');

    // Clear the atom highlight → still no restart.
    clearHighlightAtom();
    p.render(ctx);
    const afterClear = p._uniforms.uSampleCounter.value;

    // Bond highlight (instance 0) — same no-restart contract.
    p.requestBoost(64); p.render(ctx);
    const beforeBond = p._uniforms.uSampleCounter.value;
    highlightBondIn3D([0]);
    p.render(ctx);
    const afterBond = p._uniforms.uSampleCounter.value;
    const dirtyAfterBond = p._sceneDirty;

    return {
      before, afterAtom, dirtyAfterAtom, afterClear, beforeBond, afterBond, dirtyAfterBond,
      shotClean, shotAtom,
      atomInstances: (await import('./state/store.js')).highlightHover.currentlyHighlightedBondInstances,
    };
  });
  H.check('atom highlight under a tracer does NOT reset the accumulation',
    hl.afterAtom >= hl.before && hl.dirtyAfterAtom === false,
    JSON.stringify({ before: hl.before, afterAtom: hl.afterAtom, dirty: hl.dirtyAfterAtom }));
  H.check('clearing the atom highlight under a tracer does NOT reset either',
    hl.afterClear >= hl.afterAtom, JSON.stringify({ afterAtom: hl.afterAtom, afterClear: hl.afterClear }));
  H.check('bond highlight under a tracer does NOT reset the accumulation',
    hl.afterBond >= hl.beforeBond && hl.dirtyAfterBond === false,
    JSON.stringify({ beforeBond: hl.beforeBond, afterBond: hl.afterBond, dirty: hl.dirtyAfterBond }));
  {
    const clean = decode(hl.shotClean);
    const atom = decode(hl.shotAtom);
    const delta = diffFraction(clean, atom);
    const orange = orangeFraction(atom);
    H.check('the atom highlight overlay is visible over the traced image (orange delta)',
      delta > 0.001 && orange > 0.0005, `delta=${delta.toFixed(4)} orange=${orange.toFixed(4)}`);
  }

  // Raster pipelines keep the classic recolor (instanceColor bump).
  const raster = await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const { setActivePipeline } = await import('./render/index.js');
    const { highlightAtomIn3D, clearAllHighlights } = await import('./ui/SelectAndHighlightModule.js');
    setActivePipeline('depthpeel');
    const before = groups.atomsMesh.instanceColor.version;
    highlightAtomIn3D(0);
    const after = groups.atomsMesh.instanceColor.version;
    clearAllHighlights();
    return { before, after };
  });
  H.check('raster (depthpeel) highlight still recolors via instanceColor bump',
    raster.after > raster.before, JSON.stringify(raster));

  // ================= (3) Measurements traced =================================
  // Re-activate the ray tracer (section 2 left depthpeel active) and wait for its
  // ASYNC shader compile to finish before the deterministic single-evaluate drive
  // below: a fresh tracer switch parks in _shaderState 'compiling' until a
  // macrotask fires the compile, which can never happen inside one synchronous
  // evaluate — so the compile-gate readiness must be awaited across evaluates.
  await page.evaluate(async () => {
    const { setActivePipeline } = await import('./render/index.js');
    setActivePipeline('raytrace');
  });
  {
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        return p?._shaderState === 'ready' && !!p?._blueNoise?.image;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(500);
    }
  }
  const meas = await page.evaluate(async () => {
    const { app, groups, fileBrowser, measurements } = await import('./state/store.js');
    const { addDistanceMeasurement, clearAllMeasurements } = await import('./render/MeasurementModule.js');
    const { fracToCart } = await import('./math/index.js');
    const THREE = await import('./external/three/three.module.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;

    // Converge and record the baseline traced image + primitive counts.
    p.requestBoost(64); p.render(ctx);
    const cylBefore = p._encoder.cylinderCount;
    const atomBefore = p._encoder.atomCount;
    const shotBefore = canvas.toDataURL('image/png');

    // Add a distance measurement (proxy atoms from the structure), re-encode.
    const s = fileBrowser.selectedStructure;
    const mk = (i) => ({
      position: new THREE.Vector3(...fracToCart([s.atoms[i].position], s.lattice)[0]),
      userData: { atomIndex: i, element: s.elements[i] },
    });
    addDistanceMeasurement(mk(0), mk(1));
    p.requestBoost(64); p.render(ctx); // fingerprint change → re-encode → converge
    const cylAfter = p._encoder.cylinderCount;
    const atomAfter = p._encoder.atomCount;
    const shotAfter = canvas.toDataURL('image/png');

    // Clear → counts restore.
    clearAllMeasurements();
    p.requestBoost(64); p.render(ctx);
    const cylCleared = p._encoder.cylinderCount;
    const atomCleared = p._encoder.atomCount;

    return { cylBefore, atomBefore, cylAfter, atomAfter, cylCleared, atomCleared, shotBefore, shotAfter };
  });
  H.check('adding a measurement grows the traced cylinder + atom counts',
    meas.cylAfter > meas.cylBefore && meas.atomAfter > meas.atomBefore, JSON.stringify({
      cyl: [meas.cylBefore, meas.cylAfter], atom: [meas.atomBefore, meas.atomAfter] }));
  H.check('clearing the measurement restores the traced counts',
    meas.cylCleared === meas.cylBefore && meas.atomCleared === meas.atomBefore, JSON.stringify({
      cyl: [meas.cylBefore, meas.cylCleared], atom: [meas.atomBefore, meas.atomCleared] }));
  {
    const b = decode(meas.shotBefore);
    const a = decode(meas.shotAfter);
    H.check('the traced image changes when a measurement is added',
      diffFraction(b, a) > 0.001, `delta=${diffFraction(b, a).toFixed(4)}`);
  }

  // ================= (4) Measurement tool holds the raster preview ============
  const preview = await page.evaluate(async () => {
    const { app, general, mode } = await import('./state/store.js');
    general.rtRasterPreview = true;
    general.rtPreviewRestDelay = 0.5;
    const p = app.pipeline;
    p._syncPreviewLifecycle(); // ensure the preview instance exists
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    // Settle (non-interactive traces) and clear any interaction carryover.
    p.render(ctx); p.render(ctx);
    p._lastInteractionAt = 0;
    mode.measureMode = 'none';
    p.resetAccumulation(); // so a held (non-accumulating) preview frame reads 0

    // Selecting a measurement tool + an interactive frame (no camera motion) must
    // hold the preview.
    mode.measureMode = 'distance';
    p.render({ ...ctx, interactive: true });
    const heldPreview = p._previewActive;
    const heldSamples = p._uniforms.uSampleCounter.value;

    // Deselect the tool and simulate the rest window having elapsed → the tracer
    // resumes and accumulates on the next interactive frame.
    mode.measureMode = 'none';
    p._lastInteractionAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - 1000;
    p.render({ ...ctx, interactive: true });
    const resumedPreview = p._previewActive;
    const resumedSamples = p._uniforms.uSampleCounter.value;
    return { heldPreview, heldSamples, resumedPreview, resumedSamples };
  });
  H.check('an active measurement tool holds the raster preview (no trace)',
    preview.heldPreview === true && preview.heldSamples === 0, JSON.stringify(preview));
  H.check('deselecting the tool lets the tracer resume and accumulate',
    preview.resumedPreview === false && preview.resumedSamples >= 1, JSON.stringify(preview));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
