// Widget overflow: the grown dropdown and a many-species legend must both stay
// on the canvas. Menu caps its height below the anchor and scrolls; the legend
// is pinned lower-left by its bottom edge (grows upward), capped + scrollable.
'use strict';
const H = require('../harness');
const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

function crysviz(state) { return JSON.stringify({ format: 'crysviz', version: '2.16', selectedFrameIndex: 0, colors: { useDefaultColors: true }, display: { spinsActive: true }, style: {}, ...state }); }

// 6-species structure so the composition legend has 6 rows.
function manySpeciesFixture() {
  const a = 8.0;
  const els = ['Fe', 'O', 'Ni', 'Co', 'Mn', 'Cr'];
  const positions = els.map((_, i) => [i / els.length, (i * 0.17) % 1, (i * 0.31) % 1]);
  return crysviz({
    frames: [{ elements: els, lattice: [[a, 0, 0], [0, a, 0], [0, 0, a]], positions,
      spins: els.map(() => ({ vector: [0, 0, 1] })) }],
  });
}

// Many embedder links to inflate the dropdown past the viewport.
function inflatedMenuFixture() {
  const a = 4.3;
  const menuLinks = Array.from({ length: 30 }, (_, i) => ({ label: `Link number ${i + 1}`, url: `https://ex.org/f${i}` }));
  return crysviz({
    frames: [{ elements: ['Fe', 'O'], lattice: [[a, 0, 0], [0, a, 0], [0, 0, a]], positions: [[0, 0, 0], [0.5, 0.5, 0.5]] }],
    menuLinks,
  });
}

async function loadWidget(page, json) {
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  await page.goto('about:blank');
  await page.goto(`${BASE}?widget=1#load-file=${encodeURIComponent('o.crysviz')}|${encodeURIComponent(b64)}`, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(800);
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  // --- Many-species legend: fully within the view ---------------------------
  await loadWidget(page, manySpeciesFixture());
  const legend = await page.evaluate(() => {
    const w = document.querySelector('.comp-legend-widget');
    const r = w.getBoundingClientRect();
    const vh = window.innerHeight;
    const body = w.querySelector('.comp-legend-body');
    const cs = getComputedStyle(body);
    // Bottom edge pinned to the lower-left (grows upward) — not top-anchored.
    return { rows: w.querySelectorAll('.comp-legend-row').length,
      top: r.top, bottom: r.bottom, vh, fits: r.top >= -1 && r.bottom <= vh + 1,
      overflowY: cs.overflowY, cappedPx: parseFloat(cs.maxHeight),
      // Pinned to the viewport bottom (grows upward), not left where a top
      // anchor would drop it (~view.top+200 with the old bug).
      bottomPinned: (vh - r.bottom) >= 0 && (vh - r.bottom) <= 40 };
  });
  H.check('legend shows all 6 species rows', legend.rows === 6, JSON.stringify(legend));
  H.check('6-species legend is fully within the viewport (top>=0, bottom<=view)',
    legend.fits === true, JSON.stringify(legend));
  H.check('legend cap safety-net is wired (bottom-anchored, capped, scrollable)',
    legend.bottomPinned === true && legend.overflowY === 'auto'
      && Number.isFinite(legend.cappedPx) && legend.cappedPx < legend.vh, JSON.stringify(legend));

  // --- Inflated dropdown: opens within the viewport and scrolls internally ---
  await loadWidget(page, inflatedMenuFixture());
  const menu = await page.evaluate(() => {
    document.querySelector('#widgetLogo').click(); // open the menu
    const m = document.querySelector('.widget-settings-menu');
    const r = m.getBoundingClientRect();
    const links = document.querySelectorAll('.widget-menu-item[data-link]').length;
    return { links, top: r.top, bottom: r.bottom, vh: window.innerHeight,
      withinViewport: r.bottom <= window.innerHeight + 1,
      scrolls: m.scrollHeight > m.clientHeight + 1 };
  });
  H.check('inflated menu rendered all 30 links', menu.links === 30, JSON.stringify(menu));
  H.check('inflated dropdown bottom stays within the viewport', menu.withinViewport === true, JSON.stringify(menu));
  H.check('inflated dropdown scrolls internally (capped height)', menu.scrolls === true, JSON.stringify(menu));

  H.check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
