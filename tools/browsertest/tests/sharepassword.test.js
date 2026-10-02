// A password turns the share link into the same #z= link with the envelope's
// encrypted flag set (AES-GCM, header byte authenticated). Opening it asks for
// the password; a wrong one asks again; the right one restores the view.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const plain = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    fileBrowser.selectedStructure.atoms[2].color = '#123456';
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    return document.getElementById('shareLinkUrl').value;
  });
  await page.fill('#shareLinkPassword', 'hunter2');
  await page.waitForFunction((p) => document.getElementById('shareLinkUrl').value !== p, plain, { timeout: 30000 });
  const enc = await page.evaluate(async () => {
    const env = await import('./io/share/shareEnvelope.js');
    const url = document.getElementById('shareLinkUrl').value;
    const bytes = env.b64URLToBytes(url.split('#z=')[1]);
    await new Promise(r => setTimeout(r, 1500)); // let the QR re-render
    return { url, header: bytes[0], note: document.getElementById('shareLinkLockNote').textContent,
      qr: !!document.querySelector('#shareLinkQr svg') };
  });
  H.check('the password link is a #z= link with the encrypted flag',
    /#z=[A-Za-z0-9_-]+$/.test(enc.url) && (enc.header & 0x80) !== 0, `header ${enc.header}`);
  H.check('the dialog says it is encrypted and still draws a QR', /Encrypted/.test(enc.note) && enc.qr, enc.note);

  await page.goto('about:blank');
  await page.goto(enc.url, { waitUntil: 'load' });
  const answer = async (pw) => {
    await page.waitForSelector('#sharePasswordModal:not([hidden])', { timeout: 40000 });
    await page.fill('#sharePwInput', pw);
    await page.click('#sharePwOpen');
  };
  await answer('wrong');
  await page.waitForSelector('#sharePwError:not([hidden])', { timeout: 40000 });
  await answer('hunter2');
  const r = await H.waitFor(page, async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    if (!general.sharedStructureLoaded) return null;
    const c = fileBrowser.selectedStructure.atoms[2].color;
    return typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : String(c).toLowerCase();
  }, { timeout: 60000, interval: 1000 });
  H.check('the right password restores the view', r === '#123456', String(r));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
