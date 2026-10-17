// Frame-dependent colour maps and the trajectory player's render path.
//
// Atoms-by-force and bonds-by-length colours change every frame, but the render
// fast path (applyFrameFast) moves instances without recolouring them. So:
//   - isFrameDependentColorMode() names exactly those modes (one predicate);
//   - applyFrameFast bails on them, and the player's Auto mode falls back to a
//     full rebuild per frame — playback therefore stays correctly coloured;
//   - the player shows a small "full render each frame (slower)" note while
//     such a mode is active, kept in sync with the Colors dropdowns.
'use strict';
const H = require('../harness');

// 3 frames, one system in motion (tiny drift → motionProfile 'trajectory', so
// Auto WOULD take the fast path for static colours), forces differing per frame.
const TRAJ = [
  '2',
  'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0 0 0 1 0 0', 'C 1.3 0 0 2 0 0',
  '2',
  'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0.02 0 0 5 0 0', 'C 1.32 0 0 6 0 0',
  '2',
  'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:forces:R:3',
  'C 0.04 0 0 9 0 0', 'C 1.34 0 0 9.5 0 0',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, fileBrowser, structureShip } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const { addColorPanel, atomForceToColor } = await import('./ui/ColorPanel.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { applyFrameFast, lastFastFrameBail, isFrameDependentColorMode } = await import('./render/FastFrameModule.js');

    await cv.loadStructure(traj, 'note.xyz');
    openPanel('trajectory');
    const colorHost = document.createElement('div');
    colorHost.id = 'colorHostForTest';
    document.body.appendChild(colorHost);
    addColorPanel('colorHostForTest');
    await new Promise((r) => setTimeout(r, 300));

    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const note = document.getElementById('trajRenderNote');
    const noteShown = () => !!note && !note.hidden && getComputedStyle(note).display !== 'none';
    const select = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('change'));
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const initial = { predicate: isFrameDependentColorMode(), noteShown: noteShown(), noteExists: !!note };

    // --- Atoms → Force through the real dropdown ---
    select('atomsMenu', 'force');
    await wait(150);
    // Fixed range so a magnitude maps to the same colour in every frame.
    general.ForceMin = 0; general.ForceMax = 10;
    showTrajectoryFrame(0, container);
    await wait(150);
    const afterForce = { predicate: isFrameDependentColorMode(), noteShown: noteShown(), mode: general.atomsColor };

    // --- The fast path refuses these frames ---
    container.frameAt(1);
    const fastOk = applyFrameFast(fileBrowser.selectedStructure);
    const bailReason = lastFastFrameBail();

    // --- Auto playback stays correctly coloured (falls back to full) ---
    container.playbackMode = 'auto';
    showTrajectoryFrame(0, container);
    await wait(150);
    document.getElementById('speedSelect').value = '50';
    const play = document.getElementById('playPauseBtn');
    const samples = [];
    play.click();
    for (let i = 0; i < 10; i++) {
      await wait(60);
      samples.push({ step: fileBrowser.stepInput, colors: fileBrowser.selectedStructure.atoms.map((a) => a.color) });
    }
    play.click();
    await wait(150);
    const mags = [[1, 2], [5, 6], [9, 9.5]];
    const expectedFor = (step) => mags[step].map((m) => atomForceToColor(m));
    const playbackCorrect = samples.every((s) => JSON.stringify(s.colors) === JSON.stringify(expectedFor(s.step)));
    const stepsSeen = new Set(samples.map((s) => s.step)).size;

    // --- Back to Elements: note hides; Bonds → Length: note shows; back: hides ---
    select('atomsMenu', 'elements');
    await wait(100);
    const afterElements = { predicate: isFrameDependentColorMode(), noteShown: noteShown() };
    general.showBonds = true;
    select('bondsMenu', 'length');
    await wait(150);
    const afterLength = { predicate: isFrameDependentColorMode(), noteShown: noteShown(), mode: general.bondsColor };
    select('bondsMenu', 'elements');
    await wait(100);
    const afterBondsBack = { predicate: isFrameDependentColorMode(), noteShown: noteShown() };

    return {
      initial, afterForce, fastOk, bailReason, samples, playbackCorrect, stepsSeen,
      afterElements, afterLength, afterBondsBack,
    };
  }, TRAJ);

  H.check('no colour map: predicate false and the note is hidden',
    res.initial.noteExists && res.initial.predicate === false && res.initial.noteShown === false,
    JSON.stringify(res.initial));
  H.check('Atoms → Force (via the dropdown): predicate true, note shown',
    res.afterForce.predicate === true && res.afterForce.noteShown === true && res.afterForce.mode === 'force',
    JSON.stringify(res.afterForce));
  H.check('applyFrameFast bails for a frame-dependent colour map',
    res.fastOk === false && /colour mode/.test(res.bailReason || ''), `ok=${res.fastOk} bail=${res.bailReason}`);
  H.check('Auto playback stays correctly force-coloured on every sampled frame (full fallback)',
    res.playbackCorrect && res.stepsSeen >= 2, JSON.stringify({ stepsSeen: res.stepsSeen, samples: res.samples }));
  H.check('Atoms → Elements: predicate false, note hidden',
    res.afterElements.predicate === false && res.afterElements.noteShown === false, JSON.stringify(res.afterElements));
  H.check('Bonds → Length: predicate true, note shown',
    res.afterLength.predicate === true && res.afterLength.noteShown === true && res.afterLength.mode === 'length',
    JSON.stringify(res.afterLength));
  H.check('Bonds → Elements: predicate false, note hidden',
    res.afterBondsBack.predicate === false && res.afterBondsBack.noteShown === false, JSON.stringify(res.afterBondsBack));

  // The trajectory panel lazy-loads Plotly from a CDN; in a sandbox without
  // egress that one fetch fails with ERR_TUNNEL_CONNECTION_FAILED and is not
  // this test's concern. Every other error still fails the check.
  const realErrors = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED/.test(e));
  H.check('no page errors', realErrors.length === 0, realErrors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
