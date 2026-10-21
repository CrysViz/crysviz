// The camera's far plane must stay behind the whole scene. Both cameras start
// with far = 1000, and fitCameraToCurrentStructure() backs off ~2.6x the cell
// radius, so a large cell used to put its far side past the far plane: a block
// field in one corner vanished at some camera angles and came back at others.
// render/CameraClipModule.js now grows far each frame to cover the cell (at
// the periodic display boundary) and the live isosurface. Asserts the block
// field is drawn from every orbit angle around a ~1200 Å cell, that a
// normal-size cell keeps the default far = 1000, and that an orthographic
// camera left inside the scene (switching structures keeps the previous
// camera distance) is backed out so nothing sits behind its near plane.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Pixels that differ substantially between two screenshots. */
function changedPixelCount(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 90) n++;
  }
  return n;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO, ~3.8 x 3.9 x 11.7 Å
  await page.waitForTimeout(500);

  const small = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { renderFrameNow } = await import('./render/index.js');
    renderFrameNow();
    return app.camera.far;
  });
  H.check('normal-size cell keeps the default far plane', small === 1000, JSON.stringify({ far: small }));

  // The default orthographic camera 0.5 Å from the target, inside the cell: the next frame
  // must move it back so the whole cell is in front of the near plane.
  const backedOut = await page.evaluate(async () => {
    const { app, fileBrowser } = await import('./state/store.js');
    const { renderFrameNow } = await import('./render/index.js');
    const target = app.controls.target.clone();
    const dir = app.camera.position.clone().sub(target).normalize();
    app.camera.position.copy(target).addScaledVector(dir, 0.5);
    app.camera.lookAt(target);
    renderFrameNow();
    const [a, b, c] = fileBrowser.selectedStructure.lattice;
    const corner = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
    const halfDiagonal = Math.hypot(...corner) / 2;
    return { ortho: app.camera.isOrthographicCamera, dist: app.camera.position.distanceTo(target), halfDiagonal };
  });
  H.check('orthographic camera inside the cell is backed out past the cell',
    backedOut.ortho && backedOut.dist > backedOut.halfDiagonal, JSON.stringify(backedOut));

  // Stretch the cell 100x (382 x 389 x 1168 Å) and refit the camera.
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const sel = fileBrowser.selectedStructure;
    sel.lattice = sel.lattice.map((row) => row.map((x) => x * 100));
    createSupercell(1, 1, 1);
  });
  await page.waitForTimeout(1000);

  // A Gaussian block field (~50 Å across) in the cell's origin corner, with
  // the structure hidden so only the field can change the picture.
  await page.evaluate(async () => {
    const { Field } = await import('./model/index.js');
    const { app, groups } = await import('./state/store.js');
    const { setActiveField, updateField, requestRender } = await import('./render/index.js');
    const n = 16, step = 4;
    const values = new Float32Array(n * n * n);
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = (i - 7.5) / 5, y = (j - 7.5) / 5, z = (k - 7.5) / 5;
      values[i + n * (j + n * k)] = Math.exp(-(x * x + y * y + z * z));
    }
    const field = new Field({
      nx: n, ny: n, nz: n, origin: [10, 10, 10], voxel: [[step, 0, 0], [0, step, 0], [0, 0, step]],
      values, periodic: false, isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false,
    });
    setActiveField(field, false);
    updateField(0.5);
    for (const child of app.scene.children) {
      if (child !== groups.isosurfaceGroup && !child.isLight) child.visible = false;
    }
    requestRender();
  });

  const setFieldVisible = (visible) => page.evaluate(async (visible) => {
    const { groups } = await import('./state/store.js');
    const { renderFrameNow } = await import('./render/index.js');
    groups.isosurfaceGroup.visible = visible;
    renderFrameNow();
  }, visible);

  for (const deg of [0, 90, 180, 270]) {
    const state = await page.evaluate(async (deg) => {
      const { app } = await import('./state/store.js');
      const { renderFrameNow } = await import('./render/index.js');
      const target = app.controls.target;
      const offset = app.camera.position.clone().sub(target);
      const r = Math.hypot(offset.x, offset.z);
      const a = deg * Math.PI / 180;
      app.camera.position.set(target.x + r * Math.cos(a), target.y + offset.y, target.z + r * Math.sin(a));
      app.camera.lookAt(target);
      app.controls.update();
      renderFrameNow();
      return { far: app.camera.far, fieldDist: app.camera.position.distanceTo({ x: 26, y: 26, z: 26 }) };
    }, deg);
    await page.waitForTimeout(500);
    const on = await H.shotCanvas(page, `cameraclip-${deg}-on`);
    await setFieldVisible(false);
    await page.waitForTimeout(500);
    const off = await H.shotCanvas(page, `cameraclip-${deg}-off`);
    await setFieldVisible(true);
    const fieldPixels = changedPixelCount(on, off);
    H.check(`large cell, orbit ${deg} deg: far plane is past the field and the field is drawn`,
      state.far > state.fieldDist && fieldPixels > 50, JSON.stringify({ ...state, fieldPixels }));
  }

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
