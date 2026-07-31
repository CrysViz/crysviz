// Repro: does a distance measurement survive a .crysviz save/load round-trip?
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // A 3-frame trajectory (the path where the .crysviz loader rebuilds a
  // container and lands on the saved frame) — the case measurements weren't
  // surviving.
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
  await page.waitForTimeout(1200);

  // Add a distance measurement between the first two atoms, the way a click
  // does — atom proxies carrying userData.atomIndex/element and a scene position.
  const added = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { fileBrowser, measurements } = await import('./state/store.js');
    const { addDistanceMeasurement, addAngleMeasurement } = await import('./render/MeasurementModule.js');
    const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
    const proxyFor = (atomIndex) => {
      for (let i = 0; i < wrapped.cart.length; i++) {
        const srcIdx = wrapped.srcIndex ? wrapped.srcIndex[i] : i;
        if (srcIdx !== atomIndex) continue;
        return {
          position: new THREE.Vector3(...wrapped.cart[i]),
          userData: { atomIndex: srcIdx, element: wrapped.elements[i], wrappedFrac: wrapped.frac?.[i] ? [...wrapped.frac[i]] : null },
        };
      }
      return null;
    };
    addDistanceMeasurement(proxyFor(0), proxyFor(1));
    addAngleMeasurement(proxyFor(0), proxyFor(1), proxyFor(2));
    return { labelCount: measurements.measureLabels.length };
  });
  H.check('a distance + an angle measurement added', added.labelCount === 2, JSON.stringify(added));

  // Capture: the measurements block must carry both, each with its atom refs.
  const cap = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState({ includeFrames: true });
    const types = (state.measurements ?? []).map((m) => m.type).sort();
    return {
      count: state.measurements?.length ?? 0,
      types,
      distOk: (state.measurements ?? []).some((m) => m.type === 'distance' && m.atom1Ref?.atomIndex === 0 && m.atom2Ref?.atomIndex === 1),
      angOk: (state.measurements ?? []).some((m) => m.type === 'angle' && m.atom1Ref?.atomIndex === 0 && m.atom2Ref?.atomIndex === 1 && m.atom3Ref?.atomIndex === 2),
    };
  });
  H.check('save captures both measurements with their atom refs',
    cap.count === 2 && cap.distOk && cap.angOk, JSON.stringify(cap));

  // Restore: clear first (simulate a fresh session opening the file), reload
  // the captured state and confirm exactly one measurement reappears.
  const restored = await page.evaluate(async () => {
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { measurements } = await import('./state/store.js');
    const { clearAllMeasurements } = await import('./render/MeasurementModule.js');
    const state = captureState({ includeFrames: true });
    clearAllMeasurements();
    applySharedState(state, 'roundtrip.crysviz');
    await new Promise((r) => setTimeout(r, 900)); // restoreMeasurements polls for the wrap
    return { labelCount: measurements.measureLabels.length };
  });
  H.check('reload restores both measurements',
    restored.labelCount === 2, JSON.stringify(restored));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
