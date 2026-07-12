// Ground plane as a permanent fixture of all rendering modes.
//
// The raster ground disc (render/GroundPlaneModule.js, groups.groundMesh) is
// drawn by every RASTER pipeline AND the tracers' interactive preview frames,
// visually matched to the tracers' analytic disc (same placement formulas, same
// world-space pattern function, same follow-background colors). A traced frame
// never renders the raster scene, so there is no doubling — the mesh stays
// visible whenever the ground is enabled. This test asserts:
//   (a) enabling the ground under depth peeling changes the rendered pixels;
//   (b) cross-mode PLACEMENT PARITY — the raster mesh position.y/scale match the
//       tracer's uGroundD/uGroundRadius uniforms (the drift guard for the
//       DUPLICATED atom-AABB bounds loop);
//   (c) the user's mixed-mode scenario — raytrace + preview + ground on, a
//       preview frame during camera motion STILL shows the ground;
//   (d) a solid->checker pattern change alters raster pixels;
//   (e) the "Ground reflect" row is tracer-gated while the block is always shown;
//   (f) persistence smoke — the 8 rtGround* keys survive at state v2.13.
'use strict';
const H = require('../harness');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Decode a `data:image/png;base64,...` URL captured from the canvas. */
function decodeDataUrl(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Fraction of pixels differing between two same-size PNGs by summed-RGB. */
function diffFraction(a, b, thresh = 30) {
  const pa = decodeDataUrl(a);
  const pb = decodeDataUrl(b);
  const n = Math.min(pa.data.length, pb.data.length) / 4;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const s = Math.abs(pa.data[o] - pb.data[o]) + Math.abs(pa.data[o + 1] - pb.data[o + 1])
      + Math.abs(pa.data[o + 2] - pb.data[o + 2]);
    if (s > thresh) d++;
  }
  return d / n;
}

