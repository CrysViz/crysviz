// "Classic look" tracer knobs: the "Legacy tone mapping" Advanced toggle
// (general.rtToneMapLegacy — the original Reinhard operator instead of
// exposure x ACES, with the background-match inverse switching accordingly)
// and the standard material's "Tint" knob (mat.tint, carried in the standard
// type's roughness texel slot; 0.6 default = current look, 0 = the original
// untinted white coat).
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

function cornerPixel(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const o = ((png.height - 12) * png.width + 12) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2]];
}

/** Count of pixels differing substantially between two screenshots. */
function changedPixelCount(fileA, fileB, minDelta = 30) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > minDelta) n++;
  }
  return n;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- GUI presence: legacy toggle in Advanced (default OFF), Tint rows -----
  const ui = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const el = document.getElementById('rtLegacyToneToggle');
    return {
      present: !!el,
      checked: el?.checked,
      inAdvanced: !!el?.closest('details.eos-collapsible'),
      def: general.rtToneMapLegacy,
      glossRows: document.querySelectorAll('.material-gloss-row').length,
      tintRows: document.querySelectorAll('.material-tint-row').length,
    };
  });
  H.check('#rtLegacyToneToggle present in the Advanced section, default OFF',
    ui.present && ui.checked === false && ui.inAdvanced && ui.def === false,
    JSON.stringify(ui));
  H.check('material editors grew a standard-only Tint row (one per Gloss row)',
    ui.tintRows > 0 && ui.tintRows === ui.glossRows, JSON.stringify(ui));

  // --- Trace a baseline (ACES) with a distinctive background ----------------
  await page.evaluate(async () => {
    const { general, app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame
    app.scene.background = new THREE.Color('#204060');
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(3500);
  const acesShot = await H.shotCanvas(page, 'classiclook-aces');

  // --- Legacy ON: tone curve visibly changes, backdrop stays pinned ---------
  await H.clickById(page, 'rtLegacyToneToggle');
  await page.waitForTimeout(3000);
  const legacyShot = await H.shotCanvas(page, 'classiclook-reinhard');
  const toneDelta = changedPixelCount(acesShot, legacyShot);
  H.check('legacy Reinhard visibly changes the traced image',
    toneDelta > 300, JSON.stringify({ toneDelta }));
  const legacyCorner = cornerPixel(legacyShot);
  H.check('background match holds under legacy Reinhard (inverse switched)',
    Math.abs(legacyCorner[0] - 32) <= 6 && Math.abs(legacyCorner[1] - 64) <= 6
      && Math.abs(legacyCorner[2] - 96) <= 6,
    JSON.stringify({ legacyCorner }));

  // --- Standard Tint: encodes into the texel and changes the render ---------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = { Cu: { type: 'standard', tint: 0, gloss: 1 } };
    requestRender(); // encoder fingerprint picks the store change up
  });
  await page.waitForTimeout(3000);
  const texels = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const enc = app.pipeline._encoder;
    const data = enc.atomsTexture.image.data;
    const count = app.pipeline._uniforms.uAtomCount.value;
    const tints = new Set();
    for (let i = 0; i < count; i++) tints.add(Math.round(data[(i * 3 + 2) * 4 + 1] * 100) / 100);
    return { count, tints: [...tints].sort() };
  });
  H.check('tint encodes into the standard texel slot (0 for Cu, 0.6 default rest)',
    texels.count > 0 && texels.tints.includes(0) && texels.tints.includes(0.6),
    JSON.stringify(texels));
  // Visual effect: strong reflections on ALL species, tint 0.6 vs 0 (the
  // per-species Cu-only change above is too few pixels at quarter res).
  const setAllTint = async (tint) => page.evaluate(async (t) => {
    const { fileBrowser, general, app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    general.rtReflectivity = 0.7;
    structure.atomMaterials = Object.fromEntries([...new Set(structure.elements)]
      .map((el) => [el, { type: 'standard', tint: t, gloss: 1 }]));
    app.pipeline?.resetAccumulation?.();
    requestRender();
  }, tint);
  await setAllTint(0.6);
  await page.waitForTimeout(3000);
  const tintedShot = await H.shotCanvas(page, 'classiclook-tint06');
  await setAllTint(0);
  await page.waitForTimeout(3000);
  const untintedShot = await H.shotCanvas(page, 'classiclook-tint0');
  const tintDelta = changedPixelCount(tintedShot, untintedShot, 20);
  H.check('untinted (white) coat visibly changes the traced structure',
    tintDelta > 200, JSON.stringify({ tintDelta }));

  // --- Metal Tint: default 1 = fully colored mirror, 0 = chrome -------------
  const setAllMetal = async (tint) => page.evaluate(async (t) => {
    const { fileBrowser, app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = Object.fromEntries([...new Set(structure.elements)]
      .map((el) => [el, { type: 'metal', roughness: 0.05, ...(t != null ? { tint: t } : {}) }]));
    app.pipeline?.resetAccumulation?.();
    requestRender();
  }, tint);
  await setAllMetal(null); // untouched tint -> type default (fully colored)
  await page.waitForTimeout(2500);
  const metalTexel = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const data = app.pipeline._encoder.atomsTexture.image.data;
    return Math.round(data[2 * 4 + 2] * 100) / 100; // atom 0 material texel z slot
  });
  H.check('metal tint defaults to 1 in the typeParam texel slot',
    metalTexel === 1, JSON.stringify({ metalTexel }));
  const coloredMetalShot = await H.shotCanvas(page, 'classiclook-metal-colored');
  await setAllMetal(0); // chrome
  await page.waitForTimeout(2500);
  const chromeShot = await H.shotCanvas(page, 'classiclook-metal-chrome');
  const chromeDelta = changedPixelCount(coloredMetalShot, chromeShot, 20);
  H.check('chrome (tint 0) visibly whitens the metal reflections',
    chromeDelta > 200, JSON.stringify({ chromeDelta }));

  // --- PT: the light fixture appears in the coat's stochastic mirror --------
  // High standard reflectivity routes ~95% of camera rays through the COAT
  // mirror branch; those rays must see the light sphere (isPrimaryRay cleared,
  // matching SPEC) — with the regression they returned the dark background
  // instead and the glint all but vanished (near-zero bright pixels).
  // Softness 1 makes the light sphere large (glint discs span many pixels
  // even at 0.25 internal res) and intensity 3 keeps partially-covered pixels
  // clipped white through the averaging + denoiser.
  await page.evaluate(async () => {
    const { fileBrowser, general, app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    general.ptLightSoftness = 1;
    general.rtLightIntensity = 3;
    structure.atomMaterials = Object.fromEntries([...new Set(structure.elements)]
      .map((el) => [el, { type: 'standard', tint: 0, gloss: 1, reflectivity: 0.95 }]));
    app.pipeline?.resetAccumulation?.();
    requestRender();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await page.waitForTimeout(7000);
  const glintShot = await H.shotCanvas(page, 'classiclook-pt-glint');
  const glintPng = PNG.sync.read(fs.readFileSync(glintShot));
  let brightPixels = 0;
  for (let i = 0; i < glintPng.data.length; i += 4) {
    if (Math.max(glintPng.data[i], glintPng.data[i + 1], glintPng.data[i + 2]) > 230) brightPixels++;
  }
  H.check('PT light-sphere glint shows in the standard coat stochastic mirror',
    brightPixels > 100, JSON.stringify({ brightPixels }));

  // --- Persistence: legacy flag in style, tint in the material store --------
  const persisted = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState();
    return {
      legacy: state.style.rtToneMapLegacy,
      tint: state.colors?.atomMaterials?.Cu?.tint,
    };
  });
  H.check('captureState persists rtToneMapLegacy + the material tint',
    persisted.legacy === true && persisted.tint === 0, JSON.stringify(persisted));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
