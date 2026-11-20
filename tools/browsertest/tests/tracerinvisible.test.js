// Invisible objects in the tracers (raytrace/SceneEncoder.js INVISIBLE_ALPHA,
// the free shadow pass-throughs in sceneFragment.js / ptSceneFragment.js).
// Atoms at alpha 0 used to stay in the traced scene: every shadow ray crossing
// one spent its bounce budget and was dropped, so an invisible atom still cast
// a full shadow on the ground (and reflected). Now:
//   - alpha-0 atoms, bonds and polyhedra are not encoded at all: the scene
//     with all atoms at alpha 0 traces the same as the scene without atoms
//     (ground, cell edges, bonds only), where it used to show their shadows;
//   - atoms at alpha 0.1 let ~90 % of the light through: the ground under them
//     stays bright, where it used to be as dark as under opaque atoms.
// YBCO, raytrace, hard light, the ground plane, low resolution.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

const decode = (url) => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));

function renderTo(page, N) {
  return page.evaluate(async (N) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx);
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    return { url: app.renderer.domElement.toDataURL('image/png'), atoms: p._encoder.atomCount };
  }, N);
}

const setAllAtomsAlpha = (page, alpha) => page.evaluate(async (alpha) => {
  const { fileBrowser } = await import('./state/store.js');
  const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
  const s = fileBrowser.selectedStructure;
  s.atoms.forEach((a) => a.setOpacity(alpha));
  const w = s.periodic.visibleWrapped; // every on-screen copy, not just the first 13 instances
  for (let k = 0; k < w.cart.length; k++) updateSingleAtomOpacity(k, alpha);
}, alpha);

// "Without atoms": the mesh hidden (the encoder keeps the structure's extent
// from before, as it does for alpha-0 atoms, so the ground stays put).
const setAtomsVisible = (page, on) => page.evaluate(async (on) => {
  const { groups } = await import('./state/store.js');
  if (groups.atomsMesh) groups.atomsMesh.visible = on;
  const ov = groups.atomsMesh?.userData?.transparentOverlay;
  if (ov) ov.visible = on;
}, on);

function mae(a, b, mask = null) {
  let sum = 0, n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (mask && !mask[i]) continue;
    const o = i * 4;
    sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
    n += 3;
  }
  return n ? sum / n : NaN;
}

function meanOver(img, mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    sum += img.data[o] + img.data[o + 1] + img.data[o + 2];
    n++;
  }
  return n ? sum / n : NaN;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await page.setViewportSize({ width: 900, height: 640 });
  await H.loadDefaultStructure(page); // YBCO

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false; // trace every frame
    general.rtTiledRender = false;   // one render() == one sample
    general.rtResolutionScale = 0.25; // software-GL speed
    general.ptLightSoftness = 0;     // hard shadows
    general.rtGroundPlane = true;
    general.rtGroundPattern = 'none';
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready',
    { timeout: 180000, interval: 2000 });

  const N = 24;
  const opaque = await renderTo(page, N);
  const opaqueShot = decode(opaque.url);
  await setAtomsVisible(page, false);
  await page.waitForTimeout(200);
  const none = await renderTo(page, N);
  const noneShot = decode(none.url);
  const noneAgain = decode((await renderTo(page, N)).url); // the same scene twice: the jitter noise floor
  await setAtomsVisible(page, true);
  await page.waitForTimeout(200);
  H.check('the encoder holds the atoms with them shown and none with them hidden',
    opaque.atoms > 0 && none.atoms === 0, JSON.stringify({ shown: opaque.atoms, hidden: none.atoms }));

  // The shadow: ground pixels (grey, not background) clearly darker with the
  // opaque atoms than without them.
  const bg = [noneShot.data[0], noneShot.data[1], noneShot.data[2]];
  const shadow = new Uint8Array(noneShot.width * noneShot.height);
  let shadowPixels = 0;
  for (let i = 0; i < shadow.length; i++) {
    const o = i * 4;
    const isBg = Math.abs(noneShot.data[o] - bg[0]) + Math.abs(noneShot.data[o + 1] - bg[1]) + Math.abs(noneShot.data[o + 2] - bg[2]) < 6;
    const diff = (noneShot.data[o] + noneShot.data[o + 1] + noneShot.data[o + 2]) - (opaqueShot.data[o] + opaqueShot.data[o + 1] + opaqueShot.data[o + 2]);
    const r = opaqueShot.data[o], g = opaqueShot.data[o + 1], b = opaqueShot.data[o + 2];
    const grey = Math.max(r, g, b) - Math.min(r, g, b) < 8;
    if (!isBg && diff > 30 && grey) { shadow[i] = 1; shadowPixels++; }
  }
  H.check('opaque atoms cast a shadow on the ground to measure', shadowPixels > 100, String(shadowPixels));

  // ---- alpha 0: not traced at all ----
  await setAllAtomsAlpha(page, 0);
  await page.waitForTimeout(200);
  const zero = await renderTo(page, N);
  const zeroShot = decode(zero.url);
  const noise = +mae(noneAgain, noneShot).toFixed(2); // two renders of one scene differ by their pixel jitter
  const zeroVsNone = +mae(zeroShot, noneShot).toFixed(2);
  const zeroVsOpaque = +mae(zeroShot, opaqueShot, shadow).toFixed(2);
  H.check('atoms at alpha 0 are not encoded', zero.atoms === 0, String(zero.atoms));
  H.check('the scene with alpha-0 atoms traces like the scene without atoms (no shadow, nothing)',
    zeroVsNone < Math.max(2, 1.5 * noise), JSON.stringify({ zeroVsNone, noise, zeroVsOpaque }));
  H.check('… and not like the scene with opaque atoms in the shadow region',
    zeroVsOpaque > 30, JSON.stringify({ zeroVsNone, zeroVsOpaque }));

  // ---- alpha 0.1: the ground under the atoms stays bright ----
  await setAllAtomsAlpha(page, 0.1);
  await page.waitForTimeout(200);
  const faint = await renderTo(page, N);
  const faintShot = decode(faint.url);
  const lit = meanOver(noneShot, shadow);
  const dark = meanOver(opaqueShot, shadow);
  const faintMean = meanOver(faintShot, shadow);
  H.check('atoms at alpha 0.1 are traced', faint.atoms === opaque.atoms, JSON.stringify({ faint: faint.atoms, opaque: opaque.atoms }));
  H.check('the ground under atoms at alpha 0.1 keeps most of its light (no budget-exhausted shadow)',
    faintMean > lit - 0.35 * (lit - dark), JSON.stringify({ lit: +lit.toFixed(1), dark: +dark.toFixed(1), faint: +faintMean.toFixed(1) }));

  // ---- the path tracer's encoder is the same object: no atoms at alpha 0 ----
  await setAllAtomsAlpha(page, 0);
  await page.waitForTimeout(200);
  const ptAtoms = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    p.render({ renderer: app.renderer, scene: app.scene, camera: app.camera });
    return p._encoder.atomCount;
  });
  H.check('after the alpha change the encoder re-encodes with no atoms', ptAtoms === 0, String(ptAtoms));

  await setAllAtomsAlpha(page, 1);
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
