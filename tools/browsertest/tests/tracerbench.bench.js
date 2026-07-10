// Tracer performance micro-benchmark (NOT part of the default suite — the
// `.bench.js` suffix keeps it out of run.sh's `tests/*.test.js` glob; run it
// manually: `tools/browsertest/run.sh tests/tracerbench.bench.js`).
//
// Loads YBCO, inflates it with a 3x3x3 supercell (logs the actual primitive
// counts), then times N untiled full-frame `pipeline.render(ctx)` calls for
// each tracer and reports ms/sample. A 1-px readRenderTargetPixels after each
// render forces a GPU sync — WebGL command submission is async, so without a
// readback we would time submission only, not the trace itself.
//
// This is a CPU-shader (llvmpipe / Mesa software GL) proxy: absolute numbers
// are machine-dependent, but it is fetch/ALU-sensitive — exactly the cost the
// tracer optimizations reduce — so relative before/after deltas are meaningful.
// The H.check bound is intentionally loose (just "it produced a number").
'use strict';
const H = require('../harness');

const N_SAMPLES = 8;   // timed untiled render() calls per tracer
const N_WARMUP = 3;    // discarded warm-up renders (shader/JIT warm)

async function benchTracer(page, pipelineId) {
  await H.setSelect(page, 'renderPipelineMenu', pipelineId);
  // blue-noise wait: its async onLoad resets the accumulation once
  {
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
  }
  return page.evaluate(async ({ nSamples, nWarmup }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const renderer = app.renderer;
    const ctx = { renderer, scene: app.scene, camera: app.camera };
    // Manual untiled full-frame renders (no ctx.interactive => always traces;
    // rtTiledRender=false => untiled path; each render() == one sample).
    const pixel = new Float32Array(4);
    const syncOnNewest = () => {
      // 1-px readback forces the driver to finish all pending GL work; read
      // whichever target currently holds the newest sum (previous after the
      // ping-pong copy / swap). Any valid target flushes the pipeline.
      const tgt = p._previousTarget || p._accumTarget;
      try { renderer.readRenderTargetPixels(tgt, 0, 0, 1, 1, pixel); } catch { /* ignore */ }
    };
    for (let i = 0; i < nWarmup; i++) { p.render(ctx); }
    syncOnNewest();
    const counts = {
      atoms: p._uniforms.uAtomCount.value,
      cylinders: p._uniforms.uCylinderCount.value,
      polyhedra: p._uniforms.uPolyCount.value,
    };
    const t0 = performance.now();
    for (let i = 0; i < nSamples; i++) { p.render(ctx); }
    syncOnNewest();
    const elapsed = performance.now() - t0;
    return { counts, msPerSample: elapsed / nSamples, elapsed, nSamples };
  }, { nSamples: N_SAMPLES, nWarmup: N_WARMUP });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO (polyhedra-friendly)

  // Inflate the scene so the primitive loops dominate the timing.
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    createSupercell(3, 3, 3);
  });
  await page.waitForTimeout(1500);

  // Untiled, no preview, half internal resolution (software-GL affordable).
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false;
    general.rtTiledRender = false;
    general.rtResolutionScale = 0.5;
  });

  const rt = await benchTracer(page, 'raytrace');
  console.log(`BENCH raytrace  ms/sample=${rt.msPerSample.toFixed(2)}  `
    + `atoms=${rt.counts.atoms} cylinders=${rt.counts.cylinders} polyhedra=${rt.counts.polyhedra}  `
    + `(${rt.nSamples} samples, ${rt.elapsed.toFixed(1)} ms total)`);
  H.check('raytrace benchmark produced a ms/sample number',
    Number.isFinite(rt.msPerSample) && rt.msPerSample > 0, JSON.stringify(rt));

  const pt = await benchTracer(page, 'pathtrace');
  console.log(`BENCH pathtrace ms/sample=${pt.msPerSample.toFixed(2)}  `
    + `atoms=${pt.counts.atoms} cylinders=${pt.counts.cylinders} polyhedra=${pt.counts.polyhedra}  `
    + `(${pt.nSamples} samples, ${pt.elapsed.toFixed(1)} ms total)`);
  H.check('pathtrace benchmark produced a ms/sample number',
    Number.isFinite(pt.msPerSample) && pt.msPerSample > 0, JSON.stringify(pt));

  console.log(`BENCH SUMMARY primitives: atoms=${rt.counts.atoms} `
    + `cylinders=${rt.counts.cylinders} polyhedra=${rt.counts.polyhedra} | `
    + `raytrace=${rt.msPerSample.toFixed(2)} ms/s  pathtrace=${pt.msPerSample.toFixed(2)} ms/s`);

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
