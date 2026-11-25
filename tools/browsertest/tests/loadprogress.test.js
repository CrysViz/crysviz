// Faster loading and the load progress overlay (index.html #bootProgress,
// ui/BootProgress.js).
//
//   - After start-up the overlay is gone; the start-up loads only the fonts
//     the 3D view's labels use (not Greek, Cyrillic, extended Latin), the
//     logos are the web-sized copies and the About logo waits for the dialog.
//   - A styled share link (polyhedra, per-atom colours, measurements) opened
//     after start-up shows its steps on the overlay, which then goes away.
//   - Opening it computes the polyhedra once (it was twice: once before the
//     atom order and styles were restored), and the measurement lines' dashes
//     share one geometry instead of building one each.
//   - A first start-up in a browser draws the example structure before it
//     builds the windows, with the progress card moved to the bottom of the
//     view meanwhile; the bar follows the script download from the first
//     script on (the count is kept for the next start-up). A later start-up
//     builds the windows first (their code applies saved settings).
'use strict';
const H = require('../harness');

function rutilePoscar(n) {
  const base = [['Ti', 0, 0, 0], ['Ti', 0.5, 0.5, 0.5], ['O', 0.3048, 0.3048, 0], ['O', 0.6952, 0.6952, 0], ['O', 0.8048, 0.1952, 0.5], ['O', 0.1952, 0.8048, 0.5]];
  const ti = [], o = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let l = 0; l < n; l++) {
    for (const [el, x, y, z] of base) (el === 'Ti' ? ti : o).push([(x + i) / n, (y + j) / n, (z + l) / n].map((v) => v.toFixed(6)).join(' '));
  }
  return ['rutile', '1.0', `${4.5937 * n} 0 0`, `0 ${4.5937 * n} 0`, `0 0 ${2.9587 * n}`, 'Ti O', `${ti.length} ${o.length}`, 'Direct', ...ti, ...o, ''].join('\n');
}

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

