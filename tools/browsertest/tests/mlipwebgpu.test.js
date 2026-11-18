// PET-MAD's WebGPU build (external/mlip_wasm/gpu) gives the same energies,
// forces and stress as the CPU build. Needs WebGPU: run with
// CRYSVIZ_BROWSER=chromium CRYSVIZ_GPU=swiftshader (emulated on the CPU — a
// correctness check, timings meaningless) or CRYSVIZ_GPU=hardware on a machine
// with a GPU, and a model under docs/bench-models/ (pet-mad-xs.gguf).
// Skips (passes with a note) where WebGPU is unavailable.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const wasmLog = [];
  page.on('console', (m) => { if (m.text().includes('[mlip]')) wasmLog.push(m.text()); });
  page.on('worker', (w) => w.on('console', (m) => { if (m.text().includes('[mlip]')) wasmLog.push(m.text()); }));
  await H.loadDefaultStructure(page);
  const r = await page.evaluate(async () => {
    const hasGpu = 'gpu' in navigator;
    const adapter = hasGpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (!adapter) return { skipped: hasGpu ? 'no WebGPU adapter' : 'navigator.gpu missing' };
    const info = adapter.info || {};
    if (!adapter.features.has('shader-f16')) {
      // The GPU build needs shader-f16; the runner must refuse up front (so the
      // panel can fall back) instead of aborting the module on model load.
      const { WorkerMLIPRunner } = await import('./atomistic/mlipWorkerClient.js');
      const runner = new WorkerMLIPRunner({ backend: 'webgpu' });
      let refused = null;
      try { await runner.init(); } catch (e) { refused = e.message || String(e); }
      runner.destroy();
      return { noF16: true, refused, adapter: `${info.vendor || '?'} ${info.description || ''}`.trim() };
    }
    const { WorkerMLIPRunner } = await import('./atomistic/mlipWorkerClient.js');
    const { buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { fileBrowser } = await import('./state/store.js');
    const url = new URL('./bench-models/pet-mad-xs.gguf', document.baseURI).href;
    const out = {};
    for (const backend of ['cpu', 'webgpu']) {
      const runner = new WorkerMLIPRunner({ backend, threads: 1 });
      try {
        await runner.init();
        await runner.loadModelFromUrl(url);
        const s = buildNEPStructure(runner, fileBrowser.selectedStructure);
        const a = await runner.compute(s);
        const t0 = performance.now();
        const b = await runner.compute(s);
        out[backend] = { variant: runner.describe().variant, e: a.total_energy, e2: b.total_energy,
          f: a.forces.flat(), s: a.stress?.voigt ?? null, ms: performance.now() - t0 };
      } catch (e) {
        out[backend] = { error: e.message || String(e) };
      } finally {
        runner.destroy();
      }
    }
    return { adapter: `${info.vendor || '?'} ${info.architecture || ''} ${info.description || ''}`.trim(), ...out };
  });
  if (r.noF16) {
    console.log(`  adapter ${r.adapter} lacks shader-f16: numeric comparison not possible here`);
    H.check('without shader-f16 the WebGPU runner refuses at init with a clear reason',
      typeof r.refused === 'string' && /shader-f16/.test(r.refused), String(r.refused));
  } else if (r.skipped) {
    console.log(`  (skipped: ${r.skipped})`);
    H.check('WebGPU unavailable here — nothing to compare', true);
  } else {
    console.log(`  adapter: ${r.adapter}`);
    console.log(`  cpu ${JSON.stringify({ e: r.cpu?.e, ms: r.cpu?.ms })}  webgpu ${JSON.stringify({ e: r.webgpu?.e, ms: r.webgpu?.ms, error: r.webgpu?.error })}`);
    if (r.webgpu?.error) console.log(`  wasm log (last lines):\n    ${wasmLog.slice(-12).join('\n    ')}`);
    H.check('the WebGPU build starts and evaluates', r.webgpu && !r.webgpu.error && r.webgpu.variant === 'gpu',
      JSON.stringify(r.webgpu?.error || r.webgpu?.variant));
    if (r.cpu && r.webgpu && !r.webgpu.error) {
      const dE = Math.abs(r.cpu.e - r.webgpu.e);
      const dF = Math.max(...r.cpu.f.map((v, i) => Math.abs(v - r.webgpu.f[i])));
      const dS = r.cpu.s && r.webgpu.s ? Math.max(...r.cpu.s.map((v, i) => Math.abs(v - r.webgpu.s[i]))) : NaN;
      console.log(`  |dE| ${dE.toExponential(2)} eV, max |dF| ${dF.toExponential(2)} eV/A, max |dS| ${dS.toExponential(2)}`);
      H.check('WebGPU energy matches the CPU build (f32 tolerance)', dE < 1e-3 * Math.max(1, Math.abs(r.cpu.e)), String(dE));
      H.check('WebGPU forces match the CPU build', dF < 1e-3, String(dF));
      H.check('WebGPU stress matches the CPU build', !(dS > 1e-4), String(dS));
      H.check('WebGPU evaluations are repeatable', r.webgpu.e === r.webgpu.e2, `${r.webgpu.e} vs ${r.webgpu.e2}`);
    }
  }
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|\[mlip\]/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
