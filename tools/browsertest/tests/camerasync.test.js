// Camera sync across tabs (ui/CameraSync.js, Camera panel "Sync camera across tabs"):
//   - two tabs of one browser, each with the switch Off: turning one leaves the other alone
//   - Same view switches a tab on; a tab switched on second takes the first one's view
//   - turning or zooming either tab turns the other one (the tab you touch leads)
//   - the other tab eases to a jump over a few frames instead of snapping
//   - Same view keeps each tab's own centre and pan; "Also match pan and rotation centre" copies them
//   - an idle pair sends nothing (no echo between the tabs)
//   - malformed messages on the channel (wrong version, NaN, out of range, missing
//     fields, a forged own id) move nothing
//   - the switch in its window, docked and floating, clicked for real: the options
//     show while on, "Also match pan and rotation centre" only for Same view
//   - the status says Off, linked to N tabs, or no other tab yet (after the other says bye)
//   - Same turns keeps the tab's own angle and zoom when it joins, and turns and
//     zooms with the others both ways (a fixed rotation and zoom factor apart)
//   - "Line up all tabs with this one" turns the others to this view and drops the offset
//   - switching a tab off stops it following
//   - a perspective tab and a parallel tab zoom together (zoom factor <-> distance)
//   - a tab spinning by itself (Random) holds the leading tab's pose instead of
//     sending its spin; touched, it leads and the others follow its spin
'use strict';
const H = require('../harness');

/** The camera's direction (centre to eye, pan removed), up, zoom, centre and pan, rounded. */
const CAMERA = async () => {
  const THREE = await import('./external/three/three.module.js');
  const { app } = await import('./state/store.js');
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(app.camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(app.camera.quaternion);
  const r = (v) => +v.toFixed(4);
  const card = document.querySelector('.camera_sync');
  return {
    q: app.camera.quaternion.toArray(),
    dir: back.toArray().map(r),
    up: up.toArray().map(r),
    zoom: r(app.camera.zoom),
    target: app.controls.target.toArray().map(r),
    pan: [app.cameraPan.x, app.cameraPan.y].map(r),
    sync: card?.querySelector('input[name="cameraSyncMode"]:checked')?.value,
    options: card ? !card.querySelector('.camera_sync_options').hidden : null,
    status: card?.querySelector('.camera_sync_status_text')?.textContent,
  };
};

/** The Sync switch set to `value` (off, view, turns), as picking it does. */
const SYNC = async (value) => {
  document.getElementById({ off: 'cameraSyncOff', view: 'cameraSyncView', turns: 'cameraSyncTurns' }[value]).click();
};

/** Quaternions [x,y,z,w]: a·b, the inverse, and the angle between two rotations. */
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const qinv = ([x, y, z, w]) => [-x, -y, -z, w];
const qangle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0))));
/** Tab B's camera rotation relative to tab A's, on the world side (qB = offset · qA). */
const offsetOf = (ca, cb) => qmul(cb.q, qinv(ca.q));

const TURN = async ([x, y, z]) => {
  const THREE = await import('./external/three/three.module.js');
  const { setViewDirection } = await import('./ui/WindowAndSceneControls.js');
  setViewDirection(new THREE.Vector3(x, y, z));
};

const ZOOM = async (factor) => {
  const { app } = await import('./state/store.js');
  app.camera.zoom *= factor;
  app.camera.updateProjectionMatrix();
  app.controls.update();
};

/** A screen-space pan, as a pan drag makes it (ui/GestureArbiter.js). */
const PAN = async ([dx, dy]) => {
  const THREE = await import('./external/three/three.module.js');
  const { app } = await import('./state/store.js');
  app.cameraPan.x += dx;
  app.cameraPan.y += dy;
  app.camera.updateMatrixWorld(true);
  app.camera.position.addScaledVector(new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 0), dx);
  app.camera.position.addScaledVector(new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 1), dy);
  app.camera.updateMatrixWorld(true);
};

