// Tracer materials + continuous size sliders: per-species/pair/category
// materials (Structure-window editors -> style stores -> SceneEncoder
// fingerprint -> re-encode) with an emissive species measurably glowing under
// the raytrace pipeline; and the quadratic [0,1] Atom Size / Bond Diameter
// slider mapping (ui/ControlsWiring.js).
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Count of pixels that differ substantially between two screenshots — the
 *  "materials changed the render" metric (emissive Cu saturates, metal Ba
 *  goes mirror-flat; exact colors depend on tone mapping + upscale blur). */
function changedPixelCount(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 90) n++;
  }
  return n;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- Quadratic continuous size sliders -----------------------------------------
  const mapping = await page.evaluate(async () => {
    const { sizeSliderToValue, sizeValueToSlider, ATOM_SIZE_RANGE, BOND_RADIUS_RANGE }
      = await import('./ui/ControlsWiring.js');
    return {
      atomAtFull: sizeSliderToValue(1, ATOM_SIZE_RANGE),
      atomAtZero: sizeSliderToValue(0, ATOM_SIZE_RANGE),
      bondAtFull: sizeSliderToValue(1, BOND_RADIUS_RANGE),
      roundTrip: Math.abs(sizeValueToSlider(sizeSliderToValue(0.7, ATOM_SIZE_RANGE), ATOM_SIZE_RANGE) - 0.7),
      stepless: document.getElementById('atomSize')?.step === 'any'
        && document.getElementById('bondWidth')?.step === 'any',
    };
  });
  H.check('size sliders: quadratic mapping spans 0.05-3.0 / up to 1.0, no steps',
    Math.abs(mapping.atomAtFull - 3.0) < 1e-9 && Math.abs(mapping.atomAtZero - 0.05) < 1e-9
      && Math.abs(mapping.bondAtFull - 1.0) < 1e-9 && mapping.roundTrip < 1e-9 && mapping.stepless,
    JSON.stringify(mapping));

  await H.setSlider(page, 'atomSize', 1);
  const atFull = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { atomSize: general.atomSize, span: document.getElementById('atomSizeValue')?.textContent };
  });
  H.check('#atomSize at full travel drives general.atomSize to 3.0',
    Math.abs(atFull.atomSize - 3.0) < 1e-6 && atFull.span === '3.00', JSON.stringify(atFull));

  // --- Bond lengths recalculate when the atom size changes (debounced) -----------
  // Bond.visibleLen is clipped by the atom radii; bigger atoms => shorter bonds.
  const bondBefore = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const b = fileBrowser.selectedStructure.bonds.find((x) => x.halfLen > 1e-3);
    return b ? b.halfLen : null;
  });
  await page.waitForTimeout(600); // let the atomSize=3.0 rebuild from above settle
  const bondAfter = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const lens = fileBrowser.selectedStructure.bonds.map((x) => x.halfLen);
    return { max: Math.max(...lens, 0) };
  });
  H.check('bond visible lengths recalc after an atom-size change',
    bondBefore !== null && bondAfter.max < bondBefore - 1e-6,
    JSON.stringify({ bondBefore, bondAfter }));

  await H.setSlider(page, 'atomSize', 0.3444); // back to the default 0.40
  await page.waitForTimeout(600); // debounced bond rebuild at the default size

  // --- Bond diameter survives a repaint (the double-click-reset bug) --------------
  await H.setSlider(page, 'bondWidth', 0.8); // thick bonds via the Visual slider
  const bondRadius = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updateBonds } = await import('./render/index.js');
    const bond = fileBrowser.selectedStructure.bonds.find((b) => b.instanceIds);
    const before = groups.bondsMesh.instanceMatrix.array[bond.instanceIds[0] * 16];
    await updateBonds(1); // the repaint that used to revert slider-only updates
    const after = groups.bondsMesh.instanceMatrix.array[bond.instanceIds[0] * 16];
    return { modelRadius: bond.radius, before, after };
  });
  H.check('bond diameter sticks in the Bond model and survives updateBonds',
    Math.abs(bondRadius.modelRadius - bondRadius.before) < 1e-6
      && Math.abs(bondRadius.after - bondRadius.before) < 1e-6
      && bondRadius.before > 0.5,
    JSON.stringify(bondRadius));
  await H.setSlider(page, 'bondWidth', 0.3090); // back to the default 0.10

  // --- Bond endpoints respect per-species atom radius scales ----------------------
  const bondEndpoints = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { scheduleBondRebuild } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    const before = structure.bonds.find((b) => b.elements.includes('Cu'))?.r1;
    structure.atoms.forEach((atom, i) => {
      if (structure.elements[i] === 'Cu') atom.setRadiusScale(0.4);
    });
    scheduleBondRebuild(0);
    await new Promise((r) => setTimeout(r, 400));
    const bond = structure.bonds.find((b) => b.elements[0] === 'Cu');
    const scaled = bond ? bond.r1 : null;
    // restore
    structure.atoms.forEach((atom, i) => {
      if (structure.elements[i] === 'Cu') atom.setRadiusScale(1);
    });
    scheduleBondRebuild(0);
    await new Promise((r) => setTimeout(r, 400));
    return { before, scaled };
  });
  H.check('bond clip radii include per-atom radius scales after rebuild',
    bondEndpoints.scaled !== null && bondEndpoints.scaled < bondEndpoints.before * 0.6,
    JSON.stringify(bondEndpoints));

  // --- Material editors exist in the Structure window ----------------------------
  const editors = await page.evaluate(() => ({
    materialEditors: document.querySelectorAll('.material-editor').length,
    typeSelects: document.querySelectorAll('.material-type-select').length,
  }));
  H.check('material editors present in the species editors',
    editors.materialEditors > 0 && editors.typeSelects === editors.materialEditors,
    JSON.stringify(editors));

  // --- Emissive material glows under raytrace ------------------------------------
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame (no depth-peel preview stalling RAF assertions)
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(3500);
  const shot1 = await H.shotCanvas(page, 'tracermaterials-baseline');

  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = structure.atomMaterials ?? {};
    structure.atomMaterials['Cu'] = { type: 'emissive', intensity: 14 };
    structure.atomMaterials['Ba'] = { type: 'metal', roughness: 0.1 };
    requestRender(); // encoder fingerprint picks the store change up
  });
  await page.waitForTimeout(3500);
  const encoded = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return { id: app.pipeline?.id, samples: u?.uSampleCounter.value, atoms: u?.uAtomCount.value };
  });
  const shot2 = await H.shotCanvas(page, 'tracermaterials-emissive');
  const changed = changedPixelCount(shot1, shot2);
  H.check('material edit re-encoded the scene (accumulation reset + resumed)',
    encoded.id === 'raytrace' && encoded.samples > 2 && encoded.atoms > 0, JSON.stringify(encoded));
  H.check('emissive/metal materials visibly change the ray-traced structure',
    changed > 1000, JSON.stringify({ changedPixels: changed }));

  // --- Per-atom override + per-material reflectivity encode into the texels ------
  const texels = await page.evaluate(async () => {
    const { fileBrowser, groups, app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    const cuIndex = structure.elements.findIndex((e) => e === 'Cu');
    structure.atomUserMaterials = structure.atomUserMaterials ?? {};
    structure.atomUserMaterials[cuIndex] = { type: 'glass', ior: 2.0 }; // beats emissive species entry
    structure.atomMaterials['Y'] = { type: 'standard', reflectivity: 0.8 };
    requestRender();
    await new Promise((r) => setTimeout(r, 1200)); // one frame re-encodes
    const data = app.pipeline._encoder.atomsTexture.image.data;
    const srcIndex = structure.periodic.wrapped.srcIndex;
    const mesh = groups.atomsMesh;
    let cu = null, y = null;
    for (let i = 0; i < mesh.count; i++) {
      const src = srcIndex ? srcIndex[i] : i;
      const d = i * 12;
      if (src === cuIndex && !cu) cu = { type: data[d + 8], typeParam: data[d + 10] };
      if (structure.elements[src] === 'Y' && !y) y = { type: data[d + 8], reflectivity: data[d + 11] };
    }
    return { cu, y };
  });
  H.check('per-atom override (glass beats emissive species) + reflectivity texel',
    texels.cu?.type === 2 && Math.abs(texels.cu?.typeParam - 2.0) < 1e-6
      && texels.y?.type === 0 && Math.abs(texels.y?.reflectivity - 0.8) < 1e-6,
    JSON.stringify(texels));

  // --- Illustration features: ground plane + DoF + translucent + frosted glass ----
  await H.clickById(page, 'showPolyhedra'); // also needed for the edge checks below
  await page.waitForTimeout(3000);
  const plainShot = await H.shotCanvas(page, 'tracermaterials-plain');
  await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtGroundPlane = true;
    general.rtDofAperture = 0.6;
    general.ptLightSoftness = 0.6;
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials['O'] = { type: 'translucent', scatterDepth: 0.8 };
    structure.atomMaterials['Y'] = { type: 'glass', frost: 0.5, ior: 1.5, tintDepth: 0.8 };
    requestRender();
  });
  await page.waitForTimeout(4000);
  const featShot = await H.shotCanvas(page, 'tracermaterials-illustration');
  const featChanged = changedPixelCount(plainShot, featShot);
  H.check('ground plane + DoF + translucent + frost render under raytrace',
    featChanged > 500, JSON.stringify({ featChanged })); // smoke: features change the image at all

  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await page.waitForTimeout(10000); // PT + polys + edges + ground is slow under software GL
  const ptFeat = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { id: app.pipeline.id, samples: app.pipeline._uniforms.uSampleCounter.value };
  });
  H.check('pathtrace renders with all illustration features (shader compiles + accumulates)',
    ptFeat.id === 'pathtrace' && ptFeat.samples > 1, JSON.stringify(ptFeat));
  H.check('no page errors with illustration features', errors.length === 0, errors.join(' | '));

  // back to raytrace with the extras off for the remaining checks
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtGroundPlane = false;
    general.rtDofAperture = 0;
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(800);

  // --- Polyhedra edges render in the tracers (encoded as thin cylinders) ----------
  await H.setSlider(page, 'polyEdgeWidth', 0); // 0 = no edges (new slider minimum)
  await page.waitForTimeout(2500);
  const edgesOffShot = await H.shotCanvas(page, 'tracermaterials-edges-off');
  await H.setSlider(page, 'polyEdgeWidth', 6);
  await page.waitForTimeout(2500);
  const edgesOnShot = await H.shotCanvas(page, 'tracermaterials-edges-on');
  const edgeDelta = changedPixelCount(edgesOffShot, edgesOnShot);
  H.check('polyhedra edges appear in the ray tracer and width 0 hides them',
    edgeDelta > 300, JSON.stringify({ edgeDelta }));
  await H.setSlider(page, 'polyEdgeWidth', 1); // back to the default hairline
  await page.waitForTimeout(800); // let the re-encode/reset settle (the bar
  // section below forces convergence and must not race a pending reset)

  // --- Ground plane options (orientation / pattern / colors / reflect) ------------
  const groundUi = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('rtGroundToggle'));
    const options = document.getElementById('rtGroundPattern')?.closest('.control-row')?.parentElement;
    const hiddenWhenOff = getComputedStyle(options).display === 'none';
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const shownWhenOn = getComputedStyle(options).display !== 'none';
    general.rtGroundPattern = 'solid';
    requestRender();
    return {
      hiddenWhenOff, shownWhenOn,
      hasControls: !document.getElementById('rtGroundMode') // orientation control removed
        && !!document.getElementById('rtGroundPattern')
        && !!document.getElementById('rtGroundColor1') && !!document.getElementById('rtGroundColor2')
        && !!document.getElementById('rtGroundScale') && !!document.getElementById('rtGroundReflect'),
    };
  });
  H.check('ground options reveal with the toggle and all controls exist',
    groundUi.hiddenWhenOff && groundUi.shownWhenOn && groundUi.hasControls, JSON.stringify(groundUi));

  // Ground distance/size sliders: [0,1] positions with the QUADRATIC mapping
  // (position 1 = range max 50 A / 30x; position 0.5 = quarter of the range).
  const quadSliders = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const set = (id, pos) => {
      const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
      el.value = String(pos);
      el.dispatchEvent(new Event('input'));
    };
    set('rtGroundOffset', 1);
    const offMax = general.rtGroundOffset;
    set('rtGroundOffset', 0.5);
    const offMid = general.rtGroundOffset;
    set('rtGroundOffset', Math.sqrt(0.75 / 50)); // back to the default 0.75
    set('rtGroundSize', 1);
    const sizeMax = general.rtGroundSize;
    set('rtGroundSize', Math.sqrt((2.5 - 0.5) / 29.5)); // back to the default 2.5x
    return { offMax, offMid, sizeMax, offRestored: general.rtGroundOffset, sizeRestored: general.rtGroundSize };
  });
  H.check('ground distance/size sliders are quadratic with the larger ranges',
    Math.abs(quadSliders.offMax - 50) < 1e-6 && Math.abs(quadSliders.offMid - 12.5) < 1e-6
      && Math.abs(quadSliders.sizeMax - 30) < 1e-6
      && Math.abs(quadSliders.offRestored - 0.75) < 0.01 && Math.abs(quadSliders.sizeRestored - 2.5) < 0.01,
    JSON.stringify(quadSliders));

  await page.waitForTimeout(2500);
  const groundSolid = await H.shotCanvas(page, 'tracermaterials-ground-solid');
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtGroundPattern = 'checker';
    general.rtGroundColor1 = '#c8b060';
    general.rtGroundColor2 = '#404040';
    general.rtGroundReflect = 0.3;
    requestRender();
  });
  await page.waitForTimeout(2500);
  const groundChecker = await H.shotCanvas(page, 'tracermaterials-ground-checker');
  const groundDelta = changedPixelCount(groundSolid, groundChecker);
  H.check('checkerboard/reflect ground renders differently from solid',
    groundDelta > 2000, JSON.stringify({ groundDelta }));

  // Ground distance slider + placement math + finite disc:
  // d = minY - offset; disc radius = rtGroundSize * structureRadius (min 5).
  const groundGeom = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const u = app.pipeline._uniforms;
    const enc = app.pipeline._encoder;
    const render = () => app.pipeline.render(
      { renderer: app.renderer, scene: app.scene, camera: app.camera });
    general.rtGroundOffset = 4;
    render();
    const structureOk = Math.abs(u.uGroundD.value - (enc.minY - 4)) < 1e-3;
    const discOk = Math.abs(u.uGroundRadius.value
      - Math.max((general.rtGroundSize ?? 2.5) * enc.structureRadius, 5)) < 1e-3;
    requestRender();
    return { structureOk, discOk, d: u.uGroundD.value, r: u.uGroundRadius.value };
  });
  H.check('ground distance applies and the ground is a finite disc',
    groundGeom.structureOk && groundGeom.discOk, JSON.stringify(groundGeom));
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtGroundPlane = false;
    general.rtGroundPattern = 'solid';
    general.rtGroundColor1 = null;
    general.rtGroundColor2 = null;
    general.rtGroundReflect = 0;
    general.rtGroundOffset = 0.75;
    general.rtGroundSize = 2.5;
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('rtGroundToggle'));
    toggle.checked = false;
    requestRender();
  });
  await page.waitForTimeout(800);

  // --- Structure-window tracer options hide under raster pipelines ----------------
  const gating = await page.evaluate(() => {
    const editor = document.querySelector('.material-editor');
    if (!editor) return { editor: false };
    const visibleUnderTracer = getComputedStyle(editor).display !== 'none'
      && document.body.classList.contains('tracer-pipeline');
    return { editor: true, visibleUnderTracer };
  });
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await page.waitForTimeout(400);
  const gatingRaster = await page.evaluate(() => ({
    hiddenUnderRaster: getComputedStyle(document.querySelector('.material-editor')).display === 'none'
      && !document.body.classList.contains('tracer-pipeline'),
  }));
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(600);
  H.check('material editors show under tracers and hide under raster pipelines',
    gating.editor && gating.visibleUnderTracer && gatingRaster.hiddenUnderRaster,
    JSON.stringify({ gating, gatingRaster }));

  // --- Accumulation progress bar --------------------------------------------------
  const barState = await page.evaluate(() => {
    const bar = document.getElementById('tracerProgress');
    const fill = document.getElementById('tracerProgressFill');
    // The strip is parented to <body> with position:fixed (so it can stack above
    // the export modal), geometry mirrored onto #view's bounding rect.
    const view = document.getElementById('view');
    const vr = view?.getBoundingClientRect();
    const alignedToView = !!bar && !!vr
      && Math.abs(parseFloat(bar.style.left) - vr.left) < 2
      && Math.abs(parseFloat(bar.style.width) - vr.width) < 2;
    return {
      exists: !!bar && !!fill,
      inBody: bar?.parentElement === document.body,
      fixed: bar ? getComputedStyle(bar).position === 'fixed' : false,
      alignedToView,
      visible: bar ? getComputedStyle(bar).opacity !== '0' : false,
      fillWidth: fill ? parseFloat(fill.style.width) : 0,
    };
  });
  H.check('accumulation progress bar shows while the tracer refines',
    barState.exists && barState.inBody && barState.fixed && barState.alignedToView
      && barState.visible && barState.fillWidth > 5,
    JSON.stringify(barState));

  // Force convergence: the bar must fill and fade out.
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    app.pipeline._uniforms.uSampleCounter.value = app.pipeline._cfg.targetSamples - 1;
    requestRender();
  });
  await page.waitForTimeout(2500);
  const barDone = await page.evaluate(() => {
    const bar = document.getElementById('tracerProgress');
    return { opacity: bar ? getComputedStyle(bar).opacity : null };
  });
  H.check('progress bar fades out once converged', barDone.opacity === '0', JSON.stringify(barDone));

  // --- Camera-motion tolerance ------------------------------------------------------
  // Damped-controls coast-down drifts the matrix by sub-pixel amounts; that
  // must NOT reset the accumulation (the "bar never starts" bug), while a
  // real camera move must.
  const motion = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const u = app.pipeline._uniforms;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = u.uSampleCounter.value; // converged at target from the bar check
    app.camera.position.x += 1e-6; // damping-tail-scale drift
    requestRender();
    await wait(1200);
    const afterTiny = u.uSampleCounter.value;
    app.camera.position.x += 0.5; // a real move
    requestRender();
    await wait(1200);
    const afterBig = u.uSampleCounter.value;
    app.camera.position.x -= 0.5 + 1e-6;
    return { before, afterTiny, afterBig };
  });
  H.check('camera tolerance: sub-pixel drift keeps accumulating, real moves reset',
    motion.afterTiny >= motion.before && motion.afterBig < motion.afterTiny,
    JSON.stringify(motion));

  // --- Damping momentum settles to strict zero --------------------------------------
  const settled = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const c = app.controls;
    // plant a sub-perceptual damping residue (as the coast-down tail leaves)
    c._moveCurr.set(c._movePrev.x + 5e-5, c._movePrev.y);
    c._lastAngle = 5e-5;
    await new Promise((r) => setTimeout(r, 400)); // a few animate frames
    return { gap: c._moveCurr.distanceTo(c._movePrev), lastAngle: c._lastAngle };
  });
  H.check('trackball damping tail snaps to exactly zero',
    settled.gap === 0 && settled.lastAngle === 0, JSON.stringify(settled));

  // --- Background change restarts the accumulation ---------------------------------
  // (a converged image would otherwise keep showing the OLD background forever)
  const bgReset = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const THREE = await import('./external/three/three.module.js');
    const u = app.pipeline._uniforms;
    const target = app.pipeline._cfg.targetSamples;
    u.uSampleCounter.value = target; // simulate a converged, idle image
    app.scene.background = new THREE.Color('#204060');
    requestRender();
    await new Promise((r) => setTimeout(r, 1500));
    const after = u.uSampleCounter.value;
    return { target, after, bg: u.uBackgroundColor.value.getHexString() };
  });
  H.check('background change resets the tracer accumulation',
    bgReset.after < bgReset.target && bgReset.after > 0 && bgReset.bg === '204060',
    JSON.stringify(bgReset));

  // The traced backdrop must match the picked color EXACTLY (display-transform
  // pre-compensation: three never tone-maps a plain-color background).
  await page.waitForTimeout(1500);
  const bgShot = await H.shotCanvas(page, 'tracermaterials-bgmatch');
  const bgPng = PNG.sync.read(fs.readFileSync(bgShot));
  const corner = ((x, y) => {
    const o = (y * bgPng.width + x) * 4;
    return [bgPng.data[o], bgPng.data[o + 1], bgPng.data[o + 2]];
  })(12, bgPng.height - 12);
  H.check('traced background matches the picked color (#204060 = rgb(32,64,96))',
    Math.abs(corner[0] - 32) <= 6 && Math.abs(corner[1] - 64) <= 6 && Math.abs(corner[2] - 96) <= 6,
    JSON.stringify({ corner }));

  // ... and stays pinned when the Saturation slider grades the scene.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtSaturation = 1.7;
    requestRender();
  });
  await page.waitForTimeout(2000); // saturation change re-accumulates now
  const satShot = await H.shotCanvas(page, 'tracermaterials-bgsat');
  const satPng = PNG.sync.read(fs.readFileSync(satShot));
  const satCorner = ((x, y) => {
    const o = (y * satPng.width + x) * 4;
    return [satPng.data[o], satPng.data[o + 1], satPng.data[o + 2]];
  })(12, satPng.height - 12);
  H.check('background stays pinned under a cranked Saturation slider',
    Math.abs(satCorner[0] - 32) <= 8 && Math.abs(satCorner[1] - 64) <= 8 && Math.abs(satCorner[2] - 96) <= 8,
    JSON.stringify({ satCorner }));
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtSaturation = 1;
  });

  // --- Light sliders exist and rewire the uniforms ----------------------------------
  const lights = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtLightIntensity = 2.5;
    general.rtAmbient = 0.8;
    requestRender();
    await new Promise((r) => setTimeout(r, 800));
    const u = app.pipeline._uniforms;
    return {
      hasSliders: !!document.getElementById('rtLightIntensity') && !!document.getElementById('rtAmbient'),
      ambient: u.uAmbientStrength.value,
      lightHex: u.uLightColor.value.r, // key light white x 2.5 -> r 2.5
    };
  });
  H.check('light intensity + ambient sliders drive the tracer uniforms',
    lights.hasSliders && Math.abs(lights.ambient - 0.8) < 1e-6 && lights.lightHex > 2.0,
    JSON.stringify(lights));
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtLightIntensity = 1.2;
    general.rtAmbient = 0.3;
  });

  // --- Saturation grade (output pass: instant, no re-accumulation) -----------------
  const satShotColored = await H.shotCanvas(page, 'tracermaterials-saturated');
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtSaturation = 0; // grayscale grade
    requestRender();
  });
  await page.waitForTimeout(600);
  const satShotGray = await H.shotCanvas(page, 'tracermaterials-desaturated');
  const satMetric = await page.evaluate(() => ({ ok: true }));
  const maxChroma = (file) => {
    const png = PNG.sync.read(fs.readFileSync(file));
    let m = 0;
    for (let y = 0; y < png.height; y += 3) {
      for (let x = 0; x < png.width; x += 3) {
        const o = (y * png.width + x) * 4;
        const [r, g, b] = [png.data[o], png.data[o + 1], png.data[o + 2]];
        m = Math.max(m, Math.max(r, g, b) - Math.min(r, g, b));
      }
    }
    return m;
  };
  const chromaColored = maxChroma(satShotColored);
  const chromaGray = maxChroma(satShotGray);
  H.check('saturation 0 renders the traced image grayscale (output-pass grade)',
    satMetric.ok && chromaColored > 60 && chromaGray < 15,
    JSON.stringify({ chromaColored, chromaGray }));
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtSaturation = 1;
    requestRender();
  });
  await page.waitForTimeout(400);

  // --- PNG export boost API --------------------------------------------------------
  const boost = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.pipeline.requestBoost(200);
    const armed = app.pipeline._boostSamples;
    app.pipeline._boostSamples = 0; // disarm: don't burst inside this test
    return { boostSamples: armed };
  });
  H.check('requestBoost arms the export accumulation burst',
    boost.boostSamples === 200, JSON.stringify(boost));

  // --- PNG export renders tracers to full convergence --------------------------------
  const exported = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app, general } = await import('./state/store.js');
    const target = app.pipeline._cfg.targetSamples;
    let maxSamplesSeen = 0;
    let maxAccumW = 0;
    let lastAccumW = 0;
    const origRender = app.pipeline.render.bind(app.pipeline);
    app.pipeline.render = (ctx) => {
      origRender(ctx);
      maxSamplesSeen = Math.max(maxSamplesSeen, app.pipeline._uniforms.uSampleCounter.value);
      maxAccumW = Math.max(maxAccumW, app.pipeline._accumTarget.width);
      lastAccumW = app.pipeline._accumTarget.width;
    };
    try {
      const blob = await captureSceneToPng({ width: 320, height: 240, margin: 0, transparent: true });
      return {
        size: blob?.size ?? 0, type: blob?.type, target, maxSamplesSeen, maxAccumW, lastAccumW,
        scaleRestored: general.rtResolutionScale,
      };
    } finally {
      app.pipeline.render = origRender;
    }
  });
  H.check('PNG export accumulates the tracer to its convergence target',
    exported.size > 0 && exported.type === 'image/png' && exported.maxSamplesSeen >= exported.target,
    JSON.stringify(exported));
  // 100% internal resolution during export (interactive scale is 0.25 here,
  // which would cap the final pass at ~80px), the source render stays capped
  // near the requested output size (the 8192-blowup crash guard; the fixed
  // 1024 probe pass is the max), and the interactive scale is restored.
  H.check('PNG export traces at 100% resolution within the output-size cap',
    exported.lastAccumW >= 300 && exported.lastAccumW <= 400
      && exported.maxAccumW <= 1100
      && Math.abs(exported.scaleRestored - 0.25) < 1e-9,
    JSON.stringify(exported));

  // --- Materials persist (species map + category stores in captureState) ---------
  const persisted = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState();
    return {
      version: state.version,
      atomMaterials: state.colors.atomMaterials,
      atomUserMaterials: state.colors.atomUserMaterials,
    };
  });
  H.check('captureState persists atomMaterials + per-atom overrides (v2.11)',
    persisted.version === '2.11' && persisted.atomMaterials?.Cu?.type === 'emissive'
      && persisted.atomMaterials?.Ba?.type === 'metal'
      && Object.values(persisted.atomUserMaterials ?? {}).some((m) => m?.type === 'glass'),
    JSON.stringify(persisted));

  // --- PT key light is a fixture: never directly visible ---------------------------
  // Perspective camera pulled past the light distance (max(40, 4*radius)):
  // the light sphere would sit dead-center between camera and structure.
  await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25;
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('orthographicCamera'));
    toggle.checked = false;
    toggle.onchange({ target: toggle });
    const dir = app.camera.position.clone().sub(app.controls.target).normalize();
    app.camera.position.copy(app.controls.target).addScaledVector(dir, 130);
    app.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(400);
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await page.waitForTimeout(6000);
  const fixtureShot = await H.shotCanvas(page, 'tracermaterials-light-fixture');
  const fixturePng = PNG.sync.read(fs.readFileSync(fixtureShot));
  let whitePixels = 0;
  for (let i = 0; i < fixturePng.data.length; i += 4) {
    if (fixturePng.data[i] > 240 && fixturePng.data[i + 1] > 240 && fixturePng.data[i + 2] > 240) whitePixels++;
  }
  H.check('path-tracer key light sphere is not directly visible (perspective, far camera)',
    whitePixels < 2000, JSON.stringify({ whitePixels }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
