// See-through (alpha < 1, non-glass) objects in the tracers
// (raytrace/sceneFragment.js, pathtrace/ptSceneFragment.js). A ray used to
// pass such a surface by a coin flip (probability 1 - alpha), so see-through
// polyhedra, atoms and bonds — and their shadows — were an average of
// all-or-nothing samples and stayed grainy at the 64 samples a render, and
// each PNG-export tile, stops at. Now a shadow ray keeps (1 - alpha) of the
// light and a camera ray blends the surface with what lies behind it
// exactly (both tracers): the same converged image without the
// noise. The old way stays reachable through the pipelines' debug switch
// (_legacyNoise) for the Debug window's Tracer tab, which this test drives.
//
// YBCO with every atom at alpha 0.5, a hard light (softness 0: no penumbra
// noise), the ground plane, a fixed camera; errors against a longer render
// (new way), at 16 samples:
//   - raytrace, the ground in the atoms' shadow: far closer than the old way
//   - raytrace, the see-through atoms themselves: far closer than the old
//     way, and the same colour on average as the old way converges to (no
//     bias)
//   - pathtrace: the shadow no noisier than the old way, the see-through
//     atoms smoother, and the same colour on average
//   - the Debug window has a Tracer tab, and the tab renders old / new side by
//     side, then puts the pipeline back on the new way
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

const decode = (url) => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));

/** Mean absolute per-channel difference (0-255) over the pixels `mask` keeps. */
function mae(a, b, mask) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
    n += 3;
  }
  return n ? sum / n : NaN;
}

/** Accumulate the active tracer to exactly N samples, the old or new way. */
function renderTo(page, N, coinFlip = false) {
  return page.evaluate(async ({ N, coinFlip }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p._legacyNoise = coinFlip;
    p.render(ctx); p.render(ctx);
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    const url = app.renderer.domElement.toDataURL('image/png');
    p._legacyNoise = false;
    return url;
  }, { N, coinFlip });
}

const setAtomsVisible = (page, on) => page.evaluate(async (on) => {
  const { groups } = await import('./state/store.js');
  if (groups.atomsMesh) groups.atomsMesh.visible = on;
  const ov = groups.atomsMesh?.userData?.transparentOverlay;
  if (ov) ov.visible = on;
}, on);

/** Mean of the summed RGB over the pixels `mask` keeps. */
function meanOver(img, mask) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    sum += img.data[o] + img.data[o + 1] + img.data[o + 2];
    n++;
  }
  return n ? sum / n : NaN;
}

