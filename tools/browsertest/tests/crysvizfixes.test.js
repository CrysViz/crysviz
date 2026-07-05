// Verifies the batch UI fixes: (a) .crysviz saves/loads a WHOLE trajectory,
// (b) Forces/Spins panels stay available without data, (c) the initial panel
// grey-out is applied on first load, (d) the Overall font scale var applies,
// (e) the Draw Bonds stubs are gone.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // --- (c) startup grey-out: some feature panels greyed before any click -----------
  const startup = await page.evaluate(async () => {
    const forces = document.querySelector('[data-panel-id="forces"]');
    const spins = document.querySelector('[data-panel-id="spins"]');
    // At least one feature panel should be greyed (cv-unavailable) on a plain load.
    const anyUnavailable = !!document.querySelector('.cv-panel.cv-unavailable');
    return {
      anyUnavailable,
      forcesGrey: forces?.classList.contains('cv-unavailable') ?? null,
      spinsGrey: spins?.classList.contains('cv-unavailable') ?? null,
    };
  });
  H.check('some panels are greyed on first load (grey-out applied at startup)',
    startup.anyUnavailable === true, JSON.stringify(startup));
  // --- (b) Forces/Spins never greyed even without data ------------------------------
  H.check('Forces/Spins panels are NOT greyed without data',
    startup.forcesGrey === false && startup.spinsGrey === false, JSON.stringify(startup));

  // --- (e) Draw Bonds stubs removed ------------------------------------------------
  const bonds = await page.evaluate(async () => {
    try {
      const { revealPanel } = await import('./ui/panels/PanelManager.js');
      revealPanel('bonds');
    } catch { /* panel may already be built */ }
    return {
      drawBtn: !!document.getElementById('drawBondBtn'),
      histogram: !!document.getElementById('histogramsPanel'),
    };
  });
  H.check('Draw Bonds stub button is gone (Histograms section still present)',
    bonds.drawBtn === false && bonds.histogram === true, JSON.stringify(bonds));

  // --- (d) Overall font scale sets --cv-font-scale ---------------------------------
  const fs = await page.evaluate(async () => {
    const m = await import('./ui/FontScaleModule.js');
    m.applyFontScale(1.4);
    const applied = getComputedStyle(document.documentElement).getPropertyValue('--cv-font-scale').trim();
    m.applyFontScale(1); // restore
    return { applied };
  });
  H.check('font scale writes --cv-font-scale', fs.applied === '1.4', JSON.stringify(fs));

  // --- (a) .crysviz whole-trajectory round-trip ------------------------------------
  const TRAJ = [
    '3', 'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.0 0.0 0.0', 'Cl 2.0 0.0 0.0', 'Cl 0.0 2.0 0.0',
    '3', 'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.1 0.0 0.0', 'Cl 2.1 0.0 0.0', 'Cl 0.1 2.0 0.0',
    '3', 'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3',
    'Na 0.2 0.0 0.0', 'Cl 2.2 0.0 0.0', 'Cl 0.2 2.0 0.0',
  ].join('\n');
  await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(traj, 'traj.xyz');
  }, TRAJ);
  await page.waitForTimeout(1500);

  const saved = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState({ includeFrames: true });
    return { frames: state.frames?.length ?? 0, version: state.version };
  });
  H.check('captureState(includeFrames) saves all 3 trajectory frames',
    saved.frames === 3, JSON.stringify(saved));

  const restored = await page.evaluate(async () => {
    const { applySharedState, captureState } = await import('./ui/ShareModule.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const s = captureState({ includeFrames: true });
    applySharedState(s, 'roundtrip.crysviz');
    await new Promise((r) => setTimeout(r, 800));
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    return { frameCount: container?.structures?.length ?? 0 };
  });
  H.check('applySharedState rebuilds a 3-frame trajectory container',
    restored.frameCount === 3, JSON.stringify(restored));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
