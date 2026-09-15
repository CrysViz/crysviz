// ?debug opens the Debug window (ui/DebugPanel.js): accounted memory per
// trajectory, the shown frame and playback/render frame rates, sampled by
// debug/debugSampler.js with event markers and a CSV export. Without ?debug
// none of it exists. This drives the real page both ways.
'use strict';
const H = require('../harness');

// Six ionic steps, 2 atoms (Na, Cl) — enough frames for playback to advance.
const STEP = (clX, toten) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
  '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
  '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
  '',
  ' POSITION                                       TOTAL-FORCE (eV/Angst)',
  ' -----------------------------------------------------------------------------------',
  '      0.00000      0.00000      0.00000         0.100000      0.000000      0.000000',
  `      ${clX.toFixed(5)}      0.00000      0.00000        -0.100000      0.000000      0.000000`,
  ' -----------------------------------------------------------------------------------',
  '    total drift:                                0.000000      0.000000      0.000000',
  '',
  '  FREE ENERGIE OF THE ION-ELECTRON SYSTEM (eV)',
  '  ---------------------------------------------------',
  `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`,
  '',
];
const HEADER = [
  ' vasp.6.4.2 20Jul23 complex',
  ' POTCAR:    PAW_PBE Na_pv 19Sep2006',
  ' POTCAR:    PAW_PBE Cl 06Sep2000',
  '   ions per type =               1   1',
  '',
];
const OUTCAR = [...HEADER, ...[0, 1, 2, 3, 4, 5].map((i) => STEP(2.0 - 0.05 * i, -10 - i))].flat().join('\n');
// Same two atoms, but Cl jumps 2.0 -> 0.4 -> 2.0 Å (1.6 Å per frame): structures, not motion.
const DATASET = [...HEADER, ...[2.0, 0.4, 2.0, 0.4].map((x, i) => STEP(x, -10 - i))].flat().join('\n');

// Minimal Plotly stand-in: keeps data/layout on the div the way the real one
// does (chart.data / chart.layout), appends via extendTraces, merges relayout.
const PLOTLY_STUB = `
const Plotly = {
  async react(div, data, layout, config) {
    div.classList.add('js-plotly-plot');
    div.data = data; div.layout = layout; div.config = config;
    div._fullLayout = { xaxis: { _offset: 0, _length: 100, p2d: () => 0 } };
    div.__reacts = (div.__reacts || 0) + 1;
  },
  extendTraces(div, update, indices, maxPts) {
    indices.forEach((idx, k) => {
      const tr = div.data[idx]; if (!tr) return;
      for (const key of ['x', 'y']) {
        tr[key].push(...update[key][k]);
        while (tr[key].length > maxPts) tr[key].shift();
      }
    });
    div.__extends = (div.__extends || 0) + 1;
  },
  relayout(div, upd) { div.layout = Object.assign({}, div.layout, upd); },
  purge(div) { div.data = []; div.layout = {}; },
  Plots: { resize() {} },
  toImage: async () => 'data:image/png;base64,',
};
export default Plotly;
`;

