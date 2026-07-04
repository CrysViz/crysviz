// Trajectory style propagation: the "Apply styles to trajectory" button copies
// all style stores from the current frame to every frame; frame switching then
// renders the propagated styles.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // The default (single-frame) structure must NOT show the button.
  const singleFrame = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    return { buttonPresent: !!document.getElementById('applyStylesToTrajectoryBtn') };
  });
  H.check('no trajectory button for single-frame structures',
    singleFrame.buttonPresent === false, JSON.stringify(singleFrame));

  // --- Load an inline 2-frame extxyz trajectory -----------------------------------
  const TRAJ = [
    '3',
    'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.0 0.0 0.0',
    'Cl 2.0 0.0 0.0',
    'Cl 0.0 2.0 0.0',
    '3',
    'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.1 0.0 0.0',
    'Cl 2.1 0.0 0.0',
    'Cl 0.1 2.0 0.0',
  ].join('\n');
  await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(traj, 'traj.xyz');
  }, TRAJ);
  await page.waitForTimeout(2000);

  // --- Style frame 0 and propagate -------------------------------------------------
  const before = await page.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const s = fileBrowser.selectedStructure;
    s.bondCategoryStyles['Cl-Na'] = { color: '#ff0000', alpha: 0.5 };
    s.atoms[0].userColor = '#00ff00';
    s.atoms[0].color = '#00ff00';
    return {
      frames: container.structures.length,
      frameIndex: container.structures.indexOf(s),
      buttonPresent: !!document.getElementById('applyStylesToTrajectoryBtn'),
      otherFrameEmpty: Object.keys(
        container.structures.find((f) => f !== s)?.bondCategoryStyles ?? {}).length === 0,
    };
  });
  H.check('2-frame trajectory loaded with the button present and other frame unstyled',
    before.frames === 2 && before.buttonPresent && before.otherFrameEmpty,
    JSON.stringify(before));

  await H.clickById(page, 'applyStylesToTrajectoryBtn');
  const propagated = await page.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const current = fileBrowser.selectedStructure;
    const other = container.structures.find((f) => f !== current);
    return {
      otherCatStyle: other.bondCategoryStyles['Cl-Na'],
      distinctObjects: other.bondCategoryStyles !== current.bondCategoryStyles,
      otherAtomColor: other.atoms[0].color,
    };
  });
  H.check('button deep-copies stores and atom colors to the other frame',
    propagated.otherCatStyle?.color === '#ff0000'
      && propagated.otherCatStyle?.alpha === 0.5
      && propagated.distinctObjects
      && propagated.otherAtomColor === '#00ff00',
    JSON.stringify(propagated));

  // --- Switch frames like the TrajectoryPanel does; styles must render ------------
  const switched = await page.evaluate(async () => {
    const { fileBrowser, structureShip, groups, general } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const nextIndex = container.structures.indexOf(fileBrowser.selectedStructure) === 0 ? 1 : 0;
    fileBrowser.selectedStructure = container.structures[nextIndex];
    fileBrowser.stepInput = nextIndex;
    const counterBefore = general.bondsBuildCounter;
    await updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    for (let i = 0; i < 50 && general.bondsBuildCounter === counterBefore; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = fileBrowser.selectedStructure;
    const bond = s.bonds.find((b) => b.instanceIds);
    return {
      frameIndex: nextIndex,
      bondColor: bond?.color?.[0],
      bondOpacity: bond
        ? groups.bondsMesh.geometry.attributes.instanceOpacity.getX(bond.instanceIds[0])
        : null,
    };
  });
  H.check('after switching frames the propagated category style renders',
    switched.bondColor === '#ff0000' && Math.abs(switched.bondOpacity - 0.5) < 1e-6,
    JSON.stringify(switched));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
