// Long-press menus, body dragging, enlarged resize hit zones, and interaction
// opacity for the axes gizmo and floating colour bars.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

const syntheticLongPress = (page, selector, pointerType, pointerId, x, y) =>
  page.evaluate(({ selector, pointerType, pointerId, x, y }) => new Promise((resolve) => {
    const element = document.querySelector(selector);
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId, pointerType, button: 0, buttons: 1,
      clientX: x, clientY: y,
    }));
    setTimeout(() => {
      const open = !!document.querySelector('.cv-colorbar-menu-open');
      element.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId, pointerType, button: 0,
        clientX: x, clientY: y,
      }));
      resolve(open);
    }, 650);
  }), { selector, pointerType, pointerId, x, y });

// Trackball momentum decays per FRAME, so how long a coast takes to settle
// (AnimateModule's settleControlsMomentum snaps it to exact zero) depends on
// the frame rate — seconds under the software renderer. Wait for the camera
// to actually stop instead of guessing a duration.
const waitForCameraSettled = async (page, timeoutMs = 15000) => {
  const sample = () => page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  const t0 = Date.now();
  let prev = await sample();
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(400);
    const cur = await sample();
    if (cur.every((v, i) => v === prev[i])) return true;
    prev = cur;
  }
  return false;
};

const mouseLongPress = async (page, selector, x, y) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const open = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  return open;
};

