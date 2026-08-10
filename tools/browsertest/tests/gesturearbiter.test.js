// The gesture arbiter keeps TrackballControls' pointer state coherent across
// modality changes and touch-pointer-count transitions.
'use strict';
const H = require('../harness');

async function waitForQuiescence(page, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let stableFrames = 0;
  while (Date.now() < deadline) {
    const current = await page.evaluate(async () => {
      const { app } = await import('./state/store.js');
      return {
        position: app.camera.position.toArray(),
        quaternion: app.camera.quaternion.toArray(),
        zoom: app.camera.zoom,
      };
    });
    if (previous) {
      const delta = Math.max(
        ...current.position.map((value, i) => Math.abs(value - previous.position[i])),
        ...current.quaternion.map((value, i) => Math.abs(value - previous.quaternion[i])),
        Math.abs(current.zoom - previous.zoom)
      );
      stableFrames = delta < 1e-8 ? stableFrames + 1 : 0;
      if (stableFrames >= 5) return true;
    }
    previous = current;
    await page.waitForTimeout(40);
  }
  return false;
}

async function canvasCenter(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('canvas').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function cameraMetric(page) {
  return page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.position.distanceTo(app.controls.target);
  });
}

async function targetProjection(page) {
  return page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const rect = app.renderer.domElement.getBoundingClientRect();
    app.camera.updateMatrixWorld(true);
    const ndc = new THREE.Vector3().copy(app.controls.target).project(app.camera);
    return {
      x: rect.left + (ndc.x + 1) * rect.width / 2,
      y: rect.top + (1 - ndc.y) * rect.height / 2,
    };
  });
}

async function firstAtomProjection(page) {
  return page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const mesh = groups.atomsMesh;
    mesh.getMatrixAt(0, matrix);
    position.setFromMatrixPosition(matrix);
    mesh.localToWorld(position);
    app.camera.updateMatrixWorld(true);
    const ndc = position.project(app.camera);
    const rect = app.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (ndc.x + 1) * rect.width / 2,
      y: rect.top + (1 - ndc.y) * rect.height / 2,
    };
  });
}

async function sceneSelectionState(page) {
  return page.evaluate(async () => {
    const { atomSelection, measurements, highlightHover } = await import('./state/store.js');
    return {
      atomSelection: atomSelection.selectedAtoms.length,
      measurements: measurements.selectedAtoms.length,
      highlights: (highlightHover.currentlyHighlightedAtomInstances ?? []).length,
    };
  });
}

async function quaternion(page) {
  return page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.quaternion.toArray();
  });
}

