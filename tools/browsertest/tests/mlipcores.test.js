// PET-MAD's threaded wasm on a machine with many cores. Its worker pool is
// started with the module (threads cannot start while ggml waits for them),
// so the thread count must never exceed the pool: with 8 workers and "auto"
// asking for every core, Chrome on a 14-core Mac hung at the first
// evaluation. The PET-MAD worker is served here with a navigator that
// reports CORES (default 20, above the 16-thread cap). Needs a cross-origin
// isolated page and a model under docs/bench-models/:
//   CRYSVIZ_COI=1 tools/browsertest/run.sh tests/mlipcores.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const CORES = Number(process.env.CORES || 20);
const DOCS = path.join(__dirname, '..', '..', '..', 'docs');
const MODEL = ['pet-mad-xs.gguf', 'bench-xs.gguf'].find((f) => fs.existsSync(path.join(DOCS, 'bench-models', f)));

(async () => {
  const { browser, page } = await H.launchApp({ navigate: false });
  const worker = fs.readFileSync(path.join(DOCS, 'workers', 'mlipWorker.js'), 'utf8');
  await page.route(/workers\/mlipWorker\.js/, (r) => r.fulfill({
    status: 200,
    contentType: 'application/javascript',
    headers: { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin' },
    body: `Object.defineProperty(WorkerNavigator.prototype, 'hardwareConcurrency', { get: () => ${CORES} });\n${worker}`,
  }));
  await page.goto(process.env.CRYSVIZ_URL || `http://localhost:${process.env.PORT || 8123}/index.html`);
  await page.waitForTimeout(2000);
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  if (!isolated || !MODEL) {
    console.log(`  (${!isolated ? 'page not cross-origin isolated (CRYSVIZ_COI=1)' : 'no model under docs/bench-models'} — skipped)`);
    await H.finish(browser);
    return;
  }
  await H.loadDefaultStructure(page);
  const res = await page.evaluate(async (model) => {
    const { WorkerMLIPRunner } = await import('./atomistic/mlipWorkerClient.js');
    const { buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { fileBrowser } = await import('./state/store.js');
    const r = new WorkerMLIPRunner({ backend: 'cpu', threads: 'auto' });
    const work = (async () => {
      await r.init();
      await r.loadModelFromUrl(`./bench-models/${model}`);
      // 'auto' times all allowed threads on the first evaluation.
      const out = await r.compute(buildNEPStructure(r, fileBrowser.selectedStructure));
      const max = r.describe().maxThreads;
      await r.setThreads(max);
      const again = await r.compute(buildNEPStructure(r, fileBrowser.selectedStructure));
      return { energy: out.total_energy, again: again.total_energy, describe: r.describe() };
    })();
    const res = await Promise.race([work, new Promise((done) => setTimeout(() => done({ hung: true }), 120000))]);
    r.destroy();
    return res;
  }, MODEL);
  H.check(`${CORES} reported cores: at most 16 threads, and every count evaluates (no deadlock)`,
    !res.hung && Number.isFinite(res.energy) && res.again === res.energy
      && res.describe.maxThreads === Math.min(CORES, 16) && res.describe.threads === res.describe.maxThreads,
    JSON.stringify(res));
  await H.finish(browser);
})().catch(H.crash);
