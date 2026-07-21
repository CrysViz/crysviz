// How does one NEP force evaluation scale with atom count, and how much of it
// is marshalling vs the wasm kernel? The MD profile showed force eval eating
// ~64% of a 1300-atom step, so this isolates it from everything else.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async () => {
    const loadScript = (src) => new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(null);
      el.onerror = () => reject(new Error(`failed ${src}`));
      document.head.appendChild(el);
    });
    await loadScript('./external/nep_wasm/nep_wasm.js');
    await loadScript('./external/nep_wasm/nep_simple.js');
    const runner = new window.NEPWasmRunner({ defaultModelUrl: './external/nep_wasm/nep89_20250409.txt' });
    await runner.init();
    await runner.loadDefaultModel();

    // Simple cubic Cu-ish blocks at ~2.5 A spacing so the neighbour count per
    // atom is realistic; type 0 is whatever element_list[0] is.
    const build = (n) => {
      const a = 2.5;
      const positions = [];
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          for (let k = 0; k < n; k += 1) positions.push([i * a, j * a, k * a]);
        }
      }
      const L = n * a;
      return {
        lattice: [[L, 0, 0], [0, L, 0], [0, 0, L]],
        positions,
        types: positions.map(() => 0),
      };
    };

    const out = [];
    for (const n of [4, 6, 8, 11]) {
      const cell = build(n);
      runner.compute(cell); // warm up (buffer alloc, first neighbour build)
      const reps = n > 8 ? 3 : 5;
      const t0 = performance.now();
      for (let r = 0; r < reps; r += 1) runner.compute(cell);
      const ms = (performance.now() - t0) / reps;
      out.push({ atoms: cell.positions.length, ms });
    }
    // Head to head against the worker path on the same 1331-atom cell, and a
    // check that the main thread is actually free while the worker computes:
    // a 10 ms interval should keep firing through a compute that takes ~1 s.
    const { ensureWorkerNEPReady, createWorkerNEPForceEvaluator } = await import('./atomistic/nepWorkerClient.js');
    await ensureWorkerNEPReady();
    const evaluate = createWorkerNEPForceEvaluator();
    const big = build(11);
    await evaluate(big);

    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const tw = performance.now();
    const workerOut = await evaluate(big);
    const workerMs = performance.now() - tw;
    clearInterval(timer);

    const mainOut = runner.compute(big);
    const forceDelta = Math.max(...workerOut.forces.map((f, i) => Math.max(
      Math.abs(f[0] - mainOut.forces[i][0]),
      Math.abs(f[1] - mainOut.forces[i][1]),
      Math.abs(f[2] - mainOut.forces[i][2]))));

    return {
      elements: runner.modelInfo.element_list.length,
      out,
      workerMs,
      ticks,
      forceDelta,
      energyDelta: Math.abs(workerOut.total_energy - mainOut.total_energy),
    };
  });

  console.log(`  NEP model: ${res.elements} elements`);
  for (const row of res.out) {
    console.log(`  ${String(row.atoms).padStart(5)} atoms  ${row.ms.toFixed(1).padStart(9)} ms/eval  `
      + `${(1000 * row.ms / row.atoms).toFixed(1)} us/atom`);
  }

  console.log(`  worker eval (1331 atoms): ${res.workerMs.toFixed(1)} ms, `
    + `main thread stayed alive for ${res.ticks} x 10 ms ticks during it`);
  console.log(`  worker vs main-thread agreement: dF=${res.forceDelta.toExponential(2)} eV/A, `
    + `dE=${res.energyDelta.toExponential(2)} eV`);

  H.check('every size evaluated', res.out.length === 4, JSON.stringify(res.out));
  H.check('the worker returns the same forces as the in-thread runner',
    res.forceDelta < 1e-9 && res.energyDelta < 1e-9,
    `dF=${res.forceDelta} dE=${res.energyDelta}`);
  H.check('the main thread keeps running while the worker computes',
    res.ticks > 10, `ticks=${res.ticks}`);
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
