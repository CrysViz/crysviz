// Reset view's long-press menu (WindowAndSceneControls.js recenterView):
//   - a long press on Reset view opens Recenter / Recenter and fit / Cancel
//     under it, without resetting the view
//   - Recenter brings the structure back to the middle: the camera's
//     direction and zoom are kept, the panning is gone
//   - Recenter and fit keeps the direction too and fits the zoom (the same
//     zoom Reset view fits)
//   - Cancel, Escape and a click elsewhere close it and change nothing; a
//     plain click on Reset view still resets to the [1,1,1] view
//   - the feature search offers "Recenter view"
'use strict';
const H = require('../harness');

const CAMERA = async () => {
  const THREE = await import('./external/three/three.module.js');
  const { app } = await import('./state/store.js');
  const { getCellCenterAndDist } = await import('./render/index.js');
  const { center } = getCellCenterAndDist();
  // The viewing direction without the screen-space pan (which shifts only the
  // camera, by app.cameraPan along its right/up axes: ui/GestureArbiter.js).
  app.camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 0);
  const upAxis = new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 1);
  const eye = app.camera.position.clone().addScaledVector(right, -app.cameraPan.x).addScaledVector(upAxis, -app.cameraPan.y);
  const dir = eye.sub(app.controls.target).normalize();
  const r = (v) => +v.toFixed(4);
  const menu = document.getElementById('cameraResetMenu');
  return {
    dir: [dir.x, dir.y, dir.z].map(r),
    up: [app.camera.up.x, app.camera.up.y, app.camera.up.z].map(r),
    targetOff: +app.controls.target.distanceTo(center).toFixed(4),
    dist: r(eye.length ? app.camera.position.clone().addScaledVector(right, -app.cameraPan.x).addScaledVector(upAxis, -app.cameraPan.y).distanceTo(app.controls.target) : 0),
    frustum: r(app.orthographicFrustumSize || 0),
    zoom: r(app.camera.zoom || 1),
    pan: [app.cameraPan.x, app.cameraPan.y].map(r),
    menu: !!menu && !menu.hidden,
  };
};

/** Turn the view away from [1,1,1], pan it and zoom it (as a user would). */
const DISTURB = async () => {
  const THREE = await import('./external/three/three.module.js');
  const { app } = await import('./state/store.js');
  const { setViewDirection } = await import('./ui/WindowAndSceneControls.js');
  setViewDirection(new THREE.Vector3(1, 0.35, 0.6));
  const shift = new THREE.Vector3(3, -2, 1.5);
  app.controls.target.add(shift);
  app.camera.position.add(shift);
  app.orthographicFrustumSize *= 0.6;
  app.controls.update();
  // And a screen-space pan, as a pan drag makes it (ui/GestureArbiter.js).
  const [dx, dy] = [1.2, -0.8];
  app.cameraPan.x += dx;
  app.cameraPan.y += dy;
  app.camera.updateMatrixWorld(true);
  app.camera.position.addScaledVector(new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 0), dx);
  app.camera.position.addScaledVector(new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 1), dy);
  app.camera.updateMatrixWorld(true);
};

