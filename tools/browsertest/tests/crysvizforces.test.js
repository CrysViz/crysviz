// Issue #53: the .crysviz save embeds the per-atom force & spin arrows shown
// on screen, drops the top-level `structure` that duplicated the viewed frame,
// and the loader restores both the arrow data and the display toggles — so a
// reopened file "replicates what you see on the screen".
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Give the loaded structure a spread of forces AND spins, turn both on, and
  // nudge a couple of display knobs off their defaults so the restore is
  // observable rather than accidentally matching the fresh session.
  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force, Spin } = await import('./model/index.js');
    const { updateForces, updateSpins } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.forces = s.atoms.map((_, i) => new Force({ vector: [0.1 + i * 0.3, 0.05, -0.02 * i] }));
    s.spins = s.atoms.map((_, i) => new Spin({ vector: [0, 0, i % 2 ? 1 : -1], scaling: 1 }));
    // SpinModule only draws a species whose #speciesVisibilityContainer checkbox
    // is checked — the Spins panel builds these in the real app; stand them in
    // here (persists in the DOM across the reload below) so the arrows render.
    const vis = document.createElement('div');
    vis.id = 'speciesVisibilityContainer';
    [...new Set(s.elements)].forEach((el) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'species-' + el; cb.checked = true;
      vis.appendChild(cb);
    });
    document.body.appendChild(vis);
    general.forcesActive = true;
    general.spinsActive = true;
    general.forceScale = 1.7;
    general.forceColorMap = 'element';
    updateForces(general.forceScale, general.forceColorMap);
    updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap);
  });
  await page.waitForTimeout(200);

  // --- Capture: forces/spins embedded per frame, no duplicated `structure` ----
  const cap = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const state = captureState({ includeFrames: true });
    return {
      hasTopLevelStructure: 'structure' in state,
      frameCount: state.frames?.length ?? 0,
      selectedFrameIndex: state.selectedFrameIndex,
      f0: state.frames?.[0]?.forces?.length ?? 0,
      s0: state.frames?.[0]?.spins?.length ?? 0,
      savedForce: state.frames?.[0]?.forces?.[1]?.vector ?? null, // atom 1
      liveForce: [...s.forces[1].vector],
      forcesActive: state.display?.forcesActive,
      spinsActive: state.display?.spinsActive,
      forceScale: state.display?.forceScale,
      forceColorMap: state.display?.forceColorMap,
      atomCount: s.atoms.length,
    };
  });
  H.check('save embeds per-atom forces in the frame (issue #53.2)',
    cap.f0 === cap.atomCount && cap.f0 > 0, JSON.stringify(cap));
  H.check('save embeds per-atom spins in the frame',
    cap.s0 === cap.atomCount, JSON.stringify(cap));
  H.check('saved force vector matches the live structure',
    JSON.stringify(cap.savedForce) === JSON.stringify(cap.liveForce), JSON.stringify(cap));
  H.check('no duplicated top-level `structure` when frames are present (issue #53.1)',
    cap.hasTopLevelStructure === false, JSON.stringify(cap));
  H.check('selectedFrameIndex records the viewed frame',
    typeof cap.selectedFrameIndex === 'number', JSON.stringify(cap));
  H.check('force/spin display state is captured (issue #53.3)',
    cap.forcesActive === true && cap.spinsActive === true
      && Math.abs(cap.forceScale - 1.7) < 1e-9 && cap.forceColorMap === 'element',
    JSON.stringify(cap));

  // --- Restore: wipe the arrows + toggles, then reload the captured state -----
  const restored = await page.evaluate(async () => {
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { fileBrowser, general, groups } = await import('./state/store.js');
    const { removeForces, removeSpins } = await import('./render/index.js');
    const state = captureState({ includeFrames: true });
    const savedForce = state.frames[0].forces[1].vector;
    // Simulate a clean session: arrows off, meshes gone, defaults back.
    general.forcesActive = false; general.spinsActive = false;
    general.forceScale = 1.0; general.forceColorMap = 'heatmap';
    removeForces(); removeSpins();
    applySharedState(state, 'roundtrip.crysviz');
    await new Promise((r) => setTimeout(r, 500));
    const s = fileBrowser.selectedStructure;
    return {
      forcesLen: s?.forces?.length ?? 0,
      spinsLen: s?.spins?.length ?? 0,
      restoredForce: s?.forces?.[1] ? [...s.forces[1].vector] : null,
      savedForce,
      forcesActive: general.forcesActive,
      spinsActive: general.spinsActive,
      forceScale: general.forceScale,
      forceColorMap: general.forceColorMap,
      forceArrows: groups.forcesShaftMesh?.count ?? 0,
      spinArrows: groups.spinShaftMesh?.count ?? 0,
    };
  });
  H.check('reload restores force + spin data on the structure',
    restored.forcesLen > 0 && restored.spinsLen > 0, JSON.stringify(restored));
  H.check('restored force keeps its atom-aligned vector',
    JSON.stringify(restored.restoredForce) === JSON.stringify(restored.savedForce), JSON.stringify(restored));
  H.check('reload restores the display toggles + settings',
    restored.forcesActive === true && restored.spinsActive === true
      && Math.abs(restored.forceScale - 1.7) < 1e-9 && restored.forceColorMap === 'element',
    JSON.stringify(restored));
  H.check('reload redraws the force AND spin arrows on screen',
    restored.forceArrows > 0 && restored.spinArrows > 0, JSON.stringify(restored));

  // Full-app default of the new "Show spins on periodic copies" toggle: OFF,
  // and the checkbox is built unchecked.
  const copies = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { addSpinPanel } = await import('./ui/SpinPanel.js');
    const host = document.createElement('div');
    host.id = 'cvPanelBody-spins-test';
    document.body.appendChild(host);
    addSpinPanel('cvPanelBody-spins-test');
    const cb = document.getElementById('spinShowCopiesCheckbox');
    return { flag: general.showSpinsOnCopies, exists: !!cb, checked: cb ? cb.checked : null };
  });
  H.check('full app: Show-spins-on-copies toggle exists and defaults off',
    copies.flag === false && copies.exists === true && copies.checked === false, JSON.stringify(copies));

  // Item 3: "Auto" spin scaling — d_target = 0.9*min(d(mag→non), d(mag→mag)),
  // scale = d_target/L_max, clamped to the slider range. Plain 0.9*d on BOTH
  // terms because arrows render centered on their atom (an arrow of length d
  // reaches only d/2 each way), so the non-touching cap for a magnetic pair is
  // the full separation d, not d/2. "magnetic" uses the same 0.05 draw cutoff
  // updateSpins() draws by. This fixture has spins on EVERY atom (no
  // non-magnetic), so only the mag→mag term applies. Expected recomputed inline
  // (independent of autoSpinScale) to catch a formula regression.
  const auto = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { autoSpinScale } = await import('./render/index.js');
    general.spinsActive = true;
    const s = fileBrowser.selectedStructure;
    let Lmax = 0; const mag = new Set();
    s.spins.forEach((sp, i) => { const v = sp.vector; if (!v) return; const m = Math.hypot(v[0], v[1], v[2]); if (m >= 0.05) { mag.add(i); Lmax = Math.max(Lmax, m * (sp.scaling ?? 1)); } });
    const w = s.periodic.visibleWrapped ?? s.periodic.wrapped; const cart = w.cart; const si = w.srcIndex;
    const isMag = (i) => mag.has(si ? si[i] : i);
    let dMN = Infinity, dMM = Infinity;
    for (let i = 0; i < cart.length; i++) { if (!isMag(i)) continue; const a = cart[i]; for (let j = 0; j < cart.length; j++) { if (j === i) continue; const b = cart[j]; const d = Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]); if (d <= 1e-6) continue; if (isMag(j)) { if (d < dMM) dMM = d; } else if (d < dMN) dMN = d; } }
    const terms = [];
    if (Number.isFinite(dMN)) terms.push(0.9 * dMN);
    if (mag.size >= 2 && Number.isFinite(dMM)) terms.push(0.9 * dMM);
    const expected = Math.min(Math.max(Math.min(...terms) / Lmax, 0.1), 10);
    const fn = autoSpinScale(s); // the shared fn the button calls
    const before = general.spinScale;
    document.getElementById('spinAutoScaleBtn').click();
    return { before, after: general.spinScale, expected, fn: Math.min(Math.max(fn, 0.1), 10), noNonMag: !Number.isFinite(dMN) };
  });
  H.check('Auto spin scaling = 0.9*min(d(mag-non), d(mag-mag))/L_max (mag-mag only here)',
    auto.noNonMag === true && Math.abs(auto.after - auto.expected) < 1e-6 && Math.abs(auto.after - auto.fn) < 1e-6, JSON.stringify(auto));

  // Item 4: arrowhead length slider drives general.spinTipLength (default 0.4).
  const tip = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const sl = /** @type {HTMLInputElement} */ (document.getElementById('spinTipLengthSlider'));
    const def = general.spinTipLength;
    sl.value = '0.2'; sl.dispatchEvent(new Event('input'));
    return { def, defaultAttr: parseFloat(sl.value), flag: general.spinTipLength };
  });
  H.check('arrowhead length default is 0.4 and the slider updates it',
    Math.abs(tip.def - 0.4) < 1e-9 && Math.abs(tip.flag - 0.2) < 1e-9, JSON.stringify(tip));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
