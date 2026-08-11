// Arrow checkpoint: raster force/spin arrows are encoded as convex bodies in
// both tracer pipelines, without a tracer shader-source change.
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
    return { bodies: e?.arrowBodyCount, planes: e?.arrowPlaneCount,
      logicalTexels: (e?.polyCount ?? 0) * 4 + (e?.arrowPlaneCount ?? 0),
      encodeMs: performance.now() - t0 };
  });
  H.check('ray encoder emits two convex bodies per visible force arrow',
    forceMetrics.bodies === 6 && forceMetrics.planes === 57
      && forceMetrics.planes / 3 === 19 && forceMetrics.logicalTexels === 81
      && forceMetrics.logicalTexels / 3 === 27, JSON.stringify(forceMetrics));

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
        planes: app.pipeline._encoder.arrowPlaneCount,
      })));
      H.check('same-count force update moves traced arrows',
        movedState.bodies === 6 && movedState.planes === 57 && changedPixels(on, moved) > 40,
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
    return { bodies: e.arrowBodyCount, planes: e.arrowPlaneCount,
      logicalTexels: e.polyCount * 4 + e.arrowPlaneCount,
      encodeMs: performance.now() - t0 };
  });
  H.check('moderate-scene arrow scale is two bodies per atom',
    moderateBodies === moderateAtomCount * 2 && moderate.bodies === moderateAtomCount * 2,
    JSON.stringify({ atoms: moderateAtomCount, ...moderate }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
