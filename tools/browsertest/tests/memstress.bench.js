// Memory and stability of the MD player and the potentials at scale.
//
// Three phases, each in a fresh browser:
//   A. Trajectory playback: a thermally moving Si supercell trajectory from
//      1.7k to 55k atoms (past the 20k atom-imposter threshold) is generated
//      in the page, loaded, played twice on the Auto (fast) path and once on
//      the Full path, then deleted. Memory after load, after each loop and
//      after deletion: a leak shows as growth between the loops or as memory
//      that does not come back when the row is removed.
//   B. Long NEP MD: a 1625-atom cell for MD_STEPS steps through the MD panel,
//      memory sampled during the run; then the trajectory row is deleted.
//   C. PET-MAD in its worker: memory per cell size after a warm-up and after
//      repeated evaluations (a per-step leak in the wasm would grow it).
//
// Memory is measured three ways: the main-thread JS heap after a forced GC
// (CDP), the browser's own breakdown incl. workers and wasm
// (performance.measureUserAgentSpecificMemory; needs CRYSVIZ_COI=1), and the
// PSS of the whole Chromium process tree from /proc (everything: JS, wasm,
// DOM, the software GL rasteriser's buffers). Headless Chromium only.
//
//   CRYSVIZ_COI=1 CRYSVIZ_BROWSER=chromium tools/browsertest/run.sh tests/memstress.bench.js
// Env: MEM_PHASES=A,B,C  MEM_SIZES=6,10,14,19 (Si conventional cells per edge)
//      MEM_MD_STEPS=400  MEM_OUT=…/memstress.json
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const PHASES = (process.env.MEM_PHASES || 'A,B,C').split(',');
const SIZES = (process.env.MEM_SIZES || '6,10,14,19').split(',').map(Number);
const MD_STEPS = Number(process.env.MEM_MD_STEPS || 400);
const OUT = process.env.MEM_OUT || path.join(__dirname, '..', 'artifacts', 'memstress.json');
const EXTRA = process.env.MEM_EXTRA === '0' ? [] : ['--enable-blink-features=ForceEagerMeasureMemory'];
const UA_MEASURE = process.env.MEM_UA !== '0';
const MB = (b) => (Number.isFinite(b) ? +(b / 1048576).toFixed(1) : null);

function framesFor(atoms) {
  if (atoms <= 2000) return 60;
  if (atoms <= 9000) return 40;
  if (atoms <= 25000) return 20;
  return 10;
}

async function measure(page, cdp, marker, label) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const inPage = await page.evaluate(async ({ uaMeasure }) => {
    const { app, groups } = await import('./state/store.js');
    const info = app.renderer?.info;
    let ua = null;
    if (uaMeasure && globalThis.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
      try {
        const m = await performance.measureUserAgentSpecificMemory();
        const by = {};
        for (const e of m.breakdown) {
          if (!e.bytes) continue;
          const scope = e.attribution?.[0]?.scope || 'other';
          by[scope] = (by[scope] || 0) + e.bytes;
        }
        ua = { total: m.bytes, by };
      } catch { /* not available */ }
    }
    return {
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      programs: info?.programs?.length ?? null,
      atomsMeshCount: groups.atomsMesh?.count ?? null,
      imposter: !!groups.atomsMesh?.userData?.imposter,
      bondsCount: groups.bondsMesh?.count ?? null,
      dom: document.getElementsByTagName('*').length,
      ua,
    };
  }, { uaMeasure: UA_MEASURE });
  const proc = H.processMemory(marker);
  const rec = {
    label,
    heapMB: MB(heap.usedSize),
    uaMB: inPage.ua ? MB(inPage.ua.total) : null,
    uaWorkersMB: inPage.ua ? MB(Object.entries(inPage.ua.by).filter(([k]) => /Worker/.test(k)).reduce((a, [, v]) => a + v, 0)) : null,
    pssMB: proc ? +proc.pssMB.toFixed(1) : null,
    rendererMB: proc ? +proc.processes.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.pssMB, 0).toFixed(1) : null,
    gpuProcMB: proc ? +proc.processes.filter((p) => p.type === 'gpu-process').reduce((a, p) => a + p.pssMB, 0).toFixed(1) : null,
    ...inPage,
  };
  delete rec.ua;
  console.log(`    ${label.padEnd(34)} heap ${String(rec.heapMB).padStart(7)} MB  page+workers ${String(rec.uaMB ?? '–').padStart(7)} MB  `
    + `browser PSS ${String(rec.pssMB ?? '–').padStart(7)} MB (gpu proc ${rec.gpuProcMB ?? '–'})  geom ${rec.geometries} tex ${rec.textures} prog ${rec.programs}`);
  return rec;
}

