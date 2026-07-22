// Replay persistence: after a live MD run ends, the plotted series is stored on
// the container (container.plotSeries), so a panel REBUILD (as happens when the
// user interacts with the structure table) restores the plot instead of showing
// a blank canvas. Regression for the "numbers disappear on replay" bug.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Load a 2-frame trajectory so the Trajectory panel is available.
  const TRAJ = [
    '2',
    'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3',
    'Na 0 0 0', 'Cl 2 0 0',
    '2',
    'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3',
    'Na 0.1 0 0', 'Cl 2.1 0 0',
  ].join('\n');

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(traj, 'traj.xyz');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 200));

    const tp = await import('./ui/TrajectoryPanel.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const c = structureShip.container[fileBrowser.selectedRowIndex];

    // Simulate a live MD feed then its end.
    tp.resetLivePlot();
    for (let s = 1; s <= 5; s++) {
      tp.feedLiveStep({ step: s, temperatureK: 300 + s, targetTemperatureK: 300, etotEv: -10 + s * 0.01, epotEv: -10.5, ekinEv: 0.5 });
    }
    // A live run stores the series on the container; emulate that here.
    c.plotSeries = {
      temperatureK: [301, 302, 303, 304, 305],
      targetTemperatureK: [300, 300, 300, 300, 300],
      etotEv: [-9.99, -9.98, -9.97, -9.96, -9.95],
    };
    tp.endLiveFeed();

    // Now REBUILD the panel body (what a structure-table interaction triggers).
    tp.removeTrajectoryPlayer();
    tp.addTrajectoryPlayer('cvPanelBody-trajectory');

    // Plotly redraws async — wait for the restored chart to carry its traces.
    let chart = null;
    for (let i = 0; i < 80; i++) {
      chart = document.querySelector('#trajPlotHost .js-plotly-plot');
      if (chart && chart.data && chart.data.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const host = document.getElementById('trajPlotHost');
    const btn = host ? host.querySelector('.trajPlotComputeBtn') : null;
    return {
      hostShown: host ? getComputedStyle(host).display !== 'none' : false,
      chartPresent: !!chart,
      traceCount: chart?.data?.length ?? 0,
      // With a series already on the container, the compute action must be
      // hidden so a click can't wipe the streamed temperature/energy.
      computeBtnHidden: btn ? getComputedStyle(btn).display === 'none' : true,
    };
  }, TRAJ);

  H.check('after run+rebuild the plot is restored from container.plotSeries (not blank)',
    res.hostShown && res.chartPresent && res.traceCount >= 1, JSON.stringify(res));
  H.check('compute-stats action hidden when a series already exists',
    res.computeBtnHidden, JSON.stringify(res));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