async function dispatchSyntheticPointerEvents(page, events, yieldAfterPointerId = null) {
  await page.evaluate(async ({ events, yieldAfterPointerId }) => {
    const canvas = document.querySelector('canvas');
    const setPointerCapture = canvas.setPointerCapture;
    const releasePointerCapture = canvas.releasePointerCapture;
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    try {
      for (const event of events) {
        canvas.dispatchEvent(new PointerEvent(event.type, {
          bubbles: true,
          cancelable: true,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary ?? event.pointerId === 401,
          clientX: event.x,
          clientY: event.y,
          screenX: event.x,
          screenY: event.y,
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

function touch(type, pointerId, x, y, buttons = type === 'pointerup' ? 0 : 1) {
  return { type, pointerId, pointerType: 'touch', x, y, buttons };
}

function mouse(type, pointerId, x, y, button = 0, buttons = type === 'pointerup' ? 0 : 1) {
  return { type, pointerId, pointerType: 'mouse', x, y, button, buttons };
}

async function resetPerspective(page) {
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { switchCameraType, resetView } = await import('./ui/WindowAndSceneControls.js');
    if (app.useOrthographicCamera) {
      app.useOrthographicCamera = false;
      switchCameraType();
    }
    resetView();
  });
  H.check('camera reset settles', await waitForQuiescence(page));
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await resetPerspective(page);
  const center = await canvasCenter(page);

  // A mouse is already registered by TrackballControls when the touch move
  // arrives; the arbiter must suppress that mixed-modality path completely.
  await dispatchSyntheticPointerEvents(page, [
    mouse('pointerdown', 390, center.x, center.y),
    touch('pointerdown', 391, center.x - 40, center.y),
    touch('pointermove', 391, center.x - 20, center.y + 10),
    mouse('pointerup', 390, center.x, center.y),
    touch('pointerup', 391, center.x - 20, center.y + 10),
  ]);
  H.check('touch move while mouse is registered is suppressed without errors', errors.length === 0,
    errors[0] || '');

  await resetPerspective(page);

  // A touch lock suppresses the intervening mouse gesture, including its
  // pointerdown, so TrackballControls never sees a mixed pointer registry.
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 401, center.x - 60, center.y),
    touch('pointerdown', 402, center.x + 60, center.y),
  ]);
  const mixedBefore = await quaternion(page);
  await dispatchSyntheticPointerEvents(page, [
    mouse('pointerdown', 451, center.x, center.y),
    mouse('pointermove', 451, center.x + 110, center.y + 30),
    mouse('pointerup', 451, center.x + 110, center.y + 30),
  ]);
  const mixedAfter = await quaternion(page);
  const mixedQuaternionDelta = Math.max(...mixedAfter.map((value, i) =>
    Math.abs(value - mixedBefore[i])));
  H.check('mixed modality mouse drag is suppressed', mixedQuaternionDelta < 1e-10,
    JSON.stringify({ mixedQuaternionDelta }));
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerup', 401, center.x - 60, center.y),
    touch('pointerup', 402, center.x + 60, center.y),
  ]);
  await dispatchSyntheticPointerEvents(page, [
    mouse('pointerdown', 452, center.x, center.y),
    mouse('pointermove', 452, center.x + 90, center.y),
    mouse('pointerup', 452, center.x + 90, center.y),
  ]);
  const afterUnlockQuaternion = await quaternion(page);
  H.check('mouse rotation works after touch lock releases',
    Math.max(...afterUnlockQuaternion.map((value, i) => Math.abs(value - mixedAfter[i]))) > 1e-4,
    JSON.stringify({ before: mixedAfter, after: afterUnlockQuaternion }));

  await resetPerspective(page);
  const pair = { first: center.x - 60, second: center.x + 60, y: center.y };
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 501, pair.first, pair.y),
    touch('pointerdown', 502, pair.second, pair.y),
    touch('pointermove', 501, center.x - 80, pair.y),
    touch('pointermove', 502, center.x + 80, pair.y),
  ], 502);
  await waitForQuiescence(page);
  const originalPairDistance = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [touch('pointerdown', 503, center.x + 170, pair.y)]);
  const afterThirdDown = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointermove', 501, center.x - 100, pair.y),
    touch('pointermove', 502, center.x + 100, pair.y),
  ], 502);
  await waitForQuiescence(page);
  const duringThirdDistance = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [touch('pointerup', 503, center.x + 170, pair.y)]);
  const afterThirdUp = await cameraMetric(page);
  const expectedDuringThird = originalPairDistance * 160 / 200;
  H.check('2-to-3-to-2 original pair has no zoom jump',
    Math.abs(afterThirdDown / originalPairDistance - 1) < 0.005
      && Math.abs(afterThirdUp / duringThirdDistance - 1) < 0.005
      && Math.abs(duringThirdDistance / expectedDuringThird - 1) < 0.02,
    JSON.stringify({ originalPairDistance, afterThirdDown, duringThirdDistance, afterThirdUp, expectedDuringThird }));
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerup', 501, center.x - 100, pair.y),
    touch('pointerup', 502, center.x + 100, pair.y),
  ]);

  await resetPerspective(page);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 601, pair.first, pair.y),
    touch('pointerdown', 602, pair.second, pair.y),
    touch('pointermove', 601, center.x - 80, pair.y),
    touch('pointermove', 602, center.x + 80, pair.y),
  ], 602);
  await waitForQuiescence(page);
  const replacementBefore = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [touch('pointerdown', 603, center.x + 170, pair.y)]);
  await dispatchSyntheticPointerEvents(page, [touch('pointerup', 602, center.x + 80, pair.y)]);
  await page.waitForTimeout(0);
  const replacementAfterPromotion = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointermove', 601, center.x - 110, pair.y),
    touch('pointermove', 603, center.x + 200, pair.y),
  ], 603);
  await waitForQuiescence(page);
  const replacementAfterPinch = await cameraMetric(page);
  const expectedReplacementAfterPinch = replacementBefore * 250 / 310;
  H.check('promoted touch pair re-anchors without a zoom jump',
    Math.abs(replacementAfterPromotion / replacementBefore - 1) < 0.005,
    JSON.stringify({ replacementBefore, replacementAfterPromotion }));
  H.check('promoted touch pair uses current-coordinate pinch ratio',
    Math.abs(replacementAfterPinch / expectedReplacementAfterPinch - 1) < 0.02,
    JSON.stringify({ replacementBefore, replacementAfterPinch, expectedReplacementAfterPinch }));

  // The arbiter tags the promoted pointerdown as camera-only. Its later real
  // pointerup is untagged, so SceneInteraction must remember that pointer id
  // and avoid turning this lift over an atom into a measurement pick.
  const selectionBeforePromotionLift = await sceneSelectionState(page);
  const atomPoint = await firstAtomProjection(page);
  await page.evaluate(async () => {
    const { mode } = await import('./state/store.js');
    mode.measureMode = 'distance';
  });
  await dispatchSyntheticPointerEvents(page, [
    touch('pointermove', 601, atomPoint.x - 250, atomPoint.y),
    touch('pointermove', 603, atomPoint.x, atomPoint.y),
  ], 603);
  await dispatchSyntheticPointerEvents(page, [touch('pointerup', 603, atomPoint.x, atomPoint.y)]);
  const selectionAfterPromotionLift = await sceneSelectionState(page);
  H.check('lifting a promoted camera-only pointer does not pick an atom',
    JSON.stringify(selectionAfterPromotionLift) === JSON.stringify(selectionBeforePromotionLift),
    JSON.stringify({ atomPoint, selectionBeforePromotionLift, selectionAfterPromotionLift }));
  await page.evaluate(async () => {
    const { mode } = await import('./state/store.js');
    mode.measureMode = 'none';
  });
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerup', 601, center.x - 110, pair.y),
    touch('pointerup', 603, center.x + 200, pair.y),
  ]);

  await resetPerspective(page);
  const pendingTouchStart = await targetProjection(page);
  await dispatchSyntheticPointerEvents(page, [
    mouse('pointerdown', 650, center.x, center.y, 2, 2),
    touch('pointerdown', 651, center.x - 40, center.y),
    mouse('pointerup', 650, center.x, center.y, 2, 0),
  ]);
  // The first touch was suppressed while the mouse owned the modality. It is
  // still down and must be adopted when the mouse releases.
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 652, center.x + 40, center.y),
    touch('pointermove', 651, center.x + 20, center.y + 25),
    touch('pointermove', 652, center.x + 100, center.y + 25),
  ], 652);
  await waitForQuiescence(page);
  const pendingTouchEnd = await targetProjection(page);
  H.check('suppressed touch survives owner release and joins the next pair',
    Math.abs(pendingTouchEnd.x - pendingTouchStart.x - 60) < 8
      && Math.abs(pendingTouchEnd.y - pendingTouchStart.y - 25) < 8
      && errors.length === 0,
    JSON.stringify({ pendingTouchStart, pendingTouchEnd, errors: errors[0] || null }));
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerup', 651, center.x + 20, center.y + 25),
    touch('pointerup', 652, center.x + 100, center.y + 25),
  ]);

  await resetPerspective(page);
  const blurStartProjection = await targetProjection(page);
  const blurStartDistance = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 801, center.x - 60, center.y),
    touch('pointerdown', 802, center.x + 60, center.y),
    touch('pointermove', 801, center.x - 40, center.y + 10),
    touch('pointermove', 802, center.x + 80, center.y + 10),
  ], 802);
  const afterBlurSourceProjection = await targetProjection(page);
  const afterBlurSourceDistance = await cameraMetric(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 811, center.x - 60, center.y),
    touch('pointerdown', 812, center.x + 60, center.y),
    touch('pointermove', 811, center.x - 10, center.y + 50),
    touch('pointermove', 812, center.x + 110, center.y + 50),
  ], 812);
  await waitForQuiescence(page);
  const blurPanProjection = await targetProjection(page);
  const blurPanDistance = await cameraMetric(page);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointermove', 811, center.x - 40, center.y + 50),
    touch('pointermove', 812, center.x + 140, center.y + 50),
  ], 812);
  await waitForQuiescence(page);
  const blurEndProjection = await targetProjection(page);
  const blurEndDistance = await cameraMetric(page);
  const expectedBlurDistance = blurPanDistance * 120 / 180;
  H.check('blur cancels forwarded pointers before a clean new pair',
    Math.abs(blurPanProjection.x - afterBlurSourceProjection.x - 50) < 8
      && Math.abs(blurPanProjection.y - afterBlurSourceProjection.y - 50) < 8
      && Math.abs(blurEndDistance / expectedBlurDistance - 1) < 0.02
      && errors.length === 0,
    JSON.stringify({ blurStartProjection, afterBlurSourceProjection, blurPanProjection,
      blurEndProjection, blurStartDistance, afterBlurSourceDistance, blurPanDistance,
      blurEndDistance, expectedBlurDistance, errors: errors[0] || null }));
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerup', 811, center.x - 40, center.y + 50),
    touch('pointerup', 812, center.x + 140, center.y + 50),
  ]);

  await resetPerspective(page);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerdown', 701, pair.first, pair.y),
    touch('pointermove', 701, center.x - 20, pair.y + 50),
    touch('pointermove', 701, center.x + 20, pair.y - 40),
  ], 701);
  const beforePinchStart = await quaternion(page);
  await dispatchSyntheticPointerEvents(page, [touch('pointerdown', 702, pair.second, pair.y)]);
  H.check('one-finger rotation momentum is cleared at pinch start',
    await waitForQuiescence(page) && Math.max(...(await quaternion(page)).map((value, i) =>
      Math.abs(value - beforePinchStart[i]))) < 1e-8);
  await dispatchSyntheticPointerEvents(page, [
    touch('pointerup', 701, center.x + 20, pair.y - 40),
    touch('pointerup', 702, pair.second, pair.y),
  ]);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
