// "Reset UI" (#resetUiButton -> resetAllPanels) restores every panel's
// default dock slot/anchor, title-bar (strip) state, AND body open/closed
// state. Two things are checked here:
//   1. The Atomistic (backend) panel now DEFAULTS to a collapsed body, but
//      with a normal (labeled) title bar — so it stays discoverable, unlike
//      a `barCollapsed` panel which shrinks to a nameless 3px strip.
//   2. For a `barCollapsed` panel (Files) a body the user folded on top of
//      the thin strip leaves no visible title AND no visible body:
//      indistinguishable from being gone. Reset UI must reopen the body to
//      its default; the per-panel ≡ menu's "Position ▸ Default" must NOT
//      (narrower, placement-only reset).
'use strict';
const H = require('../harness');

const snap = (page, id) => page.evaluate((pid) => {
  const el = document.querySelector(`.cv-panel[data-panel-id="${pid}"]`);
  const bar = el.querySelector('.cv-panel-titlebar');
  return {
    collapsed: el.classList.contains('cv-collapsed'),
    barCollapsed: el.classList.contains('cv-bar-collapsed'),
    h: el.getBoundingClientRect().height,
    barH: bar ? bar.getBoundingClientRect().height : 0,
  };
}, id);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // 1. Atomistic starts collapsed like the other docked panels, but its bar
  //    is not stripped, so a labeled title bar stays visible and clickable.
  const atom = await snap(page, 'backend');
  H.check('Atomistic panel defaults to a collapsed body',
    atom.collapsed, JSON.stringify(atom));
  H.check('Atomistic collapsed panel keeps a visible, labeled title bar (not a 3px strip)',
    !atom.barCollapsed && atom.barH > 10, JSON.stringify(atom));

  // 2. Files is barCollapsed by default (thin strip) with its body open.
  //    Folding the body on top of the strip makes the whole panel vanish.
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="files"] .cv-panel-fold').click();
  });
  const folded = await snap(page, 'files');
  H.check('folding a barCollapsed panel body collapses it to a near-invisible strip',
    folded.collapsed && folded.h < 10, JSON.stringify(folded));

  await page.evaluate(() => document.getElementById('resetUiButton')?.click());
  await page.waitForTimeout(300);
  const afterReset = await snap(page, 'files');
  H.check('Reset UI reopens the Files panel body (its default is expanded)',
    !afterReset.collapsed && afterReset.h > 100, JSON.stringify(afterReset));

  // 3. The per-panel ≡ menu's "Position ▸ Default" is narrower: it must NOT
  //    force the body open, only fix placement/bar state.
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="files"] .cv-panel-fold').click();
  });
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="files"] .cv-panel-menu-btn').click();
  });
  await page.waitForTimeout(100);
  const menuShape = await page.evaluate(() => {
    const menu = document.querySelector('.cv-panel-menu');
    return {
      header: menu?.querySelector('.cv-panel-menu-header')?.textContent ?? null,
      items: [...(menu?.querySelectorAll('.cv-panel-menu-item') ?? [])].map((b) => b.textContent),
      checked: menu?.querySelector('.cv-panel-menu-item.checked')?.textContent ?? null,
    };
  });
  H.check('≡ menu shows a Position section with the four choices',
    menuShape.header === 'Position'
      && JSON.stringify(menuShape.items) === JSON.stringify(['Float', 'Left dock', 'Right dock', 'Default']),
    JSON.stringify(menuShape));
  H.check('current position (Left dock) is check-marked', menuShape.checked === 'Left dock',
    String(menuShape.checked));
  await page.evaluate(() => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((b) => b.textContent === 'Default')?.click();
  });
  await page.waitForTimeout(200);
  const afterHome = await snap(page, 'files');
  H.check('Position ▸ Default still leaves collapsed state as the user left it',
    afterHome.collapsed && afterHome.h < 10, JSON.stringify(afterHome));
  H.check('menu closed after selecting an item',
    await page.evaluate(() => !document.querySelector('.cv-panel-menu')));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
