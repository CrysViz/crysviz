// Ground position (Visual ▸ Ground position, general.rtGroundDirection;
// render/groundDirection.js): the ground plane is no longer stuck below the
// structure along −y.
//   - the Visual window offers the choice; 'Below (−y)' stays the default
//   - a fixed crystal side ('-c' on YBCO): the raster disc tilts onto the
//     normal and lies the offset beyond the structure's lowest point along it
//   - 'Below the view' and 'Behind the view' follow the camera: the disc's
//     normal is the camera's up / backward axis, re-placed as the view turns
//   - the tracer's analytic disc agrees with the raster one (normal and plane)
//   - share links and .crysviz sessions carry the choice; an older one without
//     it keeps the current one; an unknown value falls back to 'down'
'use strict';
const H = require('../harness');

const OFFSET = 0.75;

/** The raster disc's normal, its plane distance, and the structure's lowest
 *  point along that normal (from the atom instances, as the module does). */
const RASTER = async () => {
  const { groups } = await import('./state/store.js');
  const THREE = await import('./external/three/three.module.js');
  const gm = groups.groundMesh;
  const n = new THREE.Vector3(0, 1, 0).applyQuaternion(gm.quaternion).normalize();
  const mesh = groups.atomsMesh;
  const m = mesh.instanceMatrix.array;
  let minProj = Infinity;
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16;
    const r = m[o];
    if (!(r > 0)) continue;
    minProj = Math.min(minProj, m[o + 12] * n.x + m[o + 13] * n.y + m[o + 14] * n.z - r);
  }
  return { visible: gm.visible, n: n.toArray(), planeD: gm.position.dot(n), minProj };
};

