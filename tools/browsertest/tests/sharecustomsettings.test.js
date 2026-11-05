// A recipient's own Custom user settings (element colours, bond cutoffs in
// localStorage 'crysvizCustomUserSettings') must not leak into a shared view:
// compact links always carry the element colours and bond cutoffs of the
// species present, and the decoder fills everything else from a frozen baseline.
'use strict';
const H = require('../harness');

const COLOURS = async () => {
  const { fileBrowser, general } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const hex = (c) => (typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : String(c).toLowerCase());
  const byElement = {};
  s.atoms.forEach((a, i) => { byElement[s.elements[i]] ??= hex(a.elementColor); });
  return { byElement, cuO: general.bondLengths['Cu-O'] };
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  const sharer = await page.evaluate(COLOURS);
  const link = await page.evaluate(async () => {
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return url;
  });

  // The recipient: a separate context (own localStorage) with custom settings.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const recipient = await ctx.newPage();
  const recipientErrors = [];
  recipient.on('pageerror', (e) => recipientErrors.push(String(e.message).slice(0, 300)));
  await recipient.addInitScript(() => {
    localStorage.setItem('panelPrefs', JSON.stringify({ hideRaytraceWarning: true }));
    localStorage.setItem('crysvizCustomUserSettings', JSON.stringify({
      colorMap: { O: 0x00ff00, Cu: 0xff00ff },
      bondLengthMap: { 'Cu-O': { min: 0, max: 1.5 } },
    }));
  });

  // Sanity: the custom settings really are active for a plain load.
  await recipient.goto(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html', { waitUntil: 'load' });
  await recipient.waitForTimeout(5000);
  await H.loadDefaultStructure(recipient);
  const own = await recipient.evaluate(COLOURS);
  H.check('recipient custom settings are active on a plain load',
    own.byElement.O === '#00ff00' && Math.abs((own.cuO?.max ?? 0) - 1.5) < 1e-6, JSON.stringify(own));

  await recipient.goto('about:blank');
  await recipient.goto(link, { waitUntil: 'load' });
  await H.waitFor(recipient, async () => (await import('./state/store.js')).general.sharedStructureLoaded, { timeout: 40000, interval: 1000 });
  const shown = await recipient.evaluate(COLOURS);
  H.check("recipient sees the sharer's element colours",
    JSON.stringify(shown.byElement) === JSON.stringify(sharer.byElement),
    JSON.stringify({ sharer: sharer.byElement, shown: shown.byElement }));
  H.check("recipient sees the sharer's bond cutoff",
    Math.abs((shown.cuO?.max ?? 0) - sharer.cuO.max) < 1e-3, JSON.stringify({ sharer: sharer.cuO, shown: shown.cuO }));

  H.check('no page errors', errors.length === 0 && recipientErrors.length === 0,
    [...errors, ...recipientErrors].join(' | '));
  await ctx.close();
  await H.finish(browser);
})().catch(H.crash);
