// The file browser's per-row "step" box and the Trajectory scrubber are two
// views of one frame index, and both directions used to be broken:
//
//  1. updateRow(row, {traj, step}) IGNORED obj.step and only clamped downward.
//     All three callers are MD/relax runs passing the LAST frame, so finishing
//     a 51-step relax auto-selected Relax_… but opened it on frame 1.
//  2. Scrubbing the trajectory never wrote back to the box, so it kept showing
//     a stale number while the viewer was on another frame.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // 4 frames, each with the Na atom a bit further along x, so the frame the
  // viewer is on is identifiable from the structure alone.
  const TRAJ = [0, 0.1, 0.2, 0.3].map((dx) => [
    '2', 'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3',
    `Na ${dx} 0 0`, 'Cl 3 0 0',
  ].join('\n')).join('\n');

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    const fb = await import('./ui/FileBrowswerPanel.js');
    const pm = await import('./ui/panels/PanelManager.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await cv.loadStructure(traj, 'Relax_test.xyz');
    await sleep(300);

    const rows = document.querySelectorAll('#objectTable tbody tr');
    const row = rows[rows.length - 1];
    const box = row.querySelector('input[type="number"]');
    const container = structureShip.container[structureShip.container.length - 1];
    const frames = container.structures.length;
    const naX = (s) => s && s.atoms[0].position[0];

    // Put the row back on frame 1, the state a live run leaves it in (the row
    // is created before any frames are appended).
    box.value = '1';
    fb.selectLastAddedRow();
    await sleep(200);
    const before = { boxValue: box.value, naX: naX(fileBrowser.selectedStructure) };

    // --- (1) the relax/MD finish path: updateRow with the last frame -------
    fb.updateRow(row, { name: 'Relax_test.xyz', traj: frames, step: frames });
    fb.selectLastAddedRow();
    await sleep(300);
    const afterUpdateRow = {
      boxValue: box.value,
      boxMax: box.max,
      naX: naX(fileBrowser.selectedStructure),
    };

    // --- (2) scrubbing must write back into the box ------------------------
    pm.openPanel('trajectory');
    await sleep(400);
    const slider = document.getElementById('frameSlider');
    slider.value = '1';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const afterScrub = {
      boxValue: box.value,
      sliderValue: slider.value,
      naX: naX(fileBrowser.selectedStructure),
    };

    // Stepping forward with the transport button must keep them in step too.
    document.getElementById('stepFwdBtn').click();
    await sleep(300);
    const afterStep = { boxValue: box.value, naX: naX(fileBrowser.selectedStructure) };

    return {
      frames,
      lastNaX: naX(container.structures[frames - 1]),
      firstNaX: naX(container.structures[0]),
      before,
      afterUpdateRow,
      afterScrub,
      afterStep,
    };
  }, TRAJ);

  H.check('4-frame trajectory loaded', res.frames === 4, JSON.stringify(res));
  H.check('starts parked on frame 1 (the pre-fix state)',
    res.before.boxValue === '1' && res.before.naX === res.firstNaX, JSON.stringify(res.before));

  H.check('updateRow({step}) moves the box to the last frame',
    res.afterUpdateRow.boxValue === String(res.frames)
      && res.afterUpdateRow.boxMax === String(res.frames), JSON.stringify(res.afterUpdateRow));
  H.check('...and the viewer follows to the last structure',
    res.afterUpdateRow.naX === res.lastNaX,
    `naX=${res.afterUpdateRow.naX} last=${res.lastNaX}`);

  H.check('scrubbing to frame 2 syncs the box to 2',
    res.afterScrub.boxValue === '2' && res.afterScrub.sliderValue === '1',
    JSON.stringify(res.afterScrub));
  H.check('stepping forward syncs the box to 3',
    res.afterStep.boxValue === '3', JSON.stringify(res.afterStep));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
