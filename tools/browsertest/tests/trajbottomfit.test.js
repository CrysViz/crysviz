// The Trajectory panel is the live MD/relax monitor, so (a) it defaults to the
// left dock directly ABOVE Atomistic rather than down among the feature
// panels, and (b) once the user drags it into the right dock its plot must
// fill the pane instead of standing at the fixed 260px .trajPlot height.
// (b) is what broke docked to the BOTTOM: a short, wide pane left the chart
// overflowing and the panel body scrolling.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const TRAJ = [
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3', 'Na 0 0 0', 'Cl 2 0 0',
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3', 'Na 0.1 0 0', 'Cl 2.1 0 0',
  ].join('\n');

  const res = await page.evaluate(async (traj) => {
    const cv = await import('./core/crystal-viewer.js');
    const pm = await import('./ui/panels/PanelManager.js');
    const rd = await import('./ui/panels/RightDock.js');
    const tp = await import('./ui/TrajectoryPanel.js');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await cv.loadStructure(traj, 'multi.xyz');
    await sleep(150);

    const panel = pm.getPanel('trajectory');
    // The registered defaults, independent of whatever layout this profile has
    // persisted (registerPanel prefers the stored dock, which is the whole
    // point of "if the user moves it, keep it where they want").
    const defaults = panel.def.defaults || {};
    const defaultDock = defaults.dock;
    const defaultOrder = defaults.order;
    const atomisticOrder = (pm.getPanel('backend').def.defaults || {}).order;
    const filesOrder = (pm.getPanel('files').def.defaults || {}).order;

    // The rendered left-dock order, which is what the user actually sees.
    const leftIds = Array.from(document.querySelectorAll('#ui .cv-panel.cv-docked'))
      .map((el) => el.dataset.panelId);

    // Open it in the dock and give it a plot to size: the live feed is what
    // makes the host visible (it starts display:none until there's data).
    panel.dock = 'right';
    pm.openPanel('trajectory');
    tp.feedLiveStep({ step: 0, energy: -1.0 });
    tp.feedLiveStep({ step: 1, energy: -1.2 });
    await sleep(150);

    const host = document.getElementById('trajPlotHost');
    const plot = host && host.querySelector('.trajPlot');
    const paneBody = document.getElementById('splitPaneBody');

    function measure() {
      const paneH = paneBody.getBoundingClientRect().height;
      const paneW = paneBody.getBoundingClientRect().width;
      const r = plot.getBoundingClientRect();
      const chart = plot.querySelector('.trajPlotChart');
      return {
        paneH,
        paneW,
        plotH: r.height,
        plotW: r.width,
        chartH: chart ? chart.getBoundingClientRect().height : 0,
      };
    }

    rd.setRightDockSide('bottom');
    await sleep(250);
    const bottom = measure();

    rd.setRightDockSide('right');
    await sleep(250);
    const right = measure();

    rd.setRightDockSide('bottom');
    await sleep(250);

    return {
      defaultDock,
      defaultOrder,
      atomisticOrder,
      filesOrder,
      leftIds,
      hostVisible: !!host && host.style.display !== 'none',
      bottom,
      right,
    };
  }, TRAJ);

  H.check('Trajectory panel defaults to the LEFT dock',
    res.defaultDock === 'left', `defaults.dock=${res.defaultDock}`);

  H.check('its default order puts it above Atomistic but below Files',
    res.filesOrder < res.defaultOrder && res.defaultOrder < res.atomisticOrder,
    `files=${res.filesOrder} traj=${res.defaultOrder} atomistic=${res.atomisticOrder}`);

  const iTraj = res.leftIds.indexOf('trajectory');
  const iBackend = res.leftIds.indexOf('backend');
  H.check('and it renders above Atomistic in the left column',
    iTraj >= 0 && iBackend >= 0 && iTraj < iBackend, res.leftIds.join(','));

  H.check('live plot host is visible', res.hostVisible, JSON.stringify(res));

  const b = res.bottom;
  const r = res.right;

  // Bottom dock: the plot must fit inside the pane, not overflow it.
  H.check('bottom-docked plot fits the pane height',
    b.plotH > 0 && b.plotH <= b.paneH + 1, JSON.stringify(b));

  // ...and it must take the pane's full width (minus the body's 10px padding
  // each side plus the .panelBody's 12px each side = 44px of chrome).
  H.check('bottom-docked plot uses the full pane width',
    b.plotW >= b.paneW - 50, JSON.stringify(b));

  // The fixed 260px is gone: the height now tracks the pane, so a short bottom
  // pane and a tall right pane must not produce the same plot height.
  H.check('plot height tracks the dock side (no fixed 260px)',
    Math.abs(b.plotH - r.plotH) > 20, `bottom=${b.plotH} right=${r.plotH}`);

  H.check('right-docked plot also fits its pane',
    r.plotH > 0 && r.plotH <= r.paneH + 1, JSON.stringify(r));

  H.check('the chart itself, not just the frame, gets the height',
    b.chartH > 60 && r.chartH > 60, `bottom=${b.chartH} right=${r.chartH}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
