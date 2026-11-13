// Rotation lock (ui/RotationLock.js): with the mouse over the 3D view, the
// plain X/Y/Z and A/B/C keys restrict mouse rotation to that world / lattice
// axis, Space+X/Y/Z to the screen axis as it was when pressed (x right, y up,
// z out of the screen), and R frees it. A locked drag is a rigid rotation about the axis, so
// the axis keeps its on-screen direction while the camera turns; an axis
// pointing at the viewer is turned by dragging round the centre. The keys do
// nothing while the mouse is over a panel, Shift+X etc. keep their camera
// views, and the shortcut help lists them with the camera shortcuts.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await H.loadDefaultStructure(page); // YBCO

  const box = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const r = app.renderer.domElement.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  // Camera state: the view-space direction of an axis (how it sits on screen),
  // the camera's own view direction, and the lock.
  const state = (axis) => page.evaluate(async (axis) => {
    const THREE = await import('./external/three/three.module.js');
    const { app } = await import('./state/store.js');
    const { latticeDirs } = await import('./render/index.js');
    const { getRotationLock } = await import('./ui/RotationLock.js');
    app.camera.updateMatrixWorld(true);
    const world = axis === 'z' ? [0, 0, 1] : latticeDirs()[axis];
    const v = new THREE.Vector3(...world).normalize().transformDirection(app.camera.matrixWorldInverse);
    const view = app.camera.position.clone().sub(app.controls.target).normalize();
    const badge = document.querySelector('.cv-rotation-lock-badge');
    return {
      axisOnScreen: v.toArray(), view: view.toArray(), up: app.camera.up.toArray(),
      lock: getRotationLock(), noRotate: app.controls.noRotate,
      badge: badge && !badge.hidden ? badge.textContent : null,
    };
  }, axis);
  const close = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < tol);
  const moved = (a, b) => !close(a, b, 1e-3);

  async function dragFrom(x0, y0, path) {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (const [x, y] of path) await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600); // let any trackball damping settle
  }

  // ---- Z lock from the default (oblique) view --------------------------------
  await page.mouse.move(cx, cy);
  await page.keyboard.press('z');
  const zBefore = await state('z');
  await dragFrom(cx - 120, cy, [[cx + 120, cy + 40]]);
  const zAfter = await state('z');
  H.check('Z over the view locks rotation to z and shows the badge',
    zBefore.lock === 'z' && zBefore.noRotate === true && /locked to z/.test(zBefore.badge || ''),
    JSON.stringify(zBefore));
  H.check('a locked drag turns the camera but keeps z fixed on screen',
    moved(zBefore.view, zAfter.view) && close(zBefore.axisOnScreen, zAfter.axisOnScreen),
    JSON.stringify({ zBefore, zAfter }));

  // ---- lattice c --------------------------------------------------------------
  await page.keyboard.press('c');
  const cBefore = await state('c');
  await dragFrom(cx, cy - 100, [[cx + 60, cy + 100]]);
  const cAfter = await state('c');
  H.check('C locks to lattice c and a drag keeps c fixed on screen',
    cBefore.lock === 'c' && moved(cBefore.view, cAfter.view) && close(cBefore.axisOnScreen, cAfter.axisOnScreen),
    JSON.stringify({ cBefore, cAfter }));

  // ---- an axis pointing at the viewer turns by dragging round the centre -----
  await page.keyboard.press('Shift+Z'); // camera views along z (Shift tier unchanged)
  await page.mouse.move(cx, cy);
  const afterShiftZ = await state('z');
  H.check('Shift+Z still aligns the camera and leaves the lock alone',
    afterShiftZ.lock === 'c' && Math.abs(Math.abs(afterShiftZ.axisOnScreen[2]) - 1) < 1e-6, JSON.stringify(afterShiftZ));
  await page.keyboard.press('z');
  const twistBefore = await state('z');
  await dragFrom(cx + 150, cy, [[cx + 106, cy - 106], [cx, cy - 150]]);
  const twistAfter = await state('z');
  H.check('with z pointing at the viewer, a circular drag spins about z',
    moved(twistBefore.up, twistAfter.up) && close(twistBefore.view, twistAfter.view, 1e-5),
    JSON.stringify({ twistBefore, twistAfter }));

  // ---- keys do nothing over a panel -------------------------------------------
  const panelPoint = await page.evaluate(() => {
    const el = document.getElementById('shortcutsHelpTrigger');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(panelPoint.x, panelPoint.y);
  await page.keyboard.press('x');
  const overPanel = await state('z');
  H.check('the keys are ignored while the mouse is not over the view',
    overPanel.lock === 'z', JSON.stringify(overPanel));

  // ---- R frees it: a drag now moves the z axis on screen ----------------------
  await page.mouse.move(cx, cy);
  await page.keyboard.press('r');
  const freeBefore = await state('z');
  await dragFrom(cx - 100, cy - 60, [[cx + 100, cy + 60]]);
  const freeAfter = await state('z');
  H.check('R frees the rotation and hides the badge',
    freeBefore.lock === null && freeBefore.noRotate === false && freeBefore.badge === null,
    JSON.stringify(freeBefore));
  H.check('a free drag tumbles the view again (z moves on screen)',
    moved(freeBefore.axisOnScreen, freeAfter.axisOnScreen), JSON.stringify({ freeBefore, freeAfter }));

  // ---- screen axes (Space+X/Y/Z): captured from the view when pressed ---------
  const screen = () => page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app } = await import('./state/store.js');
    const { getRotationLock } = await import('./ui/RotationLock.js');
    app.camera.updateMatrixWorld(true);
    const col = (i) => new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, i).normalize().toArray();
    const badge = document.querySelector('.cv-rotation-lock-badge');
    return { right: col(0), up: col(1), out: col(2), lock: getRotationLock(), badge: badge && !badge.hidden ? badge.textContent : null };
  });
  const spaceKey = async (key) => {
    await page.keyboard.down('Space');
    await page.keyboard.press(key);
    await page.keyboard.up('Space');
  };
  await page.mouse.move(cx, cy);
  await spaceKey('x');
  const sxBefore = await screen();
  await dragFrom(cx, cy - 100, [[cx + 20, cy + 100]]);
  const sxAfter = await screen();
  H.check('Space+X locks to the screen x axis: a drag keeps "right" and tilts the view',
    sxBefore.lock === 'screen-x' && /locked to screen x/.test(sxBefore.badge || '')
    && close(sxBefore.right, sxAfter.right, 1e-5) && moved(sxBefore.out, sxAfter.out),
    JSON.stringify({ sxBefore, sxAfter }));

  await spaceKey('y');
  const syBefore = await screen();
  await dragFrom(cx - 100, cy, [[cx + 100, cy + 20]]);
  const syAfter = await screen();
  H.check('Space+Y locks to the screen y axis: a drag keeps "up" and turns the view',
    syBefore.lock === 'screen-y' && close(syBefore.up, syAfter.up, 1e-5) && moved(syBefore.out, syAfter.out),
    JSON.stringify({ syBefore, syAfter }));

  await spaceKey('z');
  const szBefore = await screen();
  await dragFrom(cx + 150, cy, [[cx + 106, cy - 106], [cx, cy - 150]]);
  const szAfter = await screen();
  H.check('Space+Z locks to the axis out of the screen: a circular drag spins the view in place',
    szBefore.lock === 'screen-z' && close(szBefore.out, szAfter.out, 1e-5) && moved(szBefore.up, szAfter.up),
    JSON.stringify({ szBefore, szAfter }));

  // Grabbing near the middle and dragging outwards is radial to a dial, so it
  // used to barely turn: a drag that starts near the centre rolls with the
  // horizontal movement instead, at the same speed as the other locks.
  const nearBefore = await screen();
  await dragFrom(cx + 20, cy + 3, [[cx + 320, cy + 3]]);
  const nearAfter = await screen();
  const turned = Math.acos(Math.max(-1, Math.min(1,
    nearBefore.up.reduce((sum, v, i) => sum + v * nearAfter.up[i], 0)))) * 180 / Math.PI;
  const clockwise = nearAfter.up.reduce((sum, v, i) => sum + v * nearBefore.right[i], 0) < 0;
  H.check('Space+Z: a drag from near the centre rolls like the other locks (right = clockwise)',
    turned > 45 && turned < 75 && clockwise && close(nearBefore.out, nearAfter.out, 1e-5),
    JSON.stringify({ turned, clockwise }));

  // The view must update DURING the drag. Rolling about the line of sight
  // moves only camera.up, which TrackballControls' change event (the
  // on-demand render trigger) does not notice: frames used to stop until
  // the mouse was released.
  const frames = () => page.evaluate(async () => (await import('./state/store.js')).app.renderer.info.render.frame);
  await page.mouse.move(cx + 20, cy + 3);
  await page.mouse.down();
  await page.waitForTimeout(300);
  const framesBefore = await frames();
  await page.mouse.move(cx + 220, cy + 3, { steps: 20 });
  await page.waitForTimeout(300);
  const framesDuring = await frames();
  await page.mouse.up();
  H.check('Space+Z redraws while dragging, not only on release',
    framesDuring > framesBefore, JSON.stringify({ framesBefore, framesDuring }));

  await page.keyboard.press('r');
  H.check('R frees a screen-axis lock too', (await screen()).lock === null);

  // ---- documented in the shortcut help ----------------------------------------
  const help = await page.evaluate(async () => {
    const { openShortcutsHelp } = await import('./ui/KeyboardShortcuts.js');
    openShortcutsHelp();
    const columns = [...document.querySelectorAll('.shortcuts-help-column')];
    const shift = columns.find((c) => c.querySelector('h4')?.textContent === 'Shift');
    const groups = [...(shift?.querySelectorAll('.shortcuts-help-group-row') ?? [])].map((g) => g.textContent.trim());
    const heading = [...(shift?.querySelectorAll('.shortcuts-help-group-row') ?? [])]
      .find((g) => g.textContent.trim() === 'Camera · mouse over structure');
    const rows = [];
    for (let tr = heading?.nextElementSibling; tr && tr.classList.contains('shortcuts-help-row'); tr = tr.nextElementSibling) {
      rows.push({
        key: tr.querySelector('.shortcuts-help-key').textContent.trim(),
        label: tr.querySelector('.shortcuts-help-desc-cell').textContent.trim(),
      });
    }
    return { columns: columns.length, groups, rows };
  });
  H.check('the help lists the ten keys right under the Shift column\'s Camera group',
    help.columns === 4 && help.groups[0] === 'Camera' && help.groups[1] === 'Camera · mouse over structure'
    && JSON.stringify(help.rows.map((r) => r.key.replace(/\s+/g, '')))
      === JSON.stringify(['X', 'Y', 'Z', 'A', 'B', 'C', 'Space+X', 'Space+Y', 'Space+Z', 'R']),
    JSON.stringify(help));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
