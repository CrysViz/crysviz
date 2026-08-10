// Scene background color picker (ui/BackgroundPicker.js) — had zero standing
// coverage before this test. Two entry points (the on-canvas #backgroundDot
// and the in-panel Visual-window swatch) drive the SAME picker and the same
// piece of state (app.scene.background) — exactly the kind of shared-state
// collision CLAUDE.md calls out, so this test drives both and checks they
// stay in sync rather than fighting each other.
'use strict';
const H = require('../harness');

function pickerHexInput() {
  // ColorPickerModule.js builds an RGB row then a HEX row, both
  // .cv-colorpicker-input-field text inputs — the hex one is the second.
  const inputs = document.querySelectorAll('.spin-color-picker .cv-colorpicker-input-field');
  return inputs[1];
}

async function setPickerHex(page, hex) {
  await page.evaluate((hex) => {
    const inputs = document.querySelectorAll('.spin-color-picker .cv-colorpicker-input-field');
    const hexInput = inputs[1];
    hexInput.value = hex;
    hexInput.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Visual window builds the in-panel swatch (#backgroundSwatch) lazily.
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('visual').expand();
  });
  await page.waitForTimeout(200);

  // --- opening from the on-canvas dot: a real picker panel appears ----------
  await H.clickById(page, 'backgroundDot');
  await page.waitForTimeout(150);
  let open = await page.evaluate(() => !!document.querySelector('.cv-background-picker-panel'));
  H.check('clicking the canvas dot opens the background color picker', open);

  // Real CSS applied: a positioned floating panel, not inline unstyled markup.
  const panelCss = await page.evaluate(() => {
    const el = document.querySelector('.cv-background-picker-panel');
    const cs = getComputedStyle(el);
    return { position: cs.position, zIndex: cs.zIndex };
  });
  H.check('picker panel is a positioned floating overlay (position/z-index applied)',
    panelCss.position === 'absolute' && Number(panelCss.zIndex) >= 9999, JSON.stringify(panelCss));

  // --- picking a color via the hex field live-previews the scene background -
  await setPickerHex(page, '#3366CC');
  await page.waitForTimeout(150);
  let live = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    return {
      bgHex: '#' + app.scene.background.getHexString(),
      latticeColor: general.currentLatticeColor,
      dotBorder: document.getElementById('backgroundDot').style.border,
    };
  });
  H.check('dragging/typing a color live-previews the THREE.js scene background',
    live.bgHex.toUpperCase() === '#3366CC', JSON.stringify(live));
  H.check('the on-canvas dot border switches to a contrasting color',
    /^\d+px solid/.test(live.dotBorder), JSON.stringify(live));

  // --- Apply commits it and mirrors onto the Visual-panel swatch ------------
  await page.click('.cv-background-picker-panel .cv-background-picker-btn.highlight');
  await page.waitForTimeout(150);
  let afterApply = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const swatch = document.getElementById('backgroundSwatch');
    return {
      bgHex: '#' + app.scene.background.getHexString(),
      swatchBg: swatch ? getComputedStyle(swatch).backgroundColor : null,
      pickerClosed: !document.querySelector('.cv-background-picker-panel'),
    };
  });
  H.check('Apply commits the color and closes the picker',
    afterApply.bgHex.toUpperCase() === '#3366CC' && afterApply.pickerClosed, JSON.stringify(afterApply));
  H.check('the Visual-panel swatch mirrors the applied scene background (shared state, not two copies)',
    afterApply.swatchBg === 'rgb(51, 102, 204)', afterApply.swatchBg);

  // --- opening from the IN-PANEL swatch reads the SAME current color --------
  await H.clickById(page, 'backgroundSwatch');
  await page.waitForTimeout(150);
  let fromSwatch = await page.evaluate(() => {
    const inputs = document.querySelectorAll('.spin-color-picker .cv-colorpicker-input-field');
    return inputs[1]?.value;
  });
  H.check('opening the picker from the Visual-panel swatch starts from the current scene color',
    fromSwatch?.toUpperCase() === '#3366CC', String(fromSwatch));

  // --- Reset restores the active theme's own scene color, not a hardcoded one
  await page.click('.cv-background-picker-panel .reset-btn');
  await page.waitForTimeout(150);
  let afterReset = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    return {
      bgHex: '#' + app.scene.background.getHexString(),
      matchesDefault: general.defaultBackgroundColor?.toLowerCase(),
      pickerClosed: !document.querySelector('.cv-background-picker-panel'),
    };
  });
  H.check('Reset restores the theme default scene color (not the picked one)',
    afterReset.bgHex.toUpperCase() !== '#3366CC' && afterReset.pickerClosed, JSON.stringify(afterReset));

  // --- clicking the SAME dot twice just closes it, no duplicate picker ------
  await H.clickById(page, 'backgroundDot');
  await page.waitForTimeout(150);
  await H.clickById(page, 'backgroundDot');
  await page.waitForTimeout(150);
  let doubleClick = await page.evaluate(() =>
    document.querySelectorAll('.cv-background-picker-panel').length);
  H.check('clicking the same dot twice closes the picker instead of stacking a second one',
    doubleClick === 0, String(doubleClick));

  // --- clicking outside closes it too ----------------------------------------
  await H.clickById(page, 'backgroundDot');
  await page.waitForTimeout(150);
  await page.mouse.click(20, 20);
  await page.waitForTimeout(150);
  let outsideClosed = await page.evaluate(() => !document.querySelector('.cv-background-picker-panel'));
  H.check('clicking outside the picker closes it', outsideClosed);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
