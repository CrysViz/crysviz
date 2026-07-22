// Shift+Alt+A opens the Atomistic (backend) panel — the Windows-tier shortcut
// added alongside Files/Features/Trajectory/... The panel had no shortcut before.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(400);

  const res = await page.evaluate(async () => {
    const { getPanel, closePanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel('backend');
    const registered = !!panel;
    const available = !!panel?.available;

    // Close it first so the shortcut's effect is unambiguous.
    if (panel && !panel.closed) closePanel('backend');
    await new Promise((r) => setTimeout(r, 120));
    const closedBefore = getPanel('backend')?.closed === true;

    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyA', key: 'A', shiftKey: true, altKey: true, bubbles: true,
    }));
    await new Promise((r) => setTimeout(r, 250));
    const openAfter = getPanel('backend')?.closed === false;

    // A different Shift+Alt letter must NOT open it (sanity that A is the binding).
    if (!getPanel('backend')?.closed) closePanel('backend');
    await new Promise((r) => setTimeout(r, 120));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyW', key: 'W', shiftKey: true, altKey: true, bubbles: true,
    }));
    await new Promise((r) => setTimeout(r, 200));
    const stillClosedForOtherKey = getPanel('backend')?.closed === true;

    return { registered, available, closedBefore, openAfter, stillClosedForOtherKey };
  });

  H.check('Atomistic (backend) panel is registered and available', res.registered && res.available, JSON.stringify(res));
  H.check('panel is closed before the shortcut', res.closedBefore, JSON.stringify(res));
  H.check('Shift+Alt+A opens the Atomistic panel', res.openAfter, JSON.stringify(res));
  H.check('an unrelated Shift+Alt key does not open it', res.stillClosedForOtherKey, JSON.stringify(res));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
