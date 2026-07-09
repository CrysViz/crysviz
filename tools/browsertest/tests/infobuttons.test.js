// Titlebar info ("i") buttons: backend/files/settings/features panels each
// get one wired to their existing markdown blurb, and it hides along with
// the rest of the title bar when the bar is collapsed to its thin strip.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

    for (const id of ['backend', 'files', 'settings', 'features']) {
      const has = await page.evaluate((id) => {
        const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
        const btn = el && el.querySelector('.cv-panel-titlebar > .cv-panel-info');
        return !!btn;
      }, id);
      H.check(`${id} panel has titlebar info button`, has);
    }

    // Clicking the settings info button opens the overlay with storageInfo.md.
    await page.evaluate(() => {
      const el = document.querySelector('.cv-panel[data-panel-id="settings"]');
      el.querySelector('.cv-panel-info').click();
    });
    await page.waitForTimeout(500);
    const overlayText = await page.evaluate(() => document.querySelector('.info-panel-content')?.textContent || '');
    H.check('info overlay shows content', overlayText.trim().length > 0, overlayText.slice(0, 60));

    await page.evaluate(() => document.querySelector('.info-panel-close')?.click());
    await page.waitForTimeout(200);
    const overlayGone = await page.evaluate(() => !document.querySelector('.info-panel'));
    H.check('info overlay closes', overlayGone);

    // Bar-collapse hides the info button along with the rest of the bar.
    await page.evaluate(() => {
      const el = document.querySelector('.cv-panel[data-panel-id="settings"]');
      el.querySelector('.cv-panel-barhide').click();
    });
    await page.waitForTimeout(200);
    const hiddenWithBar = await page.evaluate(() => {
      const btn = document.querySelector('.cv-panel[data-panel-id="settings"] .cv-panel-info');
      return getComputedStyle(btn).display === 'none';
    });
    H.check('info button hides with collapsed title bar', hiddenWithBar);

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
