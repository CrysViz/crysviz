// Right dock with several windows (docs/ui/panels/RightDock.js): regular
// panel windows dock on the right as TABS — #splitPaneBody hosts their
// .cv-panel elements, exactly one is front (.cv-front, visible), and the
// header strip / collapsed edge pull-tabs select it. Opening a second window
// must NOT evict the first, switching tabs must not destroy either one's
// content, and the tab ✕ closes to a detached-but-registered state
// (closeMode:'hide') that the Features toggles reopen.
'use strict';
const H = require('../harness');
const path = require('path');

async function openPanel(page, id) {
  await page.evaluate(async (id) => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel(id);
  }, id);
  await page.waitForTimeout(300);
}
async function closePanel(page, id) {
  await page.evaluate(async (id) => {
    const { closePanel } = await import('./ui/panels/PanelManager.js');
    closePanel(id);
  }, id);
  await page.waitForTimeout(300);
}
function snap(page) {
  return page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const va = document.getElementById('viewArea');
    const clean = (s) => s.replace(/\s*▸\s*$/, '');
    const edge = [...document.querySelectorAll('#splitPaneTabs .split-pane-tab')];
    const header = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')];
    const visible = (el) => !!el && el.getBoundingClientRect().width > 4;
    const lbl = (t) => clean(t.querySelector('.split-pane-tab-label')?.textContent || '');
    const activeEl = header.find((t) => t.classList.contains('active'));
    const docked = [...document.querySelectorAll('#splitPaneBody > .cv-panel')];
    const frontEl = docked.find((el) => el.classList.contains('cv-front'));
    return {
      active: va.classList.contains('split-active'),
      collapsed: va.classList.contains('split-pane-collapsed'),
      dockedIds: docked.map((el) => el.dataset.panelId),
      frontId: frontEl ? frontEl.dataset.panelId : null,
      tabLabels: edge.map(lbl),
      headerLabels: header.map(lbl),
      headerShown: visible(document.getElementById('splitPaneHeaderTabs')),
      edgeShown: getComputedStyle(document.getElementById('splitPaneTabs')).display !== 'none',
      headerHasClose: header.every((t) => !!t.querySelector('.split-pane-tab-close')),
      activeTab: activeEl ? lbl(activeEl) : '',
      eosClosed: !!getPanel('eos')?.closed,
      eosDock: getPanel('eos')?.dock ?? null,
      eosToggle: document.getElementById('eosOpenToggle')?.checked ?? null,
      eosHasContent: !!document.getElementById('eosDropZone'),
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // ---- closed by default: registered, detached, unchecked in Features -----
  let s = await snap(page);
  H.check('EOS starts closed (no tab, no pane)', !s.active && s.eosClosed
    && s.dockedIds.length === 0, JSON.stringify(s.dockedIds));
  H.check('Features EOS toggle starts unchecked', s.eosToggle === false, String(s.eosToggle));

  // ---- open EOS: its window docks right as the front tab ------------------
  await openPanel(page, 'eos');
  s = await snap(page);
  H.check('openPanel(eos) opens the right dock on EOS', s.active
    && s.dockedIds.join() === 'eos' && s.frontId === 'eos', JSON.stringify(s));
  H.check('EOS window content built into the pane', s.eosHasContent);
  H.check('tab strip shows the single window', s.headerShown
    && s.headerLabels.join() === 'EOS Fitting', JSON.stringify(s.headerLabels));
  H.check('Features EOS toggle synced on', s.eosToggle === true);
  H.check('EOS remembered as right-docked', s.eosDock === 'right' && !s.eosClosed);

  // Mark transient content state to prove tab switches never rebuild.
  await page.evaluate(() => {
    document.getElementById('eosEnergyUnits').value = 'Ry';
  });

  // ---- open Landscape too: EOS must survive; two tabs ---------------------
  await openPanel(page, 'landscape');
  s = await snap(page);
  H.check('opening Landscape keeps EOS docked (2 windows)',
    s.dockedIds.length === 2 && s.dockedIds.includes('eos') && s.dockedIds.includes('landscape'),
    JSON.stringify(s.dockedIds));
  H.check('header tabs list both windows', s.headerShown
    && s.headerLabels.includes('EOS Fitting') && s.headerLabels.includes('Energy Landscape'),
    JSON.stringify(s.headerLabels));
  H.check('each header tab has a close ✕', s.headerHasClose);
  H.check('Landscape is front (just opened)', s.frontId === 'landscape'
    && s.activeTab === 'Energy Landscape', `${s.frontId} / ${s.activeTab}`);
  H.check('edge stack hidden while open', s.edgeShown === false);

  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'splitstack-two-windows.png') });

  // ---- click the EOS header tab: front switches, nothing destroyed --------
  const eosTabPos = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => /EOS Fitting/.test(t.textContent));
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(eosTabPos.x, eosTabPos.y);
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('clicking EOS tab brings EOS front', s.frontId === 'eos' && s.activeTab === 'EOS Fitting',
    `${s.frontId} / ${s.activeTab}`);
  H.check('both windows still docked after switch', s.dockedIds.length === 2,
    JSON.stringify(s.dockedIds));
  const units = await page.evaluate(() => document.getElementById('eosEnergyUnits').value);
  H.check('tab switch kept EOS content state (units still Ry)', units === 'Ry', units);

  // ---- » collapses the whole dock: edge pull-tabs show to reopen ----------
  await page.evaluate(() => document.getElementById('splitPaneCollapseBtn').click());
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('» collapse shows the edge stack with both tabs',
    s.collapsed && s.edgeShown && s.tabLabels.length === 2,
    `edge ${s.edgeShown} ${JSON.stringify(s.tabLabels)}`);

  // ---- reopen via the Landscape pull-tab ----------------------------------
  await page.evaluate(() => {
    [...document.querySelectorAll('#splitPaneTabs .split-pane-tab')]
      .find((t) => /Energy Landscape/.test(t.textContent))?.click();
  });
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('pull-tab reopens the dock on that window', !s.collapsed && s.frontId === 'landscape',
    `${s.collapsed} / ${s.frontId}`);

  // ---- close EOS from its tab ✕: closes ONLY EOS (to hidden, not gone) ----
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => /EOS Fitting/.test(t.textContent));
    tab?.querySelector('.split-pane-tab-close')?.click();
  });
  await page.waitForTimeout(300);
  s = await snap(page);
  H.check('tab ✕ closes only EOS (1 window left, Landscape front)',
    s.dockedIds.join() === 'landscape' && s.frontId === 'landscape', JSON.stringify(s.dockedIds));
  H.check('closed EOS is detached but remembered right-docked',
    s.eosClosed && s.eosDock === 'right', `${s.eosClosed} / ${s.eosDock}`);
  H.check('Features EOS toggle synced off by the tab ✕', s.eosToggle === false);

  // ---- reopen from the Features toggle: content survived the close --------
  await H.clickById(page, 'eosOpenToggle');
  await page.waitForTimeout(300);
  s = await snap(page);
  H.check('Features toggle reopens EOS as front tab', s.dockedIds.length === 2
    && s.frontId === 'eos', JSON.stringify(s));
  const unitsAfterReopen = await page.evaluate(() => document.getElementById('eosEnergyUnits').value);
  H.check('close/reopen kept EOS content (units still Ry)', unitsAfterReopen === 'Ry', unitsAfterReopen);

  // ---- closing the last window hides the pane -----------------------------
  await closePanel(page, 'eos');
  await closePanel(page, 'landscape');
  s = await snap(page);
  H.check('closing the last window closes the pane', !s.active && s.dockedIds.length === 0,
    `${s.active} / ${JSON.stringify(s.dockedIds)}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
