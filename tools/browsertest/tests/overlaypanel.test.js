// Multi-Structure Overlay panel (ui/OverlayPanel.js) — had zero standing
// coverage before this test. Drives the real flow: check a second structure's
// row in the Files list, flip "Enable Overlay" on, and confirm the Overlay
// tab's table reflects fileBrowser.overlayEntries (ui/FileBrowswerPanel.js's
// syncOverlayFromCheckboxes, the single place that reconciles checkboxes into
// that list — the collision this file's own comments warn about: Overlay and
// the classic Comparison tab both drive the same checkboxes).
'use strict';
const H = require('../harness');

function overlayBody() {
  return document.getElementById('cvPanelBody-comparison');
}

async function openOverlayTab(page) {
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('comparison').expand();
  });
  await page.waitForTimeout(200);
  await page.click('#cvPanelBody-comparison button[data-tab="overlay"]');
  await page.waitForTimeout(200);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // the app auto-loads its own default row 1 (Si); this is YBCO, row 2

  // A third structure -> row 3, so there is something to overlay.
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const d = await import('./defaults/structure_defaults.js');
    await cv.loadStructure(d.defaultPOSCAR, 'Overlay Structure');
  });
  await page.waitForTimeout(1000);

  const rowCount = await page.evaluate(() =>
    document.querySelectorAll('#objectTable tbody tr').length);
  H.check('three structures loaded (three rows in the Files table)', rowCount === 3, String(rowCount));

  await openOverlayTab(page);

  // --- empty state: nothing checked yet, overlay mode off -------------------
  let s = await page.evaluate(() => ({
    emptyRow: !!document.querySelector('#cvPanelBody-comparison .cv-overlay-table-empty'),
    overlayModeOn: undefined, // filled below
  }));
  H.check('Overlay tab starts with the "check a row" empty state', s.emptyRow, JSON.stringify(s));

  // --- toggle "Enable Overlay" on: mutually exclusive with Comparison -------
  await page.evaluate(() => {
    document.getElementById('enableOverlayToggle').click();
  });
  await page.waitForTimeout(200);
  let flags = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { overlayModeOn: general.overlayModeOn, compareModeOn: general.compareModeOn };
  });
  H.check('Enable Overlay turns overlay mode on and forces Comparison off',
    flags.overlayModeOn === true && flags.compareModeOn === false, JSON.stringify(flags));

  let err = await page.evaluate(() => {
    const el = document.getElementById('overlayErrorField');
    return { text: el?.textContent, visible: el && getComputedStyle(el).display !== 'none' };
  });
  H.check('overlay-on-but-nothing-checked shows the "check a structure" error',
    err.visible && /check one or more structures/i.test(err.text), JSON.stringify(err));

  // --- check the new row's checkbox: a real overlay entry appears -----------
  await page.evaluate(() => {
    const cb = document.querySelector('#objectTable tbody tr:nth-child(3) input[type="checkbox"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  let entries = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.overlayEntries.map((e) => ({ opacity: e.opacity, showBonds: e.showBonds }));
  });
  H.check('checking a row creates one overlay entry, default 0.6 opacity, bonds on',
    entries.length === 1 && entries[0].opacity === 0.6 && entries[0].showBonds === true,
    JSON.stringify(entries));

  err = await page.evaluate(() => {
    const el = document.getElementById('overlayErrorField');
    return { visible: el && getComputedStyle(el).display !== 'none' };
  });
  H.check('error clears once a structure is overlaid', err.visible === false, JSON.stringify(err));

  let row = await page.evaluate(() => {
    const rowEl = document.querySelector('#cvPanelBody-comparison .cv-overlay-row');
    return {
      exists: !!rowEl,
      name: rowEl?.querySelector('.cv-overlay-entry-name')?.textContent,
      opacityValue: rowEl?.querySelector('input[type="range"]')?.value,
    };
  });
  H.check('Overlay table shows the entry with its display name and opacity slider',
    row.exists && row.name === 'Overlay Structure' && row.opacityValue === '0.6', JSON.stringify(row));

  // --- interacting with the row's own controls updates the entry live -------
  await page.evaluate(() => {
    const rowEl = document.querySelector('#cvPanelBody-comparison .cv-overlay-row');
    const bondsCb = rowEl.querySelector('.cv-overlay-bonds-label input[type="checkbox"]');
    bondsCb.checked = false;
    bondsCb.dispatchEvent(new Event('change', { bubbles: true }));
    const opacityInput = rowEl.querySelector('input[type="range"]');
    opacityInput.value = '0.25';
    opacityInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  entries = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.overlayEntries.map((e) => ({ opacity: e.opacity, showBonds: e.showBonds }));
  });
  H.check('per-row Bonds checkbox and opacity slider write straight into the entry',
    entries.length === 1 && entries[0].showBonds === false && Math.abs(entries[0].opacity - 0.25) < 0.001,
    JSON.stringify(entries));

  // --- removing via the table's own ✕ un-checks the SAME checkbox -----------
  // (the file-browser checkboxes are the single source of truth, not this
  // panel's own list — removeOverlayEntry must reach back and uncheck it).
  await page.evaluate(() => {
    document.querySelector('#cvPanelBody-comparison .cv-overlay-remove-btn').click();
  });
  await page.waitForTimeout(200);
  const afterRemove = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const cb = document.querySelector('#objectTable tbody tr:nth-child(3) input[type="checkbox"]');
    return { entries: fileBrowser.overlayEntries.length, rowChecked: cb.checked };
  });
  H.check('removing the entry from the table un-checks the file-browser row too',
    afterRemove.entries === 0 && afterRemove.rowChecked === false, JSON.stringify(afterRemove));

  // --- main-structure opacity slider drives general.mainOpacity -------------
  await page.evaluate(() => {
    const input = document.getElementById('overlayMainOpacitySlider');
    input.value = '0.4';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const mainOpacity = await page.evaluate(async () => (await import('./state/store.js')).general.mainOpacity);
  H.check('main structure opacity slider updates general.mainOpacity', mainOpacity === 0.4, String(mainOpacity));

  // --- real CSS applied: the pill toggle switch is styled, not a bare checkbox
  // (the shared 46x24 .toggle_switch base — the panel's own 50x24 variant was
  // folded into it by the toggle unification)
  const toggleCss = await page.evaluate(() => {
    const sw = document.getElementById('enableOverlayToggle').closest('.toggle_switch');
    const r = sw.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  H.check('the overlay toggle switch is the styled 46x24 pill, not a native checkbox',
    Math.round(toggleCss.width) === 46 && Math.round(toggleCss.height) === 24, JSON.stringify(toggleCss));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
