// Glass Tint: the per-material tintDepth slider must visibly colorize glass
// in the ray tracer, while tintDepth 0 remains clear.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Measure chroma in the screenshot delta, ignoring negligible pixel noise. */
function tintDeltaMetric(fileA, fileB, minDelta = 3) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let changedPixels = 0;
  let chromaSum = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dR = Math.abs(a.data[o] - b.data[o]);
    const dG = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const dB = Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (dR + dG + dB > minDelta) {
      changedPixels++;
      chromaSum += Math.max(Math.abs(dR - dG), Math.abs(dR - dB), Math.abs(dG - dB));
    }
  }
  return {
    changedPixels,
    meanChroma: changedPixels > 0 ? chromaSum / changedPixels : 0,
  };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO: Y, Ba, Cu, O

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');

  const waitForTraceSamples = async () => {
    const state = await H.waitFor(page, async () => {
      const { app } = await import('./state/store.js');
      const pipeline = app.pipeline;
      const samples = pipeline?._uniforms?.uSampleCounter?.value;
      const target = pipeline?._cfg?.targetSamples;
      return pipeline?.id === 'raytrace' && Number.isFinite(samples)
        && Number.isFinite(target) && samples >= target
        ? { samples, target } : null;
    }, { timeout: 90000, interval: 100 });
    if (!state) throw new Error('raytrace did not reach its fixed target sample count');
    return state;
  };

  const setBaTint = async (tintDepth) => page.evaluate(async (tint) => {
    const { fileBrowser, app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    fileBrowser.selectedStructure.atomMaterials.Ba = {
      type: 'glass', ior: 1.5, frost: 0, tintDepth: tint,
    };
    app.pipeline?.resetAccumulation?.();
    requestRender();
  }, tintDepth);

  await setBaTint(0);
  const clearSamples = await waitForTraceSamples();
  const clearShot = await H.shotCanvas(page, 'glasstint-clear');

  await setBaTint(2);
  const tintedSamples = await waitForTraceSamples();
  const tintedShot = await H.shotCanvas(page, 'glasstint-tinted');

  const tintDelta = tintDeltaMetric(clearShot, tintedShot);
  H.check('both screenshots use the same fixed raytrace sample count',
    clearSamples.samples === clearSamples.target
      && tintedSamples.samples === tintedSamples.target
      && clearSamples.samples === tintedSamples.samples,
    JSON.stringify({ clearSamples, tintedSamples }));
  H.check('glass Tint 0 to 2 produces a strong chroma shift',
    tintDelta.changedPixels > 200 && tintDelta.meanChroma > 10,
    JSON.stringify({ tintDelta }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