async function phaseA() {
  const results = [];
  for (const n of SIZES) {
    const atoms = 8 * n * n * n;
    const frames = framesFor(atoms);
    console.log(`  A: Si ${n}x${n}x${n} conventional = ${atoms} atoms, ${frames} frames`);
    // eslint-disable-next-line no-await-in-loop
    const { browser, page, errors, marker } = await H.launchApp({ extraArgs: EXTRA });
    const cdp = await page.context().newCDPSession(page);
    const r = { n, atoms, framesExpected: frames, steps: [] };
    try {
      r.steps.push(await measure(page, cdp, marker, 'idle (default structure)'));
      const load = await page.evaluate(async ({ n, frames }) => {
        const a = 5.43;
        const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
          [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
        const L = (n * a).toFixed(4);
        const sites = [];
        for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) for (let k = 0; k < n; k += 1) {
          for (const f of base) sites.push([(f[0] + i) * a, (f[1] + j) * a, (f[2] + k) * a]);
        }
        const parts = [];
        for (let t = 0; t < frames; t += 1) {
          parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
          for (let s = 0; s < sites.length; s += 1) {
            const p = sites[s];
            const d0 = 0.08 * Math.sin(0.5 * t + 1.3 * s);
            const d1 = 0.08 * Math.sin(0.5 * t + 1.3 * s + 2.1);
            const d2 = 0.08 * Math.sin(0.5 * t + 1.3 * s + 4.2);
            parts.push(`Si ${(p[0] + d0).toFixed(4)} ${(p[1] + d1).toFixed(4)} ${(p[2] + d2).toFixed(4)}`);
          }
        }
        let text = parts.join('\n');
        const textMB = text.length / 1048576;
        const cv = await import('./core/crystal-viewer.js');
        const { structureShip, fileBrowser } = await import('./state/store.js');
        const before = structureShip.container.length;
        const t0 = performance.now();
        await cv.loadStructure(text, `memstress_${n}.xyz`);
        text = null;
        const deadline = performance.now() + 300000;
        while (structureShip.container.length === before && performance.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((res) => setTimeout(res, 100));
        }
        await new Promise((res) => setTimeout(res, 300));
        const container = structureShip.container[structureShip.container.length - 1];
        return {
          textMB: +textMB.toFixed(1),
          loadMs: Math.round(performance.now() - t0),
          frames: container?.structures?.length ?? 0,
          atoms: fileBrowser.selectedStructure?.atoms?.length ?? 0,
          bonds: fileBrowser.selectedStructure?.bonds?.length ?? 0,
        };
      }, { n, frames });
      Object.assign(r, load);
      console.log(`    loaded ${load.textMB} MB of extxyz in ${load.loadMs} ms: ${load.frames} frames, ${load.atoms} atoms, ${load.bonds} bonds`);
      r.steps.push(await measure(page, cdp, marker, 'after load'));

      const play = async (mode, loops) => page.evaluate(async ({ mode, loops }) => {
        const { structureShip, app } = await import('./state/store.js');
        const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
        const { renderFrameNow } = await import('./render/AnimateModule.js');
        const container = structureShip.container[structureShip.container.length - 1];
        container.playbackMode = mode;
        const nf = container.structures.length;
        const out = [];
        const renderMs = [];
        for (let loop = 0; loop < loops; loop += 1) {
          let upd = 0;
          for (let f = 0; f < nf; f += 1) {
            const t0 = performance.now();
            showTrajectoryFrame(f, container, { full: false, playback: { forceFull: false }, recenter: false });
            upd += performance.now() - t0;
            // Draw every 10th frame (and the last): the headless browser's
            // GPU is a CPU emulator (SwiftShader) that intermittently takes
            // minutes for one frame; the scene state is updated every frame.
            if (f % 10 === 0 || f === nf - 1) {
              const t1 = performance.now();
              renderFrameNow();
              app.renderer.getContext().finish();
              renderMs.push(performance.now() - t1);
            }
            // Yield so timers / GC can run like in real playback.
            // eslint-disable-next-line no-await-in-loop
            await new Promise((res) => setTimeout(res, 0));
          }
          out.push(+(upd / nf).toFixed(1));
        }
        renderMs.sort((a, b) => a - b);
        out.renderMedianMs = renderMs.length ? +renderMs[Math.floor(renderMs.length / 2)].toFixed(1) : null;
        const s = container.debugStats;
        return { msPerFrame: out, renderMedianMs: out.renderMedianMs, stats: { ...s } };
      }, { mode, loops });

      const auto1 = await play('auto', 1);
      r.steps.push({ ...(await measure(page, cdp, marker, 'after Auto loop 1')), updateMsPerFrame: auto1.msPerFrame[0], renderMedianMs: auto1.renderMedianMs });
      const auto2 = await play('auto', 1);
      r.steps.push({ ...(await measure(page, cdp, marker, 'after Auto loop 2')), updateMsPerFrame: auto2.msPerFrame[0], renderMedianMs: auto2.renderMedianMs });
      if (atoms <= 25000) {
        const full = await play('full', 1);
        r.steps.push({ ...(await measure(page, cdp, marker, 'after Full loop')), updateMsPerFrame: full.msPerFrame[0], renderMedianMs: full.renderMedianMs });
      }
      r.playStats = auto2.stats;
      const fullStep = r.steps.find((x) => x.label === 'after Full loop');
      console.log(`    update ms/frame: Auto ${auto1.msPerFrame[0]} / ${auto2.msPerFrame[0]}${fullStep ? `, Full ${fullStep.updateMsPerFrame}` : ''}`
        + `  ·  median render ${auto2.renderMedianMs} ms (software GL)  ·  imposters ${r.steps[r.steps.length - 1].imposter}`);

      await page.evaluate(async () => {
        const rows = document.querySelectorAll('#objectTable tbody tr');
        rows[rows.length - 1]?.querySelector('.delete')?.click();
        await new Promise((res) => setTimeout(res, 500));
      });
      r.steps.push(await measure(page, cdp, marker, 'after deleting the row'));
      r.errors = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|esm\.sh|Plotly/.test(e));
      r.ok = true;
    } catch (error) {
      r.ok = false;
      r.error = String(error.message || error).slice(0, 300);
      console.log(`    FAILED: ${r.error}`);
    }
    await browser.close().catch(() => {});
    results.push(r);
  }
  return results;
}

