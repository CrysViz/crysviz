// Supercell creation must refresh the StructureInfoPanel composition string
// (SuperCellModule.js's updateVisualization call was missing reRenderComposition).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const before = await page.evaluate(() => document.getElementById('composition')?.textContent || '');

  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    createSupercell(2, 1, 1);
  });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => document.getElementById('composition')?.textContent || '');
  H.check('composition string changes after supercell', before !== after,
    `before="${before.slice(0, 40)}" after="${after.slice(0, 40)}"`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
