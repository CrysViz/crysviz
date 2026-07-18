// A right-docked panel that becomes unavailable (e.g. the user selects a
// single-structure row) must REOPEN when its feature returns. Previously it was
// closed out of the dock and stayed closed until a full UI reset. This drives
// the availability toggle directly on the Trajectory panel.
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
    await cv.loadStructure(traj, 'multi.xyz');
    await new Promise((r) => setTimeout(r, 150));

    const panel = pm.getPanel('trajectory');
    // Dock it on the right and open it there.
    panel.dock = 'right';
    pm.openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 100));
    const openedRightDocked = !panel.closed && panel.dock === 'right';

    // Override availability to simulate selecting a non-trajectory structure.
    const origAvail = panel.def.available;
    let avail = true;
    panel.def.available = () => avail;

    avail = false;
    pm.refreshActivePanels();
    await new Promise((r) => setTimeout(r, 80));
    const closedWhenUnavailable = panel.closed === true;

    avail = true;
    pm.refreshActivePanels();
    await new Promise((r) => setTimeout(r, 120));
    const reopened = panel.closed === false && panel.el.isConnected && panel.dock === 'right';

    panel.def.available = origAvail;
    return { openedRightDocked, closedWhenUnavailable, reopened };
  }, TRAJ);

  H.check('panel opens right-docked', res.openedRightDocked, JSON.stringify(res));
  H.check('panel auto-closes when its feature goes unavailable', res.closedWhenUnavailable, JSON.stringify(res));
  H.check('panel REOPENS right-docked when the feature returns', res.reopened, JSON.stringify(res));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