async function phaseB() {
  const { browser, page, errors, marker } = await H.launchApp({ extraArgs: EXTRA });
  const cdp = await page.context().newCDPSession(page);
  await H.loadDefaultStructure(page);
  const r = { steps: [], samples: [] };
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    createSupercell(5, 5, 5);
  });
  await page.waitForTimeout(500);
  // The MD panel loads a main-thread NEP runner (the fallback when the worker
  // cannot start, reused by relax/EFS) and keeps it for the session: ~30 MB of
  // wasm instance and model file that is a cache, not part of the trajectory.
  // Load it before the baseline so the delete check measures the MD row only.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.atomisticPotential = 'nep';
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    await ensureCalculatorRunner(() => {});
  });
  r.steps.push(await measure(page, cdp, marker, 'before MD (1625 atoms, NEP runner loaded)'));
  const startedAt = Date.now();
  await page.evaluate(async ({ steps }) => {
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'nep';
    openPanel('backend');
    await new Promise((res) => setTimeout(res, 300));
    document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click();
    await new Promise((res) => setTimeout(res, 300));
    document.getElementById('mdStepsInput').value = String(steps);
    const stride = document.getElementById('mdSaveStrideInput');
    if (stride) stride.value = '4';
    document.getElementById('mdStartBtn').click();
  }, { steps: MD_STEPS });
  // Sample while it runs (no forced GC here: that would perturb the run).
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(5000);
    // eslint-disable-next-line no-await-in-loop
    const st = await page.evaluate(() => ({
      running: document.getElementById('mdStartBtn')?.disabled === true,
      heap: performance.memory?.usedJSHeapSize ?? null,
      // The MD shell's status line reads "step i / N  ·  t=… fs …".
      status: (document.body.innerText.match(/step \d+ \/ \d+/) || [''])[0],
    }));
    const proc = H.processMemory(marker);
    const step = Number((st.status.match(/step (\d+)/) || [])[1] || NaN);
    r.samples.push({ t: (Date.now() - startedAt) / 1000, step, heapMB: MB(st.heap), pssMB: proc ? +proc.pssMB.toFixed(1) : null });
    console.log(`    t=${Math.round((Date.now() - startedAt) / 1000)} s  step ${step}  heap ${MB(st.heap)} MB  browser PSS ${proc ? proc.pssMB.toFixed(0) : '–'} MB`);
    if (!st.running) break;
    if (Date.now() - startedAt > 40 * 60 * 1000) break;
  }
  r.steps.push(await measure(page, cdp, marker, 'after MD'));
  r.trajectory = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const { accountContainer } = await import('./debug/memoryAccounting.js');
    const c = structureShip.container[structureShip.container.length - 1];
    const acc = accountContainer(c);
    return { frames: c.structures.length, accountedMB: +(acc.totalBytes / 1048576).toFixed(1), name: c.fileName };
  });
  console.log(`    MD trajectory: ${r.trajectory.frames} frames, ${r.trajectory.accountedMB} MB accounted`);
  await page.evaluate(async () => {
    const rows = document.querySelectorAll('#objectTable tbody tr');
    rows[rows.length - 1]?.querySelector('.delete')?.click();
    await new Promise((res) => setTimeout(res, 500));
  });
  r.steps.push(await measure(page, cdp, marker, 'after deleting the MD row'));
  r.errors = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|esm\.sh|Plotly/.test(e));
  await browser.close();
  return r;
}

