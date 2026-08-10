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

async function dispatchSyntheticPointerEvents(page, events, yieldAfterPointerId = null) {
  await page.evaluate(async ({ events, yieldAfterPointerId }) => {
    const canvas = document.querySelector('canvas');
    const setPointerCapture = canvas.setPointerCapture;
    const releasePointerCapture = canvas.releasePointerCapture;
    // Synthetic PointerEvents are not backed by OS pointers, so Firefox would
    // reject TrackballControls' normal capture calls. Keep its bookkeeping and
    // listeners active while making capture a no-op for this synthetic test.
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    try {
      for (const event of events) {
        canvas.dispatchEvent(new PointerEvent(event.type, {
          bubbles: true,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary ?? event.pointerId === 101,
          clientX: event.x,
          clientY: event.y,
          button: event.button ?? (event.type === 'pointermove' ? -1 : 0),
          buttons: event.buttons,
          pressure: event.pressure ?? (event.type === 'pointerup' ? 0 : 0.5),
        }));
        if (event.type === 'pointermove' && event.pointerId === yieldAfterPointerId) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } finally {
      canvas.setPointerCapture = setPointerCapture;
      canvas.releasePointerCapture = releasePointerCapture;
    }
  }, { events, yieldAfterPointerId });
}

async function dispatchTouchGesture(page, {
  midpointX, midpointY, startSeparation = 120, endSeparation = startSeparation,
  dx = 0, dy = 0, steps = 6,
}) {
  const events = [];
  const firstId = 101;
  const secondId = 102;
  const add = (type, pointerId, x, y, buttons) => {
    events.push({ type, pointerId, pointerType: 'touch', x, y, buttons });
  };
  const firstStartX = midpointX - startSeparation / 2;
  const secondStartX = midpointX + startSeparation / 2;
  add('pointerdown', firstId, firstStartX, midpointY, 1);
  add('pointerdown', secondId, secondStartX, midpointY, 1);
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const separation = startSeparation + (endSeparation - startSeparation) * progress;
    add('pointermove', firstId, midpointX - separation / 2 + dx * progress,
      midpointY + dy * progress, 1);
    add('pointermove', secondId, midpointX + separation / 2 + dx * progress,
      midpointY + dy * progress, 1);
  }
  add('pointerup', firstId, midpointX - endSeparation / 2 + dx, midpointY + dy, 0);
  add('pointerup', secondId, midpointX + endSeparation / 2 + dx, midpointY + dy, 0);

  await dispatchSyntheticPointerEvents(page, events, 102);
}

