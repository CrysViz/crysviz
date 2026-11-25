// Interatomic-potential performance map, headless: the same measurement as
// the Debug window's Benchmark tab (docs/debug/potentialBenchmark.js — MD
// through the real MD panel for NEP and PET-MAD on supercells of the default
// cell, for a ladder of viewer options), one fresh browser per potential.
//
// Writes { meta, records } to $PERF_OUT (default
// tools/browsertest/artifacts/potentialperf.json);
// tools/bench/plot_potential_perf.py turns it into figures.
//
// PET-MAD weights come from $PERF_MODEL_BASE (default ./bench-models/, i.e.
// docs/bench-models/pet-mad-xs.gguf and pet-mad-s.gguf; gitignored). Where
// Hugging Face is out of reach, tools/bench/make_random_pet_gguf.py writes
// random weights with the PET-MAD layer sizes — the cost depends on the
// layer sizes and atom count, not on the weight values. PERF_MODEL_BASE=''
// uses Hugging Face.
//
//   CRYSVIZ_COI=1 tools/browsertest/run.sh tests/potentialperf.bench.js
// Env: PERF_SIZES=1,2,3,4  PERF_POTENTIALS=nep,xsmt,xs1,xsmain,smt,s1 (also xsgpu, sgpu,
//      xs4t / s2t for an explicit thread count, and a -dot suffix on any PET-MAD
//      CPU key, e.g. xs1-dot, for the dot-product matrix kernel)
//      PERF_VISUALS=atoms,bonds,images,force  PERF_TARGET_MS=6000  PERF_MAX_STEPS=60
//      PERF_GPU=1 (or hardware) launches Chromium on the machine's GPU (WebGL +
//      WebGPU; needs a GPU and CRYSVIZ_BROWSER=chromium); PERF_GPU=swiftshader
//      emulates WebGPU on the CPU (a correctness check, not a speed figure).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../harness');

const SIZES = (process.env.PERF_SIZES || '1,2,3,4').split(',').map(Number);
const VISUALS = (process.env.PERF_VISUALS || 'atoms,bonds,images,force').split(',');
const ORDER = (process.env.PERF_POTENTIALS || 'nep,xsmt,xs1,xsmain,smt,s1').split(',');
const TARGET_MS = Number(process.env.PERF_TARGET_MS || 6000);
const MAX_STEPS = Number(process.env.PERF_MAX_STEPS || 60);
const MODEL_BASE = process.env.PERF_MODEL_BASE ?? './bench-models/';
const OUT = process.env.PERF_OUT || path.join(__dirname, '..', 'artifacts', 'potentialperf.json');

async function runPotential(key) {
  const gpu = process.env.PERF_GPU === '1' ? 'hardware' : (process.env.PERF_GPU || false);
  const { browser, page, errors } = await H.launchApp({ gpu });
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('[bench]')) console.log(`  ${t.slice(8)}`);
  });
  const result = await page.evaluate(async ({ key, sizes, visuals, targetMs, maxSteps, modelBase }) => {
    const bench = await import('./debug/potentialBenchmark.js');
    const spec = bench.benchSpec(key);
    const why = spec ? bench.unavailableReason(spec) : 'unknown potential';
    if (why) return { meta: bench.benchCapabilities(), records: [], skipped: why };
    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    return bench.runPotentialBenchmark({
      potentials: [key], sizes, visuals, targetMs, maxSteps, modelBase,
      onRecord: (r) => console.log(r.error
        ? `[bench] ${r.potentialLabel.padEnd(30)} ${r.cells}x${r.cells}x${r.cells}  ${r.visualLabel.padEnd(20)} FAILED ${r.error}`
        : `[bench] ${r.potentialLabel.padEnd(30)} ${String(r.atoms).padStart(4)} atoms  ${r.visualLabel.padEnd(20)} `
          + `${fmt(r.stepsPerS, 2).padStart(7)} steps/s  potential ${fmt(r.forceMs)} ms  viewer ${fmt(r.viewerMs)} ms  `
          + `freeze ${fmt(r.longestGapMs, 0)} ms  threads ${r.threads}`),
    });
  }, { key, sizes: SIZES, visuals: VISUALS, targetMs: TARGET_MS, maxSteps: MAX_STEPS, modelBase: MODEL_BASE });
  await browser.close();
  if (result.skipped) console.log(`  ${key}: skipped — ${result.skipped}`);
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  return { meta: result.meta, records: result.records, errors: relevant };
}

(async () => {
  const all = [];
  const errs = [];
  let browserMeta = null;
  for (const key of ORDER) {
    // eslint-disable-next-line no-await-in-loop
    const { meta, records, errors } = await runPotential(key);
    browserMeta = browserMeta || meta;
    all.push(...records);
    errs.push(...errors);
    // Write after every potential so a long run that dies keeps its data.
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({
      meta: {
        ...browserMeta,
        date: new Date().toISOString(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model,
        browser: process.env.CRYSVIZ_BROWSER || 'firefox',
        isolated: process.env.CRYSVIZ_COI === '1',
        gpu: process.env.PERF_GPU || false,
        note: 'Headless bench. Software WebGL unless PERF_GPU=1. PET-MAD weights may be random with PET-MAD layer sizes.',
      },
      records: all,
    }, null, 1));
  }
  console.log(`  wrote ${all.length} records to ${OUT}`);
  H.check('every MD run finished', all.length > 0 && all.every((r) => r.finished),
    JSON.stringify(all.filter((r) => !r.finished).map((r) => [r.potential, r.cells, r.visual, r.error])));
  H.check('no page errors', errs.length === 0, errs[0] || '');
  await H.finish({ close: async () => {} });
})();
