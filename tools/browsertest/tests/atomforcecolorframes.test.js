// Force-based atom colouring must stay live across trajectory frames. The bug:
// switching the Atoms colour mode to "Force" painted only the frame it was
// switched on — every later frame (scrub, step, playback, or a live MD stream)
// reset atom.color to the element default (materializeFrame.applyFrameStyles)
// and nothing recomputed the force colours for the new frame. The fix
// re-applies the active colour mode whenever a frame is displayed:
//   - full renders go through updateVisualization (central hook);
//   - the trajectory fast path and the live-MD stream push colours explicitly
//     (reapplyAtomForceColors + refreshAtomColors), because they bypass it.
// This test drives both: a settle step between two frames whose per-atom forces
// differ, and a direct fast-path recolour.
'use strict';
const H = require('../harness');

// Two frames, extended-XYZ with a forces column (species + pos(3) + forces(3)).
// Atom force magnitudes differ between the frames AND between the two atoms, so
// a correct colouring must yield four distinct, frame-specific colours. The
// atoms barely move (0.05 Å) so the run reads as one system in motion.
const TRAJ = [
  '2',
  'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 0 0 0 1 0 0',
  'Cl 2 0 0 2 0 0',
  '2',
  'Lattice="6 0 0 0 6 0 0 0 6" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 0.05 0 0 8 0 0',
  'Cl 2.05 0 0 9 0 0',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, fileBrowser, structureShip, groups } = await import('./state/store.js');
    const { atomForceToColor, reapplyAtomForceColors } = await import('./ui/ColorPanel.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { refreshAtomColors } = await import('./render/index.js');

    await cv.loadStructure(traj, 'forcecolor.xyz');
    await new Promise((r) => setTimeout(r, 150));

    const container = structureShip.container[fileBrowser.selectedRowIndex];

    // Settle on frame 0 (a multi-frame load opens on the last frame). Driven
    // through showTrajectoryFrame (a proper/full load, exactly like the player's
    // step buttons and slider-release) so the test needs no plot panel.
    showTrajectoryFrame(0, container);
    await new Promise((r) => setTimeout(r, 150));

    // Engage force colouring with a FIXED range (0..10) that spans both frames,
    // so a magnitude maps to the same colour in every frame — the comparable
    // scale the fix keeps stable. Then re-render frame 0 to apply it.
    general.atomsColor = 'force';
    general.atomColorMap = 'heatmap';
    general.atomColorScale = 'linear';
    general.ForceMin = 0;
    general.ForceMax = 10;
    cv.updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    await new Promise((r) => setTimeout(r, 100));

    const colorsNow = () => fileBrowser.selectedStructure.atoms.map((a) => a.color);
    const meshColorsNow = () => Array.from(groups.atomsMesh.instanceColor.array);

    const frame0 = colorsNow();
    const frame0Mesh = meshColorsNow();

    // --- Settle step to frame 1 (proper load → full render → central hook) ----
    showTrajectoryFrame(1, container);
    await new Promise((r) => setTimeout(r, 200));

    const frame1 = colorsNow();
    const frame1Mesh = meshColorsNow();

    // Expected colours from each frame's OWN force magnitudes at the fixed range.
    const expFrame0 = [atomForceToColor(1), atomForceToColor(2)];
    const expFrame1 = [atomForceToColor(8), atomForceToColor(9)];

    // --- Fast-path recolour: exercise the exact helpers the playback fast path
    //     and the live-MD stream call. frameAt(0) applies frame 0's physics in
    //     place and resets colours to element defaults (as the position-only
    //     fast write would leave them); the helpers must restore frame 0's
    //     force colours and push them to the mesh. -----------------------------
    container.frameAt(0);
    const afterReset = colorsNow(); // element defaults, not force colours
    const ran = reapplyAtomForceColors(fileBrowser.selectedStructure);
    if (ran) refreshAtomColors();
    const afterFast = colorsNow();
    const afterFastMesh = meshColorsNow();

    return {
      frame0, frame1, expFrame0, expFrame1,
      frame0MeshChanged: JSON.stringify(frame0Mesh) !== JSON.stringify(frame1Mesh),
      afterResetWasDefault: JSON.stringify(afterReset) !== JSON.stringify(expFrame0),
      ran,
      afterFast,
      afterFastMeshChanged: JSON.stringify(afterFastMesh) !== JSON.stringify(frame1Mesh),
    };
  }, TRAJ);

  H.check('frame 0 force colours match its own force magnitudes',
    JSON.stringify(res.frame0) === JSON.stringify(res.expFrame0), JSON.stringify(res));
  H.check('frame 1 force colours TRACK frame 1 (colour map stays active across frames)',
    JSON.stringify(res.frame1) === JSON.stringify(res.expFrame1), JSON.stringify(res));
  H.check('force colours actually change between frames (not frozen)',
    JSON.stringify(res.frame0) !== JSON.stringify(res.frame1), JSON.stringify(res));
  H.check('the atoms mesh instance colours change with the frame',
    res.frame0MeshChanged === true, JSON.stringify(res));
  H.check('fast-path helpers restore force colours after a position-only frame write',
    res.ran === true && res.afterResetWasDefault === true
      && JSON.stringify(res.afterFast) === JSON.stringify(res.expFrame0)
      && res.afterFastMeshChanged === true,
    JSON.stringify(res));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
