// Clicking a different row in the file browser table (switching between
// already-loaded structures) must preserve the camera's rotation/zoom and
// only re-center it — it was calling resetView() (full reset to the [1,1,1]
// default direction), discarding the user's view every time.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  // A second row to switch to.
  await H.loadDefaultStructure(page, 'defaultPOSCAR2', 'second');

  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.position.set(app.controls.target.x + 9, app.controls.target.y + 4, app.controls.target.z + 13);
    app.controls.update();
  });
  const before = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.position.clone().sub(app.controls.target);
  });

  await page.evaluate(() => {
    const rows = document.querySelectorAll('#objectTable tbody tr');
    // Click whichever row isn't currently selected.
    const other = [...rows].find((r) => !r.classList.contains('selected'));
    other?.click();
  });
  await page.waitForTimeout(300);

  const after = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return app.camera.position.clone().sub(app.controls.target);
  });

  const dx = Math.abs(before.x - after.x);
  const dy = Math.abs(before.y - after.y);
  const dz = Math.abs(before.z - after.z);
  H.check('switching rows in the file browser preserves camera rotation/zoom',
    dx < 0.01 && dy < 0.01 && dz < 0.01,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