(async () => {
  const { browser, page, errors } = await H.launchApp({ firstRunFeatures: true, navigate: false });
  // The start-up's order, as the page sees it: when the example structure's
  // row and the first window appear, and what the progress card says then.
  await page.addInitScript(() => {
    const seen = { structure: null, window: null, steps: [] };
    window.__boot = seen;
    const card = () => {
      const o = document.getElementById('bootProgress');
      return o && !o.hidden ? { text: document.getElementById('bootProgressText')?.textContent, compact: o.classList.contains('is-compact'), tracking: o.classList.contains('is-tracking') } : null;
    };
    new MutationObserver(() => {
      const t = Math.round(performance.now());
      if (seen.structure === null && document.querySelector('#fileBrowserTable, #fileBrowser, body')?.textContent.includes('oP28-C3N4')) seen.structure = { t, card: card() };
      if (seen.window === null && document.querySelector('.cv-panel')) seen.window = { t, card: card() };
      const c = card();
      if (c && seen.steps.at(-1)?.text !== c.text) seen.steps.push(c);
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  });
  await page.goto(BASE, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  const order = await page.evaluate(() => ({ ...window.__boot, scripts: Number(localStorage.getItem('crysviz.bootScripts')) }));
  H.check('a plain start-up draws the example structure before it builds the windows',
    order.structure && order.window && order.structure.t < order.window.t, JSON.stringify(order));
  H.check('meanwhile the progress card says so, at the bottom of the view',
    order.steps.some((s) => s.text === 'Preparing the windows…' && s.compact) && order.steps.every((s) => s.text !== 'Preparing the windows…' || s.compact),
    JSON.stringify(order.steps));
  H.check('the bar follows the script download (tracking from the first script; the count is kept)',
    order.steps.slice(1).every((s) => s.tracking) && order.scripts > 100, JSON.stringify({ steps: order.steps, scripts: order.scripts }));
  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  const again = await page.evaluate(() => window.__boot);
  H.check('a later start-up builds the windows first (they apply saved settings)',
    again.structure && again.window && again.window.t < again.structure.t && again.steps.every((s) => !s.compact), JSON.stringify(again));

  const polyLogs = [];
  page.on('console', (m) => { if (/\[polyhedra\] .*total=/.test(m.text())) polyLogs.push(m.text()); });

  // ---- after start-up -------------------------------------------------------------------
  const boot = await page.evaluate(() => {
    const overlay = document.getElementById('bootProgress');
    const loaded = (cp) => [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === 'CrysViz Sans' && f.status === 'loaded'
      && String(f.unicodeRange).split(',').some((p) => { const [a, b] = p.trim().replace(/^U\+/i, '').split('-'); return cp >= parseInt(a, 16) && cp <= parseInt(b || a, 16); }));
    const header = /** @type {HTMLImageElement} */ (document.getElementById('aboutTrigger'));
    const about = /** @type {HTMLImageElement} */ (document.querySelector('#aboutOverlay img.logo, #aboutModal img.logo, img.logo:not(#aboutTrigger)'));
    return {
      overlayHidden: !!overlay && overlay.hidden,
      latin: loaded(0x41),
      greek: loaded(0x3B1),
      cyrillic: loaded(0x44F),
      latinExt: loaded(0x142),
      header: { src: header?.getAttribute('src'), natural: header?.naturalWidth },
      about: { src: about?.getAttribute('src'), loading: about?.loading },
      favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href'),
    };
  });
  H.check('after start-up the progress overlay is gone', boot.overlayHidden, JSON.stringify(boot));
  H.check('start-up loads the label fonts only (Latin; not Greek, Cyrillic or extended Latin)',
    boot.latin && !boot.greek && !boot.cyrillic && !boot.latinExt, JSON.stringify(boot));
  H.check('the logos and favicon are the web-sized copies; the About logo loads with its dialog',
    /logo-web\//.test(boot.header.src) && boot.header.natural > 0 && boot.header.natural <= 600
      && /logo-web\//.test(boot.about.src) && boot.about.loading === 'lazy' && /logo-web\//.test(boot.favicon),
    JSON.stringify(boot));

  // ---- a styled share link --------------------------------------------------------------
  await page.evaluate(async (t) => { await (await import('./core/crystal-viewer.js')).loadStructure(t, 'POSCAR'); }, rutilePoscar(3));
  await page.waitForTimeout(1500);
  if (!(await page.evaluate(() => document.getElementById('showPolyhedra').checked))) await H.clickById(page, 'showPolyhedra');
  await page.waitForTimeout(2500);
  const link = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { fileBrowser } = await import('./state/store.js');
    const { updateAtoms } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.atoms.forEach((a, i) => a.setColor(`#${(((i * 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`));
    updateAtoms();
    const { addDistanceMeasurement, addAngleMeasurement } = await import('./render/MeasurementModule.js');
    const w = s.periodic.visibleWrapped;
    const atom = (i) => ({ position: new THREE.Vector3(...w.cart[i]), userData: { atomIndex: w.srcIndex ? w.srcIndex[i] : i, element: w.elements[i], wrappedFrac: [...w.frac[i]] } });
    for (let k = 0; k < 8; k++) addDistanceMeasurement(atom(k), atom(k + 7));
    for (let k = 0; k < 4; k++) addAngleMeasurement(atom(k), atom(k + 3), atom(k + 9));
    window.confirm = () => true;
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return url;
  });
  polyLogs.length = 0;
  const opened = await page.evaluate(async (url) => {
    const steps = [];
    const text = document.getElementById('bootProgressText');
    const overlay = document.getElementById('bootProgress');
    const seen = new MutationObserver(() => { if (!overlay.hidden && !steps.includes(text.textContent)) steps.push(text.textContent); });
    seen.observe(text, { childList: true, characterData: true, subtree: true });
    seen.observe(overlay, { attributes: true });
    // Only the link's own measurements should be there afterwards.
    (await import('./render/MeasurementModule.js')).clearAllMeasurements();
    const { openShareLink } = await import('./ui/ShareModule.js');
    const ok = await openShareLink(url);
    seen.disconnect();
    await new Promise((r) => setTimeout(r, 600));
    const { groups, measurements } = await import('./state/store.js');
    const dashes = [];
    for (const g of measurements.measureLines) if (['distance', 'angle'].includes(g.userData?.type)) g.traverse((o) => { if (o.geometry?.type === 'CylinderGeometry') dashes.push(o.geometry); });
    return {
      ok,
      steps,
      overlayHidden: overlay.hidden,
      polys: groups.polyhedraGroup?.children?.length ?? 0,
      lines: new Set(measurements.measureLines.filter((g) => ['distance', 'angle'].includes(g.userData?.type)).map((g) => g.userData.measurementId)).size,
      dashes: dashes.length,
      dashGeometries: new Set(dashes).size,
    };
  }, link);
  await page.waitForTimeout(500);
  H.check('opening a styled share link shows its steps, then the overlay goes away',
    opened.ok && opened.steps.some((s) => /Opening the shared structure/.test(s)) && opened.steps.some((s) => /Building the structure \(162 atoms\)/.test(s))
      && opened.steps.some((s) => /Drawing the polyhedra and measurements/.test(s)) && opened.overlayHidden, JSON.stringify(opened));
  H.check('it restores the polyhedra and all 12 measurements', opened.polys > 0 && opened.lines === 12, JSON.stringify(opened));
  H.check('the polyhedra are computed once while it opens (were twice)', polyLogs.filter((l) => /total=/.test(l) && !/render=/.test(l)).length === 1, polyLogs.join(' | '));
  H.check('the measurement dashes share one geometry per line type', opened.dashes > 24 && opened.dashGeometries <= 2, JSON.stringify(opened));

  // The share dialog draws its QR code with a library from a CDN; where the
  // network is blocked (sandboxes) that request fails, which is not this test's.
  const own = errors.filter((e) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(e));
  H.check('no console/page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
