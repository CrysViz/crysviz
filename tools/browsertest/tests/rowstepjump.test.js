// The file browser's per-row "step" box is the third way to change frames
// (next to the Trajectory scrubber and its step buttons). Changing it — typing
// or the spinner arrows — used to call the frame update directly, so:
//  - the camera did NOT re-center on the new frame (the player's own step
//    buttons always do), and
//  - the Trajectory player's scrubber / frame label kept the OLD frame.
// Now the box is a deliberate settle jump: with the player built it drives the
// player (scrubber, label, proper load, recenter); without it the browser
// loads the frame itself and re-centres.
'use strict';
const H = require('../harness');

// Two .res candidates with DIFFERENT cells and DIFFERENT atom counts, so both
// the cell center (2.5 <-> 3.0) and the composition (2 <-> 3 atoms) identify
// the frame on screen.
const RES = [
  'TITL a 0.0 125.0 -50.0 0 0 2 (P1) n 1',
  'CELL 1.54 5.0 5.0 5.0 90.0 90.0 90.0',
  'SFAC Na Cl',
  'Na1 1 0.0 0.0 0.0 1.0',
  'Cl1 2 0.5 0.5 0.5 1.0',
  'END',
  'TITL b 0.0 216.0 -49.0 0 0 3 (P1) n 1',
  'CELL 1.54 6.0 6.0 6.0 90.0 90.0 90.0',
  'SFAC Na Cl',
  'Na1 1 0.0 0.0 0.0 1.0',
  'Cl1 2 0.5 0.5 0.5 1.0',
  'Cl2 2 0.25 0.25 0.25 1.0',
  'END',
].join('\n');

const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

(async () => {
  const { browser, page, errors } = await H.launchApp();

  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    await cv.loadStructure(text, 'twocell.res');
    openPanel('trajectory'); // builds the player
  }, RES);

  const state = () => page.evaluate(async () => {
    const { app, fileBrowser } = await import('./state/store.js');
    const box = fileBrowser.selectedRow.querySelector('input[type="number"]');
    const slider = document.getElementById('frameSlider');
    const cur = document.querySelector('#frameIndicator .tfCur');
    const h4 = document.querySelector('#structureToggle h4');
    return {
      tx: app.controls.target.x, tz: app.controls.target.z,
      box: box.value,
      slider: slider ? slider.value : null,
      label: cur ? cur.textContent : null,
      atoms: h4 ? h4.textContent : null,
      playerBuilt: !!document.getElementById('TrajControlPanel'),
    };
  });
  // Type/spin a value into the selected row's step box, as the user does.
  const setBox = (step) => page.evaluate(async (step) => {
    const { fileBrowser } = await import('./state/store.js');
    const box = fileBrowser.selectedRow.querySelector('input[type="number"]');
    box.value = String(step);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, step);
  // Rotate the camera off-axis so "re-centred" is distinguishable from "reset".
  const disturb = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.controls.target.x += 0.7;
    app.controls.target.z -= 0.4;
  });

  // --- with the player built: the box drives the player -------------------
  await setBox(2);
  let s = await state();
  H.check('player built', s.playerBuilt, JSON.stringify(s));
  H.check('box -> frame 2: structure properly loaded (3 atoms)', /3\s*Atoms/i.test(s.atoms || ''), s.atoms);
  H.check('box -> frame 2: scrubber follows', s.slider === '1', JSON.stringify(s));
  H.check('box -> frame 2: frame label follows', s.label === '2', JSON.stringify(s));
  H.check('box -> frame 2: camera re-centred on the 6 Å cell (3.0)', near(s.tx, 3) && near(s.tz, 3), JSON.stringify(s));

  await disturb();
  await setBox(1);
  s = await state();
  H.check('box -> frame 1: structure properly loaded (2 atoms)', /2\s*Atoms/i.test(s.atoms || ''), s.atoms);
  H.check('box -> frame 1: scrubber follows', s.slider === '0', JSON.stringify(s));
  H.check('box -> frame 1: frame label follows', s.label === '1', JSON.stringify(s));
  H.check('box -> frame 1: camera re-centred on the 5 Å cell (2.5)', near(s.tx, 2.5) && near(s.tz, 2.5), JSON.stringify(s));

  // The player's own step button still works and keeps the box in step.
  await page.evaluate(() => document.getElementById('stepFwdBtn').click());
  s = await state();
  H.check('player step button still syncs the box', s.box === '2' && s.slider === '1', JSON.stringify(s));

  // --- without the player: the box still loads + re-centres ---------------
  await page.evaluate(async () => {
    const { closePanel } = await import('./ui/panels/PanelManager.js');
    closePanel('trajectory');
  });
  await page.waitForTimeout(200);
  await disturb();
  await setBox(1);
  s = await state();
  H.check('player removed', !s.playerBuilt, JSON.stringify(s));
  H.check('no player: box -> frame 1 loads (2 atoms)', /2\s*Atoms/i.test(s.atoms || ''), s.atoms);
  H.check('no player: camera re-centred (2.5)', near(s.tx, 2.5) && near(s.tz, 2.5), JSON.stringify(s));

  // Only the blocked-CDN noise this sandbox produces is tolerated.
  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real[0] || '');
  await H.finish(browser);
})().catch(H.crash);
