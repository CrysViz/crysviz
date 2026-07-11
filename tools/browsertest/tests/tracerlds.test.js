// Low-discrepancy sampling (A2) for the path tracer: the app-owned stratified
// ptRand() sampler replaces white-noise rng() for the first path decisions.
// Two claims are checked deterministically (everything is now deterministic —
// the R2 uRandomVec2 feed + the LDS sampler + a fixed camera + frozen frame
// counters make renders bit-reproducible per machine):
//   (1) IDENTITY: LDS on vs off converge to the SAME image (both unbiased) —
//       at N=128 the two images are near-identical;
//   (2) VARIANCE WIN: at equal low N (32), LDS-on is no worse than LDS-off in
//       mean-absolute-error against a near-converged (128-sample) reference —
//       i.e. it converges at least as fast (in practice faster; ratio logged).
// The debug flag is PathTracingPipeline._ldsEnabled -> the uLdsEnabled uniform;
// flipping it needs a hardResetAccumulation (this test does its own).
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

function decodeDataUrl(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Mean absolute per-channel RGB difference (0-255) between two decoded PNGs. */
function maePNG(a, b) {
  let sum = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
  }
  return sum / (total * 3);
}

/** Fraction of pixels whose summed |ΔRGB| exceeds `thresh` (0-765). */
function changedFrac(a, b, thresh) {
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > thresh) n++;
  }
  return n / total;
}

async function blueNoiseReady(page) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const ok = await page.evaluate(async () => {
      const { app } = await import('./state/store.js');
      const p = app.pipeline;
      return !!p?._blueNoise?.image && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 1;
    });
    if (ok || Date.now() > deadline) break;
    await page.waitForTimeout(1000);
  }
}

/** Accumulate the path tracer to exactly N samples with the LDS flag on/off, at
 *  a fixed camera, and return the raw (denoiser-off) canvas as a data URL. */
async function renderTo(page, N, lds) {
  return page.evaluate(async ({ N, lds }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    p.render(ctx); p.render(ctx); // settle sizing + camera-state snapshot
    p._ldsEnabled = lds;
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    return canvas.toDataURL('image/png');
  }, { N, lds });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false;
    general.rtTiledRender = false;
    general.rtResolutionScale = 0.25;
    general.ptDenoise = false; // raw averages reach the canvas
  });
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await blueNoiseReady(page);

  // (1) Identity: LDS on vs off at N=128 must converge to the same image.
  const on128 = decodeDataUrl(await renderTo(page, 128, true));
  const off128 = decodeDataUrl(await renderTo(page, 128, false));
  const idMae = maePNG(on128, off128);
  const idChanged = changedFrac(on128, off128, 40);
  H.check('LDS on/off converge to the same image (mean |ΔRGB| < 3, <1% pixels changed)',
    idMae < 3 && idChanged < 0.01,
    JSON.stringify({ meanAbs: +idMae.toFixed(4), changedFrac: +idChanged.toFixed(5) }));

  // (2) Variance win: MAE at N=32 against the LDS-on@128 reference; LDS-on must
  // be no worse than LDS-off (in practice clearly better — ratio logged).
  const ref = on128; // near-converged reference
  const on32 = decodeDataUrl(await renderTo(page, 32, true));
  const off32 = decodeDataUrl(await renderTo(page, 32, false));
  const maeOn = maePNG(on32, ref);
  const maeOff = maePNG(off32, ref);
  const ratio = maeOff / Math.max(maeOn, 1e-9);
  console.log(`  LDS variance: maeOn=${maeOn.toFixed(4)} maeOff=${maeOff.toFixed(4)} `
    + `off/on ratio=${ratio.toFixed(3)}`);
  // Deterministic per machine (three local runs: maeOn=0.3733, maeOff=0.4392,
  // ratio 1.177 — bit-identical each time), so gate the win at 0.95*maeOff with
  // comfortable headroom (maeOn/maeOff observed at 0.85).
  H.check('LDS-on converges measurably faster than LDS-off at N=32 (MAE < 0.95x)',
    maeOn <= maeOff * 0.95,
    JSON.stringify({ maeOn: +maeOn.toFixed(4), maeOff: +maeOff.toFixed(4), ratio: +ratio.toFixed(3) }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