async function cameraMetric(page) {
  return page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      distance: app.camera.position.distanceTo(app.controls.target),
      zoom: app.camera.zoom,
    };
  });
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

  const burstStart = await projection(page, initial);
  const burstEvents = [{
    type: 'pointerdown', pointerId: 301, pointerType: 'mouse',
    x: burstStart.x, y: burstStart.y, button: 2, buttons: 2,
  }];
  for (let i = 1; i <= 10; i++) {
    burstEvents.push({
      type: 'pointermove', pointerId: 301, pointerType: 'mouse',
      x: burstStart.x + i * 12, y: burstStart.y, buttons: 2,
    });
  }
  burstEvents.push({
    type: 'pointerup', pointerId: 301, pointerType: 'mouse',
    x: burstStart.x + 120, y: burstStart.y, buttons: 0,
  });
  await dispatchSyntheticPointerEvents(page, burstEvents);
  H.check('burst pan settles', await waitForQuiescence(page));
  const burstEnd = await projection(page, initial);
  H.check('burst mouse pan sums all deltas',
    Math.abs(burstEnd.x - burstStart.x - 120) <= 12,
    JSON.stringify({ burstStart, burstEnd, delta: burstEnd.x - burstStart.x }));

  const axisBefore = await projection(page, initial);
  await page.evaluate(async () => {
    const { applyRotationFromUI } = await import('./render/cameraAngleControl.js');
    applyRotationFromUI(5, 'y');
  });
  await waitForQuiescence(page);
  const axisAfter = await projection(page, initial);
  H.check('axis step rotation preserves panned projection',
    Math.hypot(axisAfter.x - axisBefore.x, axisAfter.y - axisBefore.y) < 4,
    JSON.stringify({ axisBefore, axisAfter }));

  await H.clickById(page, 'resetView');
  await waitForQuiescence(page);
  const staleStart = await projection(page, initial);
  const stalePointerId = 302;
  await dispatchSyntheticPointerEvents(page, [
    { type: 'pointerdown', pointerId: stalePointerId, pointerType: 'mouse',
      x: staleStart.x, y: staleStart.y, button: 2, buttons: 2 },
    { type: 'pointermove', pointerId: stalePointerId, pointerType: 'mouse',
      x: staleStart.x + 20, y: staleStart.y, buttons: 2 },
  ]);
  const staleAfterFirstMove = await projection(page, initial);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await dispatchSyntheticPointerEvents(page, [
    { type: 'pointermove', pointerId: stalePointerId, pointerType: 'mouse',
      x: staleStart.x + 120, y: staleStart.y, buttons: 2 },
    { type: 'pointerup', pointerId: stalePointerId, pointerType: 'mouse',
      x: staleStart.x + 120, y: staleStart.y, buttons: 0 },
  ]);
  const staleAfterBlur = await projection(page, initial);
  H.check('blur clears stale mouse pan state',
    Math.hypot(staleAfterBlur.x - staleAfterFirstMove.x,
      staleAfterBlur.y - staleAfterFirstMove.y) < 1,
    JSON.stringify({ staleAfterFirstMove, staleAfterBlur }));

  // The default camera is orthographic, whose pinch zoom changes zoom rather
  // than camera-target distance. Use perspective for this touch section so
  // the required pinch-distance assertion exercises the native zoom path.
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { switchCameraType, resetView } = await import('./ui/WindowAndSceneControls.js');
    if (app.useOrthographicCamera) {
      app.useOrthographicCamera = false;
      switchCameraType();
    }
    resetView();
  });
  await waitForQuiescence(page);
  const alignStartMetric = await cameraMetric(page);
  await drag(page, 'right', 240);
  await waitForQuiescence(page);
  await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { setViewDirection } = await import('./ui/WindowAndSceneControls.js');
    setViewDirection(new THREE.Vector3(1, 0, 0));
  });
  await waitForQuiescence(page);
  const alignEndMetric = await cameraMetric(page);
  H.check('perspective alignment preserves pre-pan axial distance',
    Math.abs(alignEndMetric.distance / alignStartMetric.distance - 1) < 0.02,
    JSON.stringify({ alignStartMetric, alignEndMetric }));
  await page.evaluate(async () => {
    const { resetView } = await import('./ui/WindowAndSceneControls.js');
    resetView();
  });
  await waitForQuiescence(page);
  const touchStartProjection = await projection(page, initial);
  const touchStartMetric = await cameraMetric(page);

  await dispatchTouchGesture(page, {
    midpointX: touchStartProjection.x,
    midpointY: touchStartProjection.y,
    dx: 90,
    dy: 40,
  });
  H.check('two-finger pan stops without inertia', await waitForQuiescence(page));
  const afterTouchPan = await projection(page, initial);
  const afterTouchMetric = await cameraMetric(page);
  H.check('two-finger pan is 1:1 in screen space',
    Math.abs(afterTouchPan.x - touchStartProjection.x - 90) <= 10
      && Math.abs(afterTouchPan.y - touchStartProjection.y - 40) <= 10,
    JSON.stringify({ touchStartProjection, afterTouchPan }));
  H.check('two-finger pan leaves controls.target unchanged',
    await page.evaluate(async (initial) => {
      const { app } = await import('./state/store.js');
      return Math.max(...app.controls.target.toArray().map((value, i) =>
        Math.abs(value - initial[i]))) === 0;
    }, initial));
  H.check('two-finger pan does not zoom',
    Math.abs(afterTouchMetric.distance / touchStartMetric.distance - 1) < 0.01,
    JSON.stringify({ touchStartMetric, afterTouchMetric }));
  H.check('two-finger release has no inertia', await waitForQuiescence(page));

  await H.clickById(page, 'resetView');
  await waitForQuiescence(page);
  const thirdStart = await projection(page, initial);
  const thirdY = thirdStart.y;
  await dispatchSyntheticPointerEvents(page, [
    { type: 'pointerdown', pointerId: 201, pointerType: 'touch',
      x: thirdStart.x - 50, y: thirdY, buttons: 1 },
    { type: 'pointerdown', pointerId: 202, pointerType: 'touch',
      x: thirdStart.x + 50, y: thirdY, buttons: 1 },
    { type: 'pointermove', pointerId: 201, pointerType: 'touch',
      x: thirdStart.x - 20, y: thirdY + 10, buttons: 1 },
    { type: 'pointermove', pointerId: 202, pointerType: 'touch',
      x: thirdStart.x + 80, y: thirdY + 10, buttons: 1 },
  ]);
  const thirdAfterTwo = await projection(page, initial);
  const thirdPanAfterTwo = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { x: app.cameraPan.x, y: app.cameraPan.y };
  });
  await dispatchSyntheticPointerEvents(page, [
    { type: 'pointerdown', pointerId: 203, pointerType: 'touch',
      x: thirdStart.x + 150, y: thirdY, buttons: 1 },
    { type: 'pointermove', pointerId: 201, pointerType: 'touch',
      x: thirdStart.x + 20, y: thirdY + 30, buttons: 1 },
    { type: 'pointermove', pointerId: 202, pointerType: 'touch',
      x: thirdStart.x + 120, y: thirdY + 30, buttons: 1 },
    { type: 'pointermove', pointerId: 203, pointerType: 'touch',
      x: thirdStart.x + 190, y: thirdY + 20, buttons: 1 },
  ]);
  const thirdAfterThree = await projection(page, initial);
  const thirdPanAfterThree = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { x: app.cameraPan.x, y: app.cameraPan.y };
  });
  H.check('third finger suppresses direct pan',
    Math.hypot(thirdPanAfterThree.x - thirdPanAfterTwo.x,
      thirdPanAfterThree.y - thirdPanAfterTwo.y) < 1e-8,
    JSON.stringify({ thirdPanAfterTwo, thirdPanAfterThree, thirdAfterTwo, thirdAfterThree }));
  await dispatchSyntheticPointerEvents(page, [
    { type: 'pointerup', pointerId: 203, pointerType: 'touch',
      x: thirdStart.x + 190, y: thirdY + 20, buttons: 0 },
    { type: 'pointermove', pointerId: 201, pointerType: 'touch',
      x: thirdStart.x + 45, y: thirdY + 40, buttons: 1 },
    { type: 'pointermove', pointerId: 202, pointerType: 'touch',
      x: thirdStart.x + 145, y: thirdY + 40, buttons: 1 },
    { type: 'pointerup', pointerId: 201, pointerType: 'touch',
      x: thirdStart.x + 45, y: thirdY + 40, buttons: 0 },
    { type: 'pointerup', pointerId: 202, pointerType: 'touch',
      x: thirdStart.x + 145, y: thirdY + 40, buttons: 0 },
  ]);
  const thirdAfterResume = await projection(page, initial);
  H.check('pan resumes cleanly after returning to two fingers',
    thirdAfterResume.x > thirdAfterThree.x + 20 && thirdAfterResume.y > thirdAfterThree.y + 5,
    JSON.stringify({ thirdAfterThree, thirdAfterResume }));

  await H.clickById(page, 'resetView');
  await waitForQuiescence(page);
  const pinchStartProjection = await projection(page, initial);
  const pinchStartMetric = await cameraMetric(page);
  await dispatchTouchGesture(page, {
    midpointX: pinchStartProjection.x,
    midpointY: pinchStartProjection.y,
    startSeparation: 120,
    endSeparation: 180,
  });
  H.check('pinch zoom settles', await waitForQuiescence(page));
  const pinchEndProjection = await projection(page, initial);
  const pinchEndMetric = await cameraMetric(page);
  H.check('pinch changes camera-target distance',
    Math.abs(pinchEndMetric.distance / pinchStartMetric.distance - 1) > 0.01,
    JSON.stringify({ pinchStartMetric, pinchEndMetric }));
  H.check('fixed-midpoint pinch keeps center projection fixed',
    Math.hypot(pinchEndProjection.x - pinchStartProjection.x,
      pinchEndProjection.y - pinchStartProjection.y) < 4,
    JSON.stringify({ pinchStartProjection, pinchEndProjection }));

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
