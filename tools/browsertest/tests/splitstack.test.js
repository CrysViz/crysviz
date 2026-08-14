// Side dock with several windows (docs/ui/panels/SideDock.js) and the
// content-driven activation of the plots windows: EOS and Energy Landscape
// are each a CONTROLS window in the main dock plus a PLOTS window that
// defaults to the side dock and opens by itself when there is something to
// show — dropping a P/V data file on the EOS controls, or a landscape JSON on
// the Landscape controls. Tabs select the front window, the whole dock
// collapses to pull-tabs, and the tab ≡ menu's Close item closes to a
// detached-but-registered state (closeMode:'hide') that the next fit reopens
// with content intact.
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

/** Drop a synthetic file onto an element (real DataTransfer drop event). */
async function dropFile(page, selector, name, text) {
  await page.evaluate(({ selector, name, text }) => {
    const el = document.querySelector(selector);
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/plain' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { selector, name, text });
  await page.waitForTimeout(500);
}

function snap(page) {
  return page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const va = document.getElementById('viewArea');
    const clean = (s) => s.replace(/\s*▸\s*$/, '');
    const edge = [...document.querySelectorAll('#splitPaneTabs .split-pane-tab')];
    const header = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')];
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
      edgeShown: getComputedStyle(document.getElementById('splitPaneTabs')).display !== 'none',
      headerHasMenu: header.every((t) => !!t.querySelector('.split-pane-tab-menu')),
      activeTab: activeEl ? lbl(activeEl) : '',
      eosPlotsClosed: !!getPanel('eosPlots')?.closed,
      eosPlotsDock: getPanel('eosPlots')?.dock ?? null,
      eosInMainDock: !!document.querySelector('#dock .cv-panel[data-panel-id="eos"]'),
      landscapeInMainDock: !!document.querySelector('#dock .cv-panel[data-panel-id="landscape"]'),
      hasPlotCards: !!document.getElementById('ev-plot-wrapper') && !!document.getElementById('pv-plot-wrapper'),
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // ---- boot: controls windows in the main dock, plots windows closed ------
  let s = await snap(page);
  H.check('EOS + Landscape controls windows sit in the main dock',
    s.eosInMainDock && s.landscapeInMainDock, JSON.stringify(s));
  H.check('plots windows start closed (no side dock)',
    !s.active && s.eosPlotsClosed && s.dockedIds.length === 0, JSON.stringify(s.dockedIds));

  // ---- EOS activation: loading a dataset opens the plots window -----------
  await expandPanel(page, 'eos'); // build the controls (rebuild lifecycle)
  await dropFile(page, '#eosDropZone', 'pv.txt', 'P V\n10 20\n9 21\n8 22\n7 23\n6 24\n');
  s = await snap(page);
  H.check('dropping a P/V file opens the EOS plots window in the side dock',
    s.active && s.dockedIds.join() === 'eosPlots' && s.frontId === 'eosPlots',
    JSON.stringify(s));
  H.check('plot cards built into the plots window', s.hasPlotCards);
  H.check('its tab shows the plots window title', s.headerLabels.join() === 'EOS Fit',
    JSON.stringify(s.headerLabels));

  // ---- Landscape activation: loading a JSON opens its plots window --------
  await expandPanel(page, 'landscape');
  await dropFile(page, '#landscapeControlsHost', 'scan.json', '{"not":"a real landscape"}');
  s = await snap(page);
  H.check('dropping a landscape JSON opens the Landscape plots window',
    s.dockedIds.length === 2 && s.dockedIds.includes('landscapePlots')
      && s.frontId === 'landscapePlots', JSON.stringify(s));
  H.check('header tabs list both plots windows',
    s.headerLabels.includes('EOS Fit') && s.headerLabels.includes('Landscape Plots'),
    JSON.stringify(s.headerLabels));
  H.check('each header tab has a ≡ window-menu button', s.headerHasMenu);

  await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'splitstack-two-windows.png') });

  // ---- click the EOS Fit tab: front switches, nothing destroyed -----------
  const eosTabPos = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => /EOS Fit/.test(t.textContent));
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(eosTabPos.x, eosTabPos.y);
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('clicking the EOS Fit tab brings it front', s.frontId === 'eosPlots'
    && s.activeTab === 'EOS Fit', `${s.frontId} / ${s.activeTab}`);
  H.check('both plots windows still docked after switch', s.dockedIds.length === 2,
    JSON.stringify(s.dockedIds));

  // ---- » collapses the whole dock: edge pull-tabs show to reopen ----------
  await page.evaluate(() => document.getElementById('splitPaneCollapseBtn').click());
  await page.waitForTimeout(250);
  s = await snap(page);
  // One tab, not one per window: listing every window turned the collapsed
  // edge into a full-height wall of vertical labels, which is most of what
  // collapsing is meant to get rid of. It names the front window, since that
  // is where reopening lands.
  H.check('» collapse shows a single edge pull-tab, naming the front window',
    s.collapsed && s.edgeShown && s.tabLabels.length === 1
      && /EOS Fit/.test(s.tabLabels[0]),
    `edge ${s.edgeShown} ${JSON.stringify(s.tabLabels)}`);

  // ---- reopen via that pull-tab -------------------------------------------
  await page.evaluate(() => {
    /** @type {HTMLElement | null} */
    (document.querySelector('#splitPaneTabs .split-pane-tab'))?.click();
  });
  await page.waitForTimeout(250);
  s = await snap(page);
  H.check('pull-tab reopens the dock on the front window', !s.collapsed && s.frontId === 'eosPlots',
    `${s.collapsed} / ${s.frontId}`);

  // ---- ⇩ toggles the whole dock to the BOTTOM edge (and back) -------------
  await page.evaluate(() => document.getElementById('splitPaneDockBtn').click());
  await page.waitForTimeout(300);
  const bottom = await page.evaluate(() => {
    const va = document.getElementById('viewArea');
    const pane = document.getElementById('splitPane').getBoundingClientRect();
    const view = document.getElementById('view').getBoundingClientRect();
    return {
      cls: va.classList.contains('split-dock-bottom'),
      paneAtBottom: Math.abs(pane.bottom - window.innerHeight) < 2 && pane.width > pane.height,
      viewAbovePane: view.bottom <= pane.top + 2,
      reserveBottom: getComputedStyle(document.documentElement).getPropertyValue('--split-reserve-bottom').trim(),
      btnGlyph: document.getElementById('splitPaneDockBtn').textContent,
      saved: JSON.parse(localStorage.getItem('panelLayout') || '{}').rightDock?.side ?? null,
    };
  });
  H.check('⇩ docks the pane to the bottom edge',
    bottom.cls && bottom.paneAtBottom && bottom.viewAbovePane, JSON.stringify(bottom));
  H.check('bottom reserve published + button flips to ⇒',
    parseFloat(bottom.reserveBottom) > 100 && bottom.btnGlyph === '⇒',
    `${bottom.reserveBottom} / ${bottom.btnGlyph}`);
  await page.waitForTimeout(400); // save debounce
  const savedSide = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('panelLayout') || '{}').rightDock?.side ?? null);
  H.check('dock side persists in the layout blob', savedSide === 'bottom', String(savedSide));
  await page.evaluate(() => document.getElementById('splitPaneDockBtn').click());
  await page.waitForTimeout(300);
  const backRight = await page.evaluate(() => {
    const va = document.getElementById('viewArea');
    const pane = document.getElementById('splitPane').getBoundingClientRect();
    return {
      cls: va.classList.contains('split-dock-bottom'),
      paneAtRight: Math.abs(pane.right - window.innerWidth) < 2 && pane.height > pane.width,
      reserveBottom: parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--split-reserve-bottom')) || 0,
    };
  });
  H.check('⇒ docks the pane back to the right edge',
    !backRight.cls && backRight.paneAtRight && backRight.reserveBottom === 0,
    JSON.stringify(backRight));

  // ---- close EOS Fit from its tab ≡ menu: closes ONLY it (hidden, not gone)
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => /EOS Fit/.test(t.textContent));
    /** @type {HTMLElement} */ (tab.querySelector('.split-pane-tab-menu')).click();
  });
  await page.waitForTimeout(100);
  const eosMenu = await page.evaluate(() => {
    const menu = document.querySelector('.cv-panel-menu');
    return {
      checked: menu?.querySelector('.cv-panel-menu-item.checked')?.textContent ?? null,
      hasClose: [...(menu?.querySelectorAll('.cv-panel-menu-item') ?? [])]
        .some((b) => b.textContent === 'Close'),
    };
  });
  H.check('tab ≡ opens the window menu (Side dock checked, Close offered)',
    eosMenu.checked === 'Side dock' && eosMenu.hasClose, JSON.stringify(eosMenu));
  await page.evaluate(() => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((b) => b.textContent === 'Close')?.click();
  });
  await page.waitForTimeout(300);
  s = await snap(page);
  H.check('menu Close closes only the EOS plots window',
    s.dockedIds.join() === 'landscapePlots' && s.frontId === 'landscapePlots',
    JSON.stringify(s.dockedIds));
  H.check('closed plots window detached but remembered side-docked',
    s.eosPlotsClosed && s.eosPlotsDock === 'right', `${s.eosPlotsClosed} / ${s.eosPlotsDock}`);

  // ---- using the feature again reopens it (units change -> re-fit) --------
  await page.evaluate(() => {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('eosEnergyUnits'));
    sel.value = 'Ry';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  s = await snap(page);
  H.check('re-fitting (units change) reopens the plots window as front',
    s.dockedIds.length === 2 && s.frontId === 'eosPlots' && !s.eosPlotsClosed,
    JSON.stringify(s));
  H.check('close/reopen kept the plot content (cards still built)', s.hasPlotCards);

  // ---- resetting the fit closes the plots window (nothing to show) --------
  await page.evaluate(() => document.getElementById('eosResetFitBtn').click());
  await page.waitForTimeout(400);
  s = await snap(page);
  H.check('Reset closes the EOS plots window (Landscape stays)',
    s.eosPlotsClosed && s.dockedIds.join() === 'landscapePlots', JSON.stringify(s.dockedIds));

  // The stub landscape JSON is deliberately not a valid dataset — the addon's
  // caught "failed to load JSON" console.error is the expected outcome there
  // (the window opening to show the error box is exactly what we asserted).
  const unexpected = errors.filter((e) => !/Landscape: failed to load JSON/.test(e));
  H.check('no page errors', unexpected.length === 0, unexpected[0] || '');
  await H.finish(browser);
})().catch(H.crash);
