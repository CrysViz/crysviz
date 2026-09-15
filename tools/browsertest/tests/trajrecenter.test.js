// Trajectory player recentering + fast/proper loading:
//  - dragging the scrubber (input) is a fast light preview: the Structure Info
//    panel does NOT rebuild and the camera does NOT recenter;
//  - every settle jump — releasing the scrubber (change), pausing, the step
//    buttons, or clicking the MD plot — always does a proper load AND recenters,
//    regardless of the "Recenter each step" toggle;
//  - the toggle governs only continuous playback (autoplay ticks).
'use strict';
const H = require('../harness');

// Two .res candidates with DIFFERENT cells and DIFFERENT atom counts, so both
// the cell center (2.5 <-> 3.0) and the composition (2 <-> 3 atoms) change.
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

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const setup = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    await cv.loadStructure(text, 'twocell.res');
    openPanel('trajectory'); // builds the player + the recenter checkbox
    const cb = document.getElementById('recenterEachStep');
    const h4 = document.querySelector('#structureToggle h4');
    return {
      hasCheckbox: !!cb,
      checkedByDefault: cb ? cb.checked : null,
      frame0Atoms: h4 ? h4.textContent : null,
    };
  }, RES);
  H.check('recenter checkbox exists', setup.hasCheckbox, JSON.stringify(setup));
  H.check('recenter off by default', setup.checkedByDefault === false, JSON.stringify(setup));
  H.check('frame 0 info shows 2 atoms', /2\s*Atoms/i.test(setup.frame0Atoms || ''), setup.frame0Atoms);

  const state = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const t = app.controls.target;
    const h4 = document.querySelector('#structureToggle h4');
    return { tx: t.x, tz: t.z, atoms: h4 ? h4.textContent : null };
  });
  const scrub = (frame, type) => page.evaluate(({ frame, type }) => {
    const s = document.getElementById('frameSlider');
    s.value = String(frame);
    s.dispatchEvent(new Event(type));
  }, { frame, type });
  const clickBtn = (id) => page.evaluate((id) => document.getElementById(id).click(), id);
  const setToggle = (on) => page.evaluate((on) => {
    const cb = document.getElementById('recenterEachStep');
    cb.checked = on;
    cb.dispatchEvent(new Event('change'));
  }, on);
  const near = (a, b, tol = 0.05) => Number.isFinite(a) && Math.abs(a - b) < tol;

  const s0 = await state();
  H.check('frame 0 target at cell center 2.5', near(s0.tx, 2.5) && near(s0.tz, 2.5), JSON.stringify(s0));

  // Drag to frame 1 (toggle off): fast preview — info + camera unchanged.
  await scrub(1, 'input');
  const drag = await state();
  H.check('drag: info not yet rebuilt (2 atoms)', /2\s*Atoms/i.test(drag.atoms || ''), drag.atoms);
  H.check('drag: camera unchanged (2.5)', near(drag.tx, 2.5), JSON.stringify(drag));

  // Release at frame 1: proper load AND recenter, even though the toggle is off.
  await scrub(1, 'change');
  const rel = await state();
  H.check('release: info proper-loaded to 3 atoms', /3\s*Atoms/i.test(rel.atoms || ''), rel.atoms);
  H.check('release ALWAYS recenters (-> 3.0) despite toggle off',
    near(rel.tx, 3.0) && near(rel.tz, 3.0), JSON.stringify(rel));

  // Step back with the button while the toggle is OFF: a step is a settle jump,
  // so it too proper-loads (2 atoms) AND recenters -> frame 0 center 2.5.
  await clickBtn('stepBackBtn');
  const stepOff = await state();
  H.check('step (toggle off): info proper-loaded to 2 atoms', /2\s*Atoms/i.test(stepOff.atoms || ''), stepOff.atoms);
  H.check('step ALWAYS recenters (-> 2.5) despite toggle off', near(stepOff.tx, 2.5), JSON.stringify(stepOff));

  // Enable the toggle, then drag: dragging is a fast preview and must NOT
  // recenter even with the toggle on (the toggle only affects playback).
  await setToggle(true);
  await scrub(1, 'input');
  const dragOn = await state();
  H.check('drag never recenters, even with toggle on (holds 2.5)', near(dragOn.tx, 2.5), JSON.stringify(dragOn));
  H.check('drag: info still 2 atoms (fast)', /2\s*Atoms/i.test(dragOn.atoms || ''), dragOn.atoms);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
