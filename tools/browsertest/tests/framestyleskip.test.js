// TrajectoryContainer must not run the O(N) applyFrameStyles reset on every
// frame switch. During ordinary playback of an unstyled trajectory (no
// per-frame colour/hidden/position edits) both the outgoing live objects and
// the incoming frame carry no deviations, so the reset is a no-op and is
// skipped — measured by debugStats.styled staying flat across a run of
// switches. A user edit on a frame must still be cleared when leaving it, so
// after an edit the counter advances and the next frame is pristine.
'use strict';
const H = require('../harness');

// A tiny eager (RAM-store) extxyz trajectory: nFrames of nAtoms Na/Cl that
// drift slightly per frame (a trajectory, not a dataset), no styles.
function extxyz(nFrames, nAtoms) {
  const a = 12;
  const out = [];
  for (let f = 0; f < nFrames; f++) {
    out.push(String(nAtoms));
    out.push(`Lattice="${a} 0 0 0 ${a} 0 0 0 ${a}" Properties=species:S:1:pos:R:3 energy=${(-50 - f).toFixed(3)} pbc="T T T"`);
    for (let i = 0; i < nAtoms; i++) {
      const x = ((i * 2.7) % a) + 0.01 * f, y = ((i * 1.3) % a), z = ((i * 0.7) % a);
      out.push(`${i % 2 ? 'Cl' : 'Na'} ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`);
    }
  }
  return out.join('\n') + '\n';
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (xyz) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(new File([xyz], 'run.extxyz'), 'run.extxyz');
    const c = structureShip.container[fileBrowser.selectedRowIndex];

    // Settle on frame 0 so the first (rebuild) switch is behind us.
    await c.frameAt(0);
    const styledStart = c.debugStats.styled;

    // A run of forward/backward switches with no edits: the null-record reset
    // must be skipped every time.
    const order = [1, 2, 3, 4, 3, 2, 1, 0, 4, 0];
    for (const step of order) await c.frameAt(step);
    const styledAfterPlain = c.debugStats.styled;

    // Now edit frame 2's first atom, then leave the frame: the clear must run
    // once, and the atom on the next frame must be pristine.
    const f2 = await c.frameAt(2);
    f2.atoms[0].userColor = '#ff0000';
    const styledBeforeEdit = c.debugStats.styled;
    const f3 = await c.frameAt(3);
    const styledAfterEdit = c.debugStats.styled;
    const clearedColor = f3.atoms[0].userColor;

    // Returning to the edited frame reproduces the stored edit.
    const f2again = await c.frameAt(2);
    const restoredColor = f2again.atoms[0].userColor;

    return {
      frames: c.frameCount,
      storeKind: c.store.constructor.name,
      switchesPlain: order.length,
      styledDeltaPlain: styledAfterPlain - styledStart,
      styledDeltaEdit: styledAfterEdit - styledBeforeEdit,
      clearedColor,
      restoredColor,
    };
  }, extxyz(5, 8));

  console.log(`  ${res.frames} frames (${res.storeKind}), ${res.switchesPlain} unstyled switches`);
  H.check('a multi-frame extxyz builds a RAM-backed trajectory', res.frames === 5 && res.storeKind === 'TrajectoryFrameStore', JSON.stringify(res));
  H.check('unstyled frame switches skip the O(N) style pass (styled stays 0)',
    res.styledDeltaPlain === 0, `styled advanced by ${res.styledDeltaPlain} across ${res.switchesPlain} switches`);
  H.check('leaving an edited frame runs the clear exactly once, next frame is pristine',
    res.styledDeltaEdit === 1 && res.clearedColor === null, JSON.stringify(res));
  H.check('a stored edit is reproduced on return', res.restoredColor === '#ff0000', String(res.restoredColor));

  H.check('no page errors', errors.filter((e) => !/esm\.sh|Failed to load resource/.test(e)).length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