const close = (a, b, tol = 2e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const sameView = (a, b) => close(a.dir, b.dir) && close(a.up, b.up);

async function settle(...pages) {
  for (const p of pages) await p.bringToFront();
  await pages[0].waitForTimeout(600);
}

(async () => {
  const { browser, page: a, errors } = await H.launchApp();
  await H.loadDefaultStructure(a);
  // A second tab in the same browser profile (BroadcastChannel does not cross profiles):
  // opened from tab A, as the harness's page owns its context.
  const [b] = await Promise.all([
    a.waitForEvent('popup'),
    a.evaluate((url) => { window.open(url, '_blank', 'noopener'); }, a.url()),
  ]);
  b.on('pageerror', (e) => errors.push(`pageerror (tab b): ${e.stack || e.message}`.slice(0, 1200)));
  b.on('console', (m) => { if (m.type() === 'error') errors.push(`console (tab b): ${m.text()}`.slice(0, 300)); });
  await b.setViewportSize({ width: 1400, height: 900 });
  await b.waitForLoadState('load');
  await b.waitForTimeout(5000);
  await H.loadDefaultStructure(b);

  // ---- off: independent ----------------------------------------------------------
  const b0 = await b.evaluate(CAMERA);
  H.check('both tabs have the Sync switch, Off, no options shown', b0.sync === 'off' && b0.options === false
    && b0.status === 'Off' && (await a.evaluate(CAMERA)).sync === 'off', JSON.stringify(b0));
  await a.evaluate(TURN, [1, 0.2, 0.3]);
  await settle(a, b);
  H.check('with sync off, turning tab A leaves tab B alone', sameView(await b.evaluate(CAMERA), b0),
    JSON.stringify(await b.evaluate(CAMERA)));

  // ---- on: B joins and takes A's view ---------------------------------------------
  await a.evaluate(SYNC, 'view');
  await settle(a);
  const alone = await a.evaluate(CAMERA);
  await b.evaluate(SYNC, 'view');
  await settle(b, a);
  let ca = await a.evaluate(CAMERA);
  let cb = await b.evaluate(CAMERA);
  H.check('Same view switches sync on (options shown); alone it waits, then both are linked',
    ca.sync === 'view' && ca.options === true && alone.status === 'Waiting for tabs'
    && ca.status === 'Linked to 1 tab' && cb.status === 'Linked to 1 tab', JSON.stringify({ alone, ca, cb }));
  H.check('the tab switched on second takes the view of the first', sameView(ca, cb), JSON.stringify({ ca, cb }));

  // ---- A leads ---------------------------------------------------------------------
  await a.evaluate(TURN, [0.1, 1, 0.4]);
  await settle(a, b);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('turning tab A turns tab B', sameView(ca, cb), JSON.stringify({ ca, cb }));
  await a.evaluate(ZOOM, 1.7);
  await settle(a, b);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('zooming tab A zooms tab B', Math.abs(ca.zoom - cb.zoom) < 1e-3 && Math.abs(cb.zoom - b0.zoom * 1.7) < 0.05,
    JSON.stringify({ ca, cb }));

  // ---- B eases to a jump -------------------------------------------------------------
  // Tab B records its view angle to the final direction for a few frames after the jump.
  await b.bringToFront();
  await b.evaluate(() => {
    window.__syncTrace = [];
    const sample = async () => {
      const THREE = await import('./external/three/three.module.js');
      const { app } = await import('./state/store.js');
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(app.camera.quaternion);
      window.__syncTrace.push(back.angleTo(new THREE.Vector3(1, -0.3, 0.5).normalize()));
      if (window.__syncTrace.length < 40) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await a.evaluate(TURN, [1, -0.3, 0.5]);
  await b.waitForTimeout(1500);
  const trace = await b.evaluate(() => window.__syncTrace);
  const start = trace[0];
  const between = trace.filter((t) => t > 0.02 && t < start - 0.02).length;
  H.check('tab B glides to a jump in tab A (frames between start and end), and gets there',
    start > 0.3 && between >= 2 && trace[trace.length - 1] < 2e-3, JSON.stringify(trace.map((t) => +t.toFixed(3))));

  // ---- B leads -----------------------------------------------------------------------
  await b.evaluate(TURN, [-0.5, 0.4, 1]);
  await settle(b, a);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('turning tab B turns tab A (the tab you touch leads)', sameView(ca, cb), JSON.stringify({ ca, cb }));

  // ---- modes -----------------------------------------------------------------------
  await a.evaluate(PAN, [1.5, -0.7]);
  await settle(a, b);
  cb = await b.evaluate(CAMERA);
  H.check("Same view keeps tab B's own pan", close(cb.pan, [0, 0]), JSON.stringify(cb));
  await b.evaluate(() => document.getElementById('cameraSyncCentre').click());
  await a.evaluate(PAN, [0.5, 0.2]);
  await settle(a, b);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('"Also match pan and rotation centre" copies the pan and the centre', close(ca.pan, cb.pan) && close(ca.target, cb.target)
    && sameView(ca, cb), JSON.stringify({ ca, cb }));

  // ---- no echo -----------------------------------------------------------------------
  const counted = await a.evaluate(async () => {
    const ch = new BroadcastChannel('crysviz-camera-sync');
    let n = 0;
    ch.onmessage = () => { n += 1; };
    await new Promise((resolve) => setTimeout(resolve, 1500));
    ch.close();
    return n;
  });
  H.check('an idle synced pair sends nothing', counted === 0, `messages: ${counted}`);

  // ---- malformed messages ------------------------------------------------------------
  cb = await b.evaluate(CAMERA);
  const tabBId = 'not-known-anyway';
  await a.evaluate((fakeId) => {
    const ch = new BroadcastChannel('crysviz-camera-sync');
    const good = { direction: [0, 0, 1], up: [0, 1, 0], distance: 1, zoom: 1 };
    const pose = { type: 'pose', target: [0, 0, 0], pan: { x: 0, y: 0 } };
    [
      null, 'text', 42, [], {},
      { ...pose, v: 2, from: fakeId, view: good },                                 // wrong version
      { ...pose, v: 1, view: good },                                               // no sender
      { ...pose, v: 1, from: 'x'.repeat(65), view: good },                         // sender id too long
      { ...pose, v: 1, from: fakeId, view: { ...good, direction: [NaN, 0, 1] } },  // NaN
      { ...pose, v: 1, from: fakeId, view: { ...good, direction: [0, 0, 9] } },    // not a unit vector
      { ...pose, v: 1, from: fakeId, view: { ...good, distance: 1e9 } },           // out of range
      { ...pose, v: 1, from: fakeId, view: { ...good, zoom: -1 } },
      { ...pose, v: 1, from: fakeId, view: good, target: [0, 0] },                 // short centre
      { ...pose, v: 1, from: fakeId, view: good, pan: null },                      // no pan
      { ...pose, v: 1, from: fakeId, view: good, target: [1e30, 0, 0] },
      { ...pose, v: 1, from: fakeId, view: 'up' },
      { v: 1, from: fakeId, type: 'unknown' },
    ].forEach((m) => ch.postMessage(m));
    ch.close();
  }, tabBId);
  await settle(b, a);
  const cbAfter = await b.evaluate(CAMERA);
  H.check('malformed messages move nothing and count no tab', sameView(cb, cbAfter) && cb.zoom === cbAfter.zoom
    && close(cb.target, cbAfter.target) && cbAfter.status === 'Linked to 1 tab',
    JSON.stringify({ cb, cbAfter }));

  // ---- the switch in its window ----------------------------------------------------
  // Picked with the real control (Visual ▸ Camera), with the window docked and floating.
  await b.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('visual');
  });
  await b.waitForTimeout(500);
  const SHOWN = () => {
    const row = document.querySelector('.camera_sync');
    const visible = (el) => !!el && el.getClientRects().length > 0;
    return {
      sync: row.querySelector('input[name="cameraSyncMode"]:checked')?.value,
      centre: visible(row.querySelector('.camera_sync_check')),
      align: visible(row.querySelector('#cameraSyncAlign')),
      hint: row.querySelector('.camera_sync_hint').textContent,
    };
  };
  for (const placement of ['docked', 'floating']) {
    if (placement === 'floating') {
      await b.evaluate(async () => {
        const { getPanel } = await import('./ui/panels/PanelManager.js');
        const panel = getPanel('visual');
        panel.hooks.positionPanel(panel, 'float');
      });
      await b.waitForTimeout(500);
    }
    await b.locator('.camera_sync').scrollIntoViewIfNeeded();
    await b.locator('label.camera_sync_mode', { hasText: 'Same turns' }).click();
    const turns = await b.evaluate(SHOWN);
    await b.locator('label.camera_sync_mode', { hasText: 'Same view' }).click();
    const view = await b.evaluate(SHOWN);
    H.check(`${placement} window: clicking the switch changes mode; Same view offers pan and centre, Same turns Line up`,
      turns.sync === 'turns' && turns.align && !turns.centre && /own angle/.test(turns.hint)
      && view.sync === 'view' && !view.align && view.centre && view.hint !== turns.hint, JSON.stringify({ turns, view }));
  }
  await b.evaluate(() => document.getElementById('cameraSyncCentre').click());  // back to angle and zoom only
  await settle(b, a);

  // ---- Same turns ----------------------------------------------------------------------
  // B leaves, takes its own angle and zoom, and joins in Same turns: it keeps them.
  await b.evaluate(SYNC, 'off');
  await b.evaluate(TURN, [0.3, -1, 0.2]);
  await b.evaluate(ZOOM, 2);
  await settle(b, a);
  const aLeft = await a.evaluate(CAMERA);
  H.check('a tab switched off stops sending, and the other tab sees it leave',
    !sameView(aLeft, await b.evaluate(CAMERA)) && aLeft.status === 'Waiting for tabs', JSON.stringify(aLeft));
  const bOwn = await b.evaluate(CAMERA);
  await b.evaluate(SYNC, 'turns');
  await settle(b, a);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('joining in Same turns keeps the tab\'s own angle and zoom, and the other tab\'s',
    sameView(cb, bOwn) && cb.zoom === bOwn.zoom && !sameView(ca, cb), JSON.stringify({ ca, cb, bOwn }));
  const offset0 = offsetOf(ca, cb);
  const ratio0 = cb.zoom / ca.zoom;
  // A turns and zooms: B turns and zooms by as much, from its own angle.
  await a.evaluate(TURN, [-0.6, 0.5, 0.7]);
  await a.evaluate(ZOOM, 1.4);
  await settle(a, b);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('Same turns: tab A turning and zooming turns and zooms tab B as much (same offset and zoom ratio)',
    !sameView(cb, bOwn) && qangle(offsetOf(ca, cb), offset0) < 3e-3 && Math.abs(cb.zoom / ca.zoom / ratio0 - 1) < 3e-3,
    JSON.stringify({ ca, cb, angle: qangle(offsetOf(ca, cb), offset0), ratio: cb.zoom / ca.zoom, ratio0 }));
  // B leads: A (Same view) turns as much, the offset stays.
  await b.evaluate(TURN, [0.9, 0.1, -0.4]);
  await settle(b, a);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('Same turns: tab B turning turns tab A as much',
    qangle(offsetOf(ca, cb), offset0) < 3e-3 && !sameView(ca, cb), JSON.stringify({ ca, cb, angle: qangle(offsetOf(ca, cb), offset0) }));

  // ---- Line up ----------------------------------------------------------------------------
  await b.evaluate(() => document.getElementById('cameraSyncAlign').click());
  await settle(b, a);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('"Line up all tabs with this one" turns the other tab to this view', sameView(ca, cb)
    && Math.abs(ca.zoom - cb.zoom) < 1e-3, JSON.stringify({ ca, cb }));
  await a.evaluate(TURN, [0.2, 0.8, 0.5]);
  await settle(a, b);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('after Line up, the tabs turn as one (offset dropped)', sameView(ca, cb), JSON.stringify({ ca, cb }));

  // ---- off: stops following ---------------------------------------------------------
  await b.evaluate(SYNC, 'off');
  cb = await b.evaluate(CAMERA);
  await a.evaluate(TURN, [1, 1, -0.2]);
  await settle(a, b);
  const cbOff = await b.evaluate(CAMERA);
  H.check('switched off, tab B no longer follows', cbOff.sync === 'off' && cbOff.options === false && sameView(cb, cbOff),
    JSON.stringify(cbOff));

  // ---- perspective and parallel tabs zoom together ----------------------------------
  /** The relative view (ui/CameraView.js) and the camera kind. */
  const REL = async () => {
    const { cameraView } = await import('./ui/CameraView.js');
    const { app } = await import('./state/store.js');
    const v = cameraView();
    return { ...v, parallel: !!app.camera.isOrthographicCamera };
  };
  const PROJECTION = async (parallel) => {
    const el = document.getElementById('orthographicCamera');
    el.checked = parallel;
    el.dispatchEvent(new Event('change'));
  };
  /** Move a perspective camera in to `f` of its distance (as its wheel zoom does). */
  const DOLLY = async (f) => {
    const { app } = await import('./state/store.js');
    const t = app.controls.target;
    app.camera.position.sub(t).multiplyScalar(f).add(t);
    app.controls.update();
  };
  await b.evaluate(SYNC, 'view');  // B on again
  await settle(b, a);
  await a.evaluate(PROJECTION, false);
  await a.evaluate(DOLLY, 0.5);
  await settle(a, b);
  let ra = await a.evaluate(REL);
  let rb = await b.evaluate(REL);
  H.check('a perspective tab moving in zooms a parallel tab (zoom = 1 / distance)',
    !ra.parallel && rb.parallel && Math.abs(rb.zoom * ra.distance / ra.zoom - 1) < 0.02 && close(ra.direction, rb.direction),
    JSON.stringify({ ra, rb }));
  await b.evaluate(ZOOM, 1.5);
  await settle(b, a);
  ra = await a.evaluate(REL);
  rb = await b.evaluate(REL);
  H.check('a parallel tab zooming moves a perspective tab (distance = 1 / zoom)',
    Math.abs(rb.zoom * ra.distance / ra.zoom - 1) < 0.02 && rb.zoom > 1.5, JSON.stringify({ ra, rb }));
  await a.evaluate(PROJECTION, true);
  await settle(a, b);

  // ---- a tab spinning by itself ------------------------------------------------------
  /** Camera ▸ Random on or off, with a fixed spin so the test does not depend on the random impulse. */
  const SPIN = async (on) => {
    const el = document.getElementById('pushRandom');
    el.checked = on;
    el.dispatchEvent(new Event('change'));
    if (on) (await import('./state/store.js')).app.angularVelocity.set(0.4, 0.6, 0.2);
  };
  /** A press in the tab, as a user touching it makes (not on any control). */
  const TOUCH = async () => {
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
  };
  // B last took a pose from A, so B follows: its own spin must not take over.
  const bBefore = await b.evaluate(CAMERA);
  await b.evaluate(SPIN, true);
  await settle(b, a);
  await b.waitForTimeout(600);
  let sa = await a.evaluate(CAMERA);
  let sb = await b.evaluate(CAMERA);
  H.check('a following tab that spins holds the leading tab\'s pose (no spin sent, none shown)',
    sameView(sb, bBefore) && sameView(sa, sb), JSON.stringify({ bBefore, sa, sb }));
  // Touched, B leads: A follows its spin, and stays with it when the spin stops.
  await b.evaluate(TOUCH);
  await b.waitForTimeout(1200);
  await b.evaluate(SPIN, false);
  await settle(b, a);
  sa = await a.evaluate(CAMERA);
  sb = await b.evaluate(CAMERA);
  H.check('touched, the spinning tab leads: the other tab follows its spin',
    !sameView(sb, bBefore) && sameView(sa, sb), JSON.stringify({ bBefore, sa, sb }));
  // Both spinning: the tab touched last leads, the other holds its pose. Tab B
  // records how fast it turns meanwhile (rad/s, frame by frame, so a slow frame
  // is no jump): following one leader it turns at the spin's ~1 rad/s, jumping
  // between two leaders it would swing back and forth at tens of rad/s.
  await a.evaluate(SPIN, true);
  await b.evaluate(SPIN, true);
  await a.evaluate(TOUCH);
  await a.waitForTimeout(400);  // the hand-over from B to A glides; sample after it
  await b.evaluate(() => {
    window.__spinSteps = [];
    let prev = null;
    let prevTime = 0;
    const sample = async (time) => {
      const { app } = await import('./state/store.js');
      const q = app.camera.quaternion.clone();
      if (prev && time > prevTime) window.__spinSteps.push(prev.angleTo(q) / ((time - prevTime) / 1000));
      prev = q;
      prevTime = time;
      if (window.__spinSteps.length < 50) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await a.waitForTimeout(1500);
  const steps = await b.evaluate(() => window.__spinSteps);
  await a.evaluate(SPIN, false);
  await b.evaluate(SPIN, false);
  await settle(a, b);
  sa = await a.evaluate(CAMERA);
  sb = await b.evaluate(CAMERA);
  const maxRate = Math.max(...steps);
  H.check('two spinning tabs: the one touched last leads, the other follows it smoothly',
    sameView(sa, sb) && steps.length >= 20 && maxRate < 4 && steps.some((t) => t > 1e-3),
    JSON.stringify({ maxRate, frames: steps.length, sa, sb }));

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
