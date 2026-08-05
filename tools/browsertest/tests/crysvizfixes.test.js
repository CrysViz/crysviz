// Verifies the batch UI fixes: (a) .crysviz saves/loads a WHOLE trajectory,
// (b) Forces/Spins panels stay available without data, (c) the initial panel
// grey-out is applied on first load, (d) the Overall font scale var applies,
// (e) the Draw Bonds stubs are gone, and native select chrome is normalized.
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
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

  // --- (d) Overall font scale actually resizes headlines, labels, buttons ----------
  const fscale = await page.evaluate(async () => {
    const { revealPanel } = await import('./ui/panels/PanelManager.js');
    try { revealPanel('visual'); revealPanel('settings'); } catch { /* */ }
    const m = await import('./ui/FontScaleModule.js');
    const px = (sel) => {
      const el = document.querySelector(sel);
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    };
    const measure = () => ({
      headline: px('.cv-panel-body .panel-headline'),
      label: px('.cv-panel-body label'),
      button: px('.cv-panel-body button'),
    });
    m.applyFontScale(1); const at1 = measure();
    m.applyFontScale(2); const at2 = measure();
    m.applyFontScale(1); // restore
    return { at1, at2 };
  });
  const scaled = (a, b) => a && b && Math.abs(b - a * 2) < 0.6;
  H.check('font scale resizes headline, label, and button text (2x)',
    scaled(fscale.at1.headline, fscale.at2.headline)
      && scaled(fscale.at1.label, fscale.at2.label)
      && scaled(fscale.at1.button, fscale.at2.button),
    JSON.stringify(fscale));

  // --- Native <select> chrome is normalized across browser/webview engines ------
  const selectStyle = await page.evaluate(() => {
    const el = document.getElementById('renderPipelineMenu');
    if (!el) return { present: false };
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      present: true,
      appearance: style.appearance,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      color: style.color,
      fontSize: style.fontSize,
      height: rect.height,
    };
  });
  H.check('dropdown opts out of native chrome and supplies the shared chevron',
    selectStyle.present === true
      && selectStyle.appearance === 'none'
      && selectStyle.backgroundImage !== 'none',
    JSON.stringify(selectStyle));

  const selectShotPath = path.join(__dirname, '..', 'artifacts', 'select-style.png');
  await page.locator('#renderPipelineMenu').screenshot({ path: selectShotPath });
  const selectPng = PNG.sync.read(fs.readFileSync(selectShotPath));
  let darkPixels = 0;
  for (let i = 0; i < selectPng.width * selectPng.height; i++) {
    const offset = i * 4;
    if (selectPng.data[offset] < 100
      && selectPng.data[offset + 1] < 100
      && selectPng.data[offset + 2] < 100) darkPixels++;
  }
  const darkFraction = darkPixels / (selectPng.width * selectPng.height);
  H.check('dropdown renders as a compact dark control',
    selectPng.height < 30 && darkFraction > 0.55,
    JSON.stringify({ width: selectPng.width, height: selectPng.height, darkFraction, selectStyle }));

  // --- (f) Visual background swatch mirrors the scene background --------------------
  const swatch = await page.evaluate(async () => {
    const { revealPanel } = await import('./ui/panels/PanelManager.js');
    try { revealPanel('visual'); } catch { /* */ }
    const THREE = await import('./external/three/three.module.js');
    const { app } = await import('./state/store.js');
    const { syncBackgroundSwatch } = await import('./ui/BackgroundPicker.js');
    const el = document.getElementById('backgroundSwatch');
    if (!el) return { present: false };
    // Simulate a background change made elsewhere (e.g. the canvas dot picker).
    app.scene.background = new THREE.Color('#123456');
    syncBackgroundSwatch();
    const bg = getComputedStyle(el).backgroundColor;
    return { present: true, bg };
  });
  H.check('background swatch tracks scene background changes made elsewhere',
    swatch.present === true && swatch.bg === 'rgb(18, 52, 86)', JSON.stringify(swatch));

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

  // --- double-click with "Show Bonds" off must not throw ---------------------------
  // Regression: disposeBondsMesh nulls groups.bondsMesh, and onDoubleClickAtom
  // raycast it unguarded -> "can't access property 'layers', object is null"
  // (which also aborted polyhedron double-click selection).
  const bondsMeshGone = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    document.getElementById('showBonds').click(); // uncheck -> disposes the bonds mesh
    await new Promise((r) => setTimeout(r, 300));
    return groups.bondsMesh === null;
  });
  // Real input event (a synthetic dispatchEvent would not surface a listener
  // exception as a pageerror), on the pure-canvas region.
  await page.mouse.dblclick(900, 450);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('showBonds').click()); // restore
  H.check('double-click with bonds hidden exercises the null-mesh path',
    bondsMeshGone === true, `bondsMeshGone=${bondsMeshGone}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
