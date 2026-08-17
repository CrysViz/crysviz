// Reset UI on a phone must return the Structure window to its compact home — a
// side-dock sheet on the BOTTOM edge (portrait), COLLAPSED by default (the
// launcher icon raises it) — not a right-side tab. The sheet is still attached
// from before the reset, so the "materialize an empty dock" logic has to
// recognise a dock holding only this panel as its own to re-establish the
// bottom edge. Portrait viewport is load-bearing: sideHomePanel picks the edge
// by orientation (landscape opens on the right instead), so this test pins a
// tall viewport to exercise the bottom-sheet path.
'use strict';
const H = require('../harness');

const infoHome = (page) => page.evaluate(async () => {
  const { getPanel } = await import('./ui/panels/PanelManager.js');
  const { getSideDockLayout } = await import('./ui/panels/SideDock.js');
  const info = getPanel('info');
  const dock = getSideDockLayout();
  return {
    dock: info.dock,
    autoDocked: info.autoDocked,
    side: dock.side,
    collapsed: dock.collapsed,
    launcher: !!document.querySelector('[data-compact-launcher="info"]'),
    height: Math.round(info.el.getBoundingClientRect().height),
  };
});

(async () => {
  const { browser, page, errors } = await H.launchApp();
  // Portrait phone: tall viewport so the compact home opens as a bottom sheet
  // (landscape would open it on the right — see sideHomePanel).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { setPhoneScreenOverride } = await import('./ui/panels/PanelManager.js');
    setPhoneScreenOverride(true);
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);

  const before = await infoHome(page);
  H.check('phone load: Structure is a collapsed bottom sheet with a launcher',
    before.side === 'bottom' && before.collapsed && before.launcher,
    JSON.stringify(before));

  await page.evaluate(() => document.getElementById('resetUiButton').click());
  await page.waitForTimeout(1200);

  const after = await infoHome(page);
  H.check('after Reset UI: still a BOTTOM sheet, not a right tab',
    after.side === 'bottom', JSON.stringify(after));
  H.check('after Reset UI: sheet stays collapsed with its launcher',
    after.collapsed && after.launcher, JSON.stringify(after));
  H.check('after Reset UI: marked auto-docked so a desktop would float it back',
    after.autoDocked === true, JSON.stringify(after));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})();