async function phaseC() {
  const { browser, page, errors, marker } = await H.launchApp({ extraArgs: EXTRA });
  const cdp = await page.context().newCDPSession(page);
  await H.loadDefaultStructure(page);
  const r = { steps: [] };
  r.steps.push(await measure(page, cdp, marker, 'before PET-MAD'));
  const load = await page.evaluate(async () => {
    const { WorkerMLIPRunner } = await import('./atomistic/mlipWorkerClient.js');
    window.__mlip = new WorkerMLIPRunner({ backend: 'cpu', threads: 'auto' });
    await window.__mlip.init();
    await window.__mlip.loadModelFromUrl('./bench-models/pet-mad-xs.gguf');
    return window.__mlip.describe();
  });
  r.runtime = load;
  r.steps.push(await measure(page, cdp, marker, 'model loaded'));
  for (const n of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const info = await page.evaluate(async ({ n }) => {
      const cv = await import('./core/crystal-viewer.js');
      const d = await import('./defaults/structure_defaults.js');
      const { createSupercell } = await import('./ui/SuperCellModule.js');
      const { buildNEPStructure } = await import('./atomistic/relaxer.js');
      const { fileBrowser } = await import('./state/store.js');
      await cv.loadStructure(d.defaultPOSCAR, 'YBCO');
      await new Promise((res) => setTimeout(res, 500));
      if (n > 1) createSupercell(n, n, n);
      window.__s = buildNEPStructure(window.__mlip, fileBrowser.selectedStructure);
      const t0 = performance.now();
      await window.__mlip.compute(window.__s);
      await window.__mlip.compute(window.__s);
      return { atoms: window.__s.positions.length, warmMs: Math.round(performance.now() - t0) };
    }, { n });
    // eslint-disable-next-line no-await-in-loop
    const warm = await measure(page, cdp, marker, `PET-MAD ${info.atoms} atoms, warm`);
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await window.__mlip.compute(window.__s);
      }
    });
    // eslint-disable-next-line no-await-in-loop
    const after = await measure(page, cdp, marker, `PET-MAD ${info.atoms} atoms, +10 evals`);
    r.steps.push({ ...warm, atoms: info.atoms }, { ...after, atoms: info.atoms });
  }
  await page.evaluate(() => window.__mlip.destroy());
  await page.waitForTimeout(1000);
  r.steps.push(await measure(page, cdp, marker, 'worker destroyed'));
  r.errors = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|esm\.sh|Plotly/.test(e));
  await browser.close();
  return r;
}

