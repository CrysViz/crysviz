// A styled view survives share -> open through the compact (v3) link: per-atom
// colours, opacities and radius scales, a distance and an angle measurement,
// cel style, custom bond cutoff/visibility, and a rotated camera. The link
// must also stay short: that is the point of issue #144.
'use strict';
const H = require('../harness');

const LINK_BUDGET = 700; // characters; measured ~520 when written

// What the viewer shows, reduced to comparable values.
const SNAPSHOT = async () => {
  const { fileBrowser, general, app, measurements } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const hex = (c) => (typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : String(c).toLowerCase());
  return {
    n: s.atoms.length,
    colors: s.atoms.map((a) => hex(a.color)),
    opacity: s.atoms.map((a) => +(a.getOpacity?.() ?? a.opacity ?? 1).toFixed(3)),
    radius: s.atoms.map((a) => +(a.getRadiusScale?.() ?? 1).toFixed(3)),
    style: general.renderStyle,
    atomSize: general.atomSize,
    cuO: general.bondLengths['Cu-O'],
    baOVisible: general.bondVisibility['Ba-O'],
    measurements: measurements.measureLabels.map((l) => l.userData?.type).filter(Boolean).sort(),
    camPos: app.camera.position.toArray(),
    camQuat: app.camera.quaternion.toArray(),
  };
};

const close = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { general, fileBrowser, app } = await import('./state/store.js');
    const { updateAtoms, rebuildBonds } = await import('./render/index.js');
    const { addDistanceMeasurement, addAngleMeasurement } = await import('./render/MeasurementModule.js');
    const s = fileBrowser.selectedStructure;
    for (const i of [0, 1, 2]) s.atoms[i].color = 0xff0000;
    s.atoms[5].color = 0x00ff00;
    s.atoms[7].setOpacity(0.4); s.atoms[8].setOpacity(0.4);
    s.atoms[3].setRadiusScale(1.5);
    general.bondLengths['Cu-O'] = { min: 0.2, max: 2.75 };
    general.bondVisibility['Ba-O'] = false;
    general.renderStyle = 'cel';
    general.atomSize = 0.8;
    updateAtoms();
    rebuildBonds();
    const w = s.periodic.visibleWrapped;
    const proxy = (i) => ({ position: new THREE.Vector3(...w.cart[i]),
      userData: { atomIndex: w.srcIndex ? w.srcIndex[i] : i, element: w.elements[i], instanceId: i,
        wrappedFrac: w.frac?.[i] ? [...w.frac[i]] : null } });
    addDistanceMeasurement(proxy(0), proxy(4));
    addAngleMeasurement(proxy(1), proxy(4), proxy(6));
    app.camera.position.set(9, -7, 12);
    app.camera.up.set(0.1, 0.9, 0.3).normalize();
    app.camera.lookAt(app.controls.target);
    app.camera.updateMatrixWorld();
  });
  await page.waitForTimeout(500);
  const before = await page.evaluate(SNAPSHOT);

  const link = await page.evaluate(async () => {
    const { shareStructure } = await import('./ui/ShareModule.js');
    await shareStructure();
    const url = document.getElementById('shareLinkUrl').value;
    document.getElementById('shareLinkClose').click();
    return url;
  });
  console.log(`  [info] styled link ${link.length} chars`);
  H.check('styled link is a compact #z= link within budget',
    /#z=[A-Za-z0-9_-]+$/.test(link) && link.length <= LINK_BUDGET, `${link.length} chars (budget ${LINK_BUDGET})`);

  await page.goto('about:blank');
  await page.goto(link, { waitUntil: 'load' });
  await H.waitFor(page, async () => {
    const { general, measurements } = await import('./state/store.js');
    return general.sharedStructureLoaded && measurements.measureLabels.length >= 2;
  }, { timeout: 40000, interval: 1000 });
  const after = await page.evaluate(SNAPSHOT);

  H.check('same atoms come back', after.n === before.n, `${after.n} vs ${before.n}`);
  H.check('per-atom colours survive', JSON.stringify(after.colors) === JSON.stringify(before.colors),
    JSON.stringify({ before: before.colors.slice(0, 9), after: after.colors.slice(0, 9) }));
  H.check('per-atom opacities survive', JSON.stringify(after.opacity) === JSON.stringify(before.opacity), '');
  H.check('per-atom radius scales survive', JSON.stringify(after.radius) === JSON.stringify(before.radius), '');
  H.check('cel style and atom size survive', after.style === 'cel' && Math.abs(after.atomSize - 0.8) < 1e-9,
    `${after.style} ${after.atomSize}`);
  H.check('custom bond cutoff and hidden pair survive',
    Math.abs(after.cuO?.max - 2.75) < 1e-6 && Math.abs(after.cuO?.min - 0.2) < 1e-6 && after.baOVisible === false,
    JSON.stringify({ cuO: after.cuO, baO: after.baOVisible }));
  H.check('distance and angle measurements survive',
    JSON.stringify(after.measurements) === JSON.stringify(['angle', 'distance']), JSON.stringify(after.measurements));
  H.check('rotated camera survives', close(after.camPos, before.camPos, 0.02) && close(after.camQuat, before.camQuat, 1e-3),
    JSON.stringify({ before: [before.camPos, before.camQuat], after: [after.camPos, after.camQuat] }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
