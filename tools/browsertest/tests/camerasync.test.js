// Camera sync across tabs (ui/CameraSync.js, Camera panel "Sync camera across tabs"):
//   - two tabs of one browser, each with the button Off: turning one leaves the other alone
//   - a click switches a tab on; a tab switched on second takes the first one's view
//   - turning or zooming either tab turns the other one (the tab you touch leads)
//   - the other tab eases to a jump over a few frames instead of snapping
//   - 'rotation' mode keeps each tab's own centre and pan; 'view' copies them too
//   - an idle pair sends nothing (no echo between the tabs)
//   - malformed messages on the channel (wrong version, NaN, out of range, missing
//     fields, a forged own id) move nothing
//   - a long press opens the menu (mode, "Make other tabs match this one", Cancel)
//     and does not also toggle sync; "Make other tabs match" turns the others
//   - switching a tab off stops it following
//   - a perspective tab and a parallel tab zoom together (zoom factor <-> distance)
'use strict';
const H = require('../harness');

/** The camera's direction (centre to eye, pan removed), up, zoom, centre and pan, rounded. */
const CAMERA = async () => {
  const THREE = await import('./external/three/three.module.js');
  const { app } = await import('./state/store.js');
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(app.camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(app.camera.quaternion);
  const r = (v) => +v.toFixed(4);
  const btn = document.getElementById('cameraSyncBtn');
  return {
    dir: back.toArray().map(r),
    up: up.toArray().map(r),
    zoom: r(app.camera.zoom),
    target: app.controls.target.toArray().map(r),
    pan: [app.cameraPan.x, app.cameraPan.y].map(r),
    pressed: btn?.getAttribute('aria-pressed'),
    state: btn?.querySelector('.camera_sync_state')?.textContent,
  };
};

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
  H.check('both tabs have the Sync button, Off', b0.pressed === 'false' && b0.state === 'Off'
    && (await a.evaluate(CAMERA)).state === 'Off', JSON.stringify(b0));
  await a.evaluate(TURN, [1, 0.2, 0.3]);
  await settle(a, b);
  H.check('with sync off, turning tab A leaves tab B alone', sameView(await b.evaluate(CAMERA), b0),
    JSON.stringify(await b.evaluate(CAMERA)));

  // ---- on: B joins and takes A's view ---------------------------------------------
  await H.clickById(a, 'cameraSyncBtn');
  await H.clickById(b, 'cameraSyncBtn');
  await settle(b, a);
  let ca = await a.evaluate(CAMERA);
  let cb = await b.evaluate(CAMERA);
  H.check('a click switches sync on (lit, mode shown)', ca.pressed === 'true' && ca.state === 'Rotation & zoom', JSON.stringify(ca));
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
  H.check("'rotation' mode keeps tab B's own pan", close(cb.pan, [0, 0]), JSON.stringify(cb));
  await b.evaluate(async () => (await import('./ui/CameraSync.js')).setCameraSyncMode('view'));
  await a.evaluate(PAN, [0.5, 0.2]);
  await settle(a, b);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check("'view' mode copies the pan and the centre too", close(ca.pan, cb.pan) && close(ca.target, cb.target)
    && sameView(ca, cb) && cb.state === 'Whole view', JSON.stringify({ ca, cb }));

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
  H.check('malformed messages move nothing', sameView(cb, cbAfter) && cb.zoom === cbAfter.zoom && close(cb.target, cbAfter.target),
    JSON.stringify({ cb, cbAfter }));

  // ---- long press: the menu ----------------------------------------------------------
  // A real mouse hold on the button in its window (Visual ▸ Camera), as the user does it,
  // with the window docked and floating (floating windows sit on a higher layer).
  await b.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('visual');
  });
  await b.waitForTimeout(500);
  const holdSyncButton = async () => {
    await b.locator('#cameraSyncBtn').scrollIntoViewIfNeeded();
    const box = await b.locator('#cameraSyncBtn').boundingBox();
    await b.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await b.mouse.down();
    await b.waitForTimeout(800);
    await b.mouse.up();
    await b.waitForTimeout(200);
    return b.evaluate(() => {
      const btn = document.getElementById('cameraSyncBtn');
      const menu = document.getElementById('cameraSyncMenu');
      const r = menu && !menu.hidden ? menu.getBoundingClientRect() : null;
      // On top where it opened, not behind the window that holds the button.
      const top = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        open: !!r,
        onTop: !!top && menu.contains(top),
        topIs: top ? `${top.tagName}#${top.id}.${top.className}` : null,
        checked: menu?.querySelector('[aria-checked="true"]')?.id,
        pressed: btn.getAttribute('aria-pressed'),
      };
    });
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
    const press = await holdSyncButton();
    H.check(`${placement} window: a long press opens the menu on top, the current mode checked, and does not toggle sync`,
      press.open && press.onTop && press.checked === 'cameraSyncModeView' && press.pressed === 'true', JSON.stringify(press));
    await b.keyboard.press('Escape');
  }
  H.check('Escape closes the menu', await b.evaluate(() => document.getElementById('cameraSyncMenu').hidden));

  // "Make other tabs match this one": B turns while its sync is off, then leads.
  await H.clickById(b, 'cameraSyncBtn');
  await b.evaluate(TURN, [0.3, -1, 0.2]);
  await settle(b, a);
  H.check('a tab switched off stops sending', !sameView(await a.evaluate(CAMERA), await b.evaluate(CAMERA)));
  await H.clickById(b, 'cameraSyncLead');
  await settle(b, a);
  ca = await a.evaluate(CAMERA);
  cb = await b.evaluate(CAMERA);
  H.check('"Make other tabs match this one" switches sync on and turns the others to this view',
    cb.pressed === 'true' && sameView(ca, cb), JSON.stringify({ ca, cb }));

  // ---- off: stops following ---------------------------------------------------------
  await H.clickById(b, 'cameraSyncBtn');
  cb = await b.evaluate(CAMERA);
  await a.evaluate(TURN, [1, 1, -0.2]);
  await settle(a, b);
  const cbOff = await b.evaluate(CAMERA);
  H.check('switched off, tab B no longer follows', cbOff.pressed === 'false' && sameView(cb, cbOff), JSON.stringify(cbOff));

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
  await H.clickById(b, 'cameraSyncBtn');  // B on again ('view' mode from the menu test)
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

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
