// Anchored native panning keeps the structure center as the TrackballControls
// pivot, so a later rotation spins the structure in place at its panned spot.
'use strict';
const H = require('../harness');

function projection(page, center) {
  return page.evaluate(async (center) => {
    const { app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const canvas = app.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    app.camera.updateMatrixWorld(true);
    const ndc = new THREE.Vector3(...center).project(app.camera);
    return {
      x: rect.left + (ndc.x + 1) * rect.width / 2,
      y: rect.top + (1 - ndc.y) * rect.height / 2,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }, center);
}

async function cameraState(page) {
  return page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      position: app.camera.position.toArray(),
      quaternion: app.camera.quaternion.toArray(),
    };
  });
}

async function waitForQuiescence(page, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let stableFrames = 0;
  while (Date.now() < deadline) {
    const current = await cameraState(page);
    if (previous) {
      const delta = Math.max(
        ...current.position.map((value, i) => Math.abs(value - previous.position[i])),
        ...current.quaternion.map((value, i) => Math.abs(value - previous.quaternion[i]))
      );
      stableFrames = delta < 1e-8 ? stableFrames + 1 : 0;
      if (stableFrames >= 5) return true;
    }
    previous = current;
    await page.waitForTimeout(40);
  }
  return false;
}

async function drag(page, button, dx, dy = 0) {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('3D canvas has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up({ button });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const initial = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.controls.target.toArray();
  });
  const initialProjection = await projection(page, initial);
  H.check('structure center starts near canvas center',
    Math.abs(initialProjection.x - (initialProjection.rect.left + initialProjection.rect.width / 2)) < 8
      && Math.abs(initialProjection.y - (initialProjection.rect.top + initialProjection.rect.height / 2)) < 8,
    JSON.stringify(initialProjection));

  await drag(page, 'right', 120);
  H.check('horizontal pan stops without inertia', await waitForQuiescence(page));
  const afterHorizontalPan = await projection(page, initial);
  const horizontalDelta = afterHorizontalPan.x - initialProjection.x;
  H.check('horizontal pan is 1:1 in screen space',
    Math.abs(horizontalDelta - 120) <= 12,
    JSON.stringify({ initialProjection, afterHorizontalPan, horizontalDelta }));

  await drag(page, 'right', 0, 80);
  H.check('vertical pan stops without inertia', await waitForQuiescence(page));
  const afterPan = await projection(page, initial);
  const verticalDelta = afterPan.y - afterHorizontalPan.y;
  H.check('vertical pan is 1:1 in screen space',
    Math.abs(verticalDelta - 80) <= 10,
    JSON.stringify({ afterHorizontalPan, afterPan, verticalDelta }));
  const panState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      target: app.controls.target.toArray(),
      pan: { x: app.cameraPan.x, y: app.cameraPan.y },
      quaternion: app.camera.quaternion.toArray(),
    };
  });
  H.check('panning moves the center projection in the drag direction',
    afterPan.x > initialProjection.x && afterPan.y > initialProjection.y,
    JSON.stringify({ initialProjection, afterPan }));
  H.check('panning leaves controls.target unchanged',
    Math.max(...panState.target.map((value, i) => Math.abs(value - initial[i]))) === 0,
    JSON.stringify(panState.target));
  H.check('panning records a nonzero camera-plane offset',
    Math.hypot(panState.pan.x, panState.pan.y) > 1e-6, JSON.stringify(panState.pan));

  const projectionBeforeRotate = afterPan;
  await drag(page, 'left', 90);
  H.check('rotation damping settles', await waitForQuiescence(page));
  const afterRotate = await projection(page, initial);
  const rotatedState = await cameraState(page);
  const quaternionDelta = Math.max(...rotatedState.quaternion.map((value, i) =>
    Math.abs(value - panState.quaternion[i])));
  H.check('rotation keeps the panned center projection fixed',
    Math.hypot(afterRotate.x - projectionBeforeRotate.x, afterRotate.y - projectionBeforeRotate.y) < 4,
    JSON.stringify({ projectionBeforeRotate, afterRotate }));
  H.check('rotation changes the camera quaternion', quaternionDelta > 1e-4,
    JSON.stringify({ before: panState.quaternion, after: rotatedState.quaternion }));

  await H.clickById(page, 'resetView');
  await waitForQuiescence(page);
  const afterReset = await projection(page, initial);
  const resetPan = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { x: app.cameraPan.x, y: app.cameraPan.y };
  });
  H.check('reset re-centers the structure projection',
    Math.abs(afterReset.x - (afterReset.rect.left + afterReset.rect.width / 2)) < 8
      && Math.abs(afterReset.y - (afterReset.rect.top + afterReset.rect.height / 2)) < 8,
    JSON.stringify(afterReset));
  H.check('reset clears camera pan', resetPan.x === 0 && resetPan.y === 0, JSON.stringify(resetPan));

  await drag(page, 'right', 100);
  H.check('snapshot setup pan settles', await waitForQuiescence(page));
  const saved = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { captureCameraSnapshot } = await import('./ui/WindowAndSceneControls.js');
    const snapshot = captureCameraSnapshot();
    return {
      snapshot: {
        position: snapshot.position.toArray(),
        target: snapshot.target.toArray(),
        up: snapshot.up.toArray(),
        quaternion: snapshot.quaternion.toArray(),
        pan: snapshot.pan,
        zoom: snapshot.zoom,
        orthographicFrustumSize: snapshot.orthographicFrustumSize,
      },
      projection: (() => {
        app.camera.updateMatrixWorld(true);
        const ndc = app.controls.target.clone().project(app.camera);
        const rect = app.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (ndc.x + 1) * rect.width / 2,
          y: rect.top + (1 - ndc.y) * rect.height / 2 };
      })(),
    };
  });
  await drag(page, 'left', 70, 25);
  H.check('snapshot perturbation settles', await waitForQuiescence(page));
  await page.evaluate(async (saved) => {
    const THREE = await import('./external/three/three.module.js');
    const { applyCameraSnapshot } = await import('./ui/WindowAndSceneControls.js');
    const s = saved.snapshot;
    applyCameraSnapshot({
      position: new THREE.Vector3(...s.position),
      target: new THREE.Vector3(...s.target),
      up: new THREE.Vector3(...s.up),
      quaternion: new THREE.Quaternion(...s.quaternion),
      pan: s.pan,
      zoom: s.zoom,
      orthographicFrustumSize: s.orthographicFrustumSize,
    });
  }, saved);
  H.check('snapshot restore settles', await waitForQuiescence(page));
  const restoredProjection = await projection(page, initial);
  const restoredPan = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { x: app.cameraPan.x, y: app.cameraPan.y };
  });
  H.check('snapshot restores the panned center projection',
    Math.hypot(restoredProjection.x - saved.projection.x, restoredProjection.y - saved.projection.y) < 4,
    JSON.stringify({ saved: saved.projection, restored: restoredProjection }));
  H.check('snapshot restores camera pan',
    Math.abs(restoredPan.x - saved.snapshot.pan.x) < 1e-8
      && Math.abs(restoredPan.y - saved.snapshot.pan.y) < 1e-8,
    JSON.stringify({ saved: saved.snapshot.pan, restored: restoredPan }));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
