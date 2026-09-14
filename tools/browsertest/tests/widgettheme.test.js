// Widget theme-follow: ?widget=1&theme=dark|light applies that UI mode at boot
// via ThemeManager (resolveInitialSelection override). Opaque-origin storage
// stays unavailable; the mode must not persist.
'use strict';
const H = require('../harness');
const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

const A = 4.3;
function fixture() {
  return JSON.stringify({
    format: 'crysviz', version: '2.16',
    frames: [{ elements: ['Fe', 'O'], lattice: [[A, 0, 0], [0, A, 0], [0, 0, A]], positions: [[0, 0, 0], [0.5, 0.5, 0.5]] }],
    selectedFrameIndex: 0, colors: { useDefaultColors: true }, display: {}, style: {},
  });
}

async function loadWidget(page, theme) {
  const b64 = Buffer.from(fixture(), 'utf8').toString('base64');
  const url = `${BASE}?widget=1&theme=${theme}#load-file=${encodeURIComponent('t.crysviz')}|${encodeURIComponent(b64)}`;
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

  await loadWidget(page, 'dark');
  const dark = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    logo: document.querySelector('#widgetLogo img')?.getAttribute('src'),
  }));
  H.check('theme=dark applies the dark theme', dark.theme === 'dark', JSON.stringify(dark));
  H.check('theme=dark uses the dark-ground logo asset',
    !!dark.logo && dark.logo.includes('CrysViz_logo_black_back_logo_only.png'), JSON.stringify(dark));

  await loadWidget(page, 'light');
  const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    logo: document.querySelector('#widgetLogo img')?.getAttribute('src'),
  }));
  H.check('theme=light applies the light theme', light.theme === 'light', JSON.stringify(light));
  H.check('theme=light uses the white-ground logo asset',
    !!light.logo && light.logo.includes('CrysViz_logo_white_back_logo_only.png'), JSON.stringify(light));

  H.check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
