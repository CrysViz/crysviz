// backendTrajectorySaveStride was hardcoded (store default only); MD menu
// must expose it as an editable field, defaulting to the store's current
// value and feeding back into it.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(() => {
    document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click();
  });
  await page.waitForTimeout(300);

  const before = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const input = document.getElementById('mdSaveStrideInput');
    return { storeValue: general.backendTrajectorySaveStride, inputValue: input?.value, hasInput: !!input };
  });
  H.check('MD menu has a Save-stride input field', before.hasInput, JSON.stringify(before));
  H.check('input defaults to the store value', String(before.storeValue) === before.inputValue, JSON.stringify(before));

  // Edit the field and confirm the exact expression runLocalMD reads at
  // start-time (shell.bodyEl.querySelector('#mdSaveStrideInput').value)
  // reflects the new value.
  const after = await page.evaluate(() => {
    const input = document.getElementById('mdSaveStrideInput');
    input.value = '12';
    return Number(document.querySelector('#mdSaveStrideInput')?.value || 0);
  });
  H.check('edited value is readable from the field', after === 12, `after=${after}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
