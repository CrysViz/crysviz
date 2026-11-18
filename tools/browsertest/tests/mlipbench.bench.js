// PET-MAD (mlip.cpp) throughput benchmark: ms per force evaluation on the
// default structure, and an MD run through the real MD panel, for the runner
// configurations the app can use — main thread vs worker, and the threaded
// wasm when the page is cross-origin isolated (CRYSVIZ_COI=1 in run.sh).
//
// The weights are NOT the real PET-MAD ones (Hugging Face is not reachable
// from every sandbox): a synthetic PET model with the PET-MAD-S/-XS layer
// sizes is served from docs/bench-models/ (gitignored; make one with
// tools/bench/make_random_pet_gguf.py, or drop a real .gguf there). Energies
// mean nothing; timings do.
//
// Not a pass/fail test — it prints a table. Run before and after a change:
//   tools/browsertest/run.sh tests/mlipbench.bench.js
//   CRYSVIZ_COI=1 tools/browsertest/run.sh tests/mlipbench.bench.js   # threaded build
// Env: MLIPBENCH_MODEL=pet-mad-xs.gguf (file under docs/bench-models/),
//      MLIPBENCH_EVALS=10, MLIPBENCH_MD_STEPS=20, MLIPBENCH_SUPERCELL=1,
//      MLIPBENCH_WORKER=0|1 (default: both), MLIPBENCH_THREADS=n (default auto).
'use strict';
const H = require('../harness');

const MODEL = process.env.MLIPBENCH_MODEL || 'pet-mad-xs.gguf';
const EVALS = Number(process.env.MLIPBENCH_EVALS || 10);
const MD_STEPS = Number(process.env.MLIPBENCH_MD_STEPS || 20);
const SUPERCELL = Number(process.env.MLIPBENCH_SUPERCELL || 1);
const THREADS = process.env.MLIPBENCH_THREADS ? Number(process.env.MLIPBENCH_THREADS) : 'auto';
const WORKER_MODES = process.env.MLIPBENCH_WORKER === '0' ? [false]
  : process.env.MLIPBENCH_WORKER === '1' ? [true] : [false, true];

async function runConfig(useWorker) {
  const { browser, page, errors } = await H.launchApp();
  const profiles = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[MD profile]')) profiles.push(text);
  });
  await H.loadDefaultStructure(page);

  const setup = await page.evaluate(async ({ useWorker, threads, sc }) => {
    const { general, fileBrowser } = await import('./state/store.js');
    general.mdProfile = true;
    general.mlipWorker = useWorker;
    general.mlipThreads = threads;
    general.atomisticPotential = 'mlip';
    if (sc > 1) {
      const { createSupercell } = await import('./ui/SuperCellModule.js');
      createSupercell(sc, sc, sc);
    }
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('backend');
    return { atoms: fileBrowser.selectedStructure.atoms.length, isolated: globalThis.crossOriginIsolated === true };
  }, { useWorker, threads: THREADS, sc: SUPERCELL });
  await page.waitForTimeout(300);

  const evals = await page.evaluate(async ({ model, evals }) => {
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { fileBrowser } = await import('./state/store.js');
    // Point the model select at the locally served weights.
    const select = document.querySelector('#BackendPotentialSelector [data-role="mlip-model"]');
    const opt = document.createElement('option');
    opt.value = `./bench-models/${model}`;
    opt.textContent = model;
    select.appendChild(opt);
    select.value = opt.value;
    const t0 = performance.now();
    const { runner } = await ensureCalculatorRunner(() => {});
    const loadMs = performance.now() - t0;
    const s = buildNEPStructure(runner, fileBrowser.selectedStructure);
    await runner.compute(s); // warm-up (graph allocation)
    const times = [];
    for (let i = 0; i < evals; i += 1) {
      const t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const out = await runner.compute(s);
      times.push(performance.now() - t);
      if (i === 0) window.__benchOut = { e: out.total_energy, f0: out.forces[0] };
    }
    times.sort((a, b) => a - b);
    const d = typeof runner.describe === 'function' ? runner.describe() : {};
    return {
      loadMs: Math.round(loadMs),
      medianMs: +times[Math.floor(times.length / 2)].toFixed(1),
      minMs: +times[0].toFixed(1),
      variant: d.variant, threads: d.threads, maxThreads: d.maxThreads, offThread: runner.offThread === true,
      energy: window.__benchOut.e, f0: window.__benchOut.f0,
    };
  }, { model: MODEL, evals: EVALS });

  // Keep the main thread busy with a 16 ms rAF loop that counts frames: the
  // worker path should keep painting while the potential runs.
  const md = await page.evaluate(async ({ steps }) => {
    document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const stepsInput = document.getElementById('mdStepsInput');
    const startBtn = document.getElementById('mdStartBtn');
    if (!stepsInput || !startBtn) return { error: 'MD controls not found' };
    stepsInput.value = String(steps);
    let ticks = 0;
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      ticks += 1;
    }, 16);
    const t0 = performance.now();
    startBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const deadline = Date.now() + 10 * 60 * 1000;
    while (startBtn.disabled && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    const wallMs = performance.now() - t0;
    clearInterval(timer);
    return { finished: !startBtn.disabled, wallMs: Math.round(wallMs), timerTicks: ticks,
      longestGapMs: Math.round(longest), expectedTicks: Math.round(wallMs / 16) };
  }, { steps: MD_STEPS });

  await browser.close();
  return { setup, evals, md, profiles, errors };
}

(async () => {
  const rows = [];
  for (const useWorker of WORKER_MODES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runConfig(useWorker);
    const label = `${useWorker ? 'worker' : 'main thread'}, ${r.evals.variant || '?'}, ${r.evals.threads || 1} thread(s)`;
    console.log(`\n== ${label}  [${MODEL}, ${r.setup.atoms} atoms, isolated=${r.setup.isolated}]`);
    console.log(`  model load ${r.evals.loadMs} ms; force eval median ${r.evals.medianMs} ms (min ${r.evals.minMs})`);
    console.log(`  MD ${MD_STEPS} steps: ${JSON.stringify(r.md)}`);
    for (const p of r.profiles) console.log(p.split('\n').map((l) => `  ${l}`).join('\n'));
    if (r.errors.length) console.log(`  errors: ${r.errors.slice(0, 3).join(' | ')}`);
    rows.push({ label, ...r.evals, mdWallMs: r.md.wallMs, longestGapMs: r.md.longestGapMs, errors: r.errors.length });
    H.check(`${label}: evaluations ran`, Number.isFinite(r.evals.medianMs) && r.md.finished === true,
      JSON.stringify({ evals: r.evals, md: r.md }));
    // The sandbox blocks CDNs (Plotly): that is the network, not the code.
    const relevant = r.errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(e));
    H.check(`${label}: no page errors`, relevant.length === 0, relevant[0] || '');
  }
  if (rows.length === 2) {
    const [main, worker] = rows;
    const sameNumbers = Math.abs(main.energy - worker.energy) < 1e-6;
    H.check('worker and main thread agree on the energy', sameNumbers,
      `${main.energy} vs ${worker.energy}`);
  }
  console.table(rows.map(({ f0, ...rest }) => rest));
  await H.finish({ close: async () => {} });
})();
