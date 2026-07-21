// Camera-alignment buttons (x/y/z/a/b/c) must only change viewing DIRECTION —
// pressing one used to call controls.reset() then re-fit via
// getCellCenterAndDist(), silently discarding the user's zoom and framing.
// Only the explicit "reset view" button may re-fit.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Simulate a user who has zoomed in and orbited to an arbitrary, non-fit
  // framing: zoom away from 1, and a distance well under the fit distance so
  // a re-fit (which recomputes distance too) is distinguishable from a pure
  // re-aim (which must keep it exactly).
  const before = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    app.camera.zoom = 2.5;
    app.camera.updateProjectionMatrix();
    const dist = app.camera.position.distanceTo(app.controls.target) * 0.4;
    app.camera.position.copy(
      app.controls.target.clone().add(new THREE.Vector3(3, 5, 7).normalize().multiplyScalar(dist))
    );
    app.controls.update();
    return { zoom: app.camera.zoom, dist: app.camera.position.distanceTo(app.controls.target) };
  });

  await H.clickById(page, 'viewX');
  const afterAlign = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const dir = app.camera.position.clone().sub(app.controls.target).normalize();
    return { zoom: app.camera.zoom, dist: app.camera.position.distanceTo(app.controls.target), dir };
  });

  H.check('align button preserves zoom', Math.abs(afterAlign.zoom - before.zoom) < 1e-6,
    JSON.stringify(afterAlign));
  H.check('align button preserves distance from target', Math.abs(afterAlign.dist - before.dist) < 1e-6,
    JSON.stringify({ before, afterAlign }));
  H.check('align button still points the camera down +X',
    afterAlign.dir.x > 0.999 && Math.abs(afterAlign.dir.y) < 1e-6 && Math.abs(afterAlign.dir.z) < 1e-6,
    JSON.stringify(afterAlign.dir));

  // The explicit reset button must still behave exactly as before: re-fit
  // (distance jumps to the structure's fit distance) and restore zoom.
  await H.clickById(page, 'resetView');
  const afterReset = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { zoom: app.camera.zoom, dist: app.camera.position.distanceTo(app.controls.target) };
  });
  H.check('reset view still re-fits distance (unlike alignment)',
    Math.abs(afterReset.dist - before.dist) > 0.5,
    JSON.stringify({ before, afterReset }));
  H.check('reset view still restores zoom (unlike alignment)',
    Math.abs(afterReset.zoom - before.zoom) > 0.1,
    JSON.stringify(afterReset));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
