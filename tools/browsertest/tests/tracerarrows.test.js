// Arrow checkpoint: raster force/spin arrows are encoded as analytic capped
// frustums in the cylinder bucket and exercised by both tracer shaders; this
// checkpoint intentionally covers the tracer shader-source change.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

function changedPixels(aFile, bFile, threshold = 10) {
  const a = PNG.sync.read(fs.readFileSync(aFile));
  const b = PNG.sync.read(fs.readFileSync(bFile));
  let n = 0;
  for (let i = 0; i < Math.min(a.width * a.height, b.width * b.height); i++) {
    const o = i * 4;
    if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]) > threshold) n++;
  }
  return n;
}

function arrowColorPixels(file, channel = 'force') {
  const png = PNG.sync.read(fs.readFileSync(file));
  let n = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (channel === 'force' ? r > 100 && r > g * 1.25 && r > b * 1.25
      : b > 90 && b > r * 1.15 && b > g * 0.9) n++;
  }
  return n;
}

function forceTaperProfile(file, base, apex) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const dx = apex.x - base.x, dy = apex.y - base.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 4)) return { ratio: Infinity, baseThickness: 0, apexThickness: 0, pixels: 0 };
  const ux = dx / length, uy = dy / length;
  const baseBand = [], apexBand = [];
  let pixels = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
      if (!(r > 100 && r > g * 1.25 && r > b * 1.25)) continue;
      const px = x - base.x, py = y - base.y;
      const along = (px * ux + py * uy) / length;
      if (along < 0.05 || along > 0.95) continue;
      const across = px * -uy + py * ux;
      pixels++;
      if (along <= 0.35) baseBand.push({ along, across });
      if (along >= 0.65) apexBand.push({ along, across });
    }
  }
  const meanBandThickness = (values, lo, hi) => {
    let sum = 0, samples = 0;
    for (let i = 0; i < 4; i++) {
      const a = lo + (hi - lo) * i / 4;
      const b = lo + (hi - lo) * (i + 1) / 4;
      const slice = values.filter((value) => value.along >= a && value.along <= b)
        .map((value) => value.across);
      if (slice.length > 1) {
        sum += Math.max(...slice) - Math.min(...slice);
        samples++;
      }
    }
    return { thickness: samples > 0 ? sum / samples : 0, samples };
  };
  // Keep along with across so each sub-band contributes to the mean width.
  const baseProfile = meanBandThickness(baseBand, 0.05, 0.35);
  const apexProfile = meanBandThickness(apexBand, 0.65, 0.95);
  const baseThickness = baseProfile.thickness;
  const apexThickness = apexProfile.thickness;
  return { ratio: baseThickness > 0 ? apexThickness / baseThickness : Infinity,
    baseThickness, apexThickness, baseSamples: baseProfile.samples,
    apexSamples: apexProfile.samples, pixels };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force, Spin } = await import('./model/index.js');
    const { updateForces, updateSpins, removeForces, removeSpins, requestRender } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.forces = s.atoms.map((_, i) => i < 3 ? new Force({ vector: [1, 0.15, 0], color: 0xff2020 }) : null);
    s.spins = s.atoms.map((_, i) => new Spin({
      vector: i < 3 ? [0, 0, 1] : [], color: 0x20d0ff,
    }));
    const vis = document.createElement('div');
    vis.id = 'speciesVisibilityContainer';
    [...new Set(s.elements)].forEach((el) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = `species-${el}`; cb.checked = true;
      vis.appendChild(cb);
    });
    document.body.appendChild(vis);
    general.rtResolutionScale = 0.25;
    general.rtRasterPreview = false;
    general.forceColorMap = 'none';
    general.forcesActive = false;
    general.spinsActive = false;
    removeForces(); removeSpins();
    updateForces(); updateSpins();
  });

  const waitTracer = async (id) => {
    const deadline = Date.now() + 90000;
    for (;;) {
      const ready = await page.evaluate((pipelineId) => {
        const p = window.__crysvizTestPipeline;
        return p?.id === pipelineId && p._shaderState === 'ready'
          && p._uniforms.uSampleCounter.value >= 8;
      }, id);
      if (ready || Date.now() > deadline) return ready;
      await page.waitForTimeout(500);
    }
  };
  const switchTracer = async (id) => {
    await page.evaluate(async (pipelineId) => {
      const { setActivePipeline } = await import('./render/pipeline/index.js');
      window.__crysvizTestPipeline = setActivePipeline(pipelineId);
    }, id);
    return waitTracer(id);
  };
  const setArrows = async (mode) => page.evaluate(async (which) => {
    const { general } = await import('./state/store.js');
    const { updateForces, updateSpins, removeForces, removeSpins, requestRender } = await import('./render/index.js');
    if (which === 'off') { general.forcesActive = false; general.spinsActive = false; removeForces(); removeSpins(); }
    if (which === 'force') { general.forcesActive = true; general.spinsActive = false; removeSpins(); updateForces(); }
    if (which === 'spin') { general.forcesActive = false; general.spinsActive = true; removeForces(); updateSpins(); }
    requestRender();
  }, mode);
  const waitArrowBodies = async (want) => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const count = await page.evaluate(() => import('./state/store.js')
        .then(({ app }) => app.pipeline?._encoder?.arrowBodyCount ?? -1));
      if (count === want || Date.now() > deadline) return count;
      await page.waitForTimeout(300);
    }
  };

  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await setArrows('off');
  await page.waitForTimeout(500);
  const rasterOff = await H.shotCanvas(page, 'tracer-arrows-raster-off');
  await setArrows('force');
  await page.waitForTimeout(500);
  const rasterArrowState = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    return { shaft: groups.forcesShaftMesh?.count ?? 0, tip: groups.forcesTipMesh?.count ?? 0,
      shaftVisible: !!groups.forcesShaftMesh?.visible, tipVisible: !!groups.forcesTipMesh?.visible };
  });
  H.check('raster force arrow meshes are populated and visible',
    rasterArrowState.shaft === 6 && rasterArrowState.tip === 3
      && rasterArrowState.shaftVisible && rasterArrowState.tipVisible,
    JSON.stringify(rasterArrowState));
  const rasterForce = await H.shotCanvas(page, 'tracer-arrows-raster-force');
  H.check('raster force arrows change the image', changedPixels(rasterOff, rasterForce) > 40,
    JSON.stringify({ changed: changedPixels(rasterOff, rasterForce) }));

  await switchTracer('raytrace');
  const forceMetrics = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const e = app.pipeline?._encoder;
    const t0 = performance.now();
    e.encode();
    const first = e.cylinderCount - e.arrowBodyCount;
    const data = e.cylindersTexture.image.data;
    const frustums = Array.from({ length: e.arrowBodyCount }, (_, j) => {
      const d = (first + j) * 32;
      return [data[d + 28], data[d + 29]];
    });
    return { bodies: e?.arrowBodyCount, cylinderCount: e?.cylinderCount, frustums,
      encodeMs: performance.now() - t0 };
  });
  H.check('ray encoder emits capped shaft/tip frustums per visible force arrow',
    forceMetrics.bodies === 6 && forceMetrics.frustums.length === 6
      && forceMetrics.frustums.every(([closed, rTop], j) => closed === 1
        && rTop === (j % 2 ? 0 : 1)),
    JSON.stringify(forceMetrics));

  // Isolate one arrow and view it side-on so the projected tip profile is
  // deterministic. This assertion fails if the frustum branch stops
  // executing and the tip falls back to an untapered cylinder.
  const taperSetup = await page.evaluate(async () => {
    const { app, fileBrowser, general, groups } = await import('./state/store.js');
    const { Force } = await import('./model/index.js');
    const { updateForces, removeSpins, requestRender } = await import('./render/index.js');
    const THREE = await import('./external/three/three.module.js');
    const structure = fileBrowser.selectedStructure;
    structure.forces = structure.atoms.map((_, i) => i === 0
      ? new Force({ vector: [1, 0, 0], color: 0xff2020 }) : null);
    general.forcesActive = true;
    general.spinsActive = false;
    general.forceColorMap = 'none';
    removeSpins();
    updateForces();
    const visibility = {
      atoms: groups.atomsMesh?.visible,
      bonds: groups.bondsMesh?.visible,
      lattice: groups.latticeGroup?.visible,
      polyhedra: groups.polyhedraGroup?.visible,
      showLattice: general.showLattice,
      cameraZoom: app.camera.zoom,
      cameraPosition: app.camera.position.toArray(),
      controlsTarget: app.controls.target.toArray(),
    };
    if (groups.atomsMesh) groups.atomsMesh.visible = false;
    if (groups.bondsMesh) groups.bondsMesh.visible = false;
    if (groups.latticeGroup) groups.latticeGroup.visible = false;
    if (groups.polyhedraGroup) groups.polyhedraGroup.visible = false;
    general.showLattice = false;
    const tip = groups.forcesTipMesh;
    tip.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4();
    tip.getMatrixAt(0, local);
    const world = new THREE.Matrix4().multiplyMatrices(tip.matrixWorld, local);
    const base = new THREE.Vector3(0, -0.5, 0).applyMatrix4(world);
    const apex = new THREE.Vector3(0, 0.5, 0).applyMatrix4(world);
    const target = base.clone().lerp(apex, 0.5);
    app.controls.target.copy(target);
    app.camera.position.set(target.x, target.y, target.z + 4.5);
    app.camera.zoom = Math.max(app.camera.zoom, 6);
    app.controls.update();
    app.camera.lookAt(target);
    app.camera.updateProjectionMatrix();
    app.camera.updateMatrixWorld(true);
    const rect = app.renderer.domElement.getBoundingClientRect();
    const project = (point) => {
      const ndc = point.clone().project(app.camera);
      return { x: rect.left + (ndc.x + 1) * rect.width / 2 - 460,
        y: rect.top + (1 - ndc.y) * rect.height / 2 - 120 };
    };
    requestRender();
    return { base: project(base), apex: project(apex), visibility };
  });
  await waitArrowBodies(2);
  await waitTracer('raytrace');
  const taperShot = await H.shotCanvas(page, 'tracer-arrows-raytrace-taper');
  const taper = forceTaperProfile(taperShot, taperSetup.base, taperSetup.apex);
  H.check('raytrace force tip visibly tapers toward its apex', taper.ratio <= 0.6
    && taper.baseSamples > 0 && taper.apexSamples > 0,
    JSON.stringify(taper));

  await page.evaluate(async (visibility) => {
    const { app, fileBrowser, general, groups } = await import('./state/store.js');
    const { Force } = await import('./model/index.js');
    const { updateForces, requestRender } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    if (groups.atomsMesh) groups.atomsMesh.visible = visibility.atoms;
    if (groups.bondsMesh) groups.bondsMesh.visible = visibility.bonds;
    if (groups.latticeGroup) groups.latticeGroup.visible = visibility.lattice;
    if (groups.polyhedraGroup) groups.polyhedraGroup.visible = visibility.polyhedra;
    general.showLattice = visibility.showLattice;
    app.camera.position.fromArray(visibility.cameraPosition);
    app.controls.target.fromArray(visibility.controlsTarget);
    app.camera.zoom = visibility.cameraZoom;
    app.controls.update();
    app.camera.updateProjectionMatrix();
    app.camera.updateMatrixWorld(true);
    s.forces = s.atoms.map((_, i) => i < 3
      ? new Force({ vector: [1, 0.15, 0], color: 0xff2020 }) : null);
    general.forcesActive = true;
    general.spinsActive = false;
    updateForces();
    requestRender();
  }, taperSetup.visibility);
  await waitArrowBodies(6);
  await waitTracer('raytrace');

  for (const id of ['raytrace', 'pathtrace']) {
    await switchTracer(id);
    const on = await H.shotCanvas(page, `tracer-arrows-${id}-force-on`);
    if (id === 'raytrace') {
      await page.evaluate(async () => {
        const { fileBrowser } = await import('./state/store.js');
        const { updateForces, requestRender } = await import('./render/index.js');
        fileBrowser.selectedStructure.forces[0].vector = [0, 1, 0];
        updateForces();
        requestRender();
      });
      await waitArrowBodies(6);
      await waitTracer(id);
      const moved = await H.shotCanvas(page, 'tracer-arrows-raytrace-force-moved');
      const movedState = await page.evaluate(async () => import('./state/store.js').then(({ app }) => ({
        bodies: app.pipeline._encoder.arrowBodyCount,
      })));
      H.check('same-count force update moves traced arrows',
        movedState.bodies === 6 && changedPixels(on, moved) > 40,
        JSON.stringify({ ...movedState, changed: changedPixels(on, moved) }));
    }
    await setArrows('off');
    await waitArrowBodies(0);
    await waitTracer(id);
    await page.waitForTimeout(300);
    const off = await H.shotCanvas(page, `tracer-arrows-${id}-force-off`);
    H.check(`${id} force arrows change the image`, changedPixels(off, on) > 120,
      JSON.stringify({ changed: changedPixels(off, on) }));
    H.check(`${id} force arrow colour is visible`, arrowColorPixels(on, 'force') > 5,
      JSON.stringify({ pixels: arrowColorPixels(on, 'force') }));

    await setArrows('spin');
    await waitArrowBodies(6);
    await waitTracer(id);
    await page.waitForTimeout(300);
    const spin = await H.shotCanvas(page, `tracer-arrows-${id}-spin-on`);
    H.check(`${id} spin arrows change the image`, changedPixels(off, spin) > 10,
      JSON.stringify({ changed: changedPixels(off, spin) }));
    H.check(`${id} spin arrow colour is visible`, arrowColorPixels(spin, 'spin') > 5,
      JSON.stringify({ pixels: arrowColorPixels(spin, 'spin') }));
  }

  // Scale sanity on the loaded 35-atom structure: two bodies per arrow, with
  // the actual CPU encode time and allocated poly texture recorded for handoff.
  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force } = await import('./model/index.js');
    const { updateForces, removeSpins } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.forces = s.atoms.map(() => new Force({ vector: [1, 0, 0], color: 0xff2020 }));
    general.forcesActive = true; general.spinsActive = false; general.forceColorMap = 'none';
    removeSpins();
    updateForces();
  });
  const moderateAtomCount = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.selectedStructure.atoms.length;
  });
  const moderateBodies = await waitArrowBodies(moderateAtomCount * 2);
  const moderate = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const e = app.pipeline._encoder;
    const t0 = performance.now(); e.encode();
    return { bodies: e.arrowBodyCount, cylinderCount: e.cylinderCount,
      encodeMs: performance.now() - t0 };
  });
  H.check('moderate-scene arrow scale is two bodies per atom',
    moderateBodies === moderateAtomCount * 2 && moderate.bodies === moderateAtomCount * 2,
    JSON.stringify({ atoms: moderateAtomCount, ...moderate }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
