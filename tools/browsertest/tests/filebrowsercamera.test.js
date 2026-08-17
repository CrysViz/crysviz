// Clicking a different row in the file browser table (switching between
// already-loaded structures) must preserve the camera's rotation/zoom and
// only re-center it — it was calling resetView() (full reset to the [1,1,1]
// default direction), discarding the user's view every time.
'use strict';
const H = require('../harness');

async function cameraState(page) {
  return page.evaluate(async () => {
    const { app, fileBrowser } = await import('./state/store.js');
    const rect = app.renderer.domElement.getBoundingClientRect();
    const projectedTarget = app.controls.target.clone().project(app.camera);
    return {
      activeRowIndex: fileBrowser.selectedRowIndex,
      offset: app.camera.position.clone().sub(app.controls.target).toArray(),
      targetScreen: [
        rect.left + (projectedTarget.x + 1) * rect.width / 2,
        rect.top + (1 - projectedTarget.y) * rect.height / 2,
      ],
      pan: { x: app.cameraPan.x, y: app.cameraPan.y },
      zoom: app.camera.zoom,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  // A second row to switch to.
  await H.loadDefaultStructure(page, 'defaultPOSCAR2', 'second');

  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    app.cameraLocked = true;
    app.camera.position.set(app.controls.target.x + 9, app.controls.target.y + 4, app.controls.target.z + 13);
    app.controls.update();
    // Establish the same logical/physical representation used by the pan
    // gesture and render loop, without depending on a transient animation
    // frame while sampling the state below.
    app.cameraPan.x = -2;
    app.cameraPan.y = 1.2;
    app.camera.updateMatrixWorld(true);
    const right = new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, 1);
    app.camera.position.addScaledVector(right, app.cameraPan.x);
    app.camera.position.addScaledVector(up, app.cameraPan.y);
    app.camera.updateMatrixWorld(true);
  });
  const before = await cameraState(page);
  H.check('locked camera records a nonzero pan',
    Math.hypot(before.pan.x, before.pan.y) > 1e-6, JSON.stringify(before.pan));

  await page.evaluate(() => {
    const rows = document.querySelectorAll('#objectTable tbody tr');
    // Click whichever row isn't currently selected.
    const other = [...rows].find((r) => !r.classList.contains('selected'));
    other?.click();
  });
  await page.waitForTimeout(300);

  const after = await cameraState(page);

  const dx = Math.abs(before.offset[0] - after.offset[0]);
  const dy = Math.abs(before.offset[1] - after.offset[1]);
  const dz = Math.abs(before.offset[2] - after.offset[2]);
  H.check('switching rows in the file browser preserves camera rotation/zoom',
    dx < 0.01 && dy < 0.01 && dz < 0.01,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  H.check('locked camera preserves logical pan',
    Math.abs(before.pan.x - after.pan.x) < 1e-8
      && Math.abs(before.pan.y - after.pan.y) < 1e-8,
    `before=${JSON.stringify(before.pan)} after=${JSON.stringify(after.pan)}`);
  H.check('locked camera keeps the structure center at the same screen point',
    Math.hypot(before.targetScreen[0] - after.targetScreen[0],
      before.targetScreen[1] - after.targetScreen[1]) < 4,
    `before=${JSON.stringify(before.targetScreen)} after=${JSON.stringify(after.targetScreen)}`);
  H.check('switching rows preserves camera zoom',
    Math.abs(before.zoom - after.zoom) < 1e-8,
    `before=${before.zoom} after=${after.zoom}`);
  H.check('switching rows selects the other structure', before.activeRowIndex !== after.activeRowIndex,
    `before=${before.activeRowIndex} after=${after.activeRowIndex}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
