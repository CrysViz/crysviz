// Visual ▸ Camera "Rotate & pan speed" slider: the multiplier scales the live
// TrackballControls rotate speed, the runtime pan factor (general.cameraSpeedFactor),
// and is persisted to the cameraSpeedFactor panelPref.
'use strict';
const H = require('../harness');

// Base sensitivities from WindowAndSceneControls.js (factor 1 = these values).
const BASE_ROTATE = 1.5;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const start = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const el = document.getElementById('cameraSpeedFactor');
    return {
      hasSlider: !!el,
      hasReset: !!document.querySelector('.camera_speed_reset'),
      sliderValue: el ? parseFloat(el.value) : null,
      sliderMax: el ? parseFloat(el.max) : null,
      factor: general.cameraSpeedFactor,
      rotateSpeed: app.controls.rotateSpeed,
    };
  });
  H.check('slider exists', start.hasSlider, JSON.stringify(start));
  H.check('reset button exists', start.hasReset, JSON.stringify(start));
  H.check('slider max is 5x', start.sliderMax === 5, JSON.stringify(start));
  H.check('defaults to 1x', start.sliderValue === 1 && start.factor === 1,
    JSON.stringify(start));
  H.check('default rotate speed is the tuned base',
    Math.abs(start.rotateSpeed - BASE_ROTATE) < 1e-6, JSON.stringify(start));

  // Faster: 2x.
  await H.setSlider(page, 'cameraSpeedFactor', 2);
  const faster = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    return {
      factor: general.cameraSpeedFactor,
      rotateSpeed: app.controls.rotateSpeed,
      pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').cameraSpeedFactor,
    };
  });
  H.check('2x updates the pan factor', faster.factor === 2, JSON.stringify(faster));
  H.check('2x doubles rotate speed',
    Math.abs(faster.rotateSpeed - BASE_ROTATE * 2) < 1e-6, JSON.stringify(faster));
  H.check('2x is persisted to panelPref', faster.pref === 2, JSON.stringify(faster));

  // Slower: 0.5x.
  await H.setSlider(page, 'cameraSpeedFactor', 0.5);
  const slower = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    return { factor: general.cameraSpeedFactor, rotateSpeed: app.controls.rotateSpeed };
  });
  H.check('0.5x halves rotate speed and factor',
    slower.factor === 0.5 && Math.abs(slower.rotateSpeed - BASE_ROTATE * 0.5) < 1e-6,
    JSON.stringify(slower));

  // Reset button restores 1x (factor, controls, slider position, and pref).
  const afterReset = await page.evaluate(async () => {
    document.querySelector('.camera_speed_reset').click();
    const { app, general } = await import('./state/store.js');
    return {
      factor: general.cameraSpeedFactor,
      rotateSpeed: app.controls.rotateSpeed,
      sliderValue: parseFloat(document.getElementById('cameraSpeedFactor').value),
      pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').cameraSpeedFactor,
    };
  });
  H.check('reset button restores 1x everywhere',
    afterReset.factor === 1 && afterReset.sliderValue === 1 && afterReset.pref === 1
      && Math.abs(afterReset.rotateSpeed - BASE_ROTATE) < 1e-6,
    JSON.stringify(afterReset));

  // Reset UI (#resetUiButton -> resetAllPanels) must also restore the speed.
  await H.setSlider(page, 'cameraSpeedFactor', 3);
  await page.evaluate(() => document.getElementById('resetUiButton')?.click());
  const afterResetUi = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    return {
      factor: general.cameraSpeedFactor,
      rotateSpeed: app.controls.rotateSpeed,
      sliderValue: parseFloat(document.getElementById('cameraSpeedFactor').value),
      pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').cameraSpeedFactor,
    };
  });
  H.check('Reset UI restores 1x everywhere',
    afterResetUi.factor === 1 && afterResetUi.sliderValue === 1 && afterResetUi.pref === 1
      && Math.abs(afterResetUi.rotateSpeed - BASE_ROTATE) < 1e-6,
    JSON.stringify(afterResetUi));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
