// Soft shadows in the ray tracer (Light softness > 0): each shadow ray aims at
// a point of the light's cone. Those points used to be plain white noise per
// sample, so the penumbrae — which cover most surfaces in a cluster of
// polyhedra — stayed grainy at the 64 samples a render, and each PNG-export
// tile, stops at. They now come from a stratified sequence (R2, per-pixel
// rotation; raytrace/sceneFragment.js lobeDirection): the same cost per
// sample, the same converged image, far less grain. The old way stays
// reachable through the debug switch (_legacyNoise, Debug ▸ Tracer).
//
// YBCO, opaque atoms over the ground, Light softness 0.6, a fixed camera. The
// penumbra is where a soft-light reference differs from a hard-light render,
// measured on the ground (away from silhouettes, whose anti-aliasing jitter is
// the same noise both ways); there, at 16 samples, the error against the
// reference:
//   - is far smaller with the stratified directions than with white noise
//   - and the penumbra is as dark on average both ways (no bias)
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

const decode = (url) => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));

/** Accumulate the ray tracer to exactly N samples, old or new sampling. */
function renderTo(page, N, legacy = false) {
  return page.evaluate(async ({ N, legacy }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p._legacyNoise = legacy;
    p.render(ctx); p.render(ctx);
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    const url = app.renderer.domElement.toDataURL('image/png');
    p._legacyNoise = false;
    return url;
  }, { N, legacy });
}

const setSoftness = (page, v) => page.evaluate(async (v) => {
  (await import('./state/store.js')).general.ptLightSoftness = v;
}, v);

function stats(a, ref, mask) {
  let err = 0, meanA = 0, meanRef = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) err += Math.abs(a.data[o + c] - ref.data[o + c]);
    meanA += a.data[o] + a.data[o + 1] + a.data[o + 2];
    meanRef += ref.data[o] + ref.data[o + 1] + ref.data[o + 2];
    n++;
  }
  return { mae: +(err / (3 * n)).toFixed(3), mean: +(meanA / n).toFixed(2), meanRef: +(meanRef / n).toFixed(2) };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await page.setViewportSize({ width: 900, height: 640 });
  await H.loadDefaultStructure(page); // YBCO
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false;
    general.rtTiledRender = false;
    general.rtResolutionScale = 0.25;
    general.rtGroundPlane = true;
    general.rtGroundPattern = 'solid';
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready',
    { timeout: 300000, interval: 2000 });

  // the penumbra: where the soft light differs from a hard one
  await setSoftness(page, 0);
  const hard = decode(await renderTo(page, 8));
  await setSoftness(page, 0.6);
  const reference = decode(await renderTo(page, 128));
  // …on the ground (grey: no atom or bond in front), away from silhouettes,
  // whose anti-aliasing jitter is the same noise both ways
  const mask = new Uint8Array(reference.width * reference.height);
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const d = Math.abs(hard.data[o] - reference.data[o]) + Math.abs(hard.data[o + 1] - reference.data[o + 1])
      + Math.abs(hard.data[o + 2] - reference.data[o + 2]);
    const r = reference.data[o], g = reference.data[o + 1], b = reference.data[o + 2];
    const grey = Math.max(r, g, b) - Math.min(r, g, b) < 6 && Math.max(hard.data[o], hard.data[o + 1], hard.data[o + 2])
      - Math.min(hard.data[o], hard.data[o + 1], hard.data[o + 2]) < 6;
    if (d > 18 && grey) { mask[i] = 1; pixels++; }
  }
  const oldShot = decode(await renderTo(page, 16, true));
  const newShot = decode(await renderTo(page, 16));
  const oldStats = stats(oldShot, reference, mask);
  const newStats = stats(newShot, reference, mask);
  console.log('  SOFT SHADOW (ground penumbra)', JSON.stringify({ pixels, old: oldStats, new: newStats }));

  H.check('the soft light has a penumbra to measure', pixels > 200, String(pixels));
  H.check('in the penumbra, stratified light directions leave far less grain than white noise',
    newStats.mae < oldStats.mae * 0.75, JSON.stringify({ old: oldStats, new: newStats }));
  H.check('… and the penumbra is as dark on average both ways (no bias)',
    Math.abs(newStats.mean - oldStats.mean) < 8, JSON.stringify({ old: oldStats, new: newStats }));

  const own = errors.filter((x) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(x));
  H.check('no page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
