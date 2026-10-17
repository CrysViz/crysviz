// Widget-mode live control (?widget=1&control=1): the embedding page drives a
// loaded trajectory over postMessage — no iframe reload, and a new frame never
// re-orients the camera. See docs/ui/WidgetControl.js.
//
// The app runs at the top level here, where window.parent === window, so the
// widget's `event.source === window.parent` gate is satisfied by messages the
// test posts with window.postMessage(...), and the widget's own notifications
// come back to the same window. Commands carry { target:'crysviz-widget' };
// notifications carry { source:'crysviz-widget' } — the two never cross.
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

/** A 5-frame trajectory: atom 0 marches along x by 0.1 frac per frame, so the
 *  shown frame is identifiable from atom 0's fractional x. Cell + atom count are
 *  constant, so the light in-place update path is exercised. */
function trajectoryFixture() {
  const a = 5.0;
  const lattice = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  const frames = [];
  for (let f = 0; f < 5; f++) {
    frames.push({
      elements: ['Fe', 'O'],
      lattice,
      positions: [[f * 0.1, 0, 0], [0.5, 0.5, 0.5]],
    });
  }
  return JSON.stringify({
    format: 'crysviz', version: '2.16',
    frames,
    selectedFrameIndex: 0,
    display: { showAtoms: true, showBonds: true, showLattice: true },
    style: {},
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  const b64 = Buffer.from(trajectoryFixture(), 'utf8').toString('base64');
  const url = `${BASE}?widget=1&control=1#load-file=${encodeURIComponent('traj.crysviz')}|${encodeURIComponent(b64)}`;
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1200);

  // Install a host-side collector for every widget→host notification, and prove
  // the widget announced itself once the trajectory loaded.
  await page.evaluate(() => {
    window.__cv = { msgs: [] };
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && typeof d === 'object' && d.source === 'crysviz-widget') window.__cv.msgs.push(d);
    });
  });

  // ready is posted during init (before our collector attached), so ask for the
  // current state to get an equivalent snapshot back through the live channel.
  const ready = await page.evaluate(async () => {
    window.postMessage({ target: 'crysviz-widget', type: 'getState' }, '*');
    await new Promise((r) => setTimeout(r, 300));
    return window.__cv.msgs.find((m) => m.type === 'state');
  });
  H.check('control channel responds to getState with frame count',
    !!ready && ready.frameCount === 5 && ready.index === 0 && ready.playing === false, JSON.stringify(ready));

  // Helper: the fractional x of atom 0 identifies the shown frame (0.1 * frame).
  const atomX = async () => page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.selectedStructure.atoms[0].position[0];
  });
  // Camera pose snapshot (position + orientation) to prove no re-orientation.
  const camPose = async () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.camera.position, q = app.camera.quaternion, t = app.controls.target;
    return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], t: [t.x, t.y, t.z] };
  });

  const x0 = await atomX();
  H.check('starts on frame 0 (atom0 x ≈ 0)', Math.abs(x0) < 1e-6, `x0=${x0}`);

  // --- setFrame moves coordinates but NOT the camera --------------------------
  const poseBefore = await camPose();
  await page.evaluate(() => window.postMessage({ target: 'crysviz-widget', type: 'setFrame', index: 3 }, '*'));
  await page.waitForTimeout(400);
  const x3 = await atomX();
  const poseAfter = await camPose();
  H.check('setFrame(3) shows frame 3 (atom0 x ≈ 0.3)', Math.abs(x3 - 0.3) < 1e-6, `x3=${x3}`);

  const dp = Math.hypot(...poseBefore.p.map((v, i) => v - poseAfter.p[i]));
  const dq = Math.hypot(...poseBefore.q.map((v, i) => v - poseAfter.q[i]));
  const dt = Math.hypot(...poseBefore.t.map((v, i) => v - poseAfter.t[i]));
  H.check('setFrame does NOT re-orient the camera (position/rotation/target unchanged)',
    dp < 1e-6 && dq < 1e-6 && dt < 1e-6, JSON.stringify({ dp, dq, dt, poseBefore, poseAfter }));

  // The host got a 'frame' notification for the change.
  const frameMsg = await page.evaluate(() => window.__cv.msgs.filter((m) => m.type === 'frame').pop());
  H.check('host receives a frame notification (index 3)',
    !!frameMsg && frameMsg.index === 3 && frameMsg.frameCount === 5, JSON.stringify(frameMsg));

  // --- setFrame clamps out-of-range indices -----------------------------------
  await page.evaluate(() => window.postMessage({ target: 'crysviz-widget', type: 'setFrame', index: 99 }, '*'));
  await page.waitForTimeout(300);
  const xClamp = await atomX();
  H.check('setFrame clamps past the end to the last frame (x ≈ 0.4)', Math.abs(xClamp - 0.4) < 1e-6, `x=${xClamp}`);

  // --- Security: malformed / mistargeted messages are ignored -----------------
  await page.evaluate(() => {
    window.postMessage({ target: 'someone-else', type: 'setFrame', index: 0 }, '*'); // wrong target
    window.postMessage({ type: 'setFrame', index: 0 }, '*');                          // no target
    window.postMessage('setFrame 0', '*');                                            // not an object
  });
  await page.waitForTimeout(300);
  const xAfterBad = await atomX();
  H.check('mistargeted / malformed messages are ignored (still on last frame)',
    Math.abs(xAfterBad - 0.4) < 1e-6, `x=${xAfterBad}`);

  // --- play advances frames, pause stops --------------------------------------
  await page.evaluate(() => window.postMessage({ target: 'crysviz-widget', type: 'setFrame', index: 0 }, '*'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.postMessage({ target: 'crysviz-widget', type: 'play', fps: 20, loop: true }, '*'));
  await page.waitForTimeout(600); // ~12 ticks at 20 fps → wraps around
  const movedDuringPlay = await page.evaluate(() => {
    const idxs = window.__cv.msgs.filter((m) => m.type === 'frame').map((m) => m.index);
    return new Set(idxs).size; // number of distinct frames visited
  });
  await page.evaluate(() => window.postMessage({ target: 'crysviz-widget', type: 'pause' }, '*'));
  await page.waitForTimeout(150);
  const xPause = await atomX();
  await page.waitForTimeout(400); // must NOT advance after pause
  const xStill = await atomX();
  H.check('play advances through multiple frames', movedDuringPlay >= 3, `distinct=${movedDuringPlay}`);
  H.check('pause halts playback (frame stops changing)', Math.abs(xPause - xStill) < 1e-9, `pause=${xPause} still=${xStill}`);

  H.check('no console errors during the control session',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await H.finish(browser);
})().catch(H.crash);
