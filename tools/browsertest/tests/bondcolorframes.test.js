// Bond colouring must stay live across trajectory frames, on BOTH render paths.
// Companion to atomforcecolorframes.test.js. Two frame-dependent bond modes:
//   - "length": each bond's colour maps its current length (bond.dist);
//   - "elements" (default): bonds mirror their endpoint atom colours, which are
//     themselves recomputed per frame when atoms are coloured by force.
// The full rebuild path already recoloured bonds (buildBondObjects); the render
// FAST path (applyFrameFast, used by trajectory playback and in-browser MD/relax)
// moved bond endpoints but left their colours frozen. refreshBondColors, called
// from applyFrameFast, fixes that. This test pins both paths for both modes.
'use strict';
const H = require('../harness');

// 2 frames; the C–C bond stretches (1.3 → 1.55 Å) and the per-atom forces
// differ, so length- and force-driven colours must both change frame to frame.
const TRAJ = [
  '2',
  'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0 0 0 1 0 0',
  'C 1.3 0 0 2 0 0',
  '2',
  'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0 0 0 8 0 0',
  'C 1.55 0 0 9 0 0',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, fileBrowser, structureShip } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { applyFrameFast } = await import('./render/FastFrameModule.js');

    await cv.loadStructure(traj, 'bondcolor.xyz');
    await new Promise((r) => setTimeout(r, 150));
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    general.showBonds = true;

    const bondColors = () => fileBrowser.selectedStructure.bonds
      .map((b) => (Array.isArray(b.color) ? b.color[0] : b.color));

    // ---------- LENGTH mode ----------
    general.bondsColor = 'length';
    general.bondsColorMap = 'heatmap';
    general.bondColorScale = 'linear';
    general.BondMin = 1.0;
    general.BondMax = 3.0;

    // Full path (settle load)
    showTrajectoryFrame(0, container);
    await new Promise((r) => setTimeout(r, 150));
    const lenFull0 = bondColors();
    showTrajectoryFrame(1, container);
    await new Promise((r) => setTimeout(r, 200));
    const lenFull1 = bondColors();

    // Fast path (what Auto playback would run): it writes positions only, so a
    // frame-dependent colour map must NOT take it — applyFrameFast bails and the
    // caller falls back to the full rebuild, which recolours (asserted above).
    showTrajectoryFrame(1, container);
    await new Promise((r) => setTimeout(r, 150));
    const fastBefore = bondColors();
    container.frameAt(0);
    const { lastFastFrameBail } = await import('./render/FastFrameModule.js');
    const okFast = applyFrameFast(fileBrowser.selectedStructure);
    const bailReason = lastFastFrameBail();
    await new Promise((r) => setTimeout(r, 80));
    const fastAfter = bondColors();

    // ---------- ELEMENTS mode following force-coloured atoms ----------
    general.bondsColor = 'elements';
    general.atomsColor = 'force';
    general.atomColorMap = 'heatmap';
    general.atomColorScale = 'linear';
    general.ForceMin = 0;
    general.ForceMax = 10;
    showTrajectoryFrame(0, container);
    await new Promise((r) => setTimeout(r, 200));
    const elFull0 = bondColors();
    const atoms0 = fileBrowser.selectedStructure.atoms.map((a) => a.color);
    showTrajectoryFrame(1, container);
    await new Promise((r) => setTimeout(r, 200));
    const elFull1 = bondColors();
    const atoms1 = fileBrowser.selectedStructure.atoms.map((a) => a.color);

    return {
      lenFull0, lenFull1, okFast, bailReason, fastBefore, fastAfter,
      elFull0, elFull1, atoms0, atoms1,
    };
  }, TRAJ);

  H.check('length-mode bond colours change between frames on the FULL path',
    JSON.stringify(res.lenFull0) !== JSON.stringify(res.lenFull1), JSON.stringify(res));
  // The bail leaves the (stale) colours untouched: nothing half-applied, and
  // the caller's full rebuild is what recolours.
  H.check('length mode refuses the positions-only FAST path (applyFrameFast bails)',
    res.okFast === false && /colour mode/.test(res.bailReason || '')
      && JSON.stringify(res.fastBefore) === JSON.stringify(res.fastAfter),
    JSON.stringify(res));
  // Every snapshotted bond is a periodic image of the same C–C bond, so its
  // colour[0] (the srcIndices[0] endpoint, atom 0) equals atom 0's force colour.
  H.check('elements-mode bonds follow force-coloured atoms and change per frame',
    JSON.stringify(res.elFull0) !== JSON.stringify(res.elFull1)
      && res.elFull0.every((c) => c === res.atoms0[0])
      && res.elFull1.every((c) => c === res.atoms1[0]),
    JSON.stringify(res));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
