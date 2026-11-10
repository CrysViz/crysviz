// Opening a file from the OS in the installed app (manifest.webmanifest
// file_handlers -> window.launchQueue). Chrome delivers the launch's files
// as soon as the page sets a consumer, which can be early in start-up; the
// file must still end up loaded and selected, after the default structure.
// Chrome's launchQueue is stood in for by a fake that does the same.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const CIF = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tests', 'wav_dat', 'formats', 'NaCl.cif'), 'utf8');
const XYZ = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tests', 'wav_dat', 'formats', 'Si.xyz'), 'utf8');

const STATE = async () => {
  const { fileBrowser } = await import('./state/store.js');
  return {
    rows: [...document.querySelectorAll('#objectTable tbody tr')].map((r) => r.querySelector('.name-inner').textContent),
    selected: fileBrowser.selectedRow?.querySelector('.name-inner').textContent ?? null,
  };
};

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  await page.addInitScript((cif) => {
    // Like Chrome: params queued before the page loads, handed over the
    // moment a consumer is set; later launches go to that consumer.
    const queued = [{ files: [{ getFile: async () => new File([cif], 'NaCl.cif') }] }];
    let consumer = null;
    window.launchQueue = {
      setConsumer(fn) {
        consumer = fn;
        while (queued.length) {
          const params = queued.shift();
          setTimeout(() => consumer(params), 0);
        }
      },
    };
    window.__launchAgain = (name, text) => consumer?.({ files: [{ getFile: async () => new File([text], name) }] });
  }, CIF);
  await page.goto(process.env.CRYSVIZ_URL, { waitUntil: 'load' });
  await H.waitFor(page, async () => document.querySelectorAll('#objectTable tbody tr').length >= 2, { timeout: 40000 });
  await page.waitForTimeout(2000);
  const first = await page.evaluate(STATE);
  H.check('the launched file is in the list', first.rows.includes('NaCl.cif'), JSON.stringify(first));
  H.check('and it is the structure shown', first.selected === 'NaCl.cif', JSON.stringify(first));

  // A second file opened while the app is running (launch_handler
  // focus-existing) is added to this window.
  await page.evaluate((xyz) => window.__launchAgain('Si.xyz', xyz), XYZ);
  await page.waitForTimeout(3000);
  const second = await page.evaluate(STATE);
  H.check('a file opened later is added and shown', second.rows.includes('Si.xyz') && second.selected === 'Si.xyz',
    JSON.stringify(second));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
