// PET-MAD runs in its own worker (workers/mlipWorker.js) — the twin of the
// NEP worker — and the loader picks the threaded wasm only on a cross-origin
// isolated page. Model weights come from Hugging Face, which a sandbox may
// not reach, so the model-level checks run only when a .gguf is available
// under docs/bench-models/ (gitignored; tools/bench/make_random_pet_gguf.py
// writes one); the transport checks always run.
//   tools/browsertest/run.sh tests/mlipworker.test.js
//   CRYSVIZ_COI=1 tools/browsertest/run.sh tests/mlipworker.test.js   # threaded build
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const MODEL_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'bench-models');
const MODEL = process.env.MLIPBENCH_MODEL
  || (fs.existsSync(MODEL_DIR) ? (fs.readdirSync(MODEL_DIR).find((f) => f.endsWith('.gguf')) || null) : null);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const boot = await page.evaluate(async () => {
    const { WorkerMLIPRunner } = await import('./atomistic/mlipWorkerClient.js');
    const { MLIPRunner } = await import('./external/mlip_wasm/mlip_runner.js');
    const isolated = globalThis.crossOriginIsolated === true;
    const worker = new WorkerMLIPRunner({ backend: 'cpu' });
    await worker.init();
    const inThread = new MLIPRunner({ backend: 'cpu' });
    await inThread.init();
    const out = { isolated, worker: worker.describe(), inThread: inThread.describe(),
      offThread: worker.offThread, supportsStress: worker.supportsStress };
    worker.destroy();
    inThread.destroy();
    return out;
  });
  H.check('worker runner boots and reports its runtime',
    boot.worker && (boot.worker.variant === 'cpu' || boot.worker.variant === 'cpu-mt') && boot.offThread === true
      && boot.supportsStress === true, JSON.stringify(boot));
  H.check(boot.isolated
    ? 'isolated page: the threaded build is loaded with more than one thread available'
    : 'un-isolated page: the single-threaded build is loaded',
  boot.isolated ? (boot.worker.variant === 'cpu-mt' && boot.worker.maxThreads > 1)
    : (boot.worker.variant === 'cpu' && boot.worker.threads === 1), JSON.stringify(boot));
  H.check('in-thread runner picks the same variant', boot.inThread.variant === boot.worker.variant, JSON.stringify(boot));

  // The panel path: ensureCalculatorRunner hands out a worker-backed runner
  // for PET-MAD unless general.mlipWorker is off. Without weights the load
  // fails at the fetch — the point here is which runner it built.
  const panel = await page.evaluate(async ({ model }) => {
    const { general } = await import('./state/store.js');
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'mlip';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 200));
    const select = document.querySelector('#BackendPotentialSelector [data-role="mlip-model"]');
    const multithread = document.querySelector('#BackendPotentialSelector [data-role="mlip-multithread"]');
    if (model && select) {
      const opt = document.createElement('option');
      opt.value = `./bench-models/${model}`;
      opt.textContent = model;
      select.appendChild(opt);
      select.value = opt.value;
    }
    let runner = null;
    let error = null;
    const statuses = [];
    try {
      ({ runner } = await ensureCalculatorRunner((t) => statuses.push(t)));
    } catch (e) {
      error = e.message || String(e);
    }
    // Headless loads report through the callback, not the panel's label.
    const status = statuses[statuses.length - 1] || '';
    let efs = null;
    if (runner) {
      const { buildNEPStructure } = await import('./atomistic/relaxer.js');
      const { fileBrowser } = await import('./state/store.js');
      const s = buildNEPStructure(runner, fileBrowser.selectedStructure);
      const a = await runner.compute(s);
      const b = await runner.compute(s);
      efs = { atoms: s.positions.length, energy: a.total_energy, repeat: b.total_energy,
        forcesLen: a.forces.length, stress: a.stress?.matrix3x3?.[0]?.[0], stressAvailable: a.stress?.available !== false };
      // The matrix-kernel A/B switch (blocked GEMM / dot products): it flips
      // in the running worker and both kernels give the same physics.
      if (typeof runner.setBlockedGemm === 'function') {
        const on = runner.describe().blockedGemm;
        const off = (await runner.setBlockedGemm(false)).blockedGemm;
        const c = await runner.compute(s);
        const back = (await runner.setBlockedGemm(true)).blockedGemm;
        let maxForceDiff = 0;
        a.forces.forEach((f, i) => f.forEach((x, k) => { maxForceDiff = Math.max(maxForceDiff, Math.abs(x - c.forces[i][k])); }));
        efs.gemm = { on, off, back, energyDiff: Math.abs(a.total_energy - c.total_energy), maxForceDiff };
      }
      // The WebGPU readback switch reaches the worker; on a CPU build it is a no-op.
      if (typeof runner.setGpuReadback === 'function') {
        const d = await runner.setGpuReadback('map');
        await runner.setGpuReadback('auto');
        const mm = await runner.setGpuMatmul('reg_tile');
        await runner.setGpuMatmul('tile4');
        efs.readback = { variant: d.variant, gpuReadback: d.gpuReadback, client: runner.gpuReadback,
          gpuMatmul: mm.gpuMatmul, clientMatmul: runner.gpuMatmul };
      }
    }
    // The "threads" selector: auto or 1..cores, disabled until the threaded
    // build runs; a choice reaches the loaded worker and is remembered.
    const threadsSelect = /** @type {HTMLSelectElement|null} */ (document.querySelector('#BackendPotentialSelector [data-role="mlip-threads"]'));
    let threadsUi = null;
    if (threadsSelect) {
      threadsUi = { options: [...threadsSelect.options].map((o) => o.value), disabled: threadsSelect.disabled, value: threadsSelect.value };
      if (runner && !threadsSelect.disabled) {
        const { getPanelPref } = await import('./ui/panels/PanelManager.js');
        threadsSelect.value = '2';
        threadsSelect.dispatchEvent(new Event('change'));
        for (let i = 0; i < 40 && runner.describe().threads !== 2; i++) await new Promise((r) => setTimeout(r, 50));
        threadsUi.after = runner.describe().threads;
        threadsUi.general = general.mlipThreads;
        threadsUi.stored = getPanelPref('mlipThreads');
        threadsSelect.value = 'auto';
        threadsSelect.dispatchEvent(new Event('change'));
      }
    }
    return {
      hasMultithreadToggle: !!multithread, threadsUi, status, error,
      offThread: runner ? runner.offThread === true : null,
      describe: runner && typeof runner.describe === 'function' ? runner.describe() : null,
      efs,
    };
  }, { model: MODEL });

  H.check('the PET-MAD controls carry the multi-threaded toggle', panel.hasMultithreadToggle, JSON.stringify(panel));
  const cores = await page.evaluate(() => Math.min(16, navigator.hardwareConcurrency || 1));
  H.check('a threads selector offers auto and 1..cores (usable only with the threaded build)',
    panel.threadsUi && panel.threadsUi.options[0] === 'auto' && panel.threadsUi.options.length === cores + 1
      && panel.threadsUi.disabled === !boot.isolated, JSON.stringify(panel.threadsUi));
  if (MODEL && boot.isolated) {
    H.check('choosing 2 threads reaches the loaded worker and is remembered',
      panel.threadsUi?.after === 2 && panel.threadsUi.general === 2 && panel.threadsUi.stored === '2', JSON.stringify(panel.threadsUi));
  }
  if (MODEL) {
    H.check(`model ${MODEL} loads through the panel into the worker runner`,
      panel.offThread === true && panel.efs && Number.isFinite(panel.efs.energy), JSON.stringify(panel));
    H.check('repeated evaluations agree and carry forces + stress',
      panel.efs && panel.efs.energy === panel.efs.repeat && panel.efs.forcesLen === panel.efs.atoms
        && panel.efs.stressAvailable && Number.isFinite(panel.efs.stress), JSON.stringify(panel.efs));
    H.check('the matrix kernel switches at run time and both kernels agree (1e-4 eV, 1e-4 eV/Å)',
      panel.efs?.gemm && panel.efs.gemm.on === true && panel.efs.gemm.off === false && panel.efs.gemm.back === true
        && panel.efs.gemm.energyDiff < 1e-4 && panel.efs.gemm.maxForceDiff < 1e-4, JSON.stringify(panel.efs?.gemm));
    H.check('the WebGPU readback switch reaches the worker (a no-op on the CPU build: gpuReadback null)',
      panel.efs?.readback && panel.efs.readback.variant !== 'gpu' && panel.efs.readback.gpuReadback === null
        && panel.efs.readback.client === 'auto' && panel.efs.readback.gpuMatmul === null
        && panel.efs.readback.clientMatmul === 'tile4', JSON.stringify(panel.efs?.readback));
    H.check('status line names the runtime (threads, worker)',
      /PET-MAD ready: .*\(cpu, \d+ threads?, worker\)/.test(panel.status), panel.status);
  } else {
    console.log('  (no .gguf under docs/bench-models — model-level checks skipped)');
    H.check('without weights the load fails at the fetch, not in the transport',
      typeof panel.error === 'string' && /fetch|Failed|network|Load/i.test(panel.error), JSON.stringify(panel));
  }

  // Filter the expected fetch failure out of the error list when offline.
  const relevant = errors.filter((e) => !/huggingface|ERR_TUNNEL|Failed to fetch|fetching/.test(e));
  H.check('no unexpected console/page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
