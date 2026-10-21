// Loading a widget without putting the structure in the URL (no URL-length
// limit): `#load-message` (the embedding page posts the session) and
// `#load-url=` (the widget fetches it), plus the "Open in CrysViz" handoff that
// posts the session to the new full-app tab (`#load-opener`). See
// docs/io/SessionReceiver.js and docs/io/FileURLLoader.js.
//
// Part A runs a real host page: an opaque-origin about:blank parent with the
// widget in a sandboxed iframe (the same sandbox flags the database uses), so
// the event.source / origin gates are exercised as in production.
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';
const DATA_URL = 'https://data.example.test/runs/traj.crysviz';

/** A 5-frame trajectory: atom 0's fractional x is 0.1 * frame, so the shown
 *  frame is identifiable from it. */
function trajectoryFixture() {
  const a = 5.0;
  const lattice = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  const frames = [];
  for (let f = 0; f < 5; f++) {
    frames.push({ elements: ['Fe', 'O'], lattice, positions: [[f * 0.1, 0, 0], [0.5, 0.5, 0.5]] });
  }
  return JSON.stringify({
    format: 'crysviz', version: '2.16', frames, selectedFrameIndex: 0,
    display: { showAtoms: true, showBonds: true, showLattice: true }, style: {},
  });
}

