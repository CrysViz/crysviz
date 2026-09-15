// Screen-space projection overlay (ui/notagameatall.js): the Shift+4+2
// chord starts it over the default structure, a pulse resolved through the
// normal per-frame hit path zero-scales the hit atom's instance, and ending
// it (Escape) puts the instance matrices, camera and controls back exactly.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const before = await page.evaluate(async () => {
    const { groups, app } = await import('./state/store.js');
    const { getProjectionOverlayState } = await import('./ui/notagameatall.js');
    return {
      active: getProjectionOverlayState().active,
      atoms: Array.from(groups.atomsMesh.instanceMatrix.array),
      bonds: groups.bondsMesh ? Array.from(groups.bondsMesh.instanceMatrix.array) : null,
      camera: app.camera.position.toArray(),
      controlsEnabled: app.controls.enabled !== false,
      overlay: !!document.querySelector('#view .cv-proj-overlay'),
    };
  });
  H.check('inactive at startup', !before.active);
  H.check('no overlay before first use', !before.overlay);

  // Shift held, then 4, then 2 — the press completing the chord toggles.
  await page.keyboard.down('Shift');
  await page.keyboard.down('Digit4');
  await page.keyboard.down('Digit2');
  await page.keyboard.up('Digit2');
  await page.keyboard.up('Digit4');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);

  const started = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { getProjectionOverlayState } = await import('./ui/notagameatall.js');
    const canvas = document.querySelector('#view .cv-proj-overlay');
    const banner = document.querySelector('#view .cv-proj-overlay-note');
    return {
      state: getProjectionOverlayState(),
      canvasShown: !!canvas && !canvas.hidden && canvas.width > 0,
      bannerShown: !!banner && getComputedStyle(banner).display !== 'none',
      controlsEnabled: app.controls.enabled !== false,
    };
  });
  H.check('Shift+4+2 starts the overlay', started.state.active, JSON.stringify(started.state));
  H.check('every visible atom is a target', started.state.totalCount > 0 && started.state.aliveCount === started.state.totalCount, JSON.stringify(started.state));
  H.check('overlay canvas shown', started.canvasShown);
  H.check('banner shown', started.bannerShown);
  H.check('camera controls disabled while running', !started.controlsEnabled);

  // A pulse at the lowest atom on screen, resolved by the overlay loop itself.
  const target = await page.evaluate(async () => {
    const { debugProbeLowestTarget } = await import('./ui/notagameatall.js');
    return debugProbeLowestTarget();
  });
  H.check('a target was picked', target >= 0, `instance=${target}`);
  const hit = await H.waitFor(page, async () => {
    const { getProjectionOverlayState } = await import('./ui/notagameatall.js');
    const s = getProjectionOverlayState();
    return s.aliveCount < s.totalCount;
  }, { timeout: 8000, interval: 200 });
  H.check('the pulse retires an atom', hit);

  const afterHit = await page.evaluate(async (i) => {
    const { groups } = await import('./state/store.js');
    const { getProjectionOverlayState } = await import('./ui/notagameatall.js');
    const a = groups.atomsMesh.instanceMatrix.array;
    return { scale: a[i * 16], state: getProjectionOverlayState() };
  }, target);
  H.check('hit atom instance is zero-scaled', afterHit.scale === 0, `scale=${afterHit.scale}`);
  H.check('tally counts the hit', afterHit.state.tally > 0, `tally=${afterHit.state.tally}`);

  await H.shotCanvas(page, 'notagameatall-running');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const after = await page.evaluate(async () => {
    const { groups, app } = await import('./state/store.js');
    const { getProjectionOverlayState } = await import('./ui/notagameatall.js');
    const canvas = document.querySelector('#view .cv-proj-overlay');
    const banner = document.querySelector('#view .cv-proj-overlay-note');
    return {
      active: getProjectionOverlayState().active,
      atoms: Array.from(groups.atomsMesh.instanceMatrix.array),
      bonds: groups.bondsMesh ? Array.from(groups.bondsMesh.instanceMatrix.array) : null,
      camera: app.camera.position.toArray(),
      controlsEnabled: app.controls.enabled !== false,
      canvasHidden: !!canvas && canvas.hidden,
      bannerHidden: !!banner && getComputedStyle(banner).display === 'none',
    };
  });
  const same = (x, y) => x.length === y.length && x.every((v, k) => Math.abs(v - y[k]) < 1e-6);
  H.check('Escape stops the overlay', !after.active);
  H.check('atom matrices restored', same(before.atoms, after.atoms));
  H.check('bond matrices restored', !before.bonds || same(before.bonds, after.bonds));
  H.check('camera pose restored', same(before.camera, after.camera), `${before.camera} vs ${after.camera}`);
  H.check('camera controls re-enabled', after.controlsEnabled === before.controlsEnabled);
  H.check('overlay hidden again', after.canvasHidden && after.bannerHidden);

  // Space outside the overlay must still reach the app (it is a shortcut
  // modifier there) — the capture listener is gone once the overlay stops.
  const spaceReaches = await page.evaluate(() => new Promise((resolve) => {
    const onKey = (e) => { if (e.code === 'Space') { window.removeEventListener('keydown', onKey); resolve(true); } };
    window.addEventListener('keydown', onKey);
    setTimeout(() => resolve(false), 1000);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
  }));
  H.check('overlay keys pass through after it ends', spaceReaches);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