(async () => {
  const out = { meta: { date: new Date().toISOString(), isolated: process.env.CRYSVIZ_COI === '1', gpu: process.env.CRYSVIZ_GPU || false } };
  const save = () => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  };
  if (PHASES.includes('A')) { console.log('== A: trajectory playback'); out.playback = await phaseA(); save(); }
  if (PHASES.includes('B')) { console.log('== B: long NEP MD'); out.md = await phaseB(); save(); }
  if (PHASES.includes('C')) { console.log('== C: PET-MAD worker'); out.petmad = await phaseC(); save(); }
  console.log(`  wrote ${OUT}`);

  if (out.playback) {
    for (const r of out.playback) {
      const step = (l) => r.steps?.find((s) => s.label === l);
      H.check(`A ${r.atoms} atoms: loads all ${r.framesExpected} frames and plays them`,
        r.ok && r.frames === r.framesExpected, r.error || `${r.frames} frames`);
      const l1 = step('after Auto loop 1');
      const l2 = step('after Auto loop 2');
      if (l1 && l2) {
        H.check(`A ${r.atoms} atoms: no growth between playback loops (heap +${(l2.heapMB - l1.heapMB).toFixed(1)} MB, geometries ${l1.geometries}->${l2.geometries})`,
          l2.heapMB - l1.heapMB < Math.max(5, 0.05 * l1.heapMB) && l2.geometries <= l1.geometries + 2 && l2.textures <= l1.textures + 2);
      }
      const idle = step('idle (default structure)');
      const gone = step('after deleting the row');
      const loaded = step('after load');
      if (idle && gone && loaded) {
        const held = loaded.heapMB - idle.heapMB;
        const left = gone.heapMB - idle.heapMB;
        H.check(`A ${r.atoms} atoms: deleting the row releases the trajectory (heap ${held.toFixed(0)} MB held, ${left.toFixed(0)} MB left)`,
          left < Math.max(10, 0.25 * held));
      }
      if (r.errors?.length) H.check(`A ${r.atoms} atoms: no page errors`, false, r.errors[0]);
    }
  }
  if (out.md) {
    const b = out.md.steps.find((s) => s.label.startsWith('before MD'));
    const a = out.md.steps.find((s) => s.label === 'after MD');
    const d = out.md.steps.find((s) => s.label === 'after deleting the MD row');
    H.check('B: MD run completed', out.md.trajectory?.frames > 1, JSON.stringify(out.md.trajectory));
    if (a && b && d) {
      H.check(`B: MD heap growth (${(a.heapMB - b.heapMB).toFixed(0)} MB) is of the order of the stored trajectory (${out.md.trajectory.accountedMB} MB accounted)`,
        a.heapMB - b.heapMB < 3 * out.md.trajectory.accountedMB + 20);
      H.check(`B: deleting the MD row releases it (${(d.heapMB - b.heapMB).toFixed(0)} MB left)`,
        d.heapMB - b.heapMB < Math.max(15, 0.3 * (a.heapMB - b.heapMB)));
    }
  }
  if (out.petmad) {
    const pairs = out.petmad.steps.filter((s) => s.atoms);
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const w = pairs[i];
      const x = pairs[i + 1];
      const metric = (s) => s.uaMB ?? s.pssMB;
      H.check(`C: ${w.atoms} atoms: 10 more PET-MAD evaluations do not grow memory (${(metric(x) - metric(w)).toFixed(1)} MB)`,
        metric(x) - metric(w) < 20);
    }
  }
  await H.finish({ close: async () => {} });
})();
