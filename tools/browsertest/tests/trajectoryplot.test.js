// Unified Trajectory panel with the Plotly-backed plot. Barebone (no per-frame
// data) => plot hidden, no compute action. A loaded trajectory with forces =>
// the in-plot "Compute step stats" action builds a mean-force series and the
// Plotly chart shows. A live MD feed => chart shows (temperature/energy on
// separate axes), compute action hides. The old standalone MD Monitor
// (#mdCanvas / 'mdMonitor') must be gone.
'use strict';
const H = require('../harness');

// Poll until the Plotly chart inside #trajPlotHost has drawn its traces (Plotly
// loads lazily from the shared loader, so the draw is async).
async function waitForChart(page, minTraces = 1) {
  return page.evaluate(async (min) => {
    for (let i = 0; i < 80; i++) {
      const chart = document.querySelector('#trajPlotHost .js-plotly-plot');
      if (chart && chart.data && chart.data.length >= min) {
        return { present: true, traceCount: chart.data.length, names: chart.data.map((t) => t.name), hasY2: !!chart.layout?.yaxis2 };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const chart = document.querySelector('#trajPlotHost .js-plotly-plot');
    return { present: !!chart, traceCount: chart?.data?.length ?? 0, names: (chart?.data || []).map((t) => t.name), hasY2: !!chart?.layout?.yaxis2 };
  }, minTraces);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // The old MD Monitor panel must no longer exist anywhere.
  const noMonitor = await page.evaluate(async () => {
    const md = await import('./atomistic/MD.js');
    return {
      exportGone: typeof md.createMDMonitorPanel === 'undefined',
      canvasGone: !document.getElementById('mdCanvas'),
    };
  });
  H.check('MD Monitor retired (no createMDMonitorPanel export, no #mdCanvas)',
    noMonitor.exportGone && noMonitor.canvasGone, JSON.stringify(noMonitor));

  // --- Load a 2-frame extxyz trajectory WITH forces --------------------------------
  const TRAJ = [
    '3',
    'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3:forces:R:3',
    'Na 0.0 0.0 0.0  0.10 0.00 0.00',
    'Cl 2.0 0.0 0.0  -0.20 0.05 0.00',
    'Cl 0.0 2.0 0.0  0.00 -0.10 0.30',
    '3',
    'Lattice="4.0 0.0 0.0 0.0 4.0 0.0 0.0 0.0 4.0" Properties=species:S:1:pos:R:3:forces:R:3',
    'Na 0.1 0.0 0.0  0.30 0.00 0.00',
    'Cl 2.1 0.0 0.0  -0.40 0.15 0.00',
    'Cl 0.1 2.0 0.0  0.00 -0.20 0.50',
  ].join('\n');
  await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(traj, 'traj.xyz');
  }, TRAJ);
  await page.waitForTimeout(1500);

  // Open the Trajectory panel so its DOM (controls + plot host) is built.
  const built = await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 300));
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const host = document.getElementById('trajPlotHost');
    const btn = host ? host.querySelector('.trajPlotComputeBtn') : null;
    const hasForces = container.structures.some((s) => s.forces && s.forces.length > 0);
    return {
      frames: container.structures.length,
      hasForces,
      hostPresent: !!host,
      hostHiddenInitially: host ? getComputedStyle(host).display === 'none' : null,
      btnPresent: !!btn,
      btnVisible: btn ? getComputedStyle(btn).display !== 'none' : false,
    };
  });
  H.check('2-frame traj with forces: plot host present but folded, compute action shown',
    built.frames === 2 && built.hasForces && built.hostPresent
      && built.hostHiddenInitially === true && built.btnPresent && built.btnVisible,
    JSON.stringify(built));

  // Click the in-plot "Compute step stats" -> mean-force series built, chart shows.
  await page.evaluate(() => document.querySelector('#trajPlotHost .trajPlotComputeBtn')?.click());
  const computedChart = await waitForChart(page, 1);
  const shown = await page.evaluate(() => {
    const host = document.getElementById('trajPlotHost');
    return host ? getComputedStyle(host).display !== 'none' : false;
  });
  H.check('after Compute step stats: Plotly chart shown with a mean-force trace',
    shown && computedChart.present && computedChart.names.some((n) => /\|F\|/.test(n)),
    JSON.stringify({ shown, computedChart }));

  // The compute action hides once a series exists (a click could wipe it).
  const btnAfter = await page.evaluate(() => {
    const btn = document.querySelector('#trajPlotHost .trajPlotComputeBtn');
    return btn ? getComputedStyle(btn).display === 'none' : true;
  });
  H.check('compute action hides after a series has been computed', btnAfter, String(btnAfter));

  // --- Live MD feed bridge: chart shows (dual-axis), compute action hides -----------
  const live = await page.evaluate(async () => {
    const tp = await import('./ui/TrajectoryPanel.js');
    tp.resetLivePlot();
    tp.ensureTrajectoryPanelForLive();
    for (let step = 1; step <= 6; step++) {
      tp.feedLiveStep({
        step,
        temperatureK: 300 + step * 5,
        targetTemperatureK: 300,
        etotEv: -10 + step * 0.01,
        epotEv: -10.5 + step * 0.01,
        ekinEv: 0.05,
      });
    }
    const host = document.getElementById('trajPlotHost');
    const btn = host ? host.querySelector('.trajPlotComputeBtn') : null;
    return {
      hostShown: host ? getComputedStyle(host).display !== 'none' : false,
      btnHidden: btn ? getComputedStyle(btn).display === 'none' : true,
    };
  });
  const liveChart = await waitForChart(page, 2);
  H.check('live MD feed: chart shown, compute action hidden during run',
    live.hostShown && live.btnHidden, JSON.stringify(live));
  H.check('live chart puts temperature and energy on separate axes',
    liveChart.present && liveChart.hasY2, JSON.stringify(liveChart));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