/** Wait for the active tracer to be fully initialized (async blue-noise load). */
async function waitTracerReady(page) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const ok = await page.evaluate(async () => {
      const { app } = await import('./state/store.js');
      const p = app.pipeline;
      return !!p?._blueNoise?.image && p?._initialized === true && !!p?._previewPipeline;
    });
    if (ok || Date.now() > deadline) return ok;
    await page.waitForTimeout(1000);
  }
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO — a well-populated cell

  // --- (a) depth peeling: enabling the ground changes the rendered pixels ---------
  // Default pipeline is depthpeel. Configure a large, bright, solid disc and aim
  // the camera down at the (horizontal) plane so it clearly occupies the view.
  const toggle = await page.evaluate(async () => {
    const { app, general, groups } = await import('./state/store.js');
    const { updateGroundPlane } = await import('./render/index.js');
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    general.rtGroundColor1 = '#ff0000';
    general.rtGroundColor2 = '#ff0000';
    general.rtGroundPattern = 'solid';
    general.rtGroundSize = 6;      // wide disc
    general.rtGroundOffset = 0.2;  // just below the structure
    general.rtGroundPlane = true;
    updateGroundPlane();
    const gm = groups.groundMesh;
    const c = gm.position;
    app.controls.target.set(c.x, c.y, c.z);
    app.camera.position.set(c.x, c.y + gm.scale.x * 1.2, c.z + gm.scale.x * 1.2);
    app.camera.lookAt(app.controls.target);
    app.camera.updateMatrixWorld();
    app.controls.update?.();
    app.pipeline.render(ctx);
    const on = canvas.toDataURL('image/png');
    const meshInScene = app.scene.children.includes(gm) && gm.visible === true;
    general.rtGroundPlane = false;
    updateGroundPlane();
    const hidden = gm.visible === false;
    app.pipeline.render(ctx);
    const off = canvas.toDataURL('image/png');
    return { on, off, meshInScene, hidden, pipeline: general.renderPipeline };
  });
  H.check('ground mesh is a scene child, visible when enabled and hidden when disabled',
    toggle.meshInScene && toggle.hidden && toggle.pipeline === 'depthpeel', JSON.stringify({
      meshInScene: toggle.meshInScene, hidden: toggle.hidden, pipeline: toggle.pipeline }));
  {
    const frac = diffFraction(toggle.on, toggle.off);
    H.check('enabling the ground under depth peeling changes the rendered pixels',
      frac > 0.03, `diffFraction=${frac.toFixed(4)}`);
  }

  // Speed up software-GL tracing before switching to the ray tracer.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25;
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  H.check('ray tracer initialized', await waitTracerReady(page));

  // --- (b) cross-mode PLACEMENT PARITY (drift guard for the duplicated bounds) -----
  const parity = await page.evaluate(async () => {
    const { app, general, groups } = await import('./state/store.js');
    const { updateGroundPlane } = await import('./render/index.js');
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    general.rtGroundColor1 = null; general.rtGroundColor2 = null;
    general.rtGroundOffset = 0.75; general.rtGroundSize = 2.5;
    general.rtGroundPattern = 'solid';
    general.rtGroundPlane = true;
    app.pipeline.resetAccumulation?.();
    app.pipeline.render(ctx);   // encodes the scene + sets uGroundD / uGroundRadius
    updateGroundPlane();        // positions the raster disc from the SAME atoms
    const gm = groups.groundMesh;
    const u = app.pipeline._uniforms;
    const enc = app.pipeline._encoder;
    return {
      meshX: gm.position.x, meshY: gm.position.y, meshZ: gm.position.z, meshScale: gm.scale.x,
      uGroundD: u.uGroundD.value, uGroundRadius: u.uGroundRadius.value,
      encMinY: enc.minY, centerX: enc.structureCenter.x, centerZ: enc.structureCenter.z,
      structureRadius: enc.structureRadius,
    };
  });
  {
    const expY = parity.encMinY - 0.75;
    const expScale = Math.max(2.5 * parity.structureRadius, 5);
    H.check('raster disc placement follows the driver formula (minY - offset, max(size*R, 5))',
      Math.abs(parity.meshY - expY) < 1e-3 && Math.abs(parity.meshScale - expScale) < 1e-3,
      JSON.stringify(parity));
    H.check('raster disc position/scale MATCH the tracer uGroundD / uGroundRadius (drift guard)',
      Math.abs(parity.meshY - parity.uGroundD) < 1e-3
        && Math.abs(parity.meshScale - parity.uGroundRadius) < 1e-3
        && Math.abs(parity.meshX - parity.centerX) < 1e-3
        && Math.abs(parity.meshZ - parity.centerZ) < 1e-3,
      JSON.stringify(parity));
  }

  // --- (c) the user's mixed-mode scenario: preview frame STILL shows the ground ----
  const mixed = await page.evaluate(async () => {
    const { app, general, groups } = await import('./state/store.js');
    const { updateGroundPlane } = await import('./render/index.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    general.rtRasterPreview = true;
    general.rtGroundColor1 = '#ff0000'; general.rtGroundColor2 = '#ff0000';
    general.rtGroundPattern = 'solid'; general.rtGroundSize = 6; general.rtGroundOffset = 0.2;
    general.rtGroundPlane = true; updateGroundPlane();
    const gm = groups.groundMesh; const c = { x: gm.position.x, y: gm.position.y, z: gm.position.z };
    const camY = c.y + gm.scale.x * 1.2, camZ = c.z + gm.scale.x * 1.2;
    // One preview-frame drive from a fixed pose (settle traces, clear carryover,
    // move the camera, render an INTERACTIVE frame -> raster preview).
    const drive = () => {
      app.controls.target.set(c.x, c.y, c.z);
      app.camera.position.set(c.x, camY, camZ);
      app.camera.lookAt(app.controls.target); app.camera.updateMatrixWorld();
      p.render(ctx); p.render(ctx);
      p._lastInteractionAt = 0;
      app.camera.position.x += 4; app.camera.updateMatrixWorld();
      p.render({ ...ctx, interactive: true });
      return { shot: canvas.toDataURL('image/png'), previewActive: p._previewActive };
    };
    const on = drive();
    general.rtGroundPlane = false; updateGroundPlane(); // hide the disc, same drive
    const off = drive();
    return { onShot: on.shot, offShot: off.shot,
      previewActiveOn: on.previewActive, previewActiveOff: off.previewActive };
  });
  H.check('the mixed-mode frame is a raster PREVIEW frame (not a trace)',
    mixed.previewActiveOn === true && mixed.previewActiveOff === true,
    JSON.stringify({ on: mixed.previewActiveOn, off: mixed.previewActiveOff }));
  {
    const frac = diffFraction(mixed.onShot, mixed.offShot);
    H.check('a preview frame during camera motion still shows the ground (fixes the disappearing plane)',
      frac > 0.03, `diffFraction=${frac.toFixed(4)}`);
  }

  // --- (d) pattern solid -> checker changes raster pixels under depth peeling ------
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  const pattern = await page.evaluate(async () => {
    const { app, general, groups } = await import('./state/store.js');
    const { updateGroundPlane } = await import('./render/index.js');
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    general.rtGroundColor1 = '#ff0000'; general.rtGroundColor2 = '#0000ff';
    general.rtGroundSize = 6; general.rtGroundOffset = 0.2; general.rtGroundScale = 1; // small tiles
    general.rtGroundPlane = true; updateGroundPlane();
    const gm = groups.groundMesh; const c = gm.position;
    app.controls.target.set(c.x, c.y, c.z);
    app.camera.position.set(c.x, c.y + gm.scale.x * 1.2, c.z + gm.scale.x * 1.2);
    app.camera.lookAt(app.controls.target); app.camera.updateMatrixWorld();
    general.rtGroundPattern = 'solid';
    app.pipeline.render(ctx); const solid = canvas.toDataURL('image/png');
    general.rtGroundPattern = 'checker';
    app.pipeline.render(ctx); const checker = canvas.toDataURL('image/png');
    return { solid, checker };
  });
  {
    const frac = diffFraction(pattern.solid, pattern.checker);
    H.check('solid -> checker changes the raster ground pixels', frac > 0.02, `diffFraction=${frac.toFixed(4)}`);
  }

  // --- (e) "Ground reflect" row is tracer-gated; the block is always visible -------
  const reflect = await page.evaluate(() => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    const groundToggle = /** @type {HTMLInputElement} */ (document.getElementById('rtGroundToggle'));
    const groundBlock = groundToggle?.closest('.control-row')?.parentElement;
    const reflectRow = document.getElementById('rtGroundReflect')?.closest('.control-row');
    groundToggle.checked = true; groundToggle.dispatchEvent(new Event('change')); // lay out options
    const blockDisp = () => getComputedStyle(groundBlock).display;
    const reflectDisp = () => getComputedStyle(reflectRow).display;
    const set = (v) => { select.value = v; select.dispatchEvent(new Event('change')); };
    set('depthpeel');
    const blockRaster = blockDisp() !== 'none', reflectHiddenRaster = reflectDisp() === 'none';
    set('raytrace');
    const blockTracer = blockDisp() !== 'none', reflectShownTracer = reflectDisp() !== 'none';
    set('depthpeel');
    groundToggle.checked = false; groundToggle.dispatchEvent(new Event('change'));
    return { blockRaster, reflectHiddenRaster, blockTracer, reflectShownTracer };
  });
  H.check('ground block always visible; reflect row hidden under raster, shown under the tracer',
    reflect.blockRaster && reflect.blockTracer && reflect.reflectHiddenRaster && reflect.reflectShownTracer,
    JSON.stringify(reflect));

  // --- (f) persistence smoke: the 8 rtGround* keys at state v2.13 ------------------
  const persist = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const s = captureState();
    const keys = ['rtGroundPlane', 'rtGroundPattern', 'rtGroundColor1', 'rtGroundColor2',
      'rtGroundScale', 'rtGroundOffset', 'rtGroundSize', 'rtGroundReflect'];
    return { version: s.version, present: keys.filter((k) => k in s.style) };
  });
  H.check('captureState carries all 8 rtGround* keys at v2.13',
    persist.version === '2.13' && persist.present.length === 8,
    JSON.stringify(persist));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
