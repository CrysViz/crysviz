// View-window axis rotation buttons: clicking the ▲/▼ pair for an axis must
// rigidly rotate the view about that axis, i.e. the axis keeps its screen
// (view-space) direction fixed while other directions precess around it by
// the stepped angle. Uses the triclinic defaultPOSCAR3 so the a/b/c lattice
// directions differ from the world x/y/z axes (catches the a/b/c buttons
// silently falling back to a world axis).
'use strict';
const H = require('../harness');

// View-space direction of a world-space vector, plus a couple of vector
// helpers, all evaluated in-page.
const measure = async (page) => page.evaluate(async () => {
  const { app, fileBrowser } = await import('./state/store.js');
  const THREE = await import('./external/three/three.module.js');
  app.camera.updateMatrixWorld(true);
  const L = fileBrowser.selectedStructure.lattice;
  const view = (arr) => new THREE.Vector3(arr[0], arr[1], arr[2])
    .transformDirection(app.camera.matrixWorldInverse).toArray();
  return {
    a: view(L[0]), b: view(L[1]), c: view(L[2]),
    x: view([1, 0, 0]), y: view([0, 1, 0]),
    upLen: app.camera.up.length(),
  };
});

const deg = (u, v) => {
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const n = (w) => Math.hypot(w[0], w[1], w[2]);
  return Math.acos(Math.max(-1, Math.min(1, dot / (n(u) * n(v))))) * 180 / Math.PI;
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }

  await H.loadDefaultStructure(page, 'defaultPOSCAR3', 'AlSeCl');

  // Tilt to a generic orientation first so no axis coincides with camera.up.
  for (let i = 0; i < 4; i++) await H.clickById(page, 'xUp');
  for (let i = 0; i < 3; i++) await H.clickById(page, 'cDown');

  // Lattice axis: 8 clicks of bUp = 40° about the lattice b direction.
  const before = await measure(page);
  for (let i = 0; i < 8; i++) await H.clickById(page, 'bUp');
  const after = await measure(page);

  H.check('b stays fixed on screen under bUp',
    deg(before.b, after.b) < 0.1, `drift=${deg(before.b, after.b).toFixed(3)}°`);
  H.check('a precesses around b under bUp',
    deg(before.a, after.a) > 10, `moved=${deg(before.a, after.a).toFixed(1)}°`);

  // Exact rigid-rotation check: in view space a must equal its old direction
  // rotated by ±40° about the (fixed) view direction of b.
  const exact = await page.evaluate(async ({ before, after }) => {
    const THREE = await import('./external/three/three.module.js');
    const v = (arr) => new THREE.Vector3(arr[0], arr[1], arr[2]).normalize();
    const axis = v(before.b);
    const rad = 40 * Math.PI / 180;
    const got = v(after.a);
    return Math.min(
      v(before.a).applyAxisAngle(axis, rad).angleTo(got),
      v(before.a).applyAxisAngle(axis, -rad).angleTo(got),
    ) * 180 / Math.PI;
  }, { before, after });
  H.check('a moved by exactly the stepped 40° about b',
    exact < 0.1, `residual=${exact.toFixed(3)}°`);

  // World axis: same invariant for the y button.
  const beforeY = await measure(page);
  for (let i = 0; i < 8; i++) await H.clickById(page, 'yDown');
  const afterY = await measure(page);
  H.check('world y stays fixed on screen under yDown',
    deg(beforeY.y, afterY.y) < 0.1, `drift=${deg(beforeY.y, afterY.y).toFixed(3)}°`);
  H.check('world x precesses around y under yDown',
    deg(beforeY.x, afterY.x) > 10, `moved=${deg(beforeY.x, afterY.x).toFixed(1)}°`);

  H.check('camera.up stays normalized', Math.abs(afterY.upLen - 1) < 1e-6,
    `len=${afterY.upLen}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