/** Loaded frame count + atom 0's fractional x in a CrysViz page or frame. */
async function shown(target) {
  return target.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    if (!s) return null;
    const c = structureShip.container[fileBrowser.selectedRowIndex];
    const p = s.atoms[0].position; // fractional
    const fx = Array.isArray(p) ? p[0] : p.x;
    return { frames: c?.structures?.length ?? 0, fx: Math.round(fx * 1000) / 1000 };
  }).catch(() => null);
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  const context = page.context();

  // ── A. #load-message: the host page posts the trajectory ─────────────────
  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
  await page.evaluate(({ src, json }) => {
    window.__cv = { msgs: [] };
    const iframe = document.createElement('iframe');
    iframe.id = 'w';
    iframe.width = '400';
    iframe.height = '400';
    iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads');
    iframe.src = src;
    window.addEventListener('message', (e) => {
      if (e.source !== iframe.contentWindow) return;
      const d = e.data;
      if (!d || d.source !== 'crysviz-widget') return;
      window.__cv.msgs.push({ type: d.type, index: d.index, frameCount: d.frameCount });
      if (d.type === 'awaitingSession') {
        // Bytes, transferred — no base64, no URL.
        const bytes = new TextEncoder().encode(json);
        iframe.contentWindow.postMessage(
          { target: 'crysviz-widget', type: 'loadSession', name: 'traj.crysviz', data: bytes.buffer },
          '*', [bytes.buffer]);
      }
    });
    document.body.appendChild(iframe);
  }, { src: `${BASE}?widget=1&control=1#load-message`, json: trajectoryFixture() });

  const ready = await H.waitFor(page, () => window.__cv.msgs.find((m) => m.type === 'ready') || null,
    { timeout: 60000, interval: 500 });
  const types = await page.evaluate(() => window.__cv.msgs.map((m) => m.type));
  H.check('widget asked the host for its session', types[0] === 'awaitingSession', JSON.stringify(types));
  H.check('widget loaded the posted 5-frame trajectory (ready)', ready?.frameCount === 5, JSON.stringify(ready));

  const frame = page.frames().find((f) => f.url().startsWith(BASE.replace(/index\.html$/, '')) && f !== page.mainFrame());
  const s0 = frame && await shown(frame);
  H.check('posted session is on screen (frame 0)', s0?.frames === 5 && s0?.fx === 0, JSON.stringify(s0));
  const hashLeft = frame && await frame.evaluate(() => window.location.hash);
  H.check('#load-message hash is cleared after loading', hashLeft === '', String(hashLeft));

  // The control channel answers an opaque-origin ('null') host.
  await page.evaluate(() => document.getElementById('w').contentWindow.postMessage(
    { target: 'crysviz-widget', type: 'setFrame', index: 3 }, '*'));
  const f3 = await H.waitFor(page, () => window.__cv.msgs.find((m) => m.type === 'frame' && m.index === 3) || null,
    { timeout: 15000, interval: 300 });
  H.check('setFrame reply reaches an opaque-origin host', f3?.index === 3, JSON.stringify(f3));
  const s3 = await shown(frame);
  H.check('frame 3 is on screen after setFrame', s3?.fx === 0.3, JSON.stringify(s3));

  // ── "Open in CrysViz" hands the session to the new tab (#load-opener) ──────
  const popupP = context.waitForEvent('page', { timeout: 30000 });
  await frame.evaluate(() => document.getElementById('widgetLogo').click());
  await frame.evaluate(() => document.querySelector('.widget-menu-item[data-action="open"]').click());
  const popup = await popupP;
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(String(e.message)));
  H.check('new tab opens the full app at #load-opener', /#load-opener$/.test(popup.url()) && !/widget=/.test(popup.url()),
    popup.url().slice(0, 200));
  let full = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    full = await shown(popup);
    if (full) break;
    await popup.waitForTimeout(1000);
  }
  H.check('full app received the whole trajectory', full?.frames === 5, JSON.stringify(full));
  H.check('full app opened on the frame the widget showed (3)', full?.fx === 0.3, JSON.stringify(full));
  const fullMode = await popup.evaluate(() => document.body.classList.contains('widget-mode'));
  H.check('handoff tab is the full app, not the widget', fullMode === false);
  H.check('no page errors in the handoff tab', popupErrors.length === 0, popupErrors.slice(0, 3).join(' | '));
  await popup.close();

  // ── B. #load-url=: the widget fetches the file by reference ───────────────
  let fetched = 0;
  await context.route(DATA_URL, (route) => {
    fetched++;
    route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: trajectoryFixture(),
    });
  });
  await context.route('https://data.example.test/missing.crysviz', (route) => route.fulfill({
    status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'nope',
  }));
  await page.goto(`${BASE}?widget=1#load-url=${encodeURIComponent(DATA_URL)}`, { waitUntil: 'load', timeout: 90000 });
  let byUrl = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) {
    byUrl = await shown(page);
    if (byUrl) break;
    await page.waitForTimeout(1000);
  }
  H.check('#load-url fetched the file once', fetched === 1, String(fetched));
  H.check('#load-url loaded the 5-frame trajectory', byUrl?.frames === 5 && byUrl?.fx === 0, JSON.stringify(byUrl));
  const name = await page.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    return structureShip.container[fileBrowser.selectedRowIndex]?.fileName ?? '';
  });
  H.check('#load-url names the structure from the URL path', /traj/.test(String(name)), String(name));

  // A failing fetch surfaces the widget's boot-error notice (not a blank embed).
  // (Leave the page first: a goto that only changes the hash would not reload.)
  await page.goto('about:blank');
  await page.goto(`${BASE}?widget=1#load-url=${encodeURIComponent('https://data.example.test/missing.crysviz')}`,
    { waitUntil: 'load', timeout: 90000 });
  const bootError = await H.waitFor(page, () => document.getElementById('widgetBootError')?.textContent || null,
    { timeout: 40000, interval: 500 });
  H.check('#load-url 404 shows the boot-error notice', !!bootError, String(bootError));

  // Non-http(s) schemes are refused.
  const refused = await page.evaluate(async () => {
    window.location.hash = '#load-url=' + encodeURIComponent('javascript:alert(1)');
    const { loadFromFilePath } = await import('./io/index.js');
    try { await loadFromFilePath(); return 'loaded'; } catch (e) { return String(e.message); }
  });
  H.check('#load-url refuses non-http(s) URLs', /only supports http/.test(refused), refused);

  // Only the deliberate 404 above may log (its fetch + the boot error).
  const real = errors.filter((e) => !/missing\.crysviz|status of 404/.test(e));
  H.check('no unexpected console errors', real.length === 0, real.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