async function longPress(page, id) {
  const box = await page.locator(`#${id}`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

const same = (a, b, tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.evaluate(DISTURB);
  const before = await page.evaluate(CAMERA);
  H.check('the view is turned, panned (orbit target and screen pan) and zoomed to start with',
    before.targetOff > 1 && !same(before.pan, [0, 0]) && !same(before.dir, [0.5774, 0.5774, 0.5774]), JSON.stringify(before));

  // ---- long press: the menu, nothing reset ---------------------------------------------
  await longPress(page, 'resetView');
  const opened = await page.evaluate(CAMERA);
  const items = await page.evaluate(() => [...document.querySelectorAll('#cameraResetMenu button')].map((b) => b.textContent.trim()));
  H.check('a long press on Reset view opens Recenter / Recenter and fit / Cancel', opened.menu && items.join('|') === 'Recenter|Recenter and fit|Cancel', JSON.stringify(items));
  H.check('… without resetting the view', same(opened.dir, before.dir) && opened.targetOff === before.targetOff, JSON.stringify({ before, opened }));
  const placed = await page.evaluate(() => {
    const m = document.getElementById('cameraResetMenu').getBoundingClientRect();
    const b = document.getElementById('resetView').getBoundingClientRect();
    return { below: m.top >= b.bottom - 1, inside: m.left >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight };
  });
  H.check('the menu sits under the button, inside the window', placed.below && placed.inside, JSON.stringify(placed));

  // ---- Recenter --------------------------------------------------------------------------
  await page.click('#cameraRecenterBtn');
  await page.waitForTimeout(300);
  const recentered = await page.evaluate(CAMERA);
  H.check('Recenter: the structure is back in the middle (no panning left)', recentered.targetOff < 1e-3 && same(recentered.pan, [0, 0]), JSON.stringify(recentered));
  H.check('… with the rotation and the zoom kept', same(recentered.dir, before.dir) && same(recentered.up, before.up)
    && recentered.frustum === before.frustum && recentered.zoom === before.zoom && Math.abs(recentered.dist - before.dist) < 1e-3, JSON.stringify({ before, recentered }));
  H.check('… and the menu is closed', !recentered.menu);

  // ---- Recenter and fit --------------------------------------------------------------------
  await page.evaluate(DISTURB);
  const before2 = await page.evaluate(CAMERA);
  await longPress(page, 'resetView');
  await page.click('#cameraRecenterFitBtn');
  await page.waitForTimeout(300);
  const fitted = await page.evaluate(CAMERA);
  const resetFrustum = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const saved = { p: app.camera.position.clone(), t: app.controls.target.clone(), u: app.camera.up.clone(), f: app.orthographicFrustumSize };
    (await import('./ui/WindowAndSceneControls.js')).resetView();
    const f = app.orthographicFrustumSize;
    app.camera.position.copy(saved.p); app.controls.target.copy(saved.t); app.camera.up.copy(saved.u); app.orthographicFrustumSize = saved.f; app.controls.update();
    return +f.toFixed(4);
  });
  H.check('Recenter and fit: in the middle, the rotation kept, the zoom fitted (as Reset view fits it)',
    fitted.targetOff < 1e-3 && same(fitted.dir, before2.dir) && Math.abs(fitted.frustum - resetFrustum) < 1e-3 && fitted.frustum !== before2.frustum,
    JSON.stringify({ before2, fitted, resetFrustum }));

  // ---- Cancel, Escape, a click elsewhere ---------------------------------------------------
  await page.evaluate(DISTURB);
  const before3 = await page.evaluate(CAMERA);
  await longPress(page, 'resetView');
  await page.click('#cameraResetMenuCancel');
  const afterCancel = await page.evaluate(CAMERA);
  await longPress(page, 'resetView');
  await page.keyboard.press('Escape');
  const afterEscape = await page.evaluate(CAMERA);
  await longPress(page, 'resetView');
  await page.mouse.click(5, 880);
  const afterOutside = await page.evaluate(CAMERA);
  H.check('Cancel, Escape and a click elsewhere close it and change nothing',
    [afterCancel, afterEscape, afterOutside].every((c) => !c.menu && same(c.dir, before3.dir) && c.targetOff === before3.targetOff),
    JSON.stringify({ afterCancel, afterEscape, afterOutside }));

  // ---- a plain click still resets ----------------------------------------------------------
  await page.click('#resetView');
  await page.waitForTimeout(300);
  const reset = await page.evaluate(CAMERA);
  H.check('a plain click on Reset view still resets to the [1,1,1] view', same(reset.dir, [0.5774, 0.5774, 0.5774]) && reset.targetOff < 1e-3 && !reset.menu, JSON.stringify(reset));

  // ---- the search ----------------------------------------------------------------------------
  await page.evaluate(DISTURB);
  const before4 = await page.evaluate(CAMERA);
  await page.mouse.click(900, 450);
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(250);
  await page.fill('#featureSearchInput', 'recenter');
  await page.waitForTimeout(200);
  const first = await page.evaluate(() => document.querySelector('#featureSearchResults .feature-search-result .feature-search-label')?.textContent);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const searched = await page.evaluate(CAMERA);
  H.check('the search offers "Recenter view" first; Enter recenters, rotation kept',
    first === 'Recenter view' && searched.targetOff < 1e-3 && same(searched.dir, before4.dir), JSON.stringify({ first, searched }));

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
