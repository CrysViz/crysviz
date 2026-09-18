// Widget menuLinks: the embedder may inject dropdown items that open URLs.
// Top-level `menuLinks: [{label,url}]` (same channel as frameKinds); ShareModule
// validates strictly (nonempty label ≤40 chars, http/https URL), WidgetMode
// renders the valid ones as role=menuitem entries between the toggles and
// "Open in CrysViz". Full app ignores the field.
'use strict';
const H = require('../harness');
const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

const A = 4.3;
function fixture(menuLinks) {
  const state = {
    format: 'crysviz', version: '2.16',
    frames: [{ elements: ['Fe', 'O'], lattice: [[A, 0, 0], [0, A, 0], [0, 0, A]], positions: [[0, 0, 0], [0.5, 0.5, 0.5]] }],
    selectedFrameIndex: 0, colors: { useDefaultColors: true }, display: {}, style: {},
  };
  if (menuLinks) state.menuLinks = menuLinks;
  return JSON.stringify(state);
}

async function loadWidget(page, json) {
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const url = `${BASE}?widget=1#load-file=${encodeURIComponent('m.crysviz')}|${encodeURIComponent(b64)}`;
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(500);
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  // Two valid links + two invalid (bad scheme, empty label) → only the two valid render.
  await loadWidget(page, fixture([
    { label: 'Download CIF', url: 'https://ex.org/x.cif' },
    { label: 'Download POSCAR', url: 'https://ex.org/x.vasp' },
    { label: 'Bad scheme', url: 'ftp://ex.org/x' },
    { label: '', url: 'https://ex.org/y' },
  ]));
  const links = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.widget-menu-item[data-link]')];
    // Position sanity: link rows sit before the "Open in CrysViz" action.
    const open = document.querySelector('.widget-menu-item[data-action="open"]');
    const items = [...document.querySelectorAll('.widget-menu-item')];
    const beforeOpen = rows.length > 0 && items.indexOf(rows[rows.length - 1]) < items.indexOf(open);
    return { count: rows.length, labels: rows.map((r) => r.querySelector(".widget-menu-text").textContent.trim()), urls: rows.map((r) => r.dataset.link), beforeOpen };
  });
  H.check('exactly the two valid links render (invalid dropped)',
    links.count === 2 && links.labels.includes('Download CIF') && links.labels.includes('Download POSCAR'), JSON.stringify(links));
  H.check('link rows sit above "Open in CrysViz"', links.beforeOpen === true, JSON.stringify(links));

  const clicked = await page.evaluate(() => {
    let captured = null;
    const orig = window.open;
    window.open = (url, target, feat) => { captured = { url, target, feat }; return null; };
    document.querySelector('.widget-menu-item[data-link="https://ex.org/x.cif"]').click();
    window.open = orig;
    return captured;
  });
  H.check('clicking a link opens its URL in a new tab',
    !!clicked && clicked.url === 'https://ex.org/x.cif' && clicked.target === '_blank' && String(clicked.feat).includes('noopener'),
    JSON.stringify(clicked));

  // No menuLinks → no link rows at all.
  await loadWidget(page, fixture(null));
  const none = await page.evaluate(() => document.querySelectorAll('.widget-menu-item[data-link]').length);
  H.check('payload without menuLinks renders no link group', none === 0, String(none));

  H.check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
