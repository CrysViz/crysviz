// A share link pasted into the Paste Text box opens in the running session,
// whatever domain it names — crysviz.org, the desktop app's 127.0.0.1 server or
// anything else. This is how a link reaches the desktop app: the decoder takes
// the payload and ignores the domain.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const link = await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const d = await import('./defaults/structure_defaults.js');
    await cv.loadStructure(d.defaultPOSCAR5, 'Si');
    await new Promise(r => setTimeout(r, 1500));
    const { fileBrowser } = await import('./state/store.js');
    fileBrowser.selectedStructure.atoms[0].color = '#00ff00';
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return { fragment: url.slice(url.indexOf('#')), atoms: fileBrowser.selectedStructure.atoms.length };
  });

  const hrefBefore = await page.evaluate(() => location.href);
  for (const base of ['https://crysviz.org/', 'http://127.0.0.1:41234/index.html', 'https://example.org/some/page?x=1']) {
    // Put a different structure on screen first, so a no-op paste can't pass.
    await H.loadDefaultStructure(page);
    await page.evaluate(async () => { (await import('./state/store.js')).general.sharedStructureLoaded = false; });
    await page.click('#pasteTextButton');
    await page.fill('#structureText', base + link.fragment);
    await page.click('#loadTextButton');
    const r = await H.waitFor(page, async () => {
      const { general, fileBrowser } = await import('./state/store.js');
      if (!general.sharedStructureLoaded) return null;
      const c = fileBrowser.selectedStructure.atoms[0].color;
      return { atoms: fileBrowser.selectedStructure.atoms.length,
        atom0: typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : String(c).toLowerCase() };
    }, { timeout: 40000, interval: 500 });
    H.check(`pasted link naming ${new URL(base).host} opens the shared view`,
      r && r.atoms === link.atoms && r.atom0 === '#00ff00', JSON.stringify(r));
  }
  H.check('pasting never navigates the tab', await page.evaluate(() => location.href) === hrefBefore, '');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
