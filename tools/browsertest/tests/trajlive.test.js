// A live MD/relax run must pop the Trajectory panel up for live feedback even
// though the run's container starts with a single seed frame. available() ORs
// in isLivePlotActive(), and ensureTrajectoryPanelForLive() opens the panel.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Use the default single-structure scene loaded at startup: the Trajectory
  // panel is normally unavailable for it.
  const res = await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    const tp = await import('./ui/TrajectoryPanel.js');

    const panel = pm.getPanel('trajectory');
    const availableBefore = panel.def.available();

    // Start a live feed the way the MD Start handler does.
    tp.resetLivePlot();
    tp.ensureTrajectoryPanelForLive();
    await new Promise((r) => setTimeout(r, 120));
    const availableDuringLive = panel.def.available();
    const openDuringLive = !panel.closed && panel.el.isConnected;

    tp.feedLiveStep({ step: 1, temperatureK: 305, targetTemperatureK: 300, etotEv: -10, epotEv: -10.5, ekinEv: 0.5 });
    await new Promise((r) => setTimeout(r, 80));
    const host = document.getElementById('trajPlotHost');
    const plotShown = host ? getComputedStyle(host).display !== 'none' : false;

    // A burst of steps, as from an MD run at 50+ steps per second: the plot
    // takes them in batches, and once the run ends every step is on it, in order.
    for (let step = 2; step <= 51; step++) {
      tp.feedLiveStep({ step, temperatureK: 300 + step, targetTemperatureK: 300, etotEv: -10, epotEv: -10.5, ekinEv: 0.5 });
    }
    tp.endLiveFeed();
    const availableAfter = panel.def.available();
    let plottedSteps = null;
    for (let i = 0; i < 100 && !plottedSteps; i++) {
      const chart = document.querySelector('#trajPlotHost .js-plotly-plot');
      const trace = chart?.data?.find((t) => t.x && t.x.length >= 51);
      if (trace) plottedSteps = Array.from(trace.x);
      else await new Promise((r) => setTimeout(r, 50));
    }

    return { availableBefore, availableDuringLive, openDuringLive, plotShown, availableAfter, plottedSteps };
  });

  H.check('single structure: panel unavailable before a run', res.availableBefore === false, JSON.stringify(res));
  H.check('live run makes the panel available and opens it', res.availableDuringLive && res.openDuringLive, JSON.stringify(res));
  H.check('live plot is shown during the run', res.plotShown, JSON.stringify(res));
  H.check('panel reverts to unavailable after the run (single structure)', res.availableAfter === false, JSON.stringify(res));
  H.check('every step of a fast run reaches the plot, in order',
    JSON.stringify(res.plottedSteps) === JSON.stringify(Array.from({ length: 51 }, (_, i) => i + 1)), JSON.stringify(res.plottedSteps));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