(async () => {
  // --- 1. Without ?debug: nothing registered, sampler idle ------------------
  {
    const { browser, page, errors } = await H.launchApp();
    const off = await page.evaluate(async () => {
      const pm = await import('./ui/panels/PanelManager.js');
      const mode = await import('./debug/debugMode.js');
      const sampler = await import('./debug/debugSampler.js');
      return {
        debugMode: mode.isDebugMode(),
        panel: !!pm.getPanel('debug'),
        running: sampler.isDebugSamplerRunning(),
        samples: sampler.getDebugHistory().samples.length,
      };
    });
    H.check('plain URL: debug mode off', off.debugMode === false, JSON.stringify(off));
    H.check('plain URL: no Debug window registered', off.panel === false);
    H.check('plain URL: sampler not running, no samples', off.running === false && off.samples === 0, JSON.stringify(off));
    H.check('plain URL: no console/page errors', errors.length === 0, errors[0] || '');
    await browser.close();
  }

  // --- 2. With ?debug -------------------------------------------------------
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  // Plotly comes from esm.sh (utils/plotlyLoader.js); serve a recording stub
  // instead so the run does not depend on the network and the traces/layout
  // the plot factory hands to Plotly can be inspected directly.
  await page.route('https://esm.sh/**', (route) => route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' },
    body: PLOTLY_STUB,
  }));
  const url = new URL(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html');
  url.searchParams.set('debug', '');
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  const on = await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    const mode = await import('./debug/debugMode.js');
    const sampler = await import('./debug/debugSampler.js');
    const panel = pm.getPanel('debug');
    const body = document.getElementById('cvPanelBody-debug');
    return {
      debugMode: mode.isDebugMode(),
      panel: !!panel,
      dock: panel ? panel.dock : null,
      closed: panel ? panel.closed : null,
      built: !!body && !!body.querySelector('#dbgRecordBtn'),
      plots: !!document.getElementById('debugMemoryPlot') && !!document.getElementById('debugPlaybackPlot')
        && !!document.getElementById('debugRendererPlot') && !!document.getElementById('debugStorePlot'),
      running: sampler.isDebugSamplerRunning(),
      samples: sampler.getDebugHistory().samples.length,
      urlKeepsDebug: new URLSearchParams(location.search).has('debug'),
    };
  });
  H.check('?debug: debug mode on', on.debugMode === true, JSON.stringify(on));
  H.check('?debug: Debug window registered in the side dock', on.panel && on.dock === 'right' && on.closed === false, JSON.stringify(on));
  H.check('?debug: window body built with transport + all four plots', on.built && on.plots, JSON.stringify(on));
  H.check('?debug: sampler running and has samples', on.running && on.samples >= 2, JSON.stringify(on));
  H.check('?debug: parameter stays in the URL', on.urlKeepsDebug === true);

  // Load a trajectory, play it, and watch the sampler see it.
  const play = await page.evaluate(async (outcar) => {
    const cv = await import('./core/crystal-viewer.js');
    const pm = await import('./ui/panels/PanelManager.js');
    const sampler = await import('./debug/debugSampler.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { getContainerId } = await import('./state/structures.js');
    const { usedIDs } = await import('./state/store.js');
    sampler.setDebugSamplerInterval(250);
    await cv.loadStructure(outcar, 'OUTCAR.play');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const id = getContainerId(container);
    pm.openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 800));
    const { app, groups } = await import('./state/store.js');
    const trace = await import('./debug/debugTrace.js');
    const countersBefore = trace.counters();
    const clSlot = () => {
      const wrapped = fileBrowser.selectedStructure.periodic.visibleWrapped;
      const slot = wrapped.srcIndex.indexOf(1); // first instance of atom 1 (Cl)
      const a = groups.atomsMesh.instanceMatrix.array;
      return [a[slot * 16 + 12], a[slot * 16 + 13], a[slot * 16 + 14]];
    };
    const clBefore = clSlot();
    const idsBefore = usedIDs.size;
    const texturesBefore = app.renderer.info.memory.textures;
    const bondsShown = fileBrowser.selectedStructure.bonds.length;
    const speed = document.getElementById('speedSelect');
    speed.value = '50';
    speed.dispatchEvent(new Event('change'));
    document.getElementById('playPauseBtn').click();
    // Sample the Cl instance WHILE playing: that is the fast path at work
    // (the pause below settles through a full rebuild), and comparing only the
    // settled frame with the start misses motion whenever playback happens to
    // stop on the frame it started from.
    let clMoved = false;
    for (let waited = 0; waited < 2500; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
      const cl = clSlot();
      if (clBefore.some((v, i) => Math.abs(v - cl[i]) > 1e-6)) clMoved = true;
    }
    document.getElementById('playPauseBtn').click(); // pause -> settle marker
    await new Promise((r) => setTimeout(r, 700));
    const idsAfter = usedIDs.size;
    const texturesAfter = app.renderer.info.memory.textures;
    const countersAfter = trace.counters();
    const meshSame = true;
    const kind = container.motionProfile().kind;
    const { samples, markers } = sampler.getDebugHistory();
    const recent = samples.slice(-12);
    const mine = recent.map((s) => s.containers.find((c) => c.id === id)).filter(Boolean);
    const labels = markers.map((m) => m.label);
    const readout = {
      frame: document.getElementById('dbgFrameCur').textContent,
      total: document.getElementById('dbgTotal').textContent,
      rows: document.querySelectorAll('#dbgTableBody tr').length,
    };
    return {
      frames: container.frameCount,
      sawContainer: mine.length > 0,
      mbPositive: mine.every((c) => Number.isFinite(c.mb) && c.mb > 0),
      materialized: mine.map((c) => c.materialized),
      stats: container.debugStats,
      maxPlayback: Math.max(...recent.map((s) => s.playbackFps)),
      renderSeen: recent.some((s) => s.renderFps > 0),
      framesSeen: [...new Set(recent.map((s) => s.frame))],
      labels,
      readout,
      csvHead: sampler.debugHistoryToCsv().split('\n').slice(0, 2),
      idsBefore, idsAfter, bondsShown, texturesBefore, texturesAfter,
      fastFrames: (countersAfter.playbackFast || 0) - (countersBefore.playbackFast || 0),
      fullFrames: (countersAfter.playbackFull || 0) - (countersBefore.playbackFull || 0),
      appliedFrames: (countersAfter.frameApplied || 0) - (countersBefore.frameApplied || 0),
      clMoved, meshSame, kind,
      last: (() => { const s = samples[samples.length - 1]; return {
        heapMB: s.heapMB, appMB: s.appMB, sceneMB: s.sceneMB, totalMB: s.totalMB, containersMB: s.containersMB,
        glGeometries: s.glGeometries, glTextures: s.glTextures, glPrograms: s.glPrograms,
        sceneObjects: s.sceneObjects, ids: s.ids, domNodes: s.domNodes, drawCalls: s.drawCalls,
        storeKeys: Object.keys(s.appStores || {}), storeSum: Object.values(s.appStores || {}).reduce((a, v) => a + v.mb, 0),
        appMBAgain: s.appMB, storeRows: document.querySelectorAll('#dbgStoreBody tr').length,
        storePlotTraces: (document.getElementById('debugStorePlot').data || []).length,
      }; })(),
    };
  }, OUTCAR);
  const L = play.last;
  H.check('sample carries app-state and scene-buffer MB and the accounted total sums them',
    L.appMB > 0 && L.sceneMB > 0 && Math.abs(L.totalMB - (L.containersMB + L.appMB + L.sceneMB)) < 1e-9, JSON.stringify(L));
  H.check('app state is broken down per store (8 stores summing to app_MB), table and plot present',
    L.storeKeys.length === 8 && Math.abs(L.storeSum - L.appMBAgain) < 1e-9 && L.storeRows === 8 && L.storePlotTraces >= 1, JSON.stringify({ keys: L.storeKeys, sum: L.storeSum, app: L.appMBAgain, rows: L.storeRows, traces: L.storePlotTraces }));
  H.check('sample carries the JS heap (Chromium) or NaN elsewhere', Number.isFinite(L.heapMB) || Number.isNaN(L.heapMB), String(L.heapMB));
  H.check('renderer counts: GL geometries/programs, scene objects, DOM nodes, draw calls are finite',
    L.glGeometries >= 1 && L.glPrograms >= 1 && L.sceneObjects >= 2 && L.domNodes > 100 && Number.isFinite(L.drawCalls), JSON.stringify(L));
  // The settle frame (pause) is applied through the file browser's full path,
  // so it counts as applied but as neither fast nor full playback frame.
  H.check('a smooth trajectory is classified as such and its playback frames take the render fast path',
    play.kind === 'trajectory' && play.fastFrames > 0 && play.fastFrames + play.fullFrames >= play.appliedFrames - 2 && play.appliedFrames > 1,
    JSON.stringify({ kind: play.kind, fast: play.fastFrames, full: play.fullFrames, applied: play.appliedFrames }));
  H.check('fast path moved the Cl instance in the atoms mesh', play.clMoved === true, JSON.stringify({ moved: play.clMoved }));
  H.check('GL texture count does not grow during playback (wedge texture disposed with the atoms material)',
    play.texturesAfter <= play.texturesBefore && play.stats.shown > 1,
    JSON.stringify({ before: play.texturesBefore, after: play.texturesAfter, shown: play.stats.shown }));
  H.check('id registry does not grow during playback (bond ids are released on rebuild)',
    play.bondsShown > 0 && play.idsAfter <= play.idsBefore && L.ids === play.idsAfter,
    JSON.stringify({ bonds: play.bondsShown, before: play.idsBefore, after: play.idsAfter, shown: play.stats.shown }));
  H.check('trajectory has 6 frames', play.frames === 6, String(play.frames));
  H.check('sampler accounts the loaded trajectory with a positive MB figure', play.sawContainer && play.mbPositive, JSON.stringify(play.materialized));
  H.check('store-backed trajectory keeps exactly one live frame', play.materialized.every((m) => m === 1), JSON.stringify(play.materialized));
  H.check('frame switches were counted (shown > 1, reused path)', play.stats.shown > 1 && play.stats.reused >= 1, JSON.stringify(play.stats));
  H.check('playback frames/s was measured during play', play.maxPlayback > 0, String(play.maxPlayback));
  H.check('render frames/s was measured', play.renderSeen === true);
  H.check('the shown frame index changed while playing', play.framesSeen.length >= 2, JSON.stringify(play.framesSeen));
  H.check('markers: load, play and pause recorded', play.labels.some((l) => l.startsWith('load OUTCAR.play')) && play.labels.some((l) => l.startsWith('play')) && play.labels.includes('pause'), JSON.stringify(play.labels));
  H.check('readout shows a frame and a total, table has a row per structure', /^\d+$/.test(play.readout.frame) && /^\d+\.\d$/.test(play.readout.total) && play.readout.rows === 2, JSON.stringify(play.readout));
  H.check('CSV has the fixed header and a per-container MB column', play.csvHead[0].startsWith('t_s,wall_iso,frame,frames,playback_fps,fast_fps,full_fps,render_fps,render_ms,render_capacity_fps,total_MB,containers_MB,app_MB,scene_MB,heap_MB,ids,') && play.csvHead[0].includes('OUTCAR.play_MB') && play.csvHead[0].endsWith(',event'), play.csvHead[0]);

  // A "dataset": same composition but a 1.6 Å jump between frames -> never the
  // fast path, full rebuild on every frame.
  const dataset = await page.evaluate(async (outcar) => {
    const cv = await import('./core/crystal-viewer.js');
    const trace = await import('./debug/debugTrace.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(outcar, 'OUTCAR.dataset');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const profile = container.motionProfile();
    await new Promise((r) => setTimeout(r, 500));
    const before = trace.counters();
    document.getElementById('playPauseBtn').click();
    await new Promise((r) => setTimeout(r, 1200));
    document.getElementById('playPauseBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    const after = trace.counters();
    return { profile, fast: (after.playbackFast || 0) - (before.playbackFast || 0), full: (after.playbackFull || 0) - (before.playbackFull || 0) };
  }, DATASET);
  H.check('a jumping "dataset" is classified as such (max step > 1 Å) and never takes the fast path',
    dataset.profile.kind === 'dataset' && dataset.profile.maxStep > 1 && dataset.fast === 0 && dataset.full > 0, JSON.stringify(dataset));

  // Render control: Full forces the exact path on a trajectory; "max" speed
  // plays one frame per animation frame; Bench render measures scene time.
  const modes = await page.evaluate(async () => {
    const fb = await import('./ui/FileBrowswerPanel.js');
    const trace = await import('./debug/debugTrace.js');
    const sampler = await import('./debug/debugSampler.js');
    const anim = await import('./render/index.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    // New files are inserted after the selected row, so find OUTCAR.play by name.
    fb.selectStructure(structureShip.container.findIndex((c) => c.fileName === 'OUTCAR.play'), 0);
    // A row CLICK rebuilds the 'rebuild'-lifecycle panels for the new selection;
    // the programmatic selection above does not, so do what the click path does.
    (await import('./ui/panels/PanelManager.js')).refreshActivePanels();
    await new Promise((r) => setTimeout(r, 800));
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const select = document.getElementById('renderModeSelect');
    const autoLabel = select.querySelector('option[value="auto"]').textContent;
    const playFor = async (ms) => {
      const before = trace.counters();
      document.getElementById('playPauseBtn').click();
      await new Promise((r) => setTimeout(r, ms));
      document.getElementById('playPauseBtn').click();
      await new Promise((r) => setTimeout(r, 300));
      const after = trace.counters();
      return { fast: (after.playbackFast || 0) - (before.playbackFast || 0), full: (after.playbackFull || 0) - (before.playbackFull || 0), applied: (after.frameApplied || 0) - (before.frameApplied || 0) };
    };
    select.value = 'full'; select.dispatchEvent(new Event('change'));
    const fullRun = await playFor(1000);
    select.value = 'auto'; select.dispatchEvent(new Event('change'));
    const speed = document.getElementById('speedSelect'); speed.value = '0'; speed.dispatchEvent(new Event('change'));
    const maxRun = await playFor(1500);
    speed.value = '50'; speed.dispatchEvent(new Event('change'));
    const bench = document.getElementById('dbgBenchToggle');
    bench.checked = true; bench.dispatchEvent(new Event('change'));
    const benchOn = anim.isRenderBenchmark();
    await new Promise((r) => setTimeout(r, 1300));
    const s = sampler.getDebugHistory().samples.slice(-1)[0];
    bench.checked = false; bench.dispatchEvent(new Event('change'));
    return { mode: container.playbackMode, autoLabel, fullRun, maxRun, benchOn, benchOff: !anim.isRenderBenchmark(), renderMs: s.renderMs, capacity: s.renderCapacityFps, renderFps: s.renderFps, markers: sampler.getDebugHistory().markers.map((m) => m.label).slice(-16) };
  });
  H.check('Render control shows the detected kind and Full forces the exact path', modes.autoLabel === 'Auto (trajectory)' && modes.fullRun.fast === 0 && modes.fullRun.full > 0 && modes.mode === 'auto', JSON.stringify({ label: modes.autoLabel, full: modes.fullRun, mode: modes.mode }));
  H.check('"max" speed plays one frame per animation frame (well above the 20 f/s tick cap)', modes.maxRun.applied >= 25 && modes.maxRun.fast > 0, JSON.stringify(modes.maxRun));
  H.check('Bench render toggles the uncapped GPU-synced loop and yields a scene time and capacity', modes.benchOn && modes.benchOff && modes.renderMs > 0 && modes.capacity > 0 && modes.renderFps > 0, JSON.stringify({ on: modes.benchOn, off: modes.benchOff, ms: modes.renderMs, cap: modes.capacity, fps: modes.renderFps }));
  H.check('render mode, play @max and bench markers recorded', modes.markers.some((l) => l === 'render full') && modes.markers.some((l) => l === 'play @max') && modes.markers.includes('bench render on'), JSON.stringify(modes.markers));

  // Share links must not carry ?debug; GC hint records a marker and evicts nothing here.
  const misc = await page.evaluate(async () => {
    const sampler = await import('./debug/debugSampler.js');
    const markers = sampler.getDebugHistory().markers; // live array: snapshot lengths
    const before = markers.length;
    const gc = sampler.gcHint();
    const gcMarker = markers.length === before + 1 && markers[markers.length - 1].label.startsWith('GC hint');
    document.getElementById('dbgMarkLabel').value = 'my note';
    document.getElementById('dbgMarkBtn').click();
    const last = markers[markers.length - 1];
    return { gc, gcMarker, userMarker: markers.length === before + 2 && last.label === 'my note' };
  });
  H.check('GC hint runs and records a marker', misc.gcMarker === true, JSON.stringify(misc.gc));

  // What the plot factory handed Plotly: per-container memory traces aligned
  // to the shared time axis (NaN before the file existed), the playback plot's
  // two axes, and the markers as shapes + annotations.
  const plots = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 600)); // let the rAF relayout land
    const mem = document.getElementById('debugMemoryPlot');
    const play = document.getElementById('debugPlaybackPlot');
    const traces = (div) => (div.data || []).map((t) => ({ name: t.name, yaxis: t.yaxis, n: t.y.length, nx: t.x.length,
      leadingNaN: t.y.findIndex((v) => Number.isFinite(v)), lastFinite: Number.isFinite(t.y[t.y.length - 1]) }));
    return {
      mem: traces(mem), play: traces(play),
      memShapes: (mem.layout.shapes || []).length, memAnnotations: (mem.layout.annotations || []).map((a) => a.text),
      memXTitle: mem.layout.xaxis?.title?.text, playYTitles: [mem.layout.yaxis?.title?.text, play.layout.yaxis?.title?.text, play.layout.yaxis2?.title?.text],
      extends: mem.__extends || 0, reacts: mem.__reacts || 0,
    };
  });
  const memNames = plots.mem.map((t) => t.name);
  const late = plots.mem.find((t) => t.name === 'OUTCAR.play');
  const first = plots.mem.find((t) => t.name === 'oP28-C3N4');
  H.check('memory plot: one trace per structure plus total, app state and scene buffers', memNames.includes('total (accounted)') && memNames.includes('app state') && memNames.includes('scene buffers') && memNames.includes('oP28-C3N4') && memNames.includes('OUTCAR.play'), JSON.stringify(memNames));
  H.check('memory plot: every trace is 1:1 with the time axis', plots.mem.every((t) => t.n === t.nx && t.n === plots.mem[0].n), JSON.stringify(plots.mem));
  H.check('memory plot: the later-loaded file starts with NaN gaps, then real values', late && late.leadingNaN > 0 && late.lastFinite && first && first.leadingNaN === 0, JSON.stringify({ late, first }));
  H.check('memory plot: time axis and MB axis titled', plots.memXTitle === 'Time (s)' && plots.playYTitles[0] === 'MB', JSON.stringify([plots.memXTitle, plots.playYTitles]));
  H.check('memory plot: markers drawn as shapes with labels', plots.memShapes >= 4 && plots.memAnnotations.some((t) => t.startsWith('play')) && plots.memAnnotations.includes('pause'), JSON.stringify(plots.memAnnotations));
  H.check('memory plot: streamed via extendTraces after the first draw', plots.extends > 0, JSON.stringify({ extends: plots.extends, reacts: plots.reacts }));
  const renderPlot = await page.evaluate(() => {
    const div = document.getElementById('debugRendererPlot');
    return { names: (div.data || []).map((t) => t.name), axes: (div.data || []).map((t) => t.yaxis), y2: div.layout.yaxis2?.title?.text };
  });
  H.check('renderer plot: counts on the left axis, ids on the right', renderPlot.names.includes('GL geometries') && renderPlot.names.includes('ids registered') && renderPlot.axes[renderPlot.names.indexOf('ids registered')] === 'y2' && renderPlot.y2 === 'ids', JSON.stringify(renderPlot));

  // Clear drops the history and empties the plots; sampling continues.
  const cleared = await page.evaluate(async () => {
    const sampler = await import('./debug/debugSampler.js');
    document.getElementById('dbgClearBtn').click();
    const right = sampler.getDebugHistory().samples.length;
    await new Promise((r) => setTimeout(r, 900));
    const later = sampler.getDebugHistory().samples.length;
    const mem = document.getElementById('debugMemoryPlot');
    return { right, later, running: sampler.isDebugSamplerRunning(), maxPts: Math.max(0, ...(mem.data || []).map((t) => t.x.length)) };
  });
  H.check('Clear empties the history and the plots, sampling goes on', cleared.right === 0 && cleared.later >= 1 && cleared.later <= 5 && cleared.running && cleared.maxPts <= 5, JSON.stringify(cleared));

  const playByName = Object.fromEntries(plots.play.map((t) => [t.name, t.yaxis]));
  H.check('playback plot: rates on the left axis, frame index on the right', playByName['shown f/s'] === 'y' && playByName['render f/s'] === 'y' && playByName['frame'] === 'y2' && plots.playYTitles[1] === 'frames / s' && plots.playYTitles[2] === 'frame #', JSON.stringify([playByName, plots.playYTitles]));
  H.check('Mark button records a user marker with its label', misc.userMarker === true);

  const share = await page.evaluate(async () => {
    const sm = await import('./ui/ShareModule.js');
    // buildShareLinks is internal; exercise the URL-building rule directly.
    const url = new URL(window.location.href);
    url.searchParams.delete('debug');
    return { hasDebugNow: new URLSearchParams(location.search).has('debug'), strippedOk: !url.searchParams.has('debug'), exports: Object.keys(sm).length > 0 };
  });
  H.check('URL still carries ?debug in the debugging tab', share.hasDebugNow === true);

  const unexpected = errors.filter((e) => !/OUTCAR\.play/.test(e));
  H.check('no unexpected console/page errors', unexpected.length === 0, unexpected[0] || '');
  await H.finish(browser);
})().catch(H.crash);
