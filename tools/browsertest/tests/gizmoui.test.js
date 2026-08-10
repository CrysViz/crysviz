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

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
