// Widget-mode live control (?widget=1&control=1): the embedding page drives a
// loaded trajectory over postMessage — no iframe reload, and a new frame never
// re-orients the camera. See docs/ui/WidgetControl.js.
//
// The app runs at the top level here, where window.parent === window, so the
// widget's `event.source === window.parent` gate is satisfied by messages the
// test posts with window.postMessage(...), and the widget's own notifications
// come back to the same window. Commands carry { target:'crysviz-widget' };
// notifications carry { source:'crysviz-widget' } — the two never cross.
//
// Also the camera messages a host uses to recentre a frame (setFrame recenter,
// fitView) and to link two widgets' views (getCamera / setCamera, and the
// `camera` report of a user's own move — never of a move a host command made).
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
  // `ready` is posted during start-up, before the test can attach a listener
  // after load — collect from the first script on.
  await page.addInitScript(() => {
    window.__early = [];
    window.addEventListener('message', (e) => {
      if (e.data && e.data.source === 'crysviz-widget') window.__early.push(e.data);
    });
  });
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
  H.check('control channel responds to getState with frame count (and the camera capability)',
    !!ready && ready.frameCount === 5 && ready.index === 0 && ready.playing === false && ready.camera === true,
    JSON.stringify(ready));

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

  // --- camera: ready advertises it ----------------------------------------------
  const readyMsg = await page.evaluate(() => window.__early.find((m) => m.type === 'ready'));
  H.check('ready advertises camera support (camera:true) with the frame count',
    !!readyMsg && readyMsg.camera === true && readyMsg.frameCount === 5, JSON.stringify(readyMsg));

  // Post a command and collect the `camera` messages it produces (a getCamera
  // reply is one; setCamera / fitView / setFrame must produce none).
  const send = (msg, wait = 300) => page.evaluate(async ({ msg, wait }) => {
    const before = window.__cv.msgs.length;
    window.postMessage({ target: 'crysviz-widget', ...msg }, '*');
    await new Promise((r) => setTimeout(r, wait));
    return window.__cv.msgs.slice(before).filter((m) => m.type === 'camera');
  }, { msg, wait });
  const getView = async () => (await send({ type: 'getCamera' }))[0]?.view ?? null;
  const len = (v) => Math.hypot(...v);
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

  // --- getCamera: a well-formed relative view ---------------------------------------
  const v0 = await getView();
  H.check('getCamera replies with a relative view: unit direction, perpendicular unit up, distance, zoom',
    !!v0 && Math.abs(len(v0.direction) - 1) < 1e-6 && Math.abs(len(v0.up) - 1) < 1e-6
      && Math.abs(dot(v0.direction, v0.up)) < 1e-6 && v0.distance > 0 && v0.zoom > 0,
    JSON.stringify(v0));

  // --- setCamera: applies the view, never echoes -----------------------------------
  const want = { direction: [1, 0, 0], up: [0, 0, 1], distance: 2.5, zoom: 1.7 };
  const setEcho = await send({ type: 'setCamera', view: want }, 500);
  const v1 = await getView();
  const near3 = (a, b) => Math.hypot(...a.map((x, i) => x - b[i])) < 1e-6;
  H.check('setCamera turns and zooms the camera to the view (round-trips through getCamera)',
    !!v1 && near3(v1.direction, want.direction) && near3(v1.up, want.up)
      && Math.abs(v1.distance - want.distance) < 1e-6 && Math.abs(v1.zoom - want.zoom) < 1e-6,
    JSON.stringify(v1));
  H.check('setCamera is not reported back as a camera move (no echo between linked widgets)',
    setEcho.length === 0, JSON.stringify(setEcho));
  // A non-perpendicular up is projected; a malformed view is ignored.
  await send({ type: 'setCamera', view: { direction: [0, 0, 2], up: [1, 0, 1] } });
  const v2 = await getView();
  await send({ type: 'setCamera', view: { direction: [0, 0], up: 'x' } });
  const v3 = await getView();
  H.check('setCamera normalises the direction and makes up perpendicular; a malformed view is ignored',
    !!v2 && near3(v2.direction, [0, 0, 1]) && near3(v2.up, [1, 0, 0]) && !!v3 && near3(v3.direction, v2.direction),
    JSON.stringify([v2, v3]));

  // --- a user's drag is reported, at most once per animation frame -----------------
  const box = await page.locator('#view canvas').first().boundingBox();
  const before = await page.evaluate(() => window.__cv.msgs.length);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 30, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dragged = await page.evaluate((n) => window.__cv.msgs.slice(n).filter((m) => m.type === 'camera'), before);
  H.check('a user drag is reported as camera messages (coalesced: at most one per frame)',
    dragged.length >= 1 && dragged.length <= 40 && !!dragged[dragged.length - 1].view?.direction,
    `count=${dragged.length}`);

  // --- fitView / setFrame recenter: refit, keep the direction, no echo --------------
  await send({ type: 'setCamera', view: { ...want, distance: 6 } });
  const fitEcho = await send({ type: 'fitView' }, 500);
  const vFit = await getView();
  H.check('fitView refits the camera (distance back from 6) keeping the viewing direction, unreported',
    !!vFit && vFit.distance < 6 && near3(vFit.direction, want.direction) && fitEcho.length === 0,
    JSON.stringify({ vFit, fitEcho }));
  await send({ type: 'setCamera', view: { ...want, distance: 6 } });
  const recenterEcho = await send({ type: 'setFrame', index: 2, recenter: true }, 500);
  const vRecenter = await getView();
  H.check('setFrame { recenter:true } shows the frame and refits like fitView, unreported',
    Math.abs((await atomX()) - 0.2) < 1e-6 && !!vRecenter && Math.abs(vRecenter.distance - vFit.distance) < 1e-6
      && near3(vRecenter.direction, want.direction) && recenterEcho.length === 0,
    JSON.stringify({ vRecenter, recenterEcho }));
  const keepPose = await camPose();
  await send({ type: 'setFrame', index: 1 });
  const keptPose = await camPose();
  H.check('plain setFrame still leaves the camera alone',
    Math.hypot(...keepPose.p.map((v, i) => v - keptPose.p[i])) < 1e-6, JSON.stringify([keepPose, keptPose]));

  H.check('no console errors during the control session',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await H.finish(browser);
})().catch(H.crash);
