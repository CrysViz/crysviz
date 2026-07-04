// Smoke test: the app boots with WebGL, loads the default structure, and
// builds the atom/bond meshes without page errors.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  H.check('WebGL2 available', await H.webglAvailable(page));

  const state = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    return {
      structure: !!fileBrowser.selectedStructure,
      atomCount: groups.atomsMesh ? groups.atomsMesh.count : 0,
      bondsMesh: !!groups.bondsMesh,
    };
  });
  H.check('default structure loaded', state.structure);
  H.check('atoms mesh has instances', state.atomCount > 0, `count=${state.atomCount}`);
  H.check('bonds mesh exists', state.bondsMesh);

  const shot = await H.shotCanvas(page, 'smoke');
  const drawn = H.nonUniformFraction(shot);
  H.check('canvas is not blank', drawn > 0.01, `nonUniform=${drawn.toFixed(4)}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
