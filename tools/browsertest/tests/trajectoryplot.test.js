// Unified Trajectory panel: the MD Monitor plot is folded into the Trajectory
// panel. Barebone (no per-frame data) => plot hidden, no compute button. A
// loaded trajectory with forces => "Compute step stats" builds a mean-force
// series and the plot shows. A live MD feed => plot shows, compute button
// hides. The old standalone MD Monitor (#mdCanvas / 'mdMonitor') must be gone.
'use strict';
const H = require('../harness');

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
    const btn = document.getElementById('computeStepStatsBtn');
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
  H.check('2-frame traj with forces: plot host present but folded, compute button shown',
    built.frames === 2 && built.hasForces && built.hostPresent
      && built.hostHiddenInitially === true && built.btnPresent && built.btnVisible,
    JSON.stringify(built));

  // Click "Compute step stats" -> mean-force series built, plot expands.
  await H.clickById(page, 'computeStepStatsBtn');
  const computed = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 500));
    const host = document.getElementById('trajPlotHost');
    const canvas = host ? host.querySelector('canvas') : null;
    return {
      hostShown: host ? getComputedStyle(host).display !== 'none' : false,
      canvasPresent: !!canvas,
    };
  });
  H.check('after Compute step stats: plot region shown with a canvas',
    computed.hostShown && computed.canvasPresent, JSON.stringify(computed));

  // --- Live MD feed bridge: plot shows, compute button hides -----------------------
  const live = await page.evaluate(async () => {
    const tp = await import('./ui/TrajectoryPanel.js');
    tp.resetLivePlot();
    tp.ensureTrajectoryPanelForLive();
    for (let step = 1; step <= 5; step++) {
      tp.feedLiveStep({
        step,
        temperatureK: 300 + step * 5,
        targetTemperatureK: 300,
        etotEv: -10 + step * 0.01,
        epotEv: -10.5 + step * 0.01,
        ekinEv: 0.05,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
    const host = document.getElementById('trajPlotHost');
    const btn = document.getElementById('computeStepStatsBtn');
    return {
      hostShown: host ? getComputedStyle(host).display !== 'none' : false,
      btnHidden: btn ? getComputedStyle(btn).display === 'none' : true,
    };
  });
  H.check('live MD feed: plot shown, compute button hidden during run',
    live.hostShown && live.btnHidden, JSON.stringify(live));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
