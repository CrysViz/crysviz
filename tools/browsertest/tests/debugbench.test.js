// The Debug window's Benchmark tab (ui/DebugBenchmarkTab.js over
// debug/potentialBenchmark.js): it is a second tab next to Monitor, runs MD
// through the real MD panel for the picked potentials / cells / viewer
// options, fills the table and the chart, offers the JSON for the plot
// script, and leaves the user's file list and viewer settings as it found
// them. PET-MAD needs weights under docs/bench-models/ (gitignored;
// tools/bench/make_random_pet_gguf.py) — without them only NEP is checked.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const HAVE_XS = fs.existsSync(path.join(__dirname, '..', '..', '..', 'docs', 'bench-models', 'pet-mad-xs.gguf'));

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  page.on('requestfailed', (req) => console.log(`  (request failed: ${req.url().slice(0, 120)} ${req.failure()?.errorText})`));
  const url = new URL(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html');
  url.searchParams.set('debug', '');
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  const before = await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const { general } = await import('./state/store.js');
    openPanel('debug');
    await new Promise((r) => setTimeout(r, 300));
    const body = document.getElementById('cvPanelBody-debug');
    const tabs = [...body.querySelectorAll('[data-dbg-tab]')].map((t) => t.textContent.trim());
    const monitorVisible = !body.querySelector('[data-dbg-pane="monitor"]').hidden;
    body.querySelector('[data-dbg-tab="bench"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const bench = body.querySelector('[data-dbg-pane="bench"]');
    return {
      tabs,
      monitorVisible,
      monitorHiddenAfter: body.querySelector('[data-dbg-pane="monitor"]').hidden,
      benchBuilt: !!bench.querySelector('.dbgBenchForm'),
      potentials: [...bench.querySelectorAll('input[name="pot"]')].map((i) => ({ v: i.value, disabled: i.disabled })),
      rows: document.querySelectorAll('#objectTable tbody tr').length,
      settings: { showBonds: general.showBonds, atomsColor: general.atomsColor, potential: general.atomisticPotential },
    };
  });
  H.check('Debug window has Monitor, Benchmark and Tracer tabs, Monitor first and shown',
    before.tabs.join('|') === 'Monitor|Benchmark|Tracer' && before.monitorVisible, JSON.stringify(before.tabs));
  H.check('switching to Benchmark hides Monitor and builds the form',
    before.monitorHiddenAfter && before.benchBuilt, JSON.stringify(before));
  // The WebGPU rows are settled by an async adapter probe (shader-f16).
  const caps = await page.evaluate(async () => {
    const b = await import('./debug/potentialBenchmark.js');
    const full = await b.probeBenchCapabilities();
    await new Promise((r) => setTimeout(r, 300));
    const body = document.getElementById('cvPanelBody-debug');
    const bench = body.querySelector('[data-dbg-pane="bench"]');
    const gpuInput = bench.querySelector('input[name="pot"][value="xsgpu"]');
    const threads = [...bench.querySelectorAll('input[name="threads"]')].map((i) => ({ v: i.value, disabled: i.disabled }));
    const kernels = [...bench.querySelectorAll('input[name="kernel"]')].map((i) => ({ v: i.value, checked: i.checked }));
    const readbacks = [...bench.querySelectorAll('input[name="readback"]')].map((i) => `${i.value}:${i.checked}`).join(',');
    const mapSpec = b.benchSpec('xsgpu-map');
    const matmuls = [...bench.querySelectorAll('input[name="matmul"]')].map((i) => `${i.value}:${i.checked}`).join(',');
    const rtSpec = b.benchSpec('xsgpu-map-regtile');
    const isolate = bench.querySelector('[data-role="isolate"]');
    return {
      isolated: full.isolated, webgpu: full.webgpu, cores: full.cores, gpuDisabled: gpuInput.disabled, threads, kernels,
      readbacks, mapSpec: mapSpec && { backend: mapSpec.backend, readback: mapSpec.readback, label: mapSpec.label },
      matmuls, rtSpec: rtSpec && { readback: rtSpec.readback, matmul: rtSpec.matmul, label: rtSpec.label },
      capsText: bench.querySelector('[data-role="caps"]').textContent,
      isolateButton: isolate ? { label: isolate.textContent.trim(), on: isolate.dataset.on } : null,
    };
  });
  H.check('unavailable variants are disabled (more than one thread needs isolation, WebGPU a shader-f16 adapter)',
    caps.threads.every((t) => t.disabled === (t.v !== '1' && !caps.isolated)) && caps.gpuDisabled === !caps.webgpu,
    JSON.stringify(caps));
  H.check('thread counts on offer: auto, 1, …, the core count; kernels: blocked (default) and dot products',
    caps.threads[0].v === 'auto' && caps.threads[1].v === '1' && caps.threads[caps.threads.length - 1].v === String(caps.cores)
      && caps.kernels.map((k) => `${k.v}:${k.checked}`).join(',') === 'blocked:true,dot:false', JSON.stringify(caps));
  H.check('WebGPU readbacks on offer: canvas snapshot (default) and mapAsync; "xsgpu-map" is the WebGPU row forced to mapAsync',
    caps.readbacks === 'auto:true,map:false' && caps.mapSpec?.backend === 'webgpu' && caps.mapSpec.readback === 'map'
      && / · mapAsync$/.test(caps.mapSpec.label), JSON.stringify({ readbacks: caps.readbacks, mapSpec: caps.mapSpec }));
  H.check('WebGPU matrix kernels on offer: vec4 tiles (default) and register tiles; "-regtile" keys run the old one',
    caps.matmuls === 'tile4:true,reg_tile:false' && caps.rtSpec?.matmul === 'reg_tile' && caps.rtSpec.readback === 'map'
      && / · mapAsync · reg-tile$/.test(caps.rtSpec.label), JSON.stringify({ matmuls: caps.matmuls, rtSpec: caps.rtSpec }));
  H.check('the capabilities line states isolation, and offers to enable it when not isolated',
    caps.isolated ? /cross-origin isolated: PET-MAD CPU runs can use up to \d+ threads/.test(caps.capsText)
      : /not cross-origin isolated/.test(caps.capsText) && caps.isolateButton?.on === '1',
    JSON.stringify({ text: caps.capsText, button: caps.isolateButton }));

  // WebGPU round-trip probe (page + worker): numbers where the browser has an
  // adapter (headless Chromium: SwiftShader), null otherwise.
  const rt = await page.evaluate(async () => {
    const b = await import('./debug/potentialBenchmark.js');
    const hasGpu = !!(navigator.gpu && await navigator.gpu.requestAdapter());
    return { hasGpu, ...(await b.probeGpuRoundTrip()) };
  });
  H.check('the WebGPU round-trip probe measures on the page and in a worker',
    rt.hasGpu ? Number.isFinite(rt.page?.mapMs) && Number.isFinite(rt.worker?.mapMs) && Number.isFinite(rt.worker?.workDoneMs)
      : rt.page === null, JSON.stringify(rt));
  H.check('the kernel-launch probe gives µs per kernel on the page and in a worker',
    !rt.hasGpu || [rt.page?.dispatch, rt.worker?.dispatch].every((d) => d && Number.isFinite(d.ggmlUs)
      && Number.isFinite(d.sameUs)), JSON.stringify({ page: rt.page?.dispatch, worker: rt.worker?.dispatch }));
  const pathOk = (p) => !!p && (typeof p.error === 'string'
    || (Number.isFinite(p.ms) && ['exact', 'blank', 'wrong'].includes(p.result)));
  H.check('the canvas readback probe reports both paths (time + verdict, or an error) on the page and in a worker',
    !rt.hasGpu || [rt.page?.canvas, rt.worker?.canvas].every((k) => k
      && (typeof k.error === 'string' || (pathOk(k.snapshot) && pathOk(k.videoFrame)))), JSON.stringify(rt));

  const run = await page.evaluate(async ({ haveXs }) => {
    const body = document.getElementById('cvPanelBody-debug');
    const bench = body.querySelector('[data-dbg-pane="bench"]');
    // PET-MAD-XS on one thread with both matrix kernels: the A/B pair.
    const want = new Set(['nep', ...(haveXs ? ['xscpu'] : [])]);
    bench.querySelectorAll('input[name="pot"]').forEach((i) => { i.checked = want.has(i.value); });
    bench.querySelectorAll('input[name="threads"]').forEach((i) => { i.checked = i.value === '1'; });
    bench.querySelectorAll('input[name="kernel"]').forEach((i) => { i.checked = true; });
    bench.querySelectorAll('input[name="size"]').forEach((i) => { i.checked = i.value === '1' || i.value === '2'; });
    bench.querySelectorAll('input[name="vis"]').forEach((i) => { i.checked = i.value === 'bonds' || i.value === 'force'; });
    bench.querySelector('input[name="target"]').value = '1';
    bench.querySelector('input[name="maxSteps"]').value = '8';
    bench.querySelector('input[name="modelBase"]').value = './bench-models/';
    const runBtn = bench.querySelector('[data-role="run"]');
    runBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const runningDisabled = runBtn.disabled;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (runBtn.disabled && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200));
    }
    const rows = [...bench.querySelectorAll('[data-role="rows"] tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    const chartLines = bench.querySelectorAll('[data-role="chart"] svg path').length;
    const legend = [...bench.querySelectorAll('[data-role="legend"] li')].map((li) => li.textContent);
    // The JSON download: capture the Blob instead of saving a file.
    let json = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { json = blob; return origCreate.call(URL, blob); };
    bench.querySelector('[data-role="json"]').click();
    URL.createObjectURL = origCreate;
    const parsed = json ? JSON.parse(await json.text()) : null;
    const { general } = await import('./state/store.js');
    return {
      runningDisabled,
      progress: bench.querySelector('[data-role="progress"]').textContent,
      rows, chartLines, legend,
      records: parsed?.records?.length ?? 0,
      finished: parsed?.records?.every((r) => r.finished) ?? false,
      fields: parsed?.records?.[0] ? Object.keys(parsed.records[0]) : [],
      meta: parsed?.meta ?? null,
      fileRows: document.querySelectorAll('#objectTable tbody tr').length,
      settings: { showBonds: general.showBonds, atomsColor: general.atomsColor, potential: general.atomisticPotential },
      sample: parsed?.records?.[0] ?? null,
      runs: parsed?.records?.map((r) => `${r.potential}:${r.kernel}:${r.threadsRequested}`) ?? [],
      breakdown: parsed?.records?.filter((r) => r.potential !== 'nep').map((r) => ({
        wasmMs: r.wasmMs, computeMs: r.wasmComputeMs, graphMs: r.wasmGraphMs, roundTripMs: r.roundTripMs, evalMs: r.evalMs,
      })) ?? [],
    };
  }, { haveXs: HAVE_XS });

  const expected = (HAVE_XS ? 3 : 1) * 2 * 2;
  H.check('Run disables itself while the benchmark runs', run.runningDisabled, run.progress);
  H.check(`all ${expected} runs finished and are in the table`, run.records === expected && run.finished
    && run.rows.length === expected, JSON.stringify({ progress: run.progress, rows: run.rows }));
  H.check('records carry what the plot script reads', ['potential', 'atoms', 'visual', 'stepsPerS', 'forceMs',
    'viewerMs', 'longestGapMs', 'threads'].every((k) => run.fields.includes(k)) && Number.isFinite(run.sample?.stepsPerS)
    && run.sample.stepsPerS > 0, JSON.stringify(run.sample));
  H.check('chart draws one line per potential and the legend names them',
    run.chartLines === (HAVE_XS ? 3 : 1) && run.legend.length === (HAVE_XS ? 3 : 1), JSON.stringify(run.legend));
  if (HAVE_XS) {
    H.check('PET-MAD records carry the evaluation breakdown (wasm phases <= wasm total <= worker round trip)',
      run.breakdown.length > 0 && run.breakdown.every((b) => Number.isFinite(b.wasmMs) && b.wasmMs > 0
        && b.computeMs > 0 && b.graphMs >= 0 && b.computeMs <= b.wasmMs + 0.5 && b.wasmMs <= b.roundTripMs + 0.5),
      JSON.stringify(run.breakdown.slice(0, 2)));
    H.check('the PET-MAD CPU row ran once per kernel and the records say which (kernel, threads asked)',
      ['xs1:blocked:1', 'xs1-dot:dot:1'].every((k) => run.runs.includes(k))
        && run.runs.filter((k) => k.startsWith('nep:')).every((k) => k === 'nep:null:null'), JSON.stringify(run.runs));
  }
  H.check('the file list and viewer settings are as before the run',
    run.fileRows === before.rows && JSON.stringify(run.settings) === JSON.stringify(before.settings),
    JSON.stringify({ before: before.rows, after: run.fileRows, s0: before.settings, s1: run.settings }));
  if (!HAVE_XS) console.log('  (no docs/bench-models/pet-mad-xs.gguf — PET-MAD not exercised)');

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|esm\.sh|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
