// Tracer materials + continuous size sliders: per-species/pair/category
// materials (Structure-window editors -> style stores -> SceneEncoder
// fingerprint -> re-encode) with an emissive species measurably glowing under
// the raytrace pipeline; and the quadratic [0,1] Atom Size / Bond Diameter
// slider mapping (ui/ControlsWiring.js).
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Count of pixels that differ substantially between two screenshots — the
 *  "materials changed the render" metric (emissive Cu saturates, metal Ba
 *  goes mirror-flat; exact colors depend on tone mapping + upscale blur). */
function changedPixelCount(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 90) n++;
  }
  return n;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- Quadratic continuous size sliders -----------------------------------------
  const mapping = await page.evaluate(async () => {
    const { sizeSliderToValue, sizeValueToSlider, ATOM_SIZE_RANGE, BOND_RADIUS_RANGE }
      = await import('./ui/ControlsWiring.js');
    return {
      atomAtFull: sizeSliderToValue(1, ATOM_SIZE_RANGE),
      atomAtZero: sizeSliderToValue(0, ATOM_SIZE_RANGE),
      bondAtFull: sizeSliderToValue(1, BOND_RADIUS_RANGE),
      roundTrip: Math.abs(sizeValueToSlider(sizeSliderToValue(0.7, ATOM_SIZE_RANGE), ATOM_SIZE_RANGE) - 0.7),
      stepless: document.getElementById('atomSize')?.step === 'any'
        && document.getElementById('bondWidth')?.step === 'any',
    };
  });
  H.check('size sliders: quadratic mapping spans 0.05-3.0 / up to 1.0, no steps',
    Math.abs(mapping.atomAtFull - 3.0) < 1e-9 && Math.abs(mapping.atomAtZero - 0.05) < 1e-9
      && Math.abs(mapping.bondAtFull - 1.0) < 1e-9 && mapping.roundTrip < 1e-9 && mapping.stepless,
    JSON.stringify(mapping));

  await H.setSlider(page, 'atomSize', 1);
  const atFull = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { atomSize: general.atomSize, span: document.getElementById('atomSizeValue')?.textContent };
  });
  H.check('#atomSize at full travel drives general.atomSize to 3.0',
    Math.abs(atFull.atomSize - 3.0) < 1e-6 && atFull.span === '3.00', JSON.stringify(atFull));
  await H.setSlider(page, 'atomSize', 0.3444); // back to the default 0.40

  // --- Material editors exist in the Structure window ----------------------------
  const editors = await page.evaluate(() => ({
    materialEditors: document.querySelectorAll('.material-editor').length,
    typeSelects: document.querySelectorAll('.material-type-select').length,
  }));
  H.check('material editors present in the species editors',
    editors.materialEditors > 0 && editors.typeSelects === editors.materialEditors,
    JSON.stringify(editors));

  // --- Emissive material glows under raytrace ------------------------------------
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(3500);
  const shot1 = await H.shotCanvas(page, 'tracermaterials-baseline');

  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = structure.atomMaterials ?? {};
    structure.atomMaterials['Cu'] = { type: 'emissive', intensity: 14 };
    structure.atomMaterials['Ba'] = { type: 'metal', roughness: 0.1 };
    requestRender(); // encoder fingerprint picks the store change up
  });
  await page.waitForTimeout(3500);
  const encoded = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return { id: app.pipeline?.id, samples: u?.uSampleCounter.value, atoms: u?.uAtomCount.value };
  });
  const shot2 = await H.shotCanvas(page, 'tracermaterials-emissive');
  const changed = changedPixelCount(shot1, shot2);
  H.check('material edit re-encoded the scene (accumulation reset + resumed)',
    encoded.id === 'raytrace' && encoded.samples > 2 && encoded.atoms > 0, JSON.stringify(encoded));
  H.check('emissive/metal materials visibly change the ray-traced structure',
    changed > 1000, JSON.stringify({ changedPixels: changed }));

  // --- Materials persist (species map + category stores in captureState) ---------
  const persisted = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState();
    return { version: state.version, atomMaterials: state.colors.atomMaterials };
  });
  H.check('captureState persists atomMaterials (v2.7)',
    persisted.version === '2.7' && persisted.atomMaterials?.Cu?.type === 'emissive'
      && persisted.atomMaterials?.Ba?.type === 'metal', JSON.stringify(persisted));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
