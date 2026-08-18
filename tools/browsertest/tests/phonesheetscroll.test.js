// A phone Structure sheet must be a SINGLE scroll surface. A tall panel (the
// individual-atom list after a 3x3x3 supercell) lives in a .collapsible-content
// that carries its own capped max-height + overflow-y:auto, so without the
// side-dock override it scrolled INSIDE the panel that already scrolls — two
// nested scrollbars in the sheet. This has regressed more than once; assert the
// relationship (exactly one on-screen scroller under the pane), not any height.
'use strict';
const H = require('../harness');

// Count scroll containers that are actually on-screen and actually overflowing,
// restricted to the side-dock pane (the sheet) so #ui and scene chrome don't
// count.
const paneScrollers = (page) => page.evaluate(() => {
  const pane = document.querySelector('.split-pane');
  if (!pane) return { error: 'no .split-pane' };
  const hits = [];
  pane.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll')
      && el.scrollHeight > el.clientHeight + 2;
    if (!scrollable) return;
    const r = el.getBoundingClientRect();
    const onScreen = r.height > 20 && r.bottom > 0 && r.top < window.innerHeight
      && r.right > 0 && r.left < window.innerWidth;
    if (onScreen) hits.push((el.className && el.className.toString().split(' ')[0]) || el.tagName);
  });
  return { count: hits.length, hits };
});

async function bigSheet(page, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(async () => {
    const { setPhoneScreenOverride } = await import('./ui/panels/PanelManager.js');
    setPhoneScreenOverride(true);
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    createSupercell(3, 3, 3);
  });
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const { setSideDockCollapsed } = await import('./ui/panels/SideDock.js');
    setSideDockCollapsed(false);
    const win = document.querySelector('.cv-panel.cv-side-docked');
    if (win) win.classList.remove('cv-bar-collapsed', 'cv-collapsed');
    document.querySelectorAll('.comp-expand-icon').forEach((r) => r.click());
  });
  await page.waitForTimeout(700);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  await bigSheet(page, 390, 844); // portrait phone → bottom sheet
  const portrait = await paneScrollers(page);
  H.check('portrait sheet: exactly one scroll surface', portrait.count === 1, JSON.stringify(portrait));

  await bigSheet(page, 874, 402); // landscape phone → right pane
  const landscape = await paneScrollers(page);
  H.check('landscape pane: exactly one scroll surface', landscape.count === 1, JSON.stringify(landscape));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})();
