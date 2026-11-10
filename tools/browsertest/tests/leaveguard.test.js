// Reload guard (docs/ui/LeaveGuard.js):
//   - with only the start-up demo loaded nothing is guarded: Ctrl+R and
//     leaving the page go through
//   - once a structure is loaded, Ctrl+R / Cmd+R / F5 / Ctrl+Shift+R are
//     stopped and answered with the "Reload CrysViz?" dialog, which counts the
//     structures at stake; Stay (the focused default) and Escape keep the page
//   - leaving by other means (beforeunload) asks the browser to prompt
//   - "Reload and lose them" reloads (no second, browser prompt)
//   - Settings ▸ Warnings ▸ Disable reload warning switches it all off
'use strict';
const H = require('../harness');

/** Dispatch a reload key the way the browser delivers it to the page and
 *  report whether the app stopped it. */
async function pressReloadKey(page, init) {
  return page.evaluate((init) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, init);
}

async function beforeUnloadPrevented(page) {
  return page.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

async function dialog(page) {
  return page.evaluate(() => {
    const m = document.getElementById('confirmModal');
    return {
      open: !!m && !m.hidden,
      title: document.getElementById('confirmModalTitle')?.textContent || '',
      message: document.getElementById('confirmModalMessage')?.textContent || '',
      focused: document.activeElement?.id || '',
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.setPanelPref('hideLeaveWarning', false); // the harness switches it off for the rest of the suite
  });

  // ---- only the demo: nothing to lose ---------------------------------------
  H.check('only the start-up demo: Ctrl+R goes through', !(await pressReloadKey(page, { key: 'r', code: 'KeyR', ctrlKey: true })));
  H.check('only the start-up demo: leaving is not held up', !(await beforeUnloadPrevented(page)));

  // ---- a structure of the user's ---------------------------------------------
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await page.evaluate(() => { window.__leaveGuardMarker = 1; });
  H.check('Ctrl+R is stopped', await pressReloadKey(page, { key: 'r', code: 'KeyR', ctrlKey: true }));
  await page.waitForTimeout(200);
  let d = await dialog(page);
  H.check('...and answered with the CrysViz dialog, Stay focused',
    d.open && d.title === 'Reload CrysViz?' && /The loaded structure will be lost/.test(d.message) && d.focused === 'leaveGuardStay',
    JSON.stringify(d));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  d = await dialog(page);
  H.check('Escape keeps the page', !d.open && await page.evaluate(() => window.__leaveGuardMarker === 1));

  for (const [name, init] of [
    ['Cmd+R', { key: 'r', code: 'KeyR', metaKey: true }],
    ['F5', { key: 'F5', code: 'F5' }],
    ['Ctrl+Shift+R', { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }],
  ]) {
    const stopped = await pressReloadKey(page, init);
    await page.waitForTimeout(150);
    d = await dialog(page);
    H.check(`${name} is stopped and asks too`, stopped && d.open, JSON.stringify(d));
    await page.click('#leaveGuardStay');
    await page.waitForTimeout(150);
  }
  H.check('Stay keeps the page', await page.evaluate(() => window.__leaveGuardMarker === 1));
  H.check('other ways of leaving ask the browser to prompt', await beforeUnloadPrevented(page));

  // A second structure: the count is in the message.
  await H.loadDefaultStructure(page, 'defaultPOSCAR5', 'Si');
  await pressReloadKey(page, { key: 'r', code: 'KeyR', ctrlKey: true });
  await page.waitForTimeout(200);
  d = await dialog(page);
  H.check('the dialog counts the structures at stake', /All 2 loaded structures will be lost/.test(d.message), d.message);

  // ---- Reload and lose them ----------------------------------------------------
  page.on('dialog', (dlg) => { H.check('no browser prompt after choosing to reload', false, dlg.type()); dlg.accept(); });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
    page.click('#leaveGuardReload'),
  ]);
  await page.waitForTimeout(5000);
  const after = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    return { marker: window.__leaveGuardMarker, containers: structureShip.container.length };
  });
  H.check('"Reload and lose them" reloads the page', after.marker === undefined && after.containers === 1, JSON.stringify(after));

  // ---- switched off in Settings --------------------------------------------------
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  const toggle = await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('settings');
    await new Promise((r) => setTimeout(r, 200));
    const cb = /** @type {HTMLInputElement} */ (document.getElementById('disableLeaveWarningToggle'));
    if (!cb) return null;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return pm.getPanelPref('hideLeaveWarning');
  });
  H.check('Settings ▸ Disable reload warning sets the preference', toggle === true, String(toggle));
  H.check('...after which Ctrl+R goes through', !(await pressReloadKey(page, { key: 'r', code: 'KeyR', ctrlKey: true })));
  H.check('...and leaving is not held up', !(await beforeUnloadPrevented(page)));

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
