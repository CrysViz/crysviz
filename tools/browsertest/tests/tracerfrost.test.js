// Frosted glass in the ray tracer (glass material with Frost > 0): each ray
// through the glass is bent within a cone, and the blur builds up from the
// samples. Those directions come from stratified 2D sequences
// (raytrace/sceneFragment.js rtStratified2), one sequence per draw along a
// path — a frosted polyhedron draws several (entering, leaving, the soft
// shadow behind), which used to share one sequence shifted, i.e. move in
// lockstep. The old way (white noise) stays reachable through the debug
// switch (_legacyNoise, Debug ▸ Tracer).
//
// YBCO's polyhedra in frosted glass (frost 0.5) over the ground, Light
// softness 0.3, a fixed camera; on the glass, at 16 samples, against a
// 128-sample reference:
//   - less grain than with white noise (~15 %: a frosted face averages light
//     from a wide cone, so most of its noise is the blur itself — more samples,
//     not better ones, remove it)
//   - the same colour on average (the blur converges to the same image)
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

const decode = (url) => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));

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

function stats(a, ref, mask) {
  let err = 0, mean = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) err += Math.abs(a.data[o + c] - ref.data[o + c]);
    mean += a.data[o] + a.data[o + 1] + a.data[o + 2];
    n++;
  }
  return { mae: +(err / (3 * n)).toFixed(3), mean: +(mean / n).toFixed(2) };
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
    general.ptLightSoftness = 0.3;
  });
  await H.clickById(page, 'showPolyhedra');
  await page.evaluate(async () => (await import('./render/PolyhedraModule.js')).updatePolyhedra());
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready',
    { timeout: 300000, interval: 2000 });

  // the empty scene (polyhedra hidden) marks where the glass is
  const setPolys = (visible, frost) => page.evaluate(async ({ visible, frost }) => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const { uploadPolyStyles } = await import('./render/PolyhedraMesh.js');
    const s = fileBrowser.selectedStructure;
    s.polyhedraCategoryStyles ??= {};
    // one mesh for all polyhedra: show/hide every table row directly
    const table = groups.polyhedraGroup.userData.polyTable;
    for (let i = 0; i < table.n; i++) {
      table.visible[i] = visible ? 1 : 0;
      const catKey = table.catKey[i];
      if (frost != null && catKey) {
        s.polyhedraCategoryStyles[catKey] = {
          ...(s.polyhedraCategoryStyles[catKey] || {}),
          material: { type: 'glass', ior: 1.5, frost, tint: 0.5, tintDepth: 0.4 },
        };
      }
    }
    uploadPolyStyles(table);
  }, { visible, frost });
  await setPolys(false, null);
  await page.waitForTimeout(300);
  const empty = decode(await renderTo(page, 4));
  await setPolys(true, 0.5);
  await page.waitForTimeout(300);
  const encoded = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const enc = app.pipeline._encoder;
    enc.encode();
    let glass = 0;
    for (let p = 0; p < enc.polyCount; p++) if (Math.round(enc.polyTexture.image.data[p * 16 + 2]) === 2) glass++;
    return { polys: enc.polyCount, glass };
  });
  H.check('the polyhedra trace as frosted glass', encoded.polys > 0 && encoded.glass === encoded.polys, JSON.stringify(encoded));

  const reference = decode(await renderTo(page, 128));
  const mask = new Uint8Array(reference.width * reference.height);
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const d = Math.abs(empty.data[o] - reference.data[o]) + Math.abs(empty.data[o + 1] - reference.data[o + 1])
      + Math.abs(empty.data[o + 2] - reference.data[o + 2]);
    if (d > 30) { mask[i] = 1; pixels++; }
  }
  const oldStats = stats(decode(await renderTo(page, 16, true)), reference, mask);
  const newStats = stats(decode(await renderTo(page, 16)), reference, mask);
  const refMean = stats(reference, reference, mask).mean;
  console.log('  FROST', JSON.stringify({ pixels, old: oldStats, new: newStats, refMean }));

  H.check('the glass covers part of the picture', pixels > 500, String(pixels));
  H.check('frosted glass: less grain than with white-noise directions',
    newStats.mae < oldStats.mae * 0.93, JSON.stringify({ old: oldStats, new: newStats }));
  H.check('… and the same colour on average (the blur converges to the same image)',
    Math.abs(newStats.mean - oldStats.mean) < 10 && Math.abs(newStats.mean - refMean) < 10, JSON.stringify({ old: oldStats, new: newStats, refMean }));

  const own = errors.filter((x) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(x));
  H.check('no page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
