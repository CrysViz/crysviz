// A share link that differs from the open tab's URL only in the fragment is a
// same-document navigation: the browser changes location.hash and does NOT
// reload. Opening link B in a tab showing link A (paste into the address bar,
// or a chat app reusing the tab) must still load B — the app reloads on a new
// #z= / #q= fragment.
'use strict';
const H = require('../harness');

const MAKE_LINK = async (exportName) => {
  const cv = await import('./core/crystal-viewer.js');
  const d = await import('./defaults/structure_defaults.js');
  await cv.loadStructure(d[exportName], exportName);
  await new Promise(r => setTimeout(r, 1500));
  const { shareStructure } = await import('./ui/ShareModule.js');
  const { fileBrowser } = await import('./state/store.js');
  await shareStructure();
  const url = document.getElementById('shareLinkUrl').value;
  document.getElementById('shareLinkClose').click();
  return { url, atoms: fileBrowser.selectedStructure.atoms.length };
};

const LOADED = async () => {
  const { general } = await import('./state/store.js');
  const { getActiveStructure } = await import('./state/structures.js');
  return general.sharedStructureLoaded === true ? (getActiveStructure()?.atoms?.length ?? 0) : 0;
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  const a = await page.evaluate(MAKE_LINK, 'defaultPOSCAR');
  const b = await page.evaluate(MAKE_LINK, 'defaultPOSCAR5');
  H.check('the two links show different structures', a.atoms !== b.atoms, `${a.atoms} vs ${b.atoms}`);

  await page.goto('about:blank');
  await page.goto(a.url, { waitUntil: 'load' });
  const first = await H.waitFor(page, LOADED, { timeout: 60000, interval: 1000 });
  H.check('link A opens', first === a.atoms, `${first} atoms`);

  // Same document, new fragment: what pasting link B into the address bar does.
  await page.evaluate(() => { window.__sameDocument = true; });
  const hashB = b.url.slice(b.url.indexOf('#'));
  await Promise.all([
    page.waitForEvent('load', { timeout: 60000 }),
    page.evaluate((h) => { location.hash = h; }, hashB),
  ]);
  const second = await H.waitFor(page, LOADED, { timeout: 60000, interval: 1000 });
  const reloaded = await page.evaluate(() => window.__sameDocument !== true);
  H.check('a new #z= fragment reloads the page', reloaded, '');
  H.check('link B opens in the same tab', second === b.atoms, `${second} atoms, expected ${b.atoms}`);

  // An unrelated fragment must not reload anything.
  await page.evaluate(() => { window.__sameDocument = true; location.hash = 'something-else'; });
  await page.waitForTimeout(1500);
  H.check('other fragments do not reload', await page.evaluate(() => window.__sameDocument === true), '');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
