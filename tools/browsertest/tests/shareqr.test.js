// The Share button opens the share-link dialog (not a prompt) and puts a QR
// code next to the URL. The QR encoder is fetched lazily from a CDN, so the
// offline path — dialog + URL still usable, QR replaced by a note — is asserted
// too: that fallback is the one a sandboxed or air-gapped user actually hits.
'use strict';
const fs = require('fs');
const { PNG } = require('pngjs');
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // prompt() would block the run forever if the old path came back — stub it
  // and record the call instead.
  const opened = await page.evaluate(async () => {
    window.__promptCalls = 0;
    window.prompt = () => { window.__promptCalls++; return null; };
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const modal = document.getElementById('shareLinkModal');
    const field = /** @type {HTMLTextAreaElement} */ (document.getElementById('shareLinkUrl'));
    return {
      promptCalls: window.__promptCalls,
      visible: !!modal && !modal.hidden,
      url: field ? field.value : '',
    };
  });

  H.check('Share no longer falls back to prompt()', opened.promptCalls === 0,
    JSON.stringify(opened.promptCalls));
  H.check('share dialog is open', opened.visible === true, JSON.stringify(opened.visible));
  H.check('share URL carries the deflated state (?z=)',
    /^https?:\/\/.+[?&]z=.+/.test(opened.url), opened.url.slice(0, 80));

  // The QR half settles asynchronously: either a drawn symbol or a note saying
  // why there isn't one. "Generating…" still showing means it never resolved.
  await H.waitFor(page, () => {
    const note = document.getElementById('shareLinkQrNote');
    const svg = document.querySelector('#shareLinkQr svg');
    return !!svg || (!!note && !/Generating/.test(note.textContent));
  }, { timeout: 20000, interval: 500 });

  const qr = await page.evaluate(() => {
    const svg = document.querySelector('#shareLinkQr svg');
    return {
      hasSvg: !!svg,
      modules: svg ? svg.querySelectorAll('path').length : 0,
      note: document.getElementById('shareLinkQrNote')?.textContent ?? '',
      urlLen: /** @type {HTMLTextAreaElement} */ (document.getElementById('shareLinkUrl')).value.length,
    };
  });
  console.log(`  [info] share URL ${qr.urlLen} chars; note: ${qr.note}`);
  H.check('QR area resolves to a symbol or an explanation',
    qr.hasSvg ? qr.modules > 0 : /unavailable|too long/i.test(qr.note),
    JSON.stringify(qr));

  // --- QR export ------------------------------------------------------------
  // Both files are exercised end to end (real download, real bytes) — the PNG
  // is rasterised from the module grid rather than the on-screen SVG, so a
  // regression there would produce a plausible-looking but resampled image.
  const grab = async (id) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.click(`#${id}`),
    ]);
    return { name: download.suggestedFilename(), path: await download.path() };
  };

  const svg = await grab('shareLinkQrSvg');
  const svgText = fs.readFileSync(svg.path, 'utf8');
  H.check('SVG export downloads a standalone QR svg',
    /\.svg$/.test(svg.name) && svgText.startsWith('<svg') && /<path d="M/.test(svgText),
    `${svg.name} ${svgText.slice(0, 60)}`);

  const png = await grab('shareLinkQrPng');
  const image = PNG.sync.read(fs.readFileSync(png.path));
  // Square, and big enough that each module survives a reprint (the exporter
  // floors the edge at 1024px).
  H.check('PNG export downloads a square QR image of usable size',
    /\.png$/.test(png.name) && image.width === image.height && image.width >= 1024,
    `${png.name} ${image.width}x${image.height}`);
  // Corner pixel is quiet zone: white. A black corner means the border was lost.
  H.check('PNG keeps the quiet zone',
    image.data[0] === 255 && image.data[1] === 255 && image.data[2] === 255,
    JSON.stringify([...image.data.slice(0, 3)]));

  // Closing must restore the app: a stuck full-screen overlay swallows every
  // subsequent click in the scene.
  const closed = await page.evaluate(() => {
    document.getElementById('shareLinkClose').click();
    return document.getElementById('shareLinkModal').hidden;
  });
  H.check('Close hides the dialog', closed === true, JSON.stringify(closed));

  H.check('no page errors', errors.length === 0, errors.join(' | '));

  // The compressed link has to load back — deflating the state is only safe if
  // ?z= round-trips, and this is the assertion that catches a broken encoder.
  await page.goto(opened.url, { waitUntil: 'load' });
  await H.waitFor(page, async () => {
    const { getActiveStructure } = await import('./state/structures.js');
    return (getActiveStructure()?.atoms?.length ?? 0) > 0;
  }, { timeout: 40000, interval: 1000 });
  const restored = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { getActiveStructure } = await import('./state/structures.js');
    const s = getActiveStructure();
    return { loaded: general.sharedStructureLoaded === true, atoms: s?.atoms?.length ?? 0 };
  });
  H.check('a ?z= link restores the shared structure',
    restored.loaded === true && restored.atoms > 0, JSON.stringify(restored));

  await H.finish(browser);
})().catch(H.crash);
