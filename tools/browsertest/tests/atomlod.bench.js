// Atom LOD micro-benchmark (NOT part of the default suite — the `.bench.js`
// suffix keeps it out of run.sh's `tests/*.test.js` glob; run it by hand:
//   tools/browsertest/run.sh tests/atomlod.bench.js
//   ATOMLOD_CELL=8 tools/browsertest/run.sh tests/atomlod.bench.js   (8x8x8)
//
// Loads YBCO, inflates it to an NxNxN supercell with bonds off, then times
// GPU-synced renders of the whole scene as tessellated spheres and as
// imposters (render/AtomLodModule.js), zoomed out (every atom small) and
// zoomed in (a near-sphere set in play). Software GL in the harness means the
// absolute numbers are machine-dependent; the sphere/imposter ratio is what
// this measures. Also reports the near-set computation cost.
'use strict';
const H = require('../harness');

const CELL = Number(process.env.ATOMLOD_CELL || 6);
const N_SAMPLES = 6;
const N_WARMUP = 2;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  const res = await page.evaluate(async ({ cell, nSamples, nWarmup }) => {
    const { app, general, groups } = await import('./state/store.js');
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { renderFrameNow, setRenderBenchmark, atomLodStats } = await import('./render/index.js');
    const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

    general.showBonds = false;
    createSupercell(cell, cell, cell);
    await settle(1500);

    const time = () => {
      setRenderBenchmark(true); // each render ends in a 1-px readback (GPU sync)
      for (let i = 0; i < nWarmup; i++) renderFrameNow();
      const t0 = performance.now();
      for (let i = 0; i < nSamples; i++) renderFrameNow();
      const ms = (performance.now() - t0) / nSamples;
      setRenderBenchmark(false);
      return ms;
    };
    const zoom = (f) => {
      if (app.camera.isOrthographicCamera) app.camera.zoom *= f;
      else app.camera.position.multiplyScalar(1 / f);
      app.camera.updateProjectionMatrix();
      app.camera.updateMatrixWorld();
    };

    const out = { cell, instances: groups.atomsMesh.count };
    for (const mode of ['spheres', 'imposters']) {
      general.atomDetail = mode;
      updateVisualization({ reRenderAtoms: true, reRenderBonds: false });
      await settle(800);
      renderFrameNow();
      out[mode] = { far: time() };
      zoom(10);
      renderFrameNow();
      await settle(300); // past the near-set throttle
      renderFrameNow();
      out[mode].near = time();
      out[mode].lod = atomLodStats();
      zoom(0.1);
    }
    general.atomDetail = 'auto';
    general.showBonds = true;
    return out;
  }, { cell: CELL, nSamples: N_SAMPLES, nWarmup: N_WARMUP });

  const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
  console.log(`  ${CELL}x${CELL}x${CELL} YBCO: ${res.instances} drawn atoms, bonds off`);
  console.log(`  spheres   zoomed out ${f(res.spheres.far)} ms/frame   zoomed in ${f(res.spheres.near)} ms/frame`);
  console.log(`  imposters zoomed out ${f(res.imposters.far)} ms/frame   zoomed in ${f(res.imposters.near)} ms/frame`
    + `   near spheres ${res.imposters.lod.near}${res.imposters.lod.overflow ? '+' : ''}, near-set scan ${f(res.imposters.lod.computeMs)} ms`);
  console.log(`  ratio spheres/imposters: zoomed out ${(res.spheres.far / res.imposters.far).toFixed(2)}x, zoomed in ${(res.spheres.near / res.imposters.near).toFixed(2)}x`);
  H.check('both modes produced timings', Number.isFinite(res.spheres.far) && Number.isFinite(res.imposters.far));
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
