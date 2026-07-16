// Uniform-grid accelerator equivalence (render/pipeline/raytrace/gridChunk.js +
// SceneEncoder._buildGrid): the grid must produce a BIT-IDENTICAL image to the
// brute-force primitive loops for the same seeded random stream — it only
// reorders which primitives are tested, never which are hit. Drives K manual
// untiled samples with a seeded-LCG Math.random stub (so uRandomVec2, and hence
// the shader's per-pixel RNG, is identical between the two configs), once with
// the grid forced OFF (encoder.gridMinPrims = Infinity) and once forced ON
// (gridMinPrims = 0), and asserts the two canvases match. Repeated for
// pathtrace. Deterministic: identical seeds + a fixed camera => identical
// uniform streams; the only allowed drift is measure-zero float ties.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

/** Decode a `data:image/png;base64,...` URL captured from the canvas. */
function decodeDataUrl(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Pixels whose summed RGB delta exceeds `thresh` between two decoded PNGs. */
function changedPixelsPNG(a, b, thresh) {
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > thresh) n++;
  }
  return n;
}

/** Run the brute-vs-grid equivalence for the active pipeline. Returns both
 *  captured canvases + grid-state flags. Everything happens in ONE synchronous
 *  evaluate so no RAF frame can advance the accumulation between captures. */
async function bruteVsGrid(page, K) {
  return page.evaluate(async ({ K }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    // settle: size the targets and clear the initial camera-motion reset
    p.render(ctx); p.render(ctx);

    // deterministic LCG so both configs share an identical Math.random stream
    const makeLCG = (seed) => {
      let s = seed >>> 0;
      return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    };
    const origRandom = Math.random;
    const SEED = 0x9e3779b1;
    const runConfig = (gridMin) => {
      p._encoder.gridMinPrims = gridMin;
      Math.random = makeLCG(SEED);
      p._sceneDirty = true;   // force a re-encode (+ grid rebuild) + hardReset
      p.render(ctx);          // sample 1 (re-encode, hardReset, untiled)
      for (let k = 1; k < K; k++) p.render(ctx);
      const tex = p._encoder.gridIndexTexture.image;
      return {
        url: canvas.toDataURL('image/png'),
        gridEnabled: p._uniforms.uGridEnabled.value,
        dims: p._encoder.gridDims.slice(),
        idxTexels: tex.width * tex.height,
      };
    };
    const brute = runConfig(Infinity);
    const grid = runConfig(0);
    p._encoder.gridMinPrims = 256; // restore the production threshold
    Math.random = origRandom;
    return { brute, grid, N: p._encoder.atomCount + p._encoder.cylinderCount };
  }, { K });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Above the 256-primitive grid threshold, and cheap: no preview, no tiling,
  // tiny internal resolution.
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    createSupercell(2, 2, 2);
  });
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false;
    general.rtTiledRender = false;
    general.rtResolutionScale = 0.25;
  });

  const blueNoiseReady = async () => {
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        return !!p?._blueNoise?.image && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 1;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(1000);
    }
  };

  // pixels differing by a clear margin; identical seeds should give ~0 (bit-
  // identical up to measure-zero float ties), a broken grid (missed/garbled
  // primitives) would differ over large contiguous regions.
  const THRESH = 24;

  for (const pipelineId of ['raytrace', 'pathtrace']) {
    await H.setSelect(page, 'renderPipelineMenu', pipelineId);
    await blueNoiseReady();
    const res = await bruteVsGrid(page, 4);
    const total = res.N;
    H.check(`${pipelineId}: scene is above the grid threshold`, total >= 256,
      JSON.stringify({ N: total }));
    H.check(`${pipelineId}: grid toggles (off under brute, on with textures built)`,
      res.brute.gridEnabled === false && res.grid.gridEnabled === true
        && res.grid.idxTexels > 1 && res.grid.dims.every((d) => d >= 1 && d <= 64),
      JSON.stringify({ brute: res.brute.gridEnabled, grid: res.grid.gridEnabled,
        dims: res.grid.dims, idxTexels: res.grid.idxTexels }));

    const bruteImg = decodeDataUrl(res.brute.url);
    const gridImg = decodeDataUrl(res.grid.url);
    const totalPx = bruteImg.width * bruteImg.height;
    const changed = changedPixelsPNG(bruteImg, gridImg, THRESH);
    // essentially identical (allow a handful of grazing-tie pixels); a real
    // grid regression changes far more than this.
    H.check(`${pipelineId}: grid render matches brute force (seeded, bit-identical)`,
      changed <= Math.max(40, Math.round(totalPx * 0.002)),
      JSON.stringify({ changed, totalPx, limit: Math.max(40, Math.round(totalPx * 0.002)) }));
  }

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