async function measure(page, id, { ref, n, surfaces = false }) {
  await H.setSelect(page, 'renderPipelineMenu', id);
  await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready',
    { timeout: 180000, interval: 2000 });
  const reference = decode(await renderTo(page, ref));
  const oldReference = surfaces ? decode(await renderTo(page, ref, true)) : null;
  const oldShot = decode(await renderTo(page, n, true));
  const newShot = decode(await renderTo(page, n));
  // The ground without the atoms: the shadow is where the reference is
  // clearly darker than that, off the plain background, and still grey —
  // ground seen directly, not through a (tinted) atom or bond, whose camera
  // rays stay stochastic either way.
  await setAtomsVisible(page, false);
  await page.waitForTimeout(300);
  const empty = decode(await renderTo(page, 4));
  await setAtomsVisible(page, true);
  await page.waitForTimeout(300);
  const bg = [empty.data[0], empty.data[1], empty.data[2]];
  const mask = new Uint8Array(reference.width * reference.height);
  // The see-through atoms: where the reference is tinted (not the grey
  // ground or background) and differs from the scene without them.
  const surface = new Uint8Array(reference.width * reference.height);
  let pixels = 0;
  let surfacePixels = 0;
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const isBg = Math.abs(empty.data[o] - bg[0]) + Math.abs(empty.data[o + 1] - bg[1]) + Math.abs(empty.data[o + 2] - bg[2]) < 6;
    const diff = (empty.data[o] + empty.data[o + 1] + empty.data[o + 2]) - (reference.data[o] + reference.data[o + 1] + reference.data[o + 2]);
    const r = reference.data[o], g = reference.data[o + 1], b = reference.data[o + 2];
    const grey = Math.max(r, g, b) - Math.min(r, g, b) < 8;
    if (!isBg && diff > 30 && grey) { mask[i] = 1; pixels++; }
    if (!grey && Math.max(r, g, b) - Math.min(r, g, b) > 24 && Math.abs(diff) > 30) { surface[i] = 1; surfacePixels++; }
  }
  return {
    pixels,
    old: +mae(oldShot, reference, mask).toFixed(3),
    new: +mae(newShot, reference, mask).toFixed(3),
    ...(surfaces ? {
      surfacePixels,
      surfaceOld: +mae(oldShot, reference, surface).toFixed(3),
      surfaceNew: +mae(newShot, reference, surface).toFixed(3),
      // average colour of the surfaces, converged both ways (0-765)
      surfaceMeanOld: +meanOver(oldReference, surface).toFixed(2),
      surfaceMeanNew: +meanOver(reference, surface).toFixed(2),
    } : {}),
  };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await page.setViewportSize({ width: 900, height: 640 });
  await H.loadDefaultStructure(page); // YBCO

  // Every atom half see-through; hard light; the ground catches the shadows.
  await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
    general.rtRasterPreview = false; // trace every frame
    general.rtTiledRender = false;   // one render() == one sample
    general.rtResolutionScale = 0.25; // software-GL speed
    general.ptDenoise = false;       // raw averages reach the canvas
    general.ptLightSoftness = 0;     // hard shadows: no penumbra noise
    general.rtGroundPlane = true;
    general.rtGroundPattern = 'none';
    const s = fileBrowser.selectedStructure;
    s.atoms.forEach((a, i) => { a.setOpacity(0.5); updateSingleAtomOpacity(i, 0.5); });
  });

  const rt = await measure(page, 'raytrace', { ref: 96, n: 16, surfaces: true });
  console.log('  RAYTRACE', JSON.stringify(rt));
  H.check('raytrace: the atoms cast a shadow on the ground to measure', rt.pixels > 100, JSON.stringify(rt));
  H.check('raytrace: the shadow of see-through atoms is much smoother than with the old coin flip',
    rt.new < rt.old * 0.6, JSON.stringify(rt));
  H.check('raytrace: the see-through atoms themselves are much smoother than with the old coin flip',
    rt.surfacePixels > 100 && rt.surfaceNew < rt.surfaceOld * 0.6, JSON.stringify(rt));
  H.check('raytrace: … and the same colour on average as the old way converges to (no bias)',
    Math.abs(rt.surfaceMeanNew - rt.surfaceMeanOld) < 6, JSON.stringify(rt));

  const pt = await measure(page, 'pathtrace', { ref: 48, n: 8, surfaces: true });
  console.log('  PATHTRACE', JSON.stringify(pt));
  H.check('pathtrace: the shadow is no noisier than with the old coin flip',
    pt.pixels > 100 && pt.new <= pt.old * 1.05, JSON.stringify(pt));
  H.check('pathtrace: the see-through atoms are smoother than with the old coin flip',
    pt.surfacePixels > 100 && pt.surfaceNew < pt.surfaceOld, JSON.stringify(pt));
  H.check('pathtrace: … and the same colour on average (no bias)',
    Math.abs(pt.surfaceMeanNew - pt.surfaceMeanOld) < 12, JSON.stringify(pt));

  // ---- the Debug window's Tracer tab ----
  const tab = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    (await import('./ui/DebugTracerTab.js')).buildTracerTab(host);
    host.querySelector('input[name="samples"]').value = '2';
    host.querySelector('input[name="reference"]').checked = false;
    host.querySelector('[data-role="run"]').click();
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && host.querySelectorAll('.dbgTracerShot img').length < 2
      && !/Failed/.test(host.querySelector('[data-role="progress"]').textContent)) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const out = {
      shots: [...host.querySelectorAll('.dbgTracerShot figcaption')].map((c) => c.textContent),
      images: [...host.querySelectorAll('.dbgTracerShot img')].map((i) => i.src.startsWith('data:image/png')),
      progress: host.querySelector('[data-role="progress"]').textContent,
      backToNew: app.pipeline._legacyNoise === false,
    };
    host.remove();
    return out;
  });
  H.check('the Tracer tab renders old / new side by side and puts the pipeline back on the new way',
    tab.images.length === 2 && tab.images.every(Boolean) && /^Old/.test(tab.shots[0]) && /^New: exact \+ stratified/.test(tab.shots[1])
      && /2 samples/.test(tab.shots[0]) && /Done in/.test(tab.progress) && tab.backToNew, JSON.stringify(tab));

  const origin = await page.evaluate(() => location.origin);
  await page.goto(`${origin}/index.html?debug`, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, () => !!document.querySelector('[data-dbg-tab="tracer"]'), { timeout: 60000 });
  const inWindow = await page.evaluate(async () => {
    document.querySelector('[data-dbg-tab="tracer"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    const pane = document.querySelector('[data-dbg-pane="tracer"]');
    return { shown: !!pane && !pane.hidden, built: !!pane?.querySelector('[data-role="run"]') };
  });
  H.check('with ?debug the Debug window has a Tracer tab that builds on first open', inWindow.shown && inWindow.built, JSON.stringify(inWindow));

  const own = errors.filter((x) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(x));
  H.check('no page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
