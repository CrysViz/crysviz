/**
 * Debug window, "Benchmark" tab: maps how fast in-browser MD runs on THIS
 * machine for NEP and PET-MAD (CPU one thread / all threads, WebGPU, main
 * thread) across supercells of the default cell and the viewer options that
 * cost render time. The measuring itself lives in debug/potentialBenchmark.js
 * (shared with the headless bench); this file is the form, the live results
 * table, a throughput chart and the JSON/CSV downloads. The JSON is what
 * tools/bench/plot_potential_perf.py turns into the combined figures.
 *
 * The PET-MAD "CPU" rows run once per picked thread count and matrix kernel
 * (blocked GEMM / dot products): the A/B grid for threads and the kernel. The
 * WebGPU rows run once per picked result readback (canvas snapshot / mapAsync)
 * and matrix kernel (vec4 tiles / register tiles). The
 * capabilities line says whether the page is cross-origin isolated (needed
 * for more than one thread) and offers to turn that on.
 *
 * Chart encoding (the reference data-viz palette, validated for colour-vision
 * deficiency): colour = model family (NEP blue, PET-MAD-XS orange, PET-MAD-S
 * aqua), dash = how it runs (solid all threads, dashed one thread, long dash an
 * explicit thread count, dash-dot WebGPU, dotted main thread), faded with
 * hollow points = the dot-product kernel, mapAsync readback or the old WebGPU
 * matrix kernel; every line is labelled at its end
 * and listed in the legend, and the table is the table view.
 */

import {
  BENCH_POTENTIALS, BENCH_VISUALS, BENCH_SIZES, BENCH_KERNELS, BENCH_READBACKS, BENCH_MATMULS, gpuBenchKey,
  benchCapabilities, probeBenchCapabilities, unavailableReason, runPotentialBenchmark, benchRecordsToCsv,
  benchSpec, benchThreadOptions, canvasReadbackSummary, cpuBenchKey, dispatchCostSummary, probeGpuRoundTrip,
} from '../debug/potentialBenchmark.js';
import { canRequestIsolation, isMultithreadRequested, setMultithreadEnabled } from '../host/coi.js';
import { confirmAppReload, reloadAbandoned } from './LeaveGuard.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FAMILY_COLORS = {
  // [on a dark surface, on a light surface]
  nep: ['#3987e5', '#2a78d6'],
  xs: ['#d95926', '#eb6834'],
  s: ['#199e70', '#1baf7a'],
};
const DASHES = { auto: '', 1: '6 4', n: '14 4', webgpu: '9 3 2 3', main: '2 3' };
// The form's potential rows. The PET-MAD "CPU" rows (with a family) expand to
// one run per picked thread count × kernel (cpuBenchKey), the WebGPU rows
// (gpu) to one per picked readback ('-map' suffix); the others are
// BENCH_POTENTIALS keys.
const FORM_POTENTIALS = [
  { key: 'nep' },
  { key: 'xscpu', family: 'xs', label: 'PET-MAD-XS · CPU (worker)' },
  { key: 'xsgpu', gpu: true },
  { key: 'xsmain' },
  { key: 'scpu', family: 's', label: 'PET-MAD-S · CPU (worker)' },
  { key: 'sgpu', gpu: true },
];
const DEFAULTS = {
  potentials: ['nep', 'xscpu', 'xsgpu', 'scpu', 'sgpu'],
  threads: ['auto', 1],
  kernels: ['blocked'],
  readbacks: ['auto'],
  matmuls: ['tile4'],
  sizes: [1, 2, 3],
  visuals: ['atoms', 'bonds', 'images', 'force'],
};

/** @type {{ meta: any, records: any[] }} survives tab rebuilds */
let lastResult = { meta: null, records: [] };
let running = false;
let stopRequested = false;

function dashFor(spec) {
  if (spec.mainThread) return DASHES.main;
  if (spec.backend === 'webgpu') return DASHES.webgpu;
  if (spec.threads === 'auto') return DASHES.auto;
  return spec.threads === 1 ? DASHES[1] : DASHES.n;
}

