// Long-press menus, body dragging, enlarged resize hit zones, and interaction
// opacity for the axes gizmo and floating colour bars.
'use strict';
const H = require('../harness');

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

const mouseLongPress = async (page, selector, x, y) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const open = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  return open;
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

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
  await page.mouse.move(axesSizeBefore.x, axesSizeBefore.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const axesResizeMenu = await page.evaluate(() => !!document.querySelector('.cv-colorbar-menu-open'));
  await page.mouse.move(axesSizeBefore.x + 30, axesSizeBefore.y + 30, { steps: 3 });
  await page.mouse.up();
  const axesSizeAfter = await page.evaluate(() => document.getElementById('axesGizmo').getBoundingClientRect().width);
  H.check('holding the axes resize corner does not open the menu', !axesResizeMenu);
  H.check('the axes 24px corner hit area resizes outside the old 14px mark', axesSizeAfter > axesSizeBefore.size + 10,
    JSON.stringify({ before: axesSizeBefore.size, after: axesSizeAfter }));

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

  await page.evaluate(async () => {
    const { createColorBar } = await import('./ui/ColorBarWidget.js');
    const { registerColorBarSource } = await import('./ui/ColorBarRegistry.js');
    const host = document.createElement('div');
    host.id = 'gizmoui-colorbar-host';
    document.body.appendChild(host);
    const bar = createColorBar(host, 'viridis', 0, 1, {
      floatingId: 'gizmoui-colorbar', legend: 'Test', size: 300,
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
  await page.locator('#gizmoui-colorbar .cv-colorbar-menu-item', { hasText: 'Dock' }).click();
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

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
