// Root-cause fix for the "orbit about the cell corner" bug: loadStructure's
// crysviz branch skips its fit-to-structure camera ONLY when the session
// actually restored a camera pose (loadCrysvizFile stamps container.cameraRestored).
// Full app, no widget mode — pins BOTH directions:
//   * a #load-file .crysviz WITHOUT camera  -> orbit target == structure center
//   * a #load-file .crysviz WITH a saved camera -> that pose is preserved
'use strict';
const H = require('../harness');
const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

const A = 4.3; // structure center = (A/2, A/2, A/2) = 2.15
function fixture(withCamera) {
  const frame = {
    elements: ['Fe', 'Fe', 'O', 'O'],
    lattice: [[A, 0, 0], [0, A, 0], [0, 0, A]],
    positions: [[0, 0, 0], [0.5, 0.5, 0.5], [0.5, 0, 0], [0, 0.5, 0]],
  };
  const state = {
    format: 'crysviz', version: '2.16',
    frames: [frame], selectedFrameIndex: 0,
    colors: { useDefaultColors: true },
    display: {}, style: {},
  };
  // A saved pose whose target is deliberately NOT the structure center.
  if (withCamera) state.camera = { position: [12, 3, 4], target: [1, 0, 0], zoom: 1 };
  return JSON.stringify(state);
}

async function loadNoWidget(page, json) {
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const url = `${BASE}#load-file=${encodeURIComponent('cam.crysviz')}|${encodeURIComponent(b64)}`;
  await page.goto('about:blank'); // force a real reload (hash-only nav wouldn't)
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(2500); // async restoreCamera + render settle
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  await loadNoWidget(page, fixture(false));
  const noCam = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const t = app.controls.target;
    return { target: [t.x, t.y, t.z], err: Math.hypot(t.x - 2.15, t.y - 2.15, t.z - 2.15) };
  });
  H.check('no-camera .crysviz centers the orbit target on the structure',
    noCam.err < 0.05, JSON.stringify(noCam));

  await loadNoWidget(page, fixture(true));
  const withCam = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const t = app.controls.target;
    return { target: [t.x, t.y, t.z], err: Math.hypot(t.x - 1, t.y - 0, t.z - 0) };
  });
  H.check('saved-camera .crysviz preserves its restored pose (not re-centered)',
    withCam.err < 0.05, JSON.stringify(withCam));

  H.check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