/** "XS 4T dot", "XS all T", "S WebGPU", "NEP89": the line-end labels. */
function shortLabel(spec) {
  return spec.label.replace('PET-MAD-', '').replace(' · CPU, ', ' ').replace(' · ', ' ')
    .replace('all threads', 'all T').replace(/(\d+) threads?/, '$1T').replace(' · dot products', ' dot')
    .replace(' · mapAsync', ' map').replace(' · reg-tile', ' regtile');
}

/** The thread-count checkbox text. */
function threadLabel(t, cores) {
  if (t === 'auto') return 'auto (fastest of all / 1 / half per size)';
  return t === cores && t > 1 ? `${t} (all cores)` : String(t);
}

/** The isolation part of the capabilities line, and the button that changes it. */
function isolationState(caps) {
  if (caps.isolated) {
    return {
      text: `cross-origin isolated: PET-MAD CPU runs can use up to ${caps.cores ?? '?'} threads`,
      action: isMultithreadRequested() ? { on: false, label: 'Turn multi-threading off' } : null,
    };
  }
  if (isMultithreadRequested()) {
    return {
      text: 'multi-threading is on, but this page is not cross-origin isolated (the browser may not '
        + 'support credentialless COEP): PET-MAD on one thread',
      action: { on: false, label: 'Turn multi-threading off' },
    };
  }
  return {
    text: 'not cross-origin isolated: PET-MAD on one thread',
    action: canRequestIsolation() ? { on: true, label: 'Enable multi-threading' } : null,
  };
}

/** Is the window on a light surface? (its text colour is dark) */
function onLightSurface(el) {
  const m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g);
  if (!m) return false;
  const [r, g, b] = m.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function fmt(v, digits = 1) {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 100) return v.toFixed(0);
  return v.toFixed(digits);
}

