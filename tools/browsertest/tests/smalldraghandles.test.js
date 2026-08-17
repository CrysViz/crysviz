// Settings > "Always show small drag handles": ON reverts the collapsed-bar
// drag handle to the early short-centered strip (thin 2px, 64px, always
// visible); OFF (default) keeps the current thicker, hover-revealed handle.
// The pref is a body class (cv-small-drag-handles) the CSS keys off —
// panelWindow.css + responsive.css.
'use strict';
const H = require('../harness');

const PANEL = 'info'; // the Structure window: floating by default

async function handleState(page, id) {
  return page.evaluate((id) => {
    const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const bar = el.querySelector('.cv-panel-titlebar');
    const cs = getComputedStyle(bar);
    return {
      barCollapsed: el.classList.contains('cv-bar-collapsed'),
      bodyClass: document.body.classList.contains('cv-small-drag-handles'),
      height: bar.getBoundingClientRect().height,
      width: bar.getBoundingClientRect().width,
      panelWidth: el.getBoundingClientRect().width,
      opacity: parseFloat(cs.opacity),
    };
  }, id);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Hide the Structure window's title bar (same path as its ― button).
  await page.evaluate(async (id) => {
    const { getPanel, openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel(id);
    getPanel(id).collapseBar();
  }, PANEL);
  await page.waitForTimeout(400); // let the 0.15s opacity transition settle

  // Default (toggle off): the current handle — 8px tall, short (not the
  // panel's width), and dimmed/hidden while unhovered (0.6 base; 0 on
  // hover-capable desktops) — never the always-full opacity of the toggle.
  let s = await handleState(page, PANEL);
  H.check('default: bar is collapsed to the current 8px hover handle',
    s.barCollapsed && !s.bodyClass && Math.abs(s.height - 8) < 1
      && s.width < s.panelWidth - 20 && s.opacity < 0.7,
    JSON.stringify(s));

  // Flip the Settings toggle on (drive the real UI row).
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('settings');
  });
  await page.evaluate(() => document.getElementById('smallDragHandlesToggle').click());
  await page.waitForTimeout(400);

  // On: the early strip — 2px tall, 64px wide (still centered), opacity 1
  // even without hover.
  s = await handleState(page, PANEL);
  H.check('toggled on: the early thin 64px strip, always visible',
    s.bodyClass && Math.abs(s.height - 2) < 1
      && Math.abs(s.width - 64) < 1 && s.opacity === 1,
    JSON.stringify(s));

  // The pref persists in panelPrefs (survives Reset UI by design).
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('panelPrefs')).smallDragHandles);
  H.check('pref persisted to panelPrefs', saved === true, String(saved));

  // Off again: exactly the current handle again.
  await page.evaluate(() => document.getElementById('smallDragHandlesToggle').click());
  await page.waitForTimeout(400);
  s = await handleState(page, PANEL);
  H.check('toggled back off: the current 8px hover handle returns',
    !s.bodyClass && Math.abs(s.height - 8) < 1 && s.opacity < 0.7,
    JSON.stringify(s));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
