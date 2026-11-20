// Depth of field in the tracers (render/pipeline/raytrace/dofChunk.js,
// render/FocusPlaneModule.js, the Visual window's DoF rows):
//   - two rows: DoF aperture (a slider quadratic in the lens radius,
//     labelled in Å) and Focus distance (×, with the distance in Å); the store
//     keeps the aperture as the radius squared; the sharp slab (rtDofDepth, Å)
//     is a hidden config-only setting;
//   - a drag on any of them shows the focal-plane marker (and the two slab
//     planes when a depth is set) for a moment, then it goes away;
//   - under a tracer the drag holds the raster preview instead of restarting
//     the trace at one sample per tick;
//   - the patched shader compiles and renders; the sharp slab changes the
//     picture at an open aperture (and only then);
//   - Reset rendering puts the quadratic sliders back to their defaults.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

const decode = (url) => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64'));

function changedPixels(a, b, thresh = 24) {
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]) > thresh) n++;
  }
  return n;
}

function renderTo(page, N) {
  return page.evaluate(async (N) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx);
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    return app.renderer.domElement.toDataURL('image/png');
  }, N);
}

const markerState = (page) => page.evaluate(async () =>
  (await import('./render/FocusPlaneModule.js')).focusPlaneMarkerState());

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await page.setViewportSize({ width: 900, height: 640 });
  await H.loadDefaultStructure(page); // YBCO

  // ---- the rows ----
  const rows = await page.evaluate(async () => {
    const block = document.getElementById('rtControlsBlock');
    const row = (id) => {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
      const label = el?.parentElement?.querySelector('label');
      return el ? { min: el.min, max: el.max, step: el.step, value: el.value, label: label?.textContent, inBlock: el.parentElement?.parentElement === block } : null;
    };
    return { aperture: row('rtDofAperture'), focus: row('rtDofFocus'), depth: row('rtDofDepth') };
  });
  H.check('DoF aperture is a quadratic [0,1] slider labelled in Å',
    rows.aperture?.min === '0' && rows.aperture?.max === '1' && /Å/.test(rows.aperture?.label ?? '') && rows.aperture.inBlock, JSON.stringify(rows.aperture));
  H.check('Focus distance steps by 0.01 and shows the distance in Å',
    rows.focus?.step === '0.01' && /×1\.00 \(\d+(\.\d)? Å\)/.test(rows.focus?.label ?? ''), JSON.stringify(rows.focus));
  H.check('no Focus depth row: the sharp slab is config-only', rows.depth === null, JSON.stringify(rows.depth));

  // ---- the stored values follow the sliders (raster pipeline: the peaking is drawn directly) ----
  await H.setSlider(page, 'rtDofAperture', Math.SQRT1_2); // quadratic in the radius: 2 * 0.5 = 1 Å -> stored 1
  const stored = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtDofDepth = 2; // the hidden slab: a band of a few Å (the lens's own depth of field at this zoom is well under 1 Å)
    const label = (id) => document.getElementById(id)?.parentElement?.querySelector('label')?.textContent;
    return { aperture: general.rtDofAperture, apertureLabel: label('rtDofAperture') };
  });
  H.check('aperture slider at 1/√2 (radius 1 Å) stores radius² = 1 and reads 1.00 Å',
    Math.abs(stored.aperture - 1) < 1e-9 && /1\.00 Å/.test(stored.apertureLabel), JSON.stringify(stored));
  // Focus peaking: the atoms/bonds inside the sharp band get a rim in the
  // next raster frame; the band is the slab plus the lens's own depth of field.
  let m = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { focusPlaneMarkerState, sharpHalfDepth } = await import('./render/FocusPlaneModule.js');
    app.pipeline.render({ renderer: app.renderer, scene: app.scene, camera: app.camera });
    const total = (await import('./state/store.js')).groups.atomsMesh.count;
    return { ...focusPlaneMarkerState(), half: sharpHalfDepth(), total };
  });
  H.check('focus peaking shows on a DoF drag: some, not all, atoms are rimmed (aperture 1 Å, slab ±2 Å)',
    m.visible && m.peakedAtoms > 0 && m.peakedAtoms < m.total && m.half > 2 && m.half < 4, JSON.stringify(m));
  await page.waitForTimeout(2200);
  m = await markerState(page);
  H.check('… and goes away again after the hold', !m.visible, JSON.stringify(m));
  const closed = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { sharpHalfDepth } = await import('./render/FocusPlaneModule.js');
    const was = general.rtDofAperture;
    general.rtDofAperture = 0;
    const half = sharpHalfDepth();
    general.rtDofAperture = was;
    return half;
  });
  H.check('with the aperture closed everything is sharp', closed === Infinity, String(closed));

  // ---- under raytrace: the drag holds the preview; the shader renders ----
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtTiledRender = false;
    general.rtResolutionScale = 0.25;
    general.ptLightSoftness = 0;
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready',
    { timeout: 180000, interval: 2000 });
  const hasUniform = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return typeof app.pipeline._uniforms.uFocusDepth?.value === 'number';
  });
  H.check('the trace material has the uFocusDepth uniform', hasUniform);

  // The preview hold is keyed on the last interaction time: a DoF slider
  // input must advance it (camera motion and a background drag do; tracer-
  // only knobs such as the light intensity must not).
  const held = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera, interactive: true };
    // Software-GL frames take about a second: a rest window of 5 s keeps the
    // hold readable across the waits below (the animate loop renders too).
    general.rtPreviewRestDelay = 5;
    p.render(ctx); p.render(ctx); // settle the look probes
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(30);
    const t0 = p._lastInteractionAt;
    p.render(ctx);
    const unchanged = p._lastInteractionAt === t0;
    const light = /** @type {HTMLInputElement} */ (document.getElementById('rtLightIntensity'));
    light.value = '1.5';
    light.dispatchEvent(new Event('input'));
    await wait(30);
    p.render(ctx);
    const afterLight = p._lastInteractionAt;
    const el = /** @type {HTMLInputElement} */ (document.getElementById('rtDofFocus'));
    el.value = '1.2';
    el.dispatchEvent(new Event('input'));
    await wait(30);
    p.render(ctx);
    const afterDof = p._lastInteractionAt;
    const during = p._previewActive;
    p.render(ctx);
    const during2 = p._previewActive;
    light.value = '1.2';
    light.dispatchEvent(new Event('input'));
    general.rtPreviewRestDelay = 0.5;
    p._lastInteractionAt = 0; // end the hold now
    return { unchanged, lightHeld: afterLight > t0, dofHeld: afterDof > afterLight, during, during2,
      hasPreview: !!p._previewPipeline, restDelay: general.rtPreviewRestDelay, focus: general.rtDofFocus };
  });
  H.check('a Focus distance drag under raytrace holds the raster preview (the marker is seen there); a light knob does not',
    held.unchanged && !held.lightHeld && held.dofHeld && (held.during || held.during2) && Math.abs(held.focus - 1.2) < 1e-9, JSON.stringify(held));
  await page.waitForTimeout(2500); // the rest delay + the marker hold

  // ---- the sharp slab changes the picture at an open aperture ----
  const set = (aperture, depth) => page.evaluate(async ({ aperture, depth }) => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false;
    general.rtDofAperture = aperture;
    general.rtDofFocus = 1;
    general.rtDofDepth = depth;
  }, { aperture, depth });
  await set(0, 0);
  const pinhole = decode(await renderTo(page, 12));
  await set(2.25, 0);
  const lens = decode(await renderTo(page, 12));
  await set(2.25, 20);
  const slab = decode(await renderTo(page, 12));
  await set(0, 20);
  const pinholeDepth = decode(await renderTo(page, 12));
  const d = {
    lensVsPinhole: changedPixels(lens, pinhole),
    slabVsLens: changedPixels(slab, lens),
    slabVsPinhole: changedPixels(slab, pinhole),
    depthWithoutAperture: changedPixels(pinholeDepth, pinhole),
  };
  H.check('an open aperture blurs (the picture changes)', d.lensVsPinhole > 300, JSON.stringify(d));
  H.check('a 20 Å sharp slab changes the blurred picture back towards the sharp one',
    d.slabVsLens > 150 && d.slabVsPinhole < d.lensVsPinhole, JSON.stringify(d));
  // two 12-sample renders differ by their per-sample jitter alone (~1 % of the
  // pixels at this threshold); the lens changes a hundred times more
  H.check('a focus depth without an aperture changes nothing', d.depthWithoutAperture < d.lensVsPinhole / 20, JSON.stringify(d));

  // ---- Pick focus: a click on an atom puts the focal plane through it ----
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(400);
  const pickTarget = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { app, groups, fileBrowser } = await import('./state/store.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const rect = app.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    const fwd = new THREE.Vector3(); app.camera.getWorldDirection(fwd);
    for (let i = 0; i < w.cart.length; i++) {
      const v = new THREE.Vector3(...w.cart[i]);
      const p = v.clone().project(app.camera);
      if (Math.abs(p.x) > 0.8 || Math.abs(p.y) > 0.8) continue;
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), app.camera);
      if (ray.intersectObject(groups.atomsMesh)[0]?.instanceId !== i) continue;
      const x = rect.left + (p.x + 1) / 2 * rect.width, y = rect.top + (1 - p.y) / 2 * rect.height;
      if (document.elementFromPoint(x, y) !== app.renderer.domElement) continue;
      const depth = v.clone().sub(app.camera.position).dot(fwd);
      const expected = Math.round(depth / app.camera.position.distanceTo(app.controls.target) * 100) / 100;
      if (Math.abs(expected - 1) < 0.03) continue; // an atom off the target's depth, so the factor moves
      return { x, y, expected };
    }
    return null;
  });
  H.check('found a visible atom to pick the focus on', !!pickTarget, JSON.stringify(pickTarget));
  await page.evaluate(async () => { (await import('./state/store.js')).general.rtDofFocus = 1; });
  await H.clickById(page, 'rtDofFocusPick');
  const armed = await page.evaluate(async () => {
    const { isFocusPickActive } = await import('./render/FocusPlaneModule.js');
    const { app } = await import('./state/store.js');
    return { active: isFocusPickActive(), cursor: app.renderer.domElement.style.cursor, label: document.getElementById('rtDofFocusPick')?.textContent };
  });
  H.check('Pick arms the mode (crosshair, button says what to do)', armed.active && armed.cursor === 'crosshair' && /Click an atom/.test(armed.label ?? ''), JSON.stringify(armed));
  await page.mouse.click(pickTarget.x, pickTarget.y);
  await page.waitForTimeout(300);
  const pickedFocus = await page.evaluate(async () => {
    const { isFocusPickActive, focusPlaneMarkerState } = await import('./render/FocusPlaneModule.js');
    const { general, app } = await import('./state/store.js');
    return { active: isFocusPickActive(), focus: general.rtDofFocus, slider: document.getElementById('rtDofFocus')?.value, cursor: app.renderer.domElement.style.cursor, peaking: focusPlaneMarkerState().visible };
  });
  H.check('the click puts the focal plane through the atom (slider follows), ends the mode and shows the peaking',
    !pickedFocus.active && Math.abs(pickedFocus.focus - pickTarget.expected) < 0.011 && Math.abs(parseFloat(pickedFocus.slider) - pickTarget.expected) < 0.011
      && pickedFocus.cursor === '' && pickedFocus.peaking,
    JSON.stringify({ pickedFocus, expected: pickTarget.expected }));
  await page.evaluate(async () => { (await import('./state/store.js')).general.rtDofFocus = 1; });

  // ---- Reset rendering restores the quadratic sliders ----
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = true;
  });
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(500);
  await H.setSlider(page, 'rtDofAperture', 0.7);
  await page.evaluate(async () => { (await import('./state/store.js')).general.rtDofDepth = 7; });
  const resetBtn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /reset rendering/i.test(b.textContent ?? ''));
    if (btn) btn.click();
    return !!btn;
  });
  await page.waitForTimeout(500);
  const afterReset = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return {
      aperture: general.rtDofAperture, depth: general.rtDofDepth,
      apertureEl: document.getElementById('rtDofAperture')?.value,
    };
  });
  H.check('Reset rendering puts the aperture (slider too) and the hidden slab back to 0',
    resetBtn && afterReset.aperture === 0 && afterReset.depth === 0 && afterReset.apertureEl === '0',
    JSON.stringify(afterReset));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
