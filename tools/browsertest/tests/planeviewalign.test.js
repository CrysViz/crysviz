// Planes panel: the "Along normal" / "Opposite normal" buttons under the Show
// Plane toggle align the camera with the selected plane's normal, using the
// View window's a/b/c convention (the direction points at the viewer). They
// only re-aim the camera: its distance to the target stays the same.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await H.loadDefaultStructure(page); // YBCO, orthorhombic-ish cell

  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('planes').expand();
  });
  await page.waitForTimeout(300);

  const disabledBefore = await page.evaluate(() => [
    /** @type {HTMLButtonElement} */ (document.getElementById('planeViewAlongBtn')).disabled,
    /** @type {HTMLButtonElement} */ (document.getElementById('planeViewOppositeBtn')).disabled,
  ]);
  H.check('view buttons are disabled with no plane selected',
    disabledBefore.every(Boolean), JSON.stringify(disabledBefore));

  await H.clickById(page, 'addPlaneBtn'); // (1 1 1), selected

  async function setHkl(h, k, l) {
    await page.evaluate(([h, k, l]) => {
      for (const [id, v] of [['planeH', h], ['planeK', k], ['planeL', l]]) {
        const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
        el.focus(); el.value = String(v); el.blur();
      }
    }, [h, k, l]);
    await page.waitForTimeout(200);
  }

  const aim = (buttonId) => page.evaluate(async (buttonId) => {
    const { app, fileBrowser } = await import('./state/store.js');
    const { getPlaneDefinitionNormalAndD } = await import('./model/Plane.js');
    const structure = fileBrowser.selectedStructure;
    const plane = structure.planes[structure.planes.length - 1];
    const { normal } = getPlaneDefinitionNormalAndD(plane, structure.lattice);
    const len = Math.hypot(...normal);
    const distBefore = app.camera.position.distanceTo(app.controls.target);
    /** @type {HTMLButtonElement} */ (document.getElementById(buttonId)).click();
    const view = app.camera.position.clone().sub(app.controls.target);
    const distAfter = view.length();
    view.normalize();
    const n = normal.map((v) => v / len);
    return {
      dot: view.x * n[0] + view.y * n[1] + view.z * n[2],
      distBefore, distAfter,
      upDotView: Math.abs(app.camera.up.clone().normalize().dot(view)),
    };
  }, buttonId);

  await setHkl(0, 0, 1);
  const along001 = await aim('planeViewAlongBtn');
  const opposite001 = await aim('planeViewOppositeBtn');
  await setHkl(1, 1, 0);
  const along110 = await aim('planeViewAlongBtn');
  const opposite110 = await aim('planeViewOppositeBtn');

  const sameDistance = (r) => Math.abs(r.distAfter - r.distBefore) < 1e-6 * Math.max(1, r.distBefore);
  H.check('"Along normal" puts the (0 0 1) normal towards the viewer',
    along001.dot > 1 - 1e-9 && sameDistance(along001), JSON.stringify(along001));
  H.check('"Opposite normal" turns the (0 0 1) view round',
    opposite001.dot < -1 + 1e-9 && sameDistance(opposite001), JSON.stringify(opposite001));
  H.check('works for an oblique (1 1 0) plane, with a usable up vector',
    along110.dot > 1 - 1e-9 && opposite110.dot < -1 + 1e-9
    && along110.upDotView < 0.999 && opposite110.upDotView < 0.999,
    JSON.stringify({ along110, opposite110 }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
