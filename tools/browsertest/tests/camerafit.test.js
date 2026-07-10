// getCellCenterAndDist() must guarantee the whole cell is visible, including
// oblique cells where the diagonal-corner vector nearly cancels even though
// individual lattice vectors are large (the old corner.length()*2.5 heuristic
// under-fit those). Also: file-browser structure switches must preserve
// camera rotation/zoom and only re-center (recenterCamera).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // A skewed cell: a and b are large and nearly opposite, so a+b+c (the old
  // "corner") is short even though the cell spans far in the a/b directions.
  const fit = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { getCellCenterAndDist } = await import('./render/index.js');
    const saved = fileBrowser.selectedStructure.lattice;
    fileBrowser.selectedStructure.lattice = [
      [20, 0, 0],
      [-19.5, 3.4, 0],
      [0, 0, 5],
    ];
    const { center, dist } = getCellCenterAndDist();
    // Farthest actual cell vertex from the reported center.
    const THREE = await import('./external/three/three.module.js');
    const L = fileBrowser.selectedStructure.lattice;
    const a = new THREE.Vector3(...L[0]), b = new THREE.Vector3(...L[1]), c = new THREE.Vector3(...L[2]);
    const verts = [new THREE.Vector3(0,0,0), a, b, c, a.clone().add(b), a.clone().add(c), b.clone().add(c), a.clone().add(b).add(c)];
    const c3 = new THREE.Vector3(center.x, center.y, center.z);
    const radius = Math.max(...verts.map(v => v.distanceTo(c3)));
    fileBrowser.selectedStructure.lattice = saved;
    // Required distance for a 45 deg perspective FOV to fit `radius`.
    const required = radius / Math.sin(45 / 2 * Math.PI / 180);
    return { dist, radius, required };
  });
  H.check('fit distance covers the true (oblique) bounding radius',
    fit.dist >= fit.required, JSON.stringify(fit));

  // File-browser structure switch preserves rotation/zoom, only recenters.
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.position.set(app.controls.target.x + 7, app.controls.target.y + 3, app.controls.target.z + 11);
    app.controls.update();
  });
  const before = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      offset: app.camera.position.clone().sub(app.controls.target),
    };
  });
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const d = await import('./defaults/structure_defaults.js');
    await cv.loadStructure(d.defaultPOSCAR, 'YBCO-again');
  });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const offset = app.camera.position.clone().sub(app.controls.target);
    return { offset };
  });
  const dx = Math.abs(before.offset.x - after.offset.x);
  const dy = Math.abs(before.offset.y - after.offset.y);
  const dz = Math.abs(before.offset.z - after.offset.z);
  H.check('camera offset (rotation+zoom) survives a structure switch',
    dx < 0.01 && dy < 0.01 && dz < 0.01,
    `before=${JSON.stringify(before.offset)} after=${JSON.stringify(after.offset)}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
