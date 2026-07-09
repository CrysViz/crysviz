// Multi-owner split view (docs/ui/panels/SplitView.js): several feature panels
// can hold the one shared right pane at once. Each keeps its own persistent
// content container (#splitPaneBody > .split-owner-pane) and a tab in the stack
// (#splitPaneTabs > .split-pane-tab); exactly one owner is "front" (visible).
// Opening a second owner must NOT evict the first (the old behavior), and
// switching between them via the tabs must not destroy either one's content.
'use strict';
const H = require('../harness');
const path = require('path');

async function expandPanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).expand();
  }, id);
  await page.waitForTimeout(300);
}
async function collapsePanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).collapse();
  }, id);
  await page.waitForTimeout(300);
}
function snap(page) {
  return page.evaluate(() => {
    const va = document.getElementById('viewArea');
    const clean = (s) => s.replace(/\s*▸\s*$/, '');
    const edge = [...document.querySelectorAll('#splitPaneTabs .split-pane-tab')];
    const header = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')];
    const shown = (el) => el && getComputedStyle(el).display !== 'none';
    return {
      active: va.classList.contains('split-active'),
      multi: va.classList.contains('split-multi'),
      collapsed: va.classList.contains('split-pane-collapsed'),
      title: document.getElementById('splitPaneTitle').textContent,
      ownerPanes: document.querySelectorAll('#splitPaneBody .split-owner-pane').length,
      tabLabels: edge.map((t) => clean(t.textContent)),
      headerLabels: header.map((t) => clean(t.textContent)),
      headerShown: shown(document.getElementById('splitPaneHeaderTabs')),
      edgeShown: shown(document.getElementById('splitPaneTabs')),
      activeTab: header.find((t) => t.classList.contains('active'))?.textContent.trim() || '',
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // ---- open EOS first: one owner, pane open, no tab stack (single owner) ---
  await expandPanel(page, 'eos');
  let s = await snap(page);
  H.check('EOS opens the split pane', s.active && s.title === 'EOS Fit', s.title);
  H.check('one owner-pane after EOS', s.ownerPanes === 1, String(s.ownerPanes));
  H.check('no tabs shown for a single owner', s.multi === false && !s.headerShown && !s.edgeShown,
    `header ${s.headerShown} / edge ${s.edgeShown}`);

  // ---- open Landscape too: EOS must survive; now two owners + header tabs --
  await expandPanel(page, 'landscape');
  s = await snap(page);
  H.check('opening Landscape keeps EOS open (2 owner-panes)', s.ownerPanes === 2,
    String(s.ownerPanes));
  H.check('.split-multi set with two owners', s.multi === true);
  H.check('header tab strip shown on top while open', s.headerShown &&
    s.headerLabels.includes('EOS Fit') && s.headerLabels.includes('Energy Landscape'),
    `shown ${s.headerShown} ${JSON.stringify(s.headerLabels)}`);
  H.check('edge stack hidden while open', s.edgeShown === false);
  H.check('Landscape is front (just opened)', s.title === 'Energy Landscape' &&
    s.activeTab === 'Energy Landscape', `${s.title} / ${s.activeTab}`);

  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'splitstack-two-owners.png') });

  // ---- click the EOS header tab: front switches, nothing destroyed --------
  await page.evaluate(() => {
    [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => /EOS Fit/.test(t.textContent))?.click();
  });
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('clicking EOS tab brings EOS front', s.title === 'EOS Fit' && s.activeTab === 'EOS Fit',
    `${s.title} / ${s.activeTab}`);
  H.check('both owner-panes still present after switch', s.ownerPanes === 2, String(s.ownerPanes));

  // ---- collapse the whole pane: edge stack shows to reopen ----------------
  await page.evaluate(() => document.getElementById('splitPaneCollapseBtn').click());
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('collapse shows the edge stack, hides header tabs',
    s.collapsed && s.edgeShown && !s.headerShown && s.tabLabels.length === 2,
    `edge ${s.edgeShown} header ${s.headerShown} ${JSON.stringify(s.tabLabels)}`);

  // ---- reopen via the Landscape tab --------------------------------------
  await page.evaluate(() => {
    [...document.querySelectorAll('#splitPaneTabs .split-pane-tab')]
      .find((t) => /Energy Landscape/.test(t.textContent))?.click();
  });
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('tab reopens pane on that owner', !s.collapsed && s.title === 'Energy Landscape',
    `${s.collapsed} / ${s.title}`);

  // ---- collapse EOS's dock panel: only EOS's slot is released ------------
  await collapsePanel(page, 'eos');
  s = await snap(page);
  H.check('collapsing EOS panel removes only EOS (1 owner left)', s.ownerPanes === 1 &&
    s.title === 'Energy Landscape', `${s.ownerPanes} / ${s.title}`);
  H.check('.split-multi cleared back to one owner', s.multi === false);

  // ---- collapse Landscape's dock panel: pane fully closes ----------------
  await collapsePanel(page, 'landscape');
  s = await snap(page);
  H.check('closing last owner closes the pane', !s.active && s.ownerPanes === 0,
    `${s.active} / ${s.ownerPanes}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
