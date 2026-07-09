// Camera panel "Damped" toggle: switching to undamped must disable zoom
// (app.controls.noZoom), since there's no inertia to arrest a zoom drag.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const before = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { dampingFactor: app.controls.dynamicDampingFactor, noZoom: app.controls.noZoom };
  });
  H.check('starts damped with zoom allowed', before.dampingFactor > 0 && !before.noZoom,
    JSON.stringify(before));

  await page.evaluate(() => {
    const cb = document.getElementById('autoRotate');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  });
  const undamped = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { dampingFactor: app.controls.dynamicDampingFactor, noZoom: app.controls.noZoom };
  });
  H.check('undamped disables zoom', undamped.dampingFactor === 0 && undamped.noZoom === true,
    JSON.stringify(undamped));

  await page.evaluate(() => {
    const cb = document.getElementById('autoRotate');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
  });
  const redamped = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { dampingFactor: app.controls.dynamicDampingFactor, noZoom: app.controls.noZoom };
  });
  H.check('re-damping restores zoom', redamped.dampingFactor > 0 && !redamped.noZoom,
    JSON.stringify(redamped));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