const near3 = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < tol);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO: an orthorhombic cell
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(800);

  // ---- the control ----
  const control = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const sel = document.getElementById('rtGroundDirection');
    return { exists: !!sel, value: sel?.value, options: sel ? [...sel.options].map((o) => o.value) : [], general: general.rtGroundDirection };
  });
  H.check('the Visual window offers Ground position, Below (−y) by default',
    control.exists && control.value === 'down' && control.general === 'down'
      && ['view-below', 'view-behind', '-x', '+z', '-a', '+c'].every((v) => control.options.includes(v)), JSON.stringify(control));

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { updateGroundPlane } = await import('./render/index.js');
    general.rtGroundOffset = 0.75;
    general.rtGroundPlane = true;
    updateGroundPlane();
  });
  const down = await page.evaluate(RASTER);
  H.check('Below (−y): the disc lies flat, the offset under the lowest atom (as before)',
    down.visible && near3(down.n, [0, 1, 0]) && Math.abs(down.planeD - (down.minProj - OFFSET)) < 1e-3, JSON.stringify(down));

  // ---- a fixed crystal side, chosen in the window ----
  await H.setSelect(page, 'rtGroundDirection', '-c');
  await page.waitForTimeout(300);
  const lattice = await page.evaluate(async () => (await import('./state/store.js')).fileBrowser.selectedStructure.lattice);
  const cHat = (() => { const c = lattice[2]; const l = Math.hypot(...c); return c.map((v) => v / l); })();
  const underC = await page.evaluate(RASTER);
  H.check('Under c: the disc tilts to face +c and lies the offset beyond the lowest point along c',
    near3(underC.n, cHat) && Math.abs(underC.planeD - (underC.minProj - OFFSET)) < 1e-3, JSON.stringify({ underC, cHat }));

  // ---- following the view ----
  const turn = (pos, up) => page.evaluate(async ({ pos, up }) => {
    const { app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    app.camera.position.set(...pos);
    app.camera.up.set(...up);
    app.camera.lookAt(app.controls.target);
    app.camera.updateMatrixWorld();
    app.controls.update?.();
    requestRender();
  }, { pos, up });
  const cameraAxes = () => page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const e = app.camera.matrixWorld.elements;
    const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
    return { up: norm([e[4], e[5], e[6]]), back: norm([e[8], e[9], e[10]]) };
  });
  await H.setSelect(page, 'rtGroundDirection', 'view-below');
  const target = await page.evaluate(async () => (await import('./state/store.js')).app.controls.target.toArray());
  await turn([target[0] + 30, target[1] + 5, target[2] + 4], [0, 0, 1]);
  await page.waitForTimeout(700);
  let axes = await cameraAxes();
  const below1 = await page.evaluate(RASTER);
  await turn([target[0] - 3, target[1] + 30, target[2] + 6], [1, 0, 0]);
  await page.waitForTimeout(700);
  const axes2 = await cameraAxes();
  const below2 = await page.evaluate(RASTER);
  H.check('Below the view: the disc faces the camera\'s up, and follows it when the view turns',
    near3(below1.n, axes.up) && near3(below2.n, axes2.up) && !near3(below1.n, below2.n)
      && Math.abs(below2.planeD - (below2.minProj - OFFSET)) < 1e-3, JSON.stringify({ below1, axes, below2, axes2 }));
  await H.setSelect(page, 'rtGroundDirection', 'view-behind');
  await page.waitForTimeout(500);
  axes = await cameraAxes();
  const behind = await page.evaluate(RASTER);
  H.check('Behind the view: a backdrop facing the camera, beyond the structure',
    near3(behind.n, axes.back) && Math.abs(behind.planeD - (behind.minProj - OFFSET)) < 1e-3, JSON.stringify({ behind, axes }));

  // ---- the tracer agrees ----
  await H.setSelect(page, 'rtGroundDirection', '+x');
  await page.evaluate(async () => { (await import('./state/store.js')).general.rtResolutionScale = 0.25; });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready', { timeout: 300000, interval: 2000 });
  const traced = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    app.pipeline.render(ctx);
    const u = app.pipeline._uniforms;
    return { n: u.uGroundNormal.value.toArray(), d: u.uGroundD.value, enabled: u.uGroundEnabled.value };
  });
  const rasterX = await page.evaluate(RASTER);
  H.check('the tracer\'s disc agrees with the raster one (normal −x side, same plane)',
    traced.enabled && near3(traced.n, [-1, 0, 0]) && near3(rasterX.n, [-1, 0, 0]) && Math.abs(traced.d - rasterX.planeD) < 1e-3,
    JSON.stringify({ traced, rasterX }));

  // ---- links and sessions ----
  const shared = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const { encodeCompact, expandCompact } = await import('./io/share/shareCodec.js');
    const state = JSON.parse(JSON.stringify(captureState()));
    const back = expandCompact(JSON.parse(JSON.stringify(encodeCompact(state))));
    return { captured: state.style.rtGroundDirection, link: back.style.rtGroundDirection };
  });
  H.check('share links (and sessions) carry the ground position', shared.captured === '+x' && shared.link === '+x', JSON.stringify(shared));
  const applied = await page.evaluate(async () => {
    window.confirm = () => true;
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    const { general } = await import('./state/store.js');
    const state = JSON.parse(JSON.stringify(captureState({ includeFrames: true })));
    general.rtGroundDirection = 'down';
    applySharedState(JSON.parse(JSON.stringify(state)), 'g.crysviz');
    const fromSession = general.rtGroundDirection;
    const old = JSON.parse(JSON.stringify(state));
    delete old.style.rtGroundDirection;
    general.rtGroundDirection = '-b';
    applySharedState(old, 'old.crysviz');
    const fromOld = general.rtGroundDirection;
    const bad = JSON.parse(JSON.stringify(state));
    bad.style.rtGroundDirection = 'sideways';
    applySharedState(bad, 'bad.crysviz');
    return { fromSession, fromOld, fromBad: general.rtGroundDirection, select: document.getElementById('rtGroundDirection')?.value };
  });
  H.check('a session brings it back; an older one keeps the current; an unknown value falls back to Below (−y)',
    applied.fromSession === '+x' && applied.fromOld === '-b' && applied.fromBad === 'down' && applied.select === 'down', JSON.stringify(applied));

  const own = errors.filter((x) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(x));
  H.check('no page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