const countDrawnGizmoPixels = async (page) => {
  const png = PNG.sync.read(await page.locator('#axesGizmo canvas').screenshot());
  const background = [png.data[0], png.data[1], png.data[2]];
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (Math.abs(png.data[i] - background[0]) > 30
      || Math.abs(png.data[i + 1] - background[1]) > 30
      || Math.abs(png.data[i + 2] - background[2]) > 30) count++;
  }
  return { count, width: png.width, height: png.height };
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // The background dot is off by default everywhere (panelPrefs.backgroundDot);
  // this file exercises its drag/resize/lock, so opt in like a user would.
  await page.evaluate(async () => {
    (await import('./ui/panels/PanelManager.js')).setPanelPref('backgroundDot', true);
    (await import('./ui/BackgroundPicker.js')).setBackgroundDotVisible(true);
  });

  const axesReady = await page.evaluate(() => {
    const gizmo = document.getElementById('axesGizmo');
    if (gizmo) gizmo.style.display = '';
    return !!gizmo && getComputedStyle(gizmo).pointerEvents === 'auto';
  });
  H.check('axes gizmo is interaction-opaque', axesReady);
  H.check('axes and floating strip elements are absent from the DOM', await page.evaluate(() =>
    !document.querySelector('.cv-gizmo-controls')
      && !document.querySelector('.cv-colorbar-floating .cv-colorbar-controls')
      && !document.querySelector('.cv-colorbar-floating .cv-colorbar-menu-btn')));

  const axesPoint = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const axesMenuOpened = await mouseLongPress(page, '#axesGizmo', axesPoint.x, axesPoint.y);
  H.check('long-pressing the axes gizmo opens its menu', axesMenuOpened);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const axesMenuAfterNaturalRelease = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  H.check('the axes menu survives the natural compatibility click after release', axesMenuAfterNaturalRelease);
  const labelsBefore = await page.evaluate(async () => (await import('./state/store.js')).general.gizmoLabelsOnArrows);
  await page.locator('.cv-gizmo-menu-wrap .cv-colorbar-menu-item').first().click();
  const labelsAfter = await page.evaluate(async () => (await import('./state/store.js')).general.gizmoLabelsOnArrows);
  H.check('the axes Integrate Labels item still works after natural release', labelsAfter !== labelsBefore);

  const startupGizmoState = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const axesHandle = document.querySelector('.cv-gizmo-resize-handle');
    const dot = document.getElementById('backgroundDot');
    const dotHandle = dot.querySelector('.background-dot-resize-handle');
    return {
      axesLocked: general.gizmoLocked,
      dotLocked: general.backgroundDotLocked,
      axesHandleDisplay: getComputedStyle(axesHandle).display,
      dotHandleDisplay: getComputedStyle(dotHandle).display,
      axesItemActive: [...document.querySelectorAll('.cv-gizmo-menu-wrap .cv-colorbar-menu-item')]
        .find((item) => item.textContent === 'Unlock')?.classList.contains('cv-colorbar-menu-item-active'),
    };
  });
  H.check('a fresh app starts with both startup gizmos locked',
    startupGizmoState.axesLocked && startupGizmoState.dotLocked
      && startupGizmoState.axesHandleDisplay === 'none'
      && startupGizmoState.dotHandleDisplay === 'none'
      && startupGizmoState.axesItemActive,
    JSON.stringify(startupGizmoState));

  const startupAxesBefore = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  const startupAxesCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.mouse.move(startupAxesBefore.cx, startupAxesBefore.cy);
  await page.mouse.down();
  await page.mouse.move(startupAxesBefore.cx + 110, startupAxesBefore.cy + 45, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const startupAxesAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, camera: app.camera.quaternion.toArray() };
  });
  const startupAxesRotation = startupAxesAfter.camera.reduce((sum, value, i) =>
    sum + Math.abs(value - startupAxesCameraBefore[i]), 0);
  H.check('the startup-locked axes gizmo forwards drag-through rotation',
    startupAxesRotation > 1e-5
      && Math.abs(startupAxesAfter.x - startupAxesBefore.x) < 1
      && Math.abs(startupAxesAfter.y - startupAxesBefore.y) < 1,
    JSON.stringify({ rotationDelta: startupAxesRotation, before: startupAxesBefore, after: startupAxesAfter }));

  const startupDotBefore = await page.evaluate(() => {
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left, y: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  await page.mouse.click(startupDotBefore.cx, startupDotBefore.cy);
  await page.waitForTimeout(100);
  const startupDotPickerOpened = await page.evaluate(() => !!document.querySelector('.cv-background-picker-panel'));
  await page.mouse.click(startupDotBefore.cx, startupDotBefore.cy);
  await page.waitForTimeout(100);
  H.check('the startup-locked dot still opens its picker on click', startupDotPickerOpened);
  const startupDotCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.mouse.move(startupDotBefore.cx, startupDotBefore.cy);
  await page.mouse.down();
  await page.mouse.move(startupDotBefore.cx + 110, startupDotBefore.cy + 45, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const startupDotAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left, y: r.top, camera: app.camera.quaternion.toArray(), picker: !!document.querySelector('.cv-background-picker-panel') };
  });
  const startupDotRotation = startupDotAfter.camera.reduce((sum, value, i) =>
    sum + Math.abs(value - startupDotCameraBefore[i]), 0);
  H.check('the startup-locked dot does not move on drag',
    Math.abs(startupDotAfter.x - startupDotBefore.x) < 1
      && Math.abs(startupDotAfter.y - startupDotBefore.y) < 1
      && !startupDotAfter.picker,
    JSON.stringify({ rotationDelta: startupDotRotation, before: startupDotBefore, after: startupDotAfter }));

  await mouseLongPress(page, '#axesGizmo', startupAxesBefore.cx, startupAxesBefore.cy);
  await page.mouse.up();
  await page.locator('.cv-gizmo-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).click();
  await mouseLongPress(page, '#backgroundDot', startupDotBefore.cx, startupDotBefore.cy);
  await page.mouse.up();
  await page.locator('.background-dot-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).click();
  H.check('startup gizmos can be explicitly unlocked through their menus',
    await page.evaluate(async () => {
      const { general } = await import('./state/store.js');
      return !general.gizmoLocked && !general.backgroundDotLocked;
    }));

  const readGizmoLabels = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      camera: app.gizmoCamera.isOrthographicCamera ? 'orthographic' : 'perspective',
      labels: ['aLabel', 'bLabel', 'cLabel'].map((key) => {
        const label = app.gizmoScene.userData[key];
        return {
          attenuation: label.material.sizeAttenuation,
          scale: [label.scale.x, label.scale.y, label.scale.z],
        };
      }),
    };
  });
  const readLabelPixels = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const arrows = ['aArrow', 'bArrow', 'cArrow'].map((key) => app.gizmoScene.userData[key]);
    const labels = ['aLabel', 'bLabel', 'cLabel'].map((key) => app.gizmoScene.userData[key]);
    const saved = arrows.map((arrow, i) => arrow.children.map((child) => ({ child, visible: child.visible, arrow: arrow.visible, label: labels[i].visible })));
    arrows.forEach((arrow, i) => {
      arrow.visible = true;
      arrow.children.forEach((child) => { child.visible = child === labels[i]; });
      labels[i].visible = true;
    });
    app.gizmoRenderer.render(app.gizmoScene, app.gizmoCamera);
    const canvas = app.gizmoRenderer.domElement;
    const gl = app.gizmoRenderer.getContext();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && (pixels[i] > 0 || pixels[i + 1] > 0 || pixels[i + 2] > 0)) count++;
    }
    saved.forEach((children, i) => {
      arrows[i].visible = children[0]?.arrow ?? true;
      children.forEach(({ child, visible }) => { child.visible = visible; });
      labels[i].visible = children[0]?.label ?? labels[i].visible;
    });
    return count;
  });
  const labelsOrtho = await readGizmoLabels();
  H.check('axes gizmo starts in the main camera projection mode', labelsOrtho.camera === 'orthographic', labelsOrtho.camera);
  H.check('orthographic gizmo labels are non-attenuated and equal-sized',
    labelsOrtho.labels.every((label) => label.attenuation === false)
      && labelsOrtho.labels.every((label) => label.scale.every((value, i) => Math.abs(value - labelsOrtho.labels[0].scale[i]) < 1e-8)),
    JSON.stringify(labelsOrtho));
  await page.evaluate(() => {
    const checkbox = document.getElementById('orthographicCamera');
    if (checkbox.checked) checkbox.click();
  });
  await page.waitForTimeout(100);
  const labelsPerspective = await readGizmoLabels();
  H.check('the real camera toggle switches the gizmo to perspective', labelsPerspective.camera === 'perspective', labelsPerspective.camera);
  H.check('perspective gizmo labels are non-attenuated and equal-sized',
    labelsPerspective.labels.every((label) => label.attenuation === false)
      && labelsPerspective.labels.every((label) => label.scale.every((value, i) => Math.abs(value - labelsPerspective.labels[0].scale[i]) < 1e-8)),
    JSON.stringify(labelsPerspective));
  await page.evaluate(() => {
    const checkbox = document.getElementById('orthographicCamera');
    if (!checkbox.checked) checkbox.click();
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const axesTouchOpened = await syntheticLongPress(page, '#axesGizmo', 'touch', 702, axesPoint.x, axesPoint.y);
  H.check('touch long-pressing the axes gizmo opens its menu', axesTouchOpened);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  const axesBeforeDrag = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.mouse.move(axesBeforeDrag.x + 25, axesBeforeDrag.y + 25);
  await page.mouse.down();
  await page.mouse.move(axesBeforeDrag.x + 95, axesBeforeDrag.y + 65, { steps: 3 });
  await page.mouse.up();
  const axesAfterDrag = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, menu: !!document.querySelector('.cv-colorbar-menu-open') };
  });
  H.check('moving before 500ms drags the axes gizmo without opening its menu',
    (Math.abs(axesAfterDrag.x - axesBeforeDrag.x) > 20
      || Math.abs(axesAfterDrag.y - axesBeforeDrag.y) > 10) && !axesAfterDrag.menu,
    JSON.stringify({ before: axesBeforeDrag, after: axesAfterDrag }));

  // The default gizmo is parked at the bottom edge, where the scene clamp
  // leaves only a few pixels for growth. Move it upward before testing the
  // corner hit zone so the resize assertion measures the handle, not the
  // viewport cap.
  const axesLift = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(axesLift.x, axesLift.y);
  await page.mouse.down();
  await page.mouse.move(axesLift.x, axesLift.y - 140, { steps: 6 });
  await page.mouse.up();

  const axesSizeBefore = await page.evaluate(() => {
    const r = document.querySelector('.cv-gizmo-resize-handle').getBoundingClientRect();
    const box = document.getElementById('axesGizmo').getBoundingClientRect();
    return { size: box.width, x: r.right - 20, y: r.bottom - 20 };
  });
  const labelPixelsBefore = await readLabelPixels();
  await page.mouse.move(axesSizeBefore.x, axesSizeBefore.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const axesResizeMenu = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  await page.mouse.move(axesSizeBefore.x + 30, axesSizeBefore.y + 30, { steps: 3 });
  await page.waitForTimeout(50);
  const midResizePixels = await countDrawnGizmoPixels(page);
  await page.mouse.up();
  const axesSizeAfter = await page.evaluate(async () => ({
    size: document.getElementById('axesGizmo').getBoundingClientRect().width,
    labelScale: (await import('./state/store.js')).app.gizmoScene.userData.aLabel.scale.x,
  }));
  const labelPixelsAfter = await readLabelPixels();
  H.check('holding the axes resize corner does not open the menu', !axesResizeMenu);
  H.check('the axes resize redraws the gizmo before pointerup', midResizePixels.count > 100,
    JSON.stringify(midResizePixels));
  H.check('the axes 24px corner hit area resizes outside the old 14px mark', axesSizeAfter.size > axesSizeBefore.size + 10,
    JSON.stringify({ before: axesSizeBefore.size, after: axesSizeAfter.size }));
  H.check('integrated labels grow on screen with the gizmo box', labelPixelsAfter > labelPixelsBefore,
    JSON.stringify({ before: labelPixelsBefore, after: labelPixelsAfter, scale: axesSizeAfter.labelScale }));

  await page.mouse.move(axesSizeBefore.x, axesSizeBefore.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const menuOpenDuringHeldDrag = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  const heldDragBefore = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.mouse.move(axesSizeBefore.x + 80, axesSizeBefore.y + 45, { steps: 4 });
  const heldDragAfter = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, menu: !!document.querySelector('.cv-colorbar-menu-open') };
  });
  await page.evaluate(() => {
    const canvas = document.querySelector('#axesGizmo canvas');
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  const menuAfterGhostClick = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  await page.mouse.up();
  H.check('moving after an axes long-press does not drag with the menu open',
    menuOpenDuringHeldDrag && heldDragAfter.menu
      && Math.abs(heldDragAfter.x - heldDragBefore.x) < 1
      && Math.abs(heldDragAfter.y - heldDragBefore.y) < 1,
    JSON.stringify({ before: heldDragBefore, after: heldDragAfter }));
  H.check('a compatibility click after an axes long-press is suppressed', menuAfterGhostClick);

  const cameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  const axesCameraPoint = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(axesCameraPoint.x, axesCameraPoint.y);
  await page.mouse.down();
  await page.mouse.move(axesCameraPoint.x + 80, axesCameraPoint.y + 35, { steps: 8 });
  await page.mouse.up();
  const cameraAfter = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  H.check('dragging across the axes gizmo does not rotate the camera',
    cameraBefore.every((v, i) => Math.abs(v - cameraAfter[i]) < 1e-8), JSON.stringify({ cameraBefore, cameraAfter }));

  // ---- locked axes pass-through -------------------------------------------
  const axesLockPoint = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await mouseLongPress(page, '#axesGizmo', axesLockPoint.x, axesLockPoint.y);
  await page.mouse.up();
  await page.locator('.cv-gizmo-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Lock$/ }).click();
  const axesLockedMenu = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const item = [...document.querySelectorAll('.cv-gizmo-menu-wrap .cv-colorbar-menu-item')]
      .find((button) => button.textContent === 'Unlock');
    return { locked: general.gizmoLocked, active: item?.classList.contains('cv-colorbar-menu-item-active'), pos: document.getElementById('axesGizmo').getBoundingClientRect().toJSON(), camera: app.camera.quaternion.toArray() };
  });
  H.check('locking the axes menu item marks it active and persists in general',
    axesLockedMenu.locked && axesLockedMenu.active, JSON.stringify(axesLockedMenu));

  const lockedAxesHeldMenu = await mouseLongPress(page, '#axesGizmo', axesLockPoint.x, axesLockPoint.y);
  const lockedAxesHeldCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.mouse.move(axesLockPoint.x + 60, axesLockPoint.y + 35, { steps: 4 });
  const lockedAxesHeldAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      camera: app.camera.quaternion.toArray(),
      menu: !!document.querySelector('.cv-gizmo-menu-wrap .cv-colorbar-menu-open'),
    };
  });
  const lockedHeldRotationDelta = lockedAxesHeldAfter.camera.reduce((sum, value, i) =>
    sum + Math.abs(value - lockedAxesHeldCameraBefore[i]), 0);
  H.check('a locked axes long-press consumes later movement while keeping its menu open',
    lockedAxesHeldMenu && lockedAxesHeldAfter.menu && lockedHeldRotationDelta < 1e-8,
    JSON.stringify({ rotationDelta: lockedHeldRotationDelta, after: lockedAxesHeldAfter }));
  await page.mouse.up();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  const axesLockedBefore = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, size: r.width, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  await page.evaluate(async () => {
    const canvas = document.querySelector('#view canvas');
    window.__forwardCaptureCalls = 0;
    window.__originalCanvasCapture = canvas.setPointerCapture;
    canvas.setPointerCapture = (...args) => {
      window.__forwardCaptureCalls++;
      return window.__originalCanvasCapture.apply(canvas, args);
    };
  });
  const axesLockedCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.mouse.move(axesLockedBefore.cx, axesLockedBefore.cy);
  await page.mouse.down();
  await page.mouse.move(axesLockedBefore.cx + 25, axesLockedBefore.cy + 10);
  await page.mouse.move(axesLockedBefore.cx + 220, axesLockedBefore.cy + 80);
  const axesLockedMid = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { pointers: app.controls._pointers.length, state: app.controls.state,
      movePrev: app.controls._movePrev.toArray(), moveCurr: app.controls._moveCurr.toArray() };
  });
  await page.mouse.up();
  const axesCameraAtRelease = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.waitForTimeout(120);
  const axesCameraAfterCoast = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.waitForTimeout(100);
  const axesLockedAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, size: r.width, camera: app.camera.quaternion.toArray(),
      controls: { pointers: app.controls._pointers.length, state: app.controls.state,
        pointerPositions: Object.keys(app.controls._pointerPositions) },
      canvasCaptureCalls: window.__forwardCaptureCalls };
  });
  axesLockedAfter.mid = axesLockedMid;
  await page.evaluate(() => {
    const canvas = document.querySelector('#view canvas');
    canvas.setPointerCapture = window.__originalCanvasCapture;
  });
  const axesRotationDelta = axesLockedAfter.camera.reduce((sum, value, i) => sum + Math.abs(value - axesLockedCameraBefore[i]), 0);
  H.check('a locked axes drag rotates the camera but does not move the gizmo',
    axesRotationDelta > 1e-5
      && Math.abs(axesLockedAfter.x - axesLockedBefore.x) < 1
      && Math.abs(axesLockedAfter.y - axesLockedBefore.y) < 1,
    JSON.stringify({ rotationDelta: axesRotationDelta, before: axesLockedBefore, after: axesLockedAfter }));
  const axesCoastDelta = axesCameraAfterCoast.reduce((sum, value, i) =>
    sum + Math.abs(value - axesCameraAtRelease[i]), 0);
  H.check('an ordinary forwarded release preserves camera rotation inertia', axesCoastDelta > 1e-6,
    JSON.stringify({ coastDelta: axesCoastDelta, release: axesCameraAtRelease, after: axesCameraAfterCoast }));

  await page.mouse.move(axesLockedBefore.cx, axesLockedBefore.cy);
  await page.mouse.down();
  await page.mouse.move(axesLockedBefore.cx + 35, axesLockedBefore.cy + 15, { steps: 2 });
  const forwardedBeforeUnlock = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.quaternion.toArray();
  });
  await page.evaluate(async () => { (await import('./state/store.js')).general.gizmoLocked = false; });
  await page.mouse.move(axesLockedBefore.cx + 100, axesLockedBefore.cy + 60, { steps: 3 });
  await page.mouse.up();
  const forwardedAfterUnlock = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.waitForTimeout(150);
  const forcedAbortAfterCoast = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  const forwardedAbortDelta = forwardedAfterUnlock.reduce((sum, value, i) => sum + Math.abs(value - forwardedBeforeUnlock[i]), 0);
  const forcedAbortCoastDelta = forcedAbortAfterCoast.reduce((sum, value, i) => sum + Math.abs(value - forwardedAfterUnlock[i]), 0);
  H.check('unlocking mid-forwarded axes drag aborts that sequence', forwardedAbortDelta < 1e-8,
    JSON.stringify({ rotationDeltaAfterUnlock: forwardedAbortDelta }));
  H.check('a forced forwarded abort does not coast', forcedAbortCoastDelta < 1e-8,
    JSON.stringify({ coastDelta: forcedAbortCoastDelta }));
  await page.evaluate(async () => { (await import('./state/store.js')).general.gizmoLocked = true; });
  H.check('forwarding does not capture the renderer canvas and cleans Trackball state',
    axesLockedAfter.canvasCaptureCalls === 0
      && axesLockedAfter.controls.pointers === 0
      && axesLockedAfter.controls.pointerPositions.length === 0,
    JSON.stringify(axesLockedAfter));
  const freshTouchMove = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    try {
      app.renderer.domElement.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 991, pointerType: 'touch', clientX: 40, clientY: 40,
      }));
      return { pointers: app.controls._pointers.length, pointerPositions: Object.keys(app.controls._pointerPositions) };
    } catch (error) {
      return { error: String(error) };
    }
  });
  H.check('a fresh touch move after forwarding has no stale Trackball sequence',
    !freshTouchMove.error && freshTouchMove.pointers === 0 && freshTouchMove.pointerPositions.length === 0,
    JSON.stringify(freshTouchMove));

  await page.mouse.move(axesLockedBefore.x + axesLockedBefore.size - 8, axesLockedBefore.y + axesLockedBefore.size - 8);
  await page.mouse.down();
  await page.mouse.move(axesLockedBefore.x + axesLockedBefore.size + 30, axesLockedBefore.y + axesLockedBefore.size + 30, { steps: 3 });
  await page.mouse.up();
  const axesLockedResize = await page.evaluate(() => document.getElementById('axesGizmo').getBoundingClientRect().width);
  H.check('a locked axes resize corner is inert', Math.abs(axesLockedResize - axesLockedBefore.size) < 1,
    JSON.stringify({ before: axesLockedBefore.size, after: axesLockedResize }));

  const touchAxesCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.evaluate(({ x, y }) => {
    const gizmo = document.getElementById('axesGizmo');
    gizmo.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 811, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: 1, clientX: x, clientY: y, screenX: x, screenY: y, pressure: 0.5,
    }));
    gizmo.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 811, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: 1, clientX: x + 100, clientY: y + 35, screenX: x + 100, screenY: y + 35, pressure: 0.5,
    }));
    gizmo.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 811, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: 0, clientX: x + 100, clientY: y + 35, screenX: x + 100, screenY: y + 35,
    }));
  }, axesLockPoint);
  await page.waitForTimeout(100);
  const touchAxesCameraAfter = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  const touchAxesRotationDelta = touchAxesCameraAfter.reduce((sum, value, i) => sum + Math.abs(value - touchAxesCameraBefore[i]), 0);
  H.check('a synthetic touch drag over a locked axes gizmo reaches the camera', touchAxesRotationDelta > 1e-5,
    JSON.stringify({ rotationDelta: touchAxesRotationDelta }));

  await mouseLongPress(page, '#axesGizmo', axesLockPoint.x, axesLockPoint.y);
  await page.mouse.up();
  H.check('a locked axes gizmo still opens its Unlock menu item', await page.locator('.cv-gizmo-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).count() > 0);
  await page.locator('.cv-gizmo-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).click();
  // The preceding locked touch pass-through is an ordinary release and now
  // deliberately retains Trackball inertia; let that coast settle before
  // measuring the unlocked widget drag.
  await waitForCameraSettled(page);
  const axesUnlockedBefore = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { locked: general.gizmoLocked, x: r.left, y: r.top, camera: app.camera.quaternion.toArray() };
  });
  await page.mouse.move(axesUnlockedBefore.x + 25, axesUnlockedBefore.y + 25);
  await page.mouse.down();
  await page.mouse.move(axesUnlockedBefore.x + 100, axesUnlockedBefore.y + 70, { steps: 5 });
  await page.mouse.up();
  const axesUnlockedAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top, camera: app.camera.quaternion.toArray() };
  });
  const axesUnlockRotationDelta = axesUnlockedAfter.camera.reduce((sum, value, i) => sum + Math.abs(value - axesUnlockedBefore.camera[i]), 0);
  H.check('unlocking restores axes dragging without camera rotation',
    !axesUnlockedBefore.locked
      && (Math.abs(axesUnlockedAfter.x - axesUnlockedBefore.x) > 20 || Math.abs(axesUnlockedAfter.y - axesUnlockedBefore.y) > 10)
      && axesUnlockRotationDelta < 1e-8,
    JSON.stringify({ rotationDelta: axesUnlockRotationDelta, before: axesUnlockedBefore, after: axesUnlockedAfter }));

  await page.mouse.move(axesUnlockedAfter.x + 30, axesUnlockedAfter.y + 30);
  await page.mouse.down();
  await page.mouse.move(axesUnlockedAfter.x + 60, axesUnlockedAfter.y + 55, { steps: 2 });
  const unlockedBeforeLock = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.evaluate(async () => { (await import('./state/store.js')).general.gizmoLocked = true; });
  await page.mouse.move(axesUnlockedAfter.x + 150, axesUnlockedAfter.y + 100, { steps: 3 });
  await page.mouse.up();
  const unlockedAfterLock = await page.evaluate(() => {
    const r = document.getElementById('axesGizmo').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  H.check('locking mid-move aborts an axes drag',
    Math.abs(unlockedAfterLock.x - unlockedBeforeLock.x) < 1
      && Math.abs(unlockedAfterLock.y - unlockedBeforeLock.y) < 1,
    JSON.stringify({ before: unlockedBeforeLock, after: unlockedAfterLock }));
  await page.evaluate(async () => { (await import('./state/store.js')).general.gizmoLocked = false; });

  await page.evaluate(async () => {
    const { createColorBar } = await import('./ui/ColorBarWidget.js');
    const { registerColorBarSource } = await import('./ui/ColorBarRegistry.js');
    const { general } = await import('./state/store.js');
    const host = document.createElement('div');
    host.id = 'gizmoui-colorbar-host';
    document.body.appendChild(host);
    const bar = createColorBar(host, 'viridis', 0, 1, {
      floatingId: 'gizmoui-colorbar', legend: 'Test', size: 300,
      isLocked: () => general.forceColorBarLocked,
      onLockChange: (locked) => { general.forceColorBarLocked = locked; },
    });
    const view = document.getElementById('view').getBoundingClientRect();
    bar.floatAt(view.left + 420, view.top + 220);
    window.__gizmouiColorBar = bar;
    registerColorBarSource('gizmoui', 'Gizmo UI test', () => window.__gizmouiColorBar);
  });
  await page.waitForTimeout(250);
  const barSelector = '#gizmoui-colorbar';
  H.check('floating color bar has no controls strip', await page.evaluate(() => {
    const bar = document.querySelector('#gizmoui-colorbar');
    return !!bar && !bar.querySelector('.cv-colorbar-controls') && !bar.querySelector('.cv-colorbar-menu-btn');
  }));
  const barPoint = await page.evaluate(() => {
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  H.check('long-pressing a floating color bar opens its menu',
    await mouseLongPress(page, barSelector, barPoint.x, barPoint.y));
  await page.locator('#gizmoui-colorbar .cv-colorbar-menu-item').filter({ hasText: /^Lock$/ }).click();
  await page.mouse.up();
  const barLockedState = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const item = [...document.querySelectorAll('#gizmoui-colorbar .cv-colorbar-menu-item')]
      .find((button) => button.textContent === 'Unlock');
    return { locked: general.forceColorBarLocked, active: item?.classList.contains('cv-colorbar-menu-item-active') };
  });
  H.check('locking a floating color bar marks its Lock item active and persists',
    barLockedState.locked && barLockedState.active, JSON.stringify(barLockedState));

  const barLockedBefore = await page.evaluate(() => {
    const bar = document.querySelector('#gizmoui-colorbar');
    const r = bar.getBoundingClientRect();
    return { x: r.left, y: r.top, width: document.querySelector('#gizmoui-colorbar .cv-colorbar-bar-handle').getBoundingClientRect().width, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  const barLockedCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  const minInput = page.locator('#gizmoui-colorbar .cv-colorbar-value-input').first();
  await minInput.fill('0.25');
  await minInput.press('Enter');
  H.check('a locked color bar still accepts Min/Max input', await minInput.inputValue() === '0.25');
  await page.mouse.move(barLockedBefore.cx, barLockedBefore.cy);
  await page.mouse.down();
  await page.mouse.move(barLockedBefore.cx + 120, barLockedBefore.cy + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const barLockedAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const bar = document.querySelector('#gizmoui-colorbar');
    const r = bar.getBoundingClientRect();
    return { x: r.left, y: r.top, width: document.querySelector('#gizmoui-colorbar .cv-colorbar-bar-handle').getBoundingClientRect().width, camera: app.camera.quaternion.toArray() };
  });
  const barRotationDelta = barLockedAfter.camera.reduce((sum, value, i) => sum + Math.abs(value - barLockedCameraBefore[i]), 0);
  H.check('a locked color bar drag rotates through to the camera without moving the bar',
    barRotationDelta > 1e-5
      && Math.abs(barLockedAfter.x - barLockedBefore.x) < 1
      && Math.abs(barLockedAfter.y - barLockedBefore.y) < 1,
    JSON.stringify({ rotationDelta: barRotationDelta, before: barLockedBefore, after: barLockedAfter }));

  await mouseLongPress(page, barSelector, barLockedBefore.cx, barLockedBefore.cy);
  await page.mouse.up();
  H.check('a locked color bar still opens Unlock', await page.locator('#gizmoui-colorbar .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).count() > 0);
  await page.locator('#gizmoui-colorbar .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).click();
  await waitForCameraSettled(page);
  const barUnlockedBefore = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { locked: general.forceColorBarLocked, x: r.left, y: r.top, camera: app.camera.quaternion.toArray() };
  });
  await page.mouse.move(barUnlockedBefore.x + 35, barUnlockedBefore.y + 35);
  await page.mouse.down();
  await page.mouse.move(barUnlockedBefore.x + 120, barUnlockedBefore.y + 85, { steps: 6 });
  await page.mouse.up();
  const barUnlockedAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { x: r.left, y: r.top, camera: app.camera.quaternion.toArray() };
  });
  const barUnlockRotationDelta = barUnlockedAfter.camera.reduce((sum, value, i) => sum + Math.abs(value - barUnlockedBefore.camera[i]), 0);
  H.check('unlocking restores color-bar dragging without camera rotation',
    !barUnlockedBefore.locked
      && (Math.abs(barUnlockedAfter.x - barUnlockedBefore.x) > 20 || Math.abs(barUnlockedAfter.y - barUnlockedBefore.y) > 20)
      && barUnlockRotationDelta < 1e-8,
    JSON.stringify({ rotationDelta: barUnlockRotationDelta, before: barUnlockedBefore, after: barUnlockedAfter }));

  const barDockPoint = await page.evaluate(() => {
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(barDockPoint.x, barDockPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.locator('#gizmoui-colorbar .cv-colorbar-menu-item').filter({ hasText: /^Dock$/ }).click();
  await page.mouse.up();
  H.check('the floating color bar Dock item still docks it', await page.evaluate(() =>
    !document.querySelector('#gizmoui-colorbar')?.classList.contains('cv-colorbar-floating')));
  await page.evaluate(() => {
    const view = document.getElementById('view').getBoundingClientRect();
    window.__gizmouiColorBar.floatAt(view.left + 420, view.top + 220);
  });
  await page.waitForTimeout(200);
  const touchPoint = await page.evaluate(() => {
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  H.check('touch long-pressing a floating color bar opens its menu',
    await syntheticLongPress(page, barSelector, 'touch', 705, touchPoint.x, touchPoint.y));
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  const barBeforeDrag = await page.evaluate(() => {
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.mouse.move(touchPoint.x, touchPoint.y);
  await page.mouse.down();
  await page.mouse.move(touchPoint.x + 70, touchPoint.y + 45, { steps: 5 });
  await page.mouse.up();
  const barAfterDrag = await page.evaluate(() => {
    const r = document.querySelector('#gizmoui-colorbar').getBoundingClientRect();
    return { x: r.left, y: r.top, menu: !!document.querySelector('.cv-colorbar-menu-open') };
  });
  H.check('moving before 500ms drags the floating bar without opening its menu',
    Math.abs(barAfterDrag.x - barBeforeDrag.x) > 20 && Math.abs(barAfterDrag.y - barBeforeDrag.y) > 20
      && !barAfterDrag.menu, JSON.stringify({ before: barBeforeDrag, after: barAfterDrag }));

  const barSizeBefore = await page.evaluate(() => {
    const h = document.querySelector('#gizmoui-colorbar .cv-colorbar-resize-handle').getBoundingClientRect();
    const b = document.querySelector('#gizmoui-colorbar .cv-colorbar-bar-handle').getBoundingClientRect();
    return { width: b.width, x: h.right - 10, y: h.bottom - 10,
      handle: { left: h.left, top: h.top, right: h.right, bottom: h.bottom },
      hit: document.elementFromPoint(h.right - 10, h.bottom - 10)?.className || '' };
  });
  await page.mouse.move(barSizeBefore.x, barSizeBefore.y);
  await page.mouse.down();
  await page.mouse.move(barSizeBefore.x + 40, barSizeBefore.y, { steps: 4 });
  await page.mouse.up();
  const barSizeAfter = await page.evaluate(() => document.querySelector('#gizmoui-colorbar .cv-colorbar-bar-handle').getBoundingClientRect().width);
  H.check('the floating color bar corner resizes functionally',
    barSizeAfter > barSizeBefore.width + 10, JSON.stringify({ before: barSizeBefore, after: barSizeAfter }));

  // ---- background dot gizmo -----------------------------------------------
  const backgroundDefault = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot');
    const rect = dot.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  });
  await page.mouse.click(backgroundDefault.x, backgroundDefault.y);
  await page.waitForTimeout(150);
  const backgroundPickerOpen = await page.evaluate(() => !!document.querySelector('.cv-background-picker-panel'));
  H.check('clicking the background dot opens its picker', backgroundPickerOpen);
  await page.mouse.click(backgroundDefault.x, backgroundDefault.y);
  await page.waitForTimeout(150);
  H.check('clicking the background dot a second time closes its picker',
    await page.evaluate(() => !document.querySelector('.cv-background-picker-panel')));

  const backgroundBeforeDrag = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot');
    const view = document.getElementById('view').getBoundingClientRect();
    const rect = dot.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      view: { left: view.left, right: view.right, top: view.top, bottom: view.bottom },
    };
  });
  await page.mouse.move(backgroundBeforeDrag.x, backgroundBeforeDrag.y);
  await page.mouse.down();
  await page.mouse.move(backgroundBeforeDrag.x - 90, backgroundBeforeDrag.y + 45, { steps: 5 });
  await page.mouse.up();
  const backgroundAfterDrag = await page.evaluate(async () => {
    const dot = document.getElementById('backgroundDot');
    const view = document.getElementById('view').getBoundingClientRect();
    const rect = dot.getBoundingClientRect();
    return {
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      view: { left: view.left, right: view.right, top: view.top, bottom: view.bottom },
      picker: !!document.querySelector('.cv-background-picker-panel'),
      pos: (await import('./state/store.js')).general.backgroundDotPos,
    };
  });
  H.check('dragging the background dot moves it without opening the picker',
    Math.abs(backgroundAfterDrag.rect.left - backgroundBeforeDrag.rect.left) > 20
      && Math.abs(backgroundAfterDrag.rect.top - backgroundBeforeDrag.rect.top) > 20
      && !backgroundAfterDrag.picker
      && !!backgroundAfterDrag.pos, JSON.stringify({ before: backgroundBeforeDrag.rect, after: backgroundAfterDrag.rect }));

  const gap = (info, edge) => edge === 'left'
    ? info.rect.left - info.view.left
    : edge === 'right'
      ? info.view.right - info.rect.right
      : edge === 'top'
        ? info.rect.top - info.view.top
        : info.view.bottom - info.rect.bottom;
  const horizontalEdge = backgroundBeforeDrag.rect.left - backgroundBeforeDrag.view.left
    <= backgroundBeforeDrag.view.right - backgroundBeforeDrag.rect.right ? 'left' : 'right';
  const verticalEdge = backgroundBeforeDrag.rect.top - backgroundBeforeDrag.view.top
    <= backgroundBeforeDrag.view.bottom - backgroundBeforeDrag.rect.bottom ? 'top' : 'bottom';
  const backgroundGapBeforeResize = { horizontal: gap(backgroundAfterDrag, horizontalEdge), vertical: gap(backgroundAfterDrag, verticalEdge) };
  await page.setViewportSize({ width: 1300, height: 850 });
  await page.waitForTimeout(500);
  const backgroundAfterViewportResize = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot');
    const view = document.getElementById('view').getBoundingClientRect();
    const rect = dot.getBoundingClientRect();
    return { rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, view: { left: view.left, right: view.right, top: view.top, bottom: view.bottom } };
  });
  H.check('the background dot preserves its edge anchor across #view resize',
    Math.abs(gap(backgroundAfterViewportResize, horizontalEdge) - backgroundGapBeforeResize.horizontal) < 3
      && Math.abs(gap(backgroundAfterViewportResize, verticalEdge) - backgroundGapBeforeResize.vertical) < 3,
    JSON.stringify({ before: backgroundGapBeforeResize, after: { horizontal: gap(backgroundAfterViewportResize, horizontalEdge), vertical: gap(backgroundAfterViewportResize, verticalEdge) } }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(500);

  const backgroundLongPressPoint = await page.evaluate(() => {
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(backgroundLongPressPoint.x, backgroundLongPressPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const backgroundMenuOpened = await page.evaluate(() => !!document.querySelector('.background-dot-menu-wrap .cv-colorbar-menu-open'));
  await page.mouse.up();
  await page.waitForTimeout(50);
  const backgroundAfterLongRelease = await page.evaluate(() => ({
    menu: !!document.querySelector('.background-dot-menu-wrap .cv-colorbar-menu-open'),
    picker: !!document.querySelector('.cv-background-picker-panel'),
  }));
  H.check('mouse long-press opens the background-dot menu and suppresses the picker click',
    backgroundMenuOpened && backgroundAfterLongRelease.menu && !backgroundAfterLongRelease.picker,
    JSON.stringify(backgroundAfterLongRelease));
  await page.locator('.background-dot-menu-wrap .cv-colorbar-menu-item', { hasText: 'Reset Layout' }).click();
  const backgroundAfterReset = await page.evaluate(async () => {
    const dot = document.getElementById('backgroundDot');
    const { general } = await import('./state/store.js');
    return { width: dot.getBoundingClientRect().width, pos: general.backgroundDotPos, size: general.backgroundDotSize, left: dot.style.left, right: dot.style.right };
  });
  H.check('Reset Layout restores the background dot default position and size',
    backgroundAfterReset.width === backgroundDefault.width
      && backgroundAfterReset.pos === null
      && backgroundAfterReset.size === null
      && backgroundAfterReset.left === ''
      && backgroundAfterReset.right === '', JSON.stringify(backgroundAfterReset));

  const backgroundLockPoint = await page.evaluate(() => {
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(backgroundLockPoint.x, backgroundLockPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await page.locator('.background-dot-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Lock$/ }).click();
  const backgroundLockedState = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const item = [...document.querySelectorAll('.background-dot-menu-wrap .cv-colorbar-menu-item')]
      .find((button) => button.textContent === 'Unlock');
    return { locked: general.backgroundDotLocked, active: item?.classList.contains('cv-colorbar-menu-item-active') };
  });
  H.check('locking the background dot marks its Lock item active and persists',
    backgroundLockedState.locked && backgroundLockedState.active, JSON.stringify(backgroundLockedState));
  await page.mouse.click(backgroundLockPoint.x, backgroundLockPoint.y);
  await page.waitForTimeout(120);
  H.check('a locked background dot still opens its picker', await page.evaluate(() => !!document.querySelector('.cv-background-picker-panel')));
  await page.mouse.click(backgroundLockPoint.x, backgroundLockPoint.y);
  await page.waitForTimeout(120);
  H.check('a locked background dot still toggles its picker closed', await page.evaluate(() => !document.querySelector('.cv-background-picker-panel')));

  const backgroundLockedBefore = await page.evaluate(() => {
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left, y: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2, pos: document.getElementById('backgroundDot').style.cssText };
  });
  const backgroundLockedCameraBefore = await page.evaluate(async () => (await import('./state/store.js')).app.camera.quaternion.toArray());
  await page.mouse.move(backgroundLockedBefore.cx, backgroundLockedBefore.cy);
  await page.mouse.down();
  await page.mouse.move(backgroundLockedBefore.cx + 120, backgroundLockedBefore.cy + 45, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const backgroundLockedAfter = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left, y: r.top, camera: app.camera.quaternion.toArray() };
  });
  const backgroundRotationDelta = backgroundLockedAfter.camera.reduce((sum, value, i) => sum + Math.abs(value - backgroundLockedCameraBefore[i]), 0);
  H.check('a locked background-dot drag rotates the camera without moving the dot',
    backgroundRotationDelta > 1e-5
      && Math.abs(backgroundLockedAfter.x - backgroundLockedBefore.x) < 1
      && Math.abs(backgroundLockedAfter.y - backgroundLockedBefore.y) < 1,
    JSON.stringify({ rotationDelta: backgroundRotationDelta, before: backgroundLockedBefore, after: backgroundLockedAfter }));

  await page.mouse.move(backgroundLockedBefore.cx, backgroundLockedBefore.cy);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await page.locator('.background-dot-menu-wrap .cv-colorbar-menu-item').filter({ hasText: /^Unlock$/ }).click();
  H.check('unlocking the background dot updates its persisted state',
    await page.evaluate(async () => !(await import('./state/store.js')).general.backgroundDotLocked));

  const backgroundTouchPoint = await page.evaluate(() => {
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const backgroundTouch = await page.evaluate(({ x, y }) => new Promise((resolve) => {
    const dot = document.getElementById('backgroundDot');
    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 901, pointerType: 'touch', button: 0, buttons: 1, clientX: x, clientY: y }));
    setTimeout(() => {
      const open = !!document.querySelector('.background-dot-menu-wrap .cv-colorbar-menu-open');
      dot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 901, pointerType: 'touch', button: 0, clientX: x, clientY: y }));
      dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      resolve({ open, menu: !!document.querySelector('.background-dot-menu-wrap .cv-colorbar-menu-open'), picker: !!document.querySelector('.cv-background-picker-panel') });
    }, 650);
  }), backgroundTouchPoint);
  H.check('touch long-press opens the background-dot menu without opening the picker',
    backgroundTouch.open && backgroundTouch.menu && !backgroundTouch.picker, JSON.stringify(backgroundTouch));
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  const backgroundResizeBefore = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot');
    const handle = dot.querySelector('.background-dot-resize-handle').getBoundingClientRect();
    return { width: dot.getBoundingClientRect().width, x: handle.right - 20, y: handle.bottom - 20 };
  });
  await page.mouse.move(backgroundResizeBefore.x, backgroundResizeBefore.y);
  await page.mouse.down();
  await page.mouse.move(backgroundResizeBefore.x + 35, backgroundResizeBefore.y + 35, { steps: 3 });
  await page.mouse.up();
  const backgroundResizeAfter = await page.evaluate(async () => {
    const dot = document.getElementById('backgroundDot');
    return { width: dot.getBoundingClientRect().width, size: (await import('./state/store.js')).general.backgroundDotSize };
  });
  H.check('dragging the background dot corner resizes it',
    backgroundResizeAfter.width > backgroundResizeBefore.width + 20
      && backgroundResizeAfter.size === backgroundResizeAfter.width,
    JSON.stringify({ before: backgroundResizeBefore.width, after: backgroundResizeAfter }));

  const backgroundMaxReposition = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot');
    const view = document.getElementById('view').getBoundingClientRect();
    const r = dot.getBoundingClientRect();
    return { from: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      to: { x: view.left + 120, y: view.top + 120 } };
  });
  await page.mouse.move(backgroundMaxReposition.from.x, backgroundMaxReposition.from.y);
  await page.mouse.down();
  await page.mouse.move(backgroundMaxReposition.to.x, backgroundMaxReposition.to.y, { steps: 4 });
  await page.mouse.up();

  const backgroundMaxResizeBefore = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot');
    const handle = dot.querySelector('.background-dot-resize-handle').getBoundingClientRect();
    return { x: handle.right - 20, y: handle.bottom - 20 };
  });
  await page.mouse.move(backgroundMaxResizeBefore.x, backgroundMaxResizeBefore.y);
  await page.mouse.down();
  await page.mouse.move(backgroundMaxResizeBefore.x + 600, backgroundMaxResizeBefore.y + 600, { steps: 8 });
  await page.mouse.up();
  const backgroundMaxCenter = await page.evaluate(() => {
    const r = document.getElementById('backgroundDot').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(backgroundMaxCenter.x, backgroundMaxCenter.y);
  await page.waitForTimeout(120);
  const backgroundPickerOverlap = await page.evaluate(() => {
    const dot = document.getElementById('backgroundDot').getBoundingClientRect();
    const panel = document.querySelector('.cv-background-picker-panel')?.getBoundingClientRect();
    const center = { x: dot.left + dot.width / 2, y: dot.top + dot.height / 2 };
    return panel ? {
      dot: { left: dot.left, right: dot.right, top: dot.top, bottom: dot.bottom },
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      overlap: !(panel.right <= dot.left || panel.left >= dot.right || panel.bottom <= dot.top || panel.top >= dot.bottom),
    } : { missing: true, dot: { left: dot.left, right: dot.right, top: dot.top, bottom: dot.bottom }, center,
      element: document.elementFromPoint(center.x, center.y)?.className || '' };
  });
  H.check('the background picker stays clear of a maximally resized dot',
    !backgroundPickerOverlap.missing && !backgroundPickerOverlap.overlap,
    JSON.stringify(backgroundPickerOverlap));
  await page.mouse.click(backgroundMaxCenter.x, backgroundMaxCenter.y);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
