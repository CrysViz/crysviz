// Custom User Settings panel (ui/CustomUserSettingsPanel.js) — had zero
// standing coverage before this test, despite driving three independent
// override maps (colors/radii/bond-distances) through one shared periodic-
// table grid renderer. Covers the collision that grid renderer would create
// if it broke for one map but not another: pick an override in each of the
// three pickers, confirm it applies LIVE to the loaded structure, persists to
// localStorage, and survives a reload.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO: Y, Ba, Cu, O all present

  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('customSettings').expand();
  });
  await page.waitForTimeout(200);

  // Buttons are matched by their exact label rather than position/class:
  // the "All Settings" section (Load/Download JSON) also uses .btn-mini
  // .highlight, so scoping by class alone picked up the wrong button.
  async function clickLabeled(text, index = 0) {
    await page.evaluate(({ text, index }) => {
      const matches = [...document.querySelectorAll('#cvPanelBody-customSettings button')]
        .filter((b) => b.textContent.trim() === text);
      matches[index].click();
    }, { text, index });
  }

  // ---- Colors: open the picker, override Cu, confirm it applies live -------
  await clickLabeled('Configure via Periodic Table', 0); // Colors section
  await page.waitForTimeout(150);

  let popupCss = await page.evaluate(() => {
    const el = document.querySelector('.cv-cus-popup');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      position: cs.position,
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    };
  });
  H.check('the periodic-table popup is a real centered floating dialog (CSS applied)',
    popupCss.position === 'fixed'
      && Math.abs(popupCss.centerX - popupCss.viewportW / 2) < 5
      && Math.abs(popupCss.centerY - popupCss.viewportH / 2) < 5,
    JSON.stringify(popupCss));

  await page.evaluate(() => {
    document.querySelector('.cv-cus-popup button[data-symbol="Cu"]').click();
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const hexInput = document.querySelectorAll('.swatch-color-picker .cv-colorpicker-input-field')[1];
    hexInput.value = '#123456';
    hexInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);

  let colorState = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const cuAtomIdx = fileBrowser.selectedStructure.elements.findIndex((e) => e === 'Cu');
    return {
      mapValue: general.customColorMap.Cu,
      atomColor: fileBrowser.selectedStructure.atoms[cuAtomIdx]?.color,
    };
  });
  H.check('picking a color override records it in general.customColorMap',
    colorState.mapValue === 0x123456, JSON.stringify(colorState));
  H.check('the override applies LIVE to the loaded structure\'s Cu atoms',
    colorState.atomColor === 0x123456, JSON.stringify(colorState));

  await page.click('.cv-cus-popup .cv-cus-close-btn');
  await page.waitForTimeout(150);
  // Section order in the DOM: [0] the wide "All Settings" section, [1] Colors.
  let colorCount = await page.evaluate(() =>
    document.getElementById('cvPanelBody-customSettings')
      .querySelectorAll('.cv-cus-section')[1].querySelector('.cv-cus-section-count').textContent);
  H.check('Colors section count reflects the one override', /1 element/.test(colorCount), colorCount);

  // ---- Radii: override O's atomic radius via the enlarged preview input ----
  await clickLabeled('Configure via Periodic Table', 1); // Radii section
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.querySelector('.cv-cus-popup button[data-symbol="O"]').click();
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const input = document.querySelector('.cv-cus-popup .radius-preview-input');
    input.value = '1.23';
    input.dispatchEvent(new Event('input'));
  });
  await page.click('.cv-cus-popup .radius-preview-apply');
  await page.waitForTimeout(150);

  let radiusState = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return general.customAtomicRadii.O;
  });
  H.check('picking a radius override records it in general.customAtomicRadii',
    Math.abs(radiusState - 1.23) < 0.001, String(radiusState));

  await page.click('.cv-cus-popup .cv-cus-close-btn');
  await page.waitForTimeout(150);

  // ---- Bonds: pick a pair, set a distance, confirm the shared map updates --
  await clickLabeled('Configure via Periodic Table', 2); // Bond Distances section
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.querySelector('.cv-cus-popup button[data-symbol="Cu"]').click();
    document.querySelector('.cv-cus-popup button[data-symbol="O"]').click();
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('.cv-cus-popup .cv-cus-bond-distance-input');
    inputs[0].value = '1.5';
    inputs[1].value = '2.75';
  });
  await page.click('.cv-cus-popup .cv-cus-bond-btn.highlight'); // Apply
  await page.waitForTimeout(150);

  let bondState = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { live: general.bondLengths['Cu-O'], custom: general.customBondLengths['Cu-O'] };
  });
  H.check('picking a bond-pair override updates BOTH the live bondLengths map and the custom bookkeeping map',
    bondState.live?.max === 2.75 && bondState.live?.min === 1.5
      && bondState.custom?.max === 2.75 && bondState.custom?.min === 1.5,
    JSON.stringify(bondState));

  await page.click('.cv-cus-popup .cv-cus-close-btn');
  await page.waitForTimeout(150);

  // ---- persistence: all three overrides survive a reload -------------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  let restored = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return {
      color: general.customColorMap.Cu,
      radius: general.customAtomicRadii.O,
      bond: general.customBondLengths['Cu-O'],
    };
  });
  H.check('all three override maps round-trip through localStorage across a reload',
    restored.color === 0x123456 && Math.abs(restored.radius - 1.23) < 0.001
      && restored.bond?.max === 2.75,
    JSON.stringify(restored));

  // ---- Clear All actually clears (not just the count label) ----------------
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('customSettings').expand();
  });
  await page.waitForTimeout(200);
  await clickLabeled('Clear All', 0); // Colors "Clear All"
  await page.waitForTimeout(150);
  let cleared = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const cuAtomIdx = fileBrowser.selectedStructure.elements.findIndex((e) => e === 'Cu');
    return {
      mapHasCu: Object.prototype.hasOwnProperty.call(general.customColorMap, 'Cu'),
      atomColor: fileBrowser.selectedStructure.atoms[cuAtomIdx]?.color,
    };
  });
  H.check('Clear All removes the override AND reverts the live atom color',
    !cleared.mapHasCu && cleared.atomColor !== 0x123456, JSON.stringify(cleared));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