function checkboxes(name, items, selected, labelOf, disabledReason = (_item) => null) {
  return items.map((item) => {
    const key = typeof item === 'object' ? item.key : String(item);
    const reason = disabledReason(item);
    return `<label class="dbgBenchCheck"${reason ? ` title="${reason.replace(/"/g, '&quot;')}"` : ''}>
      <input type="checkbox" name="${name}" value="${key}"${selected.includes(item.key ?? item) && !reason ? ' checked' : ''}${reason ? ' disabled' : ''} />
      <span>${labelOf(item)}</span></label>`;
  }).join('');
}

function readChecked(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => /** @type {HTMLInputElement} */ (i).value);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build the tab into `host` (idempotent: rebuilding keeps the last results).
 * @param {HTMLElement} host
 */
export function buildBenchmarkTab(host) {
  const caps = benchCapabilities();
  const iso = isolationState(caps);
  const capLine = [
    `${caps.cores ?? '?'} logical cores`,
    iso.text,
    caps.webgpu ? 'WebGPU available' : 'no WebGPU',
  ].join(' · ');
  const threadOptions = benchThreadOptions(caps);
  const formLabel = (p) => p.label || benchSpec(p.key).label;
  const formReason = (p) => (p.family ? null : unavailableReason(benchSpec(p.key), caps));
  const threadReason = (t) => (t !== 1 && !caps.isolated ? 'needs a cross-origin isolated page (Enable multi-threading above)' : null);
  host.innerHTML = `
    <div class="dbgBench">
      <p class="dbgBenchIntro">Runs short MD simulations through the MD panel and measures steps per second,
        the time per step spent in the potential and in the viewer, and the longest UI freeze. It loads the
        default cell (and its supercells) as extra rows and removes them afterwards. PET-MAD models are
        downloaded on first use.</p>
      <div class="dbgBenchCaps"><span data-role="caps">${capLine}</span>
        ${iso.action ? `<button type="button" class="trajBtn dbgTextBtn" data-role="isolate" data-on="${iso.action.on ? '1' : '0'}"
          title="Reloads the page (the isolation headers only apply to a fresh load); reopen Debug → Benchmark afterwards">${iso.action.label}</button>` : ''}</div>
      <form class="dbgBenchForm">
        <fieldset><legend>Potentials</legend>
          ${checkboxes('pot', FORM_POTENTIALS, DEFAULTS.potentials, formLabel, formReason)}
        </fieldset>
        <fieldset><legend>PET-MAD CPU threads</legend>
          ${checkboxes('threads', threadOptions, DEFAULTS.threads, (t) => threadLabel(t, caps.cores), threadReason)}
        </fieldset>
        <fieldset><legend>PET-MAD CPU matrix kernel</legend>
          ${checkboxes('kernel', BENCH_KERNELS, DEFAULTS.kernels, (k) => k.label)}
        </fieldset>
        <fieldset><legend>PET-MAD WebGPU readback</legend>
          ${checkboxes('readback', BENCH_READBACKS, DEFAULTS.readbacks, (k) => k.label)}
        </fieldset>
        <fieldset><legend>PET-MAD WebGPU matrix kernel</legend>
          ${checkboxes('matmul', BENCH_MATMULS, DEFAULTS.matmuls, (k) => k.label)}
        </fieldset>
        <fieldset><legend>Cells</legend>
          ${checkboxes('size', BENCH_SIZES, DEFAULTS.sizes, (n) => `${n}×${n}×${n} (${13 * n * n * n} atoms)`)}
        </fieldset>
        <fieldset><legend>Viewer</legend>
          ${checkboxes('vis', BENCH_VISUALS, DEFAULTS.visuals, (v) => v.label)}
        </fieldset>
        <fieldset><legend>Run length</legend>
          <label class="dbgBenchCheck">target <input type="number" name="target" value="5" min="1" max="120" step="1" class="dbgBenchNum" /> s per run</label>
          <label class="dbgBenchCheck">max <input type="number" name="maxSteps" value="60" min="3" max="1000" step="1" class="dbgBenchNum" /> steps</label>
          <label class="dbgBenchCheck" title="Where PET-MAD weights are fetched from; empty = the default (Hugging Face). A relative path such as ./bench-models/ works for locally served files.">
            models <input type="text" name="modelBase" value="" placeholder="Hugging Face (default)" class="dbgBenchText" /></label>
        </fieldset>
      </form>
      <div class="trajTransport dbgTransport">
        <button type="button" class="trajBtn dbgTextBtn" data-role="run">Run</button>
        <button type="button" class="trajBtn dbgTextBtn" data-role="stop" disabled>Stop</button>
        <span class="dbgBenchProgress" data-role="progress"></span>
        <span class="dbgSpacer"></span>
        <button type="button" class="trajBtn dbgTextBtn" data-role="json" title="Download the results (input for tools/bench/plot_potential_perf.py)">JSON</button>
        <button type="button" class="trajBtn dbgTextBtn" data-role="csv" title="Download the results table">CSV</button>
      </div>
      <div class="dbgBenchChartHead">
        <span class="dbgPlotTitle">MD steps per second</span>
        <label class="trajOpt">viewer <select data-role="chartVisual">
          ${BENCH_VISUALS.map((v) => `<option value="${v.key}"${v.key === 'bonds' ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select></label>
      </div>
      <div class="dbgBenchChart" data-role="chart"></div>
      <ul class="dbgBenchLegend" data-role="legend"></ul>
      <div class="dbgTableWrap">
        <table class="dbgTable dbgBenchTable">
          <thead><tr>
            <th>potential</th><th>atoms</th><th>viewer</th>
            <th title="MD steps per second, everything included">steps/s</th>
            <th title="ms per step waiting for the potential">potential</th>
            <th title="ms per step updating the 3D view">viewer</th>
            <th title="longest stretch the page could not respond, ms">freeze</th>
            <th title="CPU threads the potential used (after calibration)">threads</th>
          </tr></thead>
          <tbody data-role="rows"></tbody>
        </table>
      </div>
    </div>`;

  const form = /** @type {HTMLFormElement} */ (host.querySelector('.dbgBenchForm'));
  const q = (role) => /** @type {any} */ (host.querySelector(`[data-role="${role}"]`));
  const els = {
    run: q('run'), stop: q('stop'), progress: q('progress'), json: q('json'), csv: q('csv'),
    chart: q('chart'), legend: q('legend'), rows: q('rows'), chartVisual: q('chartVisual'), isolate: q('isolate'),
  };

  const refresh = () => {
    renderRows(els.rows, lastResult.records);
    renderChart(els.chart, els.legend, lastResult.records, els.chartVisual.value, onLightSurface(host));
    els.json.disabled = !lastResult.records.length;
    els.csv.disabled = !lastResult.records.length;
  };
  const setRunning = (on) => {
    running = on;
    els.run.disabled = on;
    els.stop.disabled = !on;
    if (els.isolate) els.isolate.disabled = on;
    form.querySelectorAll('input').forEach((i) => { i.disabled = on || i.dataset.unavailable === '1'; });
  };
  form.querySelectorAll('input:disabled').forEach((i) => { /** @type {HTMLElement} */ (i).dataset.unavailable = '1'; });

  els.chartVisual.addEventListener('change', refresh);
  els.isolate?.addEventListener('click', async () => {
    if (running) return;
    const enable = els.isolate.dataset.on === '1';
    els.isolate.disabled = true;
    // The reload loses everything held only in this page: ask first.
    if (!(await confirmAppReload(enable ? 'Turning multi-threading on' : 'Turning multi-threading off'))) {
      els.isolate.disabled = false;
      return;
    }
    els.progress.textContent = 'reloading the page …';
    let reloading = false;
    let reason = 'this browser cannot register the service worker it needs';
    try {
      reloading = await setMultithreadEnabled(enable);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (!reloading) {
      reloadAbandoned();
      els.isolate.disabled = false;
      els.progress.textContent = `multi-threading unavailable: ${reason}`;
    }
  });
  els.json.addEventListener('click', () => download('crysviz-potential-benchmark.json',
    JSON.stringify(lastResult, null, 1), 'application/json'));
  els.csv.addEventListener('click', () => download('crysviz-potential-benchmark.csv',
    benchRecordsToCsv(lastResult.records), 'text/csv'));
  els.stop.addEventListener('click', () => {
    stopRequested = true;
    els.progress.textContent = 'stopping after the current run …';
  });
  els.run.addEventListener('click', async () => {
    if (running) return;
    const threads = readChecked(form, 'threads').map((v) => (v === 'auto' ? 'auto' : Number(v)));
    const kernels = readChecked(form, 'kernel');
    const readbacks = readChecked(form, 'readback');
    const matmuls = readChecked(form, 'matmul');
    const picked = readChecked(form, 'pot');
    const potentials = [];
    for (const key of picked) {
      const row = FORM_POTENTIALS.find((p) => p.key === key);
      const family = /** @type {'xs'|'s'|undefined} */ (row?.family);
      if (row?.gpu) for (const rb of readbacks) for (const mm of matmuls) potentials.push(gpuBenchKey(key, rb, mm));
      else if (!family) potentials.push(key);
      else for (const t of threads) for (const k of kernels) potentials.push(cpuBenchKey(family, t, k));
    }
    const sizes = readChecked(form, 'size').map(Number);
    const visuals = readChecked(form, 'vis');
    if (!potentials.length || !sizes.length || !visuals.length) {
      els.progress.textContent = picked.length
        ? 'pick at least one PET-MAD CPU thread count and matrix kernel, WebGPU readback and matrix kernel, cell and viewer option'
        : 'pick at least one potential, cell and viewer option';
      return;
    }
    const fd = new FormData(form);
    stopRequested = false;
    lastResult = { meta: null, records: [] };
    refresh();
    setRunning(true);
    try {
      const result = await runPotentialBenchmark({
        potentials, sizes, visuals,
        targetMs: Math.max(1, Number(fd.get('target')) || 5) * 1000,
        maxSteps: Math.max(3, Number(fd.get('maxSteps')) || 60),
        modelBase: String(fd.get('modelBase') || '').trim(),
        shouldStop: () => stopRequested,
        onProgress: ({ index, total, label }) => {
          els.progress.textContent = `run ${index + 1} / ${total}: ${label}`;
        },
        onStatus: (t) => {
          if (/fetching|loading|initializing/.test(t)) els.progress.textContent = t;
        },
        onRecord: (rec) => {
          lastResult.records.push(rec);
          refresh();
        },
      });
      lastResult.meta = result.meta;
      els.progress.textContent = stopRequested
        ? `stopped after ${lastResult.records.length} runs`
        : `done: ${lastResult.records.length} runs`;
    } catch (error) {
      els.progress.textContent = `failed: ${error instanceof Error ? error.message : error}`;
    } finally {
      setRunning(false);
      refresh();
    }
  });
  setRunning(running);
  refresh();

  // navigator.gpu existing is not enough: the PET-MAD WebGPU build needs an
  // adapter with 'shader-f16'. Probe once and disable the WebGPU rows if not.
  probeBenchCapabilities().then((full) => {
    if (full.webgpu) {
      // How long one wait for the GPU takes here and in a worker (PET-MAD
      // runs in one): the floor per WebGPU step.
      probeGpuRoundTrip().then(({ page, worker }) => {
        const f = (r) => (r && Number.isFinite(r.mapMs) ? `${r.mapMs.toFixed(1)} ms` : (r?.error || 'n/a'));
        const capsEl = host.querySelector('[data-role="caps"]');
        const c = (r) => canvasReadbackSummary(r?.canvas) ?? 'n/a';
        if (capsEl) {
          capsEl.textContent += ` · WebGPU round trip: ${f(page)} on the page, ${f(worker)} in a worker`
            + ` · canvas readback: ${c(page)} on the page, ${c(worker)} in a worker`
            + ` · kernel launch: ${dispatchCostSummary(page?.dispatch) ?? 'n/a'} on the page,`
            + ` ${dispatchCostSummary(worker?.dispatch) ?? 'n/a'} in a worker`;
        }
      }).catch(() => { /* informational only */ });
      return;
    }
    host.querySelector('[data-role="caps"]').textContent = capLine.replace('WebGPU available', 'WebGPU unusable for PET-MAD');
    for (const spec of BENCH_POTENTIALS.filter((p) => p.needs === 'webgpu')) {
      const input = /** @type {HTMLInputElement|null} */ (form.querySelector(`input[name="pot"][value="${spec.key}"]`));
      if (!input) continue;
      input.checked = false;
      input.disabled = true;
      input.dataset.unavailable = '1';
      input.closest('label')?.setAttribute('title', full.webgpuReason || 'WebGPU unavailable');
    }
  }).catch(() => { /* keep the synchronous estimate */ });
}

function renderRows(tbody, records) {
  tbody.innerHTML = '';
  for (const r of records) {
    const tr = document.createElement('tr');
    const add = (text, span = 1) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (span > 1) td.colSpan = span;
      tr.appendChild(td);
    };
    add(r.potentialLabel);
    add(Number.isFinite(r.atoms) ? String(r.atoms) : `${r.cells}×${r.cells}×${r.cells}`);
    add(r.visualLabel);
    if (r.error) {
      add(`failed: ${r.error}`, 5);
    } else {
      add(fmt(r.stepsPerS, 2));
      add(fmt(r.forceMs));
      add(fmt(r.viewerMs));
      add(fmt(r.longestGapMs, 0));
      add(String(r.threads ?? ''));
    }
    tbody.appendChild(tr);
  }
}

function svg(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (parent) parent.appendChild(el);
  return el;
}

/** Log-log chart of steps/s vs atoms, one line per configuration. */
function renderChart(host, legend, records, visualKey, light) {
  host.innerHTML = '';
  legend.innerHTML = '';
  const rows = records.filter((r) => !r.error && r.visual === visualKey && Number.isFinite(r.stepsPerS) && r.stepsPerS > 0);
  if (!rows.length) {
    host.textContent = records.length ? 'No finished runs for this viewer option yet.' : 'Run the benchmark to fill the chart.';
    return;
  }
  const W = 520;
  const H = 260;
  const M = { l: 46, r: 96, t: 10, b: 34 };
  const xs = rows.map((r) => r.atoms);
  const ys = rows.map((r) => r.stepsPerS);
  const lx0 = Math.log10(Math.min(...xs)) - 0.08;
  const lx1 = Math.log10(Math.max(...xs)) + 0.08;
  const ly0 = Math.floor(Math.log10(Math.min(...ys)));
  const ly1 = Math.ceil(Math.log10(Math.max(...ys)));
  const X = (v) => M.l + ((Math.log10(v) - lx0) / Math.max(1e-9, lx1 - lx0)) * (W - M.l - M.r);
  const Y = (v) => H - M.b - ((Math.log10(v) - ly0) / Math.max(1e-9, ly1 - ly0)) * (H - M.t - M.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dbgBenchSvg', role: 'img',
    'aria-label': 'MD steps per second against atoms in the cell' }, host);

  // grid + y ticks (decades and 2, 5 within)
  for (let e = ly0; e <= ly1; e += 1) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (Math.log10(v) > ly1 + 1e-9) continue;
      const y = Y(v);
      svg('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, class: 'dbgBenchGrid' }, root);
      const t = svg('text', { x: M.l - 6, y: y + 3, class: 'dbgBenchTick', 'text-anchor': 'end' }, root);
      t.textContent = v >= 1 ? String(v) : String(Number(v.toPrecision(1)));
    }
  }
  const sizes = [...new Set(xs)].sort((a, b) => a - b);
  for (const n of sizes) {
    const x = X(n);
    svg('line', { x1: x, x2: x, y1: M.t, y2: H - M.b, class: 'dbgBenchGrid' }, root);
    const t = svg('text', { x, y: H - M.b + 14, class: 'dbgBenchTick', 'text-anchor': 'middle' }, root);
    t.textContent = String(n);
  }
  const xl = svg('text', { x: (M.l + W - M.r) / 2, y: H - 4, class: 'dbgBenchAxisLabel', 'text-anchor': 'middle' }, root);
  xl.textContent = 'atoms in the cell';
  svg('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'dbgBenchAxis' }, root);

  const labels = [];
  for (const key of new Set(rows.map((r) => r.potential))) {
    const spec = benchSpec(key);
    if (!spec) continue;
    const pts = rows.filter((r) => r.potential === key).sort((a, b) => a.atoms - b.atoms);
    const color = FAMILY_COLORS[spec.family][light ? 1 : 0];
    const dot = spec.kernel === 'dot' || /** @type {any} */ (spec).readback === 'map'
      || /** @type {any} */ (spec).matmul === 'reg_tile';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.atoms).toFixed(1)},${Y(p.stepsPerS).toFixed(1)}`).join(' ');
    svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': dashFor(spec),
      'stroke-linejoin': 'round', 'stroke-opacity': dot ? 0.55 : 1 }, root);
    for (const p of pts) {
      const c = svg('circle', { cx: X(p.atoms), cy: Y(p.stepsPerS), r: 4, class: 'dbgBenchDot',
        ...(dot ? { fill: 'none', stroke: color, 'stroke-width': 1.5 } : { fill: color }) }, root);
      const title = svg('title', {}, c);
      title.textContent = `${spec.label}, ${p.atoms} atoms: ${fmt(p.stepsPerS, 2)} steps/s `
        + `(potential ${fmt(p.forceMs)} ms, viewer ${fmt(p.viewerMs)} ms per step)`;
    }
    const lastPt = pts[pts.length - 1];
    labels.push({ y: Y(lastPt.stepsPerS), x: X(lastPt.atoms), text: shortLabel(spec) });

    const li = document.createElement('li');
    const sw = svg('svg', { width: 26, height: 8, class: 'dbgBenchSwatch' });
    svg('line', { x1: 1, x2: 25, y1: 4, y2: 4, stroke: color, 'stroke-width': 2, 'stroke-dasharray': dashFor(spec),
      'stroke-opacity': dot ? 0.55 : 1 }, sw);
    li.appendChild(sw);
    li.appendChild(document.createTextNode(spec.label));
    legend.appendChild(li);
  }
  // end labels, nudged apart so they never overlap
  labels.sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const l of labels) {
    const y = Math.max(l.y, prev + 11);
    prev = y;
    const t = svg('text', { x: l.x + 7, y: y + 3, class: 'dbgBenchEndLabel' }, root);
    t.textContent = l.text;
  }
}
