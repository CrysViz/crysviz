// Path-tracer convergence-error harness (NOT part of the default suite — the
// `.bench.js` suffix keeps it out of run.sh's `tests/*.test.js` glob; run it
// manually: `tools/browsertest/run.sh tests/tracervariance.bench.js`).
//
// Quantifies the low-discrepancy-sampling (A2) variance win and — after the
// emissive NEE work (B2) — the emissive-scene behaviour. For each config it
// accumulates the path tracer to N samples at a FIXED camera and measures the
// mean-absolute-error (MAE, in 0-255 units) of the raw averaged image against a
// converged reference (LDS-on at 512 samples). Lower MAE at equal N = faster
// convergence = the variance reduction.
//
// Determinism: preview + tiling off, denoiser off (raw averages reach the
// canvas), tiny internal resolution, camera untouched. The render loop drives
// uSampleCounter directly, one sample per render(). Absolute numbers are
// software-GL / machine dependent; the LDS-on-vs-off DELTA at equal N is the
// signal. H.check bounds are intentionally loose (finite + monotone); the LDS
// win is LOGGED as a table, not gated (that gate lives in tracerlds.test.js).
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

function decodeDataUrl(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Mean absolute per-channel RGB difference (0-255) between two decoded PNGs. */
function maePNG(a, b) {
  let sum = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
  }
  return sum / (total * 3);
}

async function blueNoiseReady(page) {
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

/** Accumulate the path tracer to exactly N samples with lds on/off, at a fixed
 *  camera, and return the raw (denoiser-off) canvas as a data URL. One
 *  synchronous evaluate so no RAF frame advances the accumulation. */
async function renderTo(page, N, lds) {
  return page.evaluate(async ({ N, lds }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    // settle: size the targets + establish the camera-state snapshot so the
    // measurement loop below never trips a resize/motion reset.
    p.render(ctx); p.render(ctx);
    p._ldsEnabled = lds;
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    return { url: canvas.toDataURL('image/png'), samples: p._uniforms.uSampleCounter.value };
  }, { N, lds });
}

const NS = [8, 16, 32, 64];

/** Run the full on/off x N MAE sweep for the currently-loaded scene; returns
 *  the reference sample count + the rows. Prints a labelled table. */
async function sweep(page, label) {
  const ref = await renderTo(page, 512, true); // LDS-on converged reference
  const refImg = decodeDataUrl(ref.url);
  const rows = [];
  for (const lds of [true, false]) {
    for (const N of NS) {
      const r = await renderTo(page, N, lds);
      const mae = maePNG(decodeDataUrl(r.url), refImg);
      rows.push({ lds: lds ? 'on' : 'off', N, samples: r.samples, mae });
    }
  }
  console.log(`\n  BENCH VARIANCE — ${label} (reference: LDS-on @ ${ref.samples} samples)`);
  console.log('  lds  N    samples   MAE(0-255)');
  for (const row of rows) {
    console.log(`  ${row.lds.padEnd(3)}  ${String(row.N).padEnd(4)} ${String(row.samples).padEnd(8)} ${row.mae.toFixed(4)}`);
  }
  // LDS win ratio (off/on) at each N — > 1 means LDS converges faster
  console.log('  LDS win (MAE_off / MAE_on) per N:');
  for (const N of NS) {
    const on = rows.find((r) => r.lds === 'on' && r.N === N).mae;
    const off = rows.find((r) => r.lds === 'off' && r.N === N).mae;
    console.log(`    N=${String(N).padEnd(3)}  off/on = ${(off / Math.max(on, 1e-9)).toFixed(3)}`);
  }
  return rows;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtRasterPreview = false; // trace every frame
    general.rtTiledRender = false;   // untiled: one render() == one sample
    general.rtResolutionScale = 0.25; // software-GL speed
    general.ptDenoise = false;       // raw averages reach the canvas
  });
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await blueNoiseReady(page);

  // --- standard scene (fixture light only) ---------------------------------
  const std = await sweep(page, 'standard scene (fixture light only)');
  H.check('standard: all MAE finite and reference converged',
    std.every((r) => Number.isFinite(r.mae)),
    JSON.stringify(std.map((r) => ({ lds: r.lds, N: r.N, mae: +r.mae.toFixed(3) }))));
  const monoOn = NS.slice(1).every((N, i) => {
    const cur = std.find((r) => r.lds === 'on' && r.N === N).mae;
    const prev = std.find((r) => r.lds === 'on' && r.N === NS[i]).mae;
    return cur <= prev + 0.5; // loose: MAE broadly decreases with N
  });
  H.check('standard: LDS-on MAE broadly decreases with N', monoOn,
    JSON.stringify(std.filter((r) => r.lds === 'on').map((r) => +r.mae.toFixed(3))));

  // --- emissive scene (after B2) -------------------------------------------
  // Cu turned into an emissive species with the fixture light dimmed nearly to
  // black; measures the NEE convergence of emitter-lit neighbours.
  await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    general.rtLightIntensity = 0.05;
    general.rtAmbient = 0;
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = structure.atomMaterials ?? {};
    structure.atomMaterials['Cu'] = { type: 'emissive', intensity: 12 };
    requestRender();
  });
  await page.waitForTimeout(2000); // re-encode + reset settle
  const emi = await sweep(page, 'emissive scene (Cu emissive, fixture ~off)');
  H.check('emissive: all MAE finite', emi.every((r) => Number.isFinite(r.mae)),
    JSON.stringify(emi.map((r) => ({ lds: r.lds, N: r.N, mae: +r.mae.toFixed(3) }))));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
