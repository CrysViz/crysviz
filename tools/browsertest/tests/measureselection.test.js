// Measuring with atoms selected: the selection's glow goes off the moment a
// measure tool is turned on, the measurement's own picks glow while it is
// made, and the selection glows again when the tool is turned off — the
// selection itself (and the Selection Inspector on it) is kept throughout.
// See ui/SelectAndHighlightModule.js pauseSelectionGlowForMeasure.
//
//   - two selected atoms glow; Distance on: no glow, still selected
//   - a distance measured by clicking two other atoms: the measurement is
//     made, the selection still does not glow
//   - Distance → Angle: still off; Angle off again: the selection glows again
//   - the same through Clear all (the tool off with it)
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  // Every visible instance's screen point, where a click really hits it.
  const pickable = () => page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, groups, fileBrowser } = await import('./state/store.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const rect = app.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    const out = [];
    for (let i = 0; i < w.cart.length; i++) {
      const p = new THREE.Vector3(...w.cart[i]).project(app.camera);
      if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) continue;
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), app.camera);
      const hit = ray.intersectObject(groups.atomsMesh)[0];
      if (hit?.instanceId !== i) continue;
      const x = rect.left + (p.x + 1) / 2 * rect.width, y = rect.top + (1 - p.y) / 2 * rect.height;
      if (document.elementFromPoint(x, y) !== app.renderer.domElement) continue; // under a window
      out.push({ i, src: w.srcIndex[i], x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height });
    }
    return out;
  });
  const glow = (instances) => page.evaluate(async (ids) => {
    const { groups } = await import('./state/store.js');
    const a = groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity;
    return ids.map((i) => a.getX(i));
  }, instances);
  const selection = () => page.evaluate(async () => {
    const { getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const { measurements, mode } = await import('./state/store.js');
    return {
      selected: getSelectedAtoms().map((a) => a.sourceIndex),
      inspector: getSelectionInspectorState()?.atoms ?? null,
      measurements: measurements.measureLabels.length,
      mode: mode.measureMode,
    };
  });

  const spots = await pickable();
  const bySrc = new Map();
  for (const s of spots) if (!bySrc.has(s.src)) bySrc.set(s.src, s);
  const distinct = [...bySrc.values()];
  H.check('enough atoms to click', distinct.length >= 4, String(distinct.length));
  const [selA, selB] = distinct;

  // Select two atoms, open the Selection Inspector.
  const selInstances = await page.evaluate(async ({ a, b }) => {
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomsByInstances([a, b]);
    const { openSelectionInspector } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    openSelectionInspector();
    const { fileBrowser } = await import('./state/store.js');
    const st = fileBrowser.selectedStructure;
    // Linked copies: every image of the two atoms glows.
    return [a, b].flatMap((i) => st.atomImages[st.periodic.visibleWrapped.srcIndex[i]]);
  }, { a: selA.i, b: selB.i });
  await page.waitForTimeout(800);
  // Where to click now that the inspector is docked: two other atoms.
  const free = [...new Map((await pickable()).filter((p) => p.src !== selA.src && p.src !== selB.src)
    .map((p) => [p.src, p])).values()];
  const [pickA, pickB] = free;
  H.check('two other atoms to measure, clear of any window', !!pickA && !!pickB, JSON.stringify(free.length));
  let g = await glow(selInstances);
  let s = await selection();
  H.check('two selected atoms glow, the inspector shows them', g.every((v) => v > 0) && s.selected.length === 2 && s.inspector === 2,
    JSON.stringify({ g, s }));

  // ---- Distance on: the glow goes off, the selection stays -------------------------
  await H.clickById(page, 'distanceModeBtn');
  await page.waitForTimeout(200);
  g = await glow(selInstances);
  s = await selection();
  H.check('Distance on: the selection no longer glows, but is still selected (and inspected)',
    s.mode === 'distance' && g.every((v) => v === 0) && s.selected.length === 2 && s.inspector === 2, JSON.stringify({ g, s }));

  // ---- measure two other atoms --------------------------------------------------------
  await page.mouse.click(pickA.x, pickA.y);
  await page.waitForTimeout(250);
  const pickGlow = await glow([pickA.i]);
  await page.mouse.click(pickB.x, pickB.y);
  await page.waitForTimeout(400);
  g = await glow(selInstances);
  s = await selection();
  H.check('the first pick glows while the measurement is made',
    pickGlow[0] > 0, JSON.stringify(pickGlow));
  H.check('a distance is measured; the selection still does not glow and is kept',
    s.measurements === 1 && g.every((v) => v === 0) && s.selected.length === 2, JSON.stringify({ g, s }));

  // ---- Distance → Angle → off ----------------------------------------------------------
  await H.clickById(page, 'angleModeBtn');
  await page.waitForTimeout(200);
  g = await glow(selInstances);
  s = await selection();
  H.check('switching to Angle keeps the glow off', s.mode === 'angle' && g.every((v) => v === 0), JSON.stringify({ g, s }));
  await H.clickById(page, 'angleModeBtn');
  await page.waitForTimeout(300);
  g = await glow(selInstances);
  s = await selection();
  H.check('Angle off: the selection glows again; the measurement stays',
    s.mode === 'none' && g.every((v) => v > 0) && s.selected.length === 2 && s.measurements === 1, JSON.stringify({ g, s }));

  // ---- Clear all turns the tool off too ------------------------------------------------
  await H.clickById(page, 'distanceModeBtn');
  await page.waitForTimeout(200);
  const offAgain = await glow(selInstances);
  await H.clickById(page, 'clearAllMeasurements');
  await page.waitForTimeout(300);
  g = await glow(selInstances);
  s = await selection();
  H.check('Clear all (with Distance on): the measurements go, the tool is off, the selection glows again',
    offAgain.every((v) => v === 0) && s.mode === 'none' && s.measurements === 0 && g.every((v) => v > 0) && s.selected.length === 2,
    JSON.stringify({ offAgain, g, s }));

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
