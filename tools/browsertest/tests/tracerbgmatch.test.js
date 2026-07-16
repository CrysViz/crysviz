// "Match background color" Advanced toggle (general.rtBackgroundMatch):
// ON (default) pins the traced backdrop to the exact picked background color
// (inverse-tone-map pre-compensation on primary-miss rays); OFF restores the
// older look where the backdrop is tone-mapped along with the scene. Toggled
// by #rtBgMatchToggle in the Rendering "Advanced" section; persisted in the
// ShareModule style block.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Background sample: a pixel near the bottom-left corner (no structure). */
function cornerPixel(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const o = ((png.height - 12) * png.width + 12) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2]];
}
const near = (px, rgb, tol) => Math.abs(px[0] - rgb[0]) <= tol
  && Math.abs(px[1] - rgb[1]) <= tol && Math.abs(px[2] - rgb[2]) <= tol;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- Toggle exists in the Advanced section and defaults to ON -------------
  const ui = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const el = document.getElementById('rtBgMatchToggle');
    return {
      present: !!el,
      checked: el?.checked,
      inAdvanced: !!el?.closest('details.eos-collapsible'),
      def: general.rtBackgroundMatch,
    };
  });
  H.check('#rtBgMatchToggle present in the Advanced section, default ON',
    ui.present && ui.checked === true && ui.inAdvanced && ui.def === true,
    JSON.stringify(ui));

  // --- Trace with a distinctive background ----------------------------------
  await page.evaluate(async () => {
    const { general, app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame
    app.scene.background = new THREE.Color('#204060');
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(3500);
  const onCorner = cornerPixel(await H.shotCanvas(page, 'bgmatch-on'));
  H.check('matching ON: backdrop equals the picked #204060 = rgb(32,64,96)',
    near(onCorner, [32, 64, 96], 6), JSON.stringify({ onCorner }));

  // --- Toggle OFF through the real checkbox: backdrop becomes tone-mapped ---
  await H.clickById(page, 'rtBgMatchToggle');
  await page.waitForTimeout(3000);
  const offFlag = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return general.rtBackgroundMatch;
  });
  const offCorner = cornerPixel(await H.shotCanvas(page, 'bgmatch-off'));
  const delta = Math.abs(offCorner[0] - onCorner[0])
    + Math.abs(offCorner[1] - onCorner[1]) + Math.abs(offCorner[2] - onCorner[2]);
  H.check('matching OFF: flag false and the backdrop visibly shifts (tone-mapped look)',
    offFlag === false && delta > 20, JSON.stringify({ offCorner, delta }));

  // --- Back ON restores the exact match --------------------------------------
  await H.clickById(page, 'rtBgMatchToggle');
  await page.waitForTimeout(3000);
  const backCorner = cornerPixel(await H.shotCanvas(page, 'bgmatch-back-on'));
  H.check('matching back ON: backdrop pinned to #204060 again',
    near(backCorner, [32, 64, 96], 6), JSON.stringify({ backCorner }));

  // --- Persistence: the flag rides in the ShareModule style block ------------
  const persisted = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { captureState } = await import('./ui/ShareModule.js');
    general.rtBackgroundMatch = false;
    const style = captureState().style;
    general.rtBackgroundMatch = true;
    return { key: 'rtBackgroundMatch' in style, value: style.rtBackgroundMatch };
  });
  H.check('captureState persists style.rtBackgroundMatch',
    persisted.key && persisted.value === false, JSON.stringify(persisted));

  H.check('no page errors', errors.length === 0, JSON.stringify(errors));
  await H.finish(browser);
})().catch(H.crash);
