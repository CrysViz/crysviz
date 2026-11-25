// Switching multi-threaded PET-MAD on or off reloads the page (host/coi.js),
// which loses everything held only in this page. Both switches — "multi-
// threaded" in the Atomistic window's PET-MAD controls and "Enable
// multi-threading" in Debug ▸ Benchmark — ask first (ui/LeaveGuard.js
// confirmAppReload):
//   - asked even with only the start-up demo (runs and results are at stake)
//   - a loaded structure is named, with the way to keep it
//   - Cancel (the focused default) and Escape change nothing: box unticked,
//     setting not stored, no reload
//   - Reload reloads, with no second browser prompt, and stores the setting
//   - asked even with Settings ▸ Warnings ▸ Disable reload warning on (that
//     switch is for reloads by accident; this one is a click)
'use strict';
const H = require('../harness');

const FLAG = 'crysviz.multithread';

async function dialog(page) {
  return page.evaluate(() => {
    const m = document.getElementById('confirmModal');
    return {
      open: !!m && !m.hidden,
      title: document.getElementById('confirmModalTitle')?.textContent || '',
      message: document.getElementById('confirmModalMessage')?.textContent || '',
      detail: document.getElementById('confirmModalDetail')?.textContent || '',
      focused: document.activeElement?.id || '',
    };
  });
}

/** Open the Atomistic window on PET-MAD and report its multi-threaded box. */
async function openMultithreadBox(page) {
  return page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'mlip';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 300));
    const box = document.querySelector('#BackendPotentialSelector [data-role="mlip-multithread"]');
    box?.scrollIntoView({ block: 'center' });
    return box ? { checked: box.checked, disabled: box.disabled } : null;
  });
}

async function state(page) {
  return page.evaluate((flag) => {
    const box = document.querySelector('#BackendPotentialSelector [data-role="mlip-multithread"]');
    const status = document.querySelector('#BackendPotentialSelector [data-role="mlip-status"]');
    return {
      checked: box?.checked, disabled: box?.disabled, flag: localStorage.getItem(flag),
      marker: window.__mtMarker, status: status?.textContent || '',
    };
  }, FLAG);
}

const clickBox = (page) => page.evaluate(() => {
  document.querySelector('#BackendPotentialSelector [data-role="mlip-multithread"]').click();
});

(async () => {
  // ?debug: the Debug window (and its Benchmark tab) is offered; reloads keep it.
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  const url = new URL(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html');
  url.searchParams.set('debug', '');
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.setPanelPref('hideLeaveWarning', false); // the harness switches it off for the rest of the suite
    window.__mtMarker = 1;
  });
  let promptSeen = null;
  page.on('dialog', (dlg) => { promptSeen = dlg.type(); dlg.dismiss().catch(() => {}); });

  const box = await openMultithreadBox(page);
  H.check('the multi-threaded box is offered here (secure context, not isolated)',
    box && !box.checked && !box.disabled, JSON.stringify(box));

  // ---- only the start-up demo: asked anyway ----------------------------------
  await clickBox(page);
  await page.waitForTimeout(300);
  let d = await dialog(page);
  H.check('turning it on asks first, Cancel focused',
    d.open && d.title === 'Reload CrysViz?' && /^Turning multi-threading on reloads CrysViz/.test(d.message)
      && d.focused === 'appReloadCancel', JSON.stringify(d));
  H.check('...naming running calculations and results not downloaded, no structures',
    /still running/.test(d.detail) && /results not downloaded/.test(d.detail) && !/loaded structure/.test(d.detail), d.detail);
  H.check('...with the box locked while asking', (await state(page)).disabled === true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  let s = await state(page);
  H.check('Escape changes nothing: box unticked and free, setting not stored, no reload',
    !(await dialog(page)).open && s.checked === false && s.disabled === false && s.flag === null && s.marker === 1
      && !/reloading/.test(s.status), JSON.stringify(s));

  // ---- a structure of the user's -----------------------------------------------
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await openMultithreadBox(page);
  await clickBox(page);
  await page.waitForTimeout(300);
  d = await dialog(page);
  H.check('with a structure loaded the question names it and how to keep it',
    d.open && /the loaded structure/.test(d.detail) && /Files ▸ Download/.test(d.detail), d.detail);
  await page.click('#appReloadCancel');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('Cancel changes nothing either',
    s.checked === false && s.disabled === false && s.flag === null && s.marker === 1, JSON.stringify(s));

  // ---- Reload ---------------------------------------------------------------------
  await clickBox(page);
  await page.waitForTimeout(300);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
    page.click('#appReloadOk'),
  ]);
  await page.waitForTimeout(5000);
  H.check('Reload goes through with no second, browser prompt', promptSeen === null, String(promptSeen));
  await openMultithreadBox(page);
  s = await state(page);
  H.check('...reloads the page and stores the setting', s.marker === undefined && s.flag === '1' && s.checked === true,
    JSON.stringify(s));

  // ---- turning it off asks too ------------------------------------------------------
  await clickBox(page);
  await page.waitForTimeout(300);
  d = await dialog(page);
  H.check('turning it off asks too', d.open && /^Turning multi-threading off reloads CrysViz/.test(d.message), d.message);
  await page.click('#appReloadCancel');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('...and Cancel leaves it on', s.checked === true && s.flag === '1', JSON.stringify(s));

  // ---- Debug ▸ Benchmark's button asks the same question ------------------------------
  const bench = await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('debug');
    await new Promise((r) => setTimeout(r, 300));
    const body = document.getElementById('cvPanelBody-debug');
    body?.querySelector('[data-dbg-tab="bench"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const btn = body?.querySelector('[data-dbg-pane="bench"] [data-role="isolate"]');
    if (!btn) return null;
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return { on: btn.dataset.on, label: btn.textContent.trim() };
  });
  d = await dialog(page);
  // Whether the page came back isolated depends on the browser (credentialless
  // COEP); the button turns multi-threading on or off accordingly.
  H.check('the Benchmark tab\'s multi-threading button asks first',
    bench && d.open && /^Turning multi-threading (on|off) reloads CrysViz/.test(d.message), JSON.stringify({ bench, d }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const after = await page.evaluate((flag) => {
    const btn = document.querySelector('#cvPanelBody-debug [data-dbg-pane="bench"] [data-role="isolate"]');
    return { disabled: btn?.disabled, flag: localStorage.getItem(flag) };
  }, FLAG);
  H.check('...and Escape there changes nothing', after.disabled === false && after.flag === '1', JSON.stringify(after));

  // ---- asked even with Settings ▸ Disable reload warning on ------------------------------
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.setPanelPref('hideLeaveWarning', true);
  });
  await openMultithreadBox(page);
  await clickBox(page);
  await page.waitForTimeout(300);
  d = await dialog(page);
  H.check('with reload warnings switched off in Settings it still asks', d.open && d.focused === 'appReloadCancel',
    JSON.stringify(d));
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
    page.click('#appReloadOk'),
  ]);
  await page.waitForTimeout(5000);
  s = await page.evaluate((flag) => localStorage.getItem(flag), FLAG);
  H.check('...and Reload then turns it off', s === null, String(s));
  H.check('no browser prompt at any point', promptSeen === null, String(promptSeen));

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
