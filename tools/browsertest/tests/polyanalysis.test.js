// Polyhedra analysis windows (docs/ui/AnalysisPanels/*): Type histogram,
// Polyhedron Inspector and Connectivity, each ONE ordinary panel window
// opened from the Polyhedra window's per-row Open buttons, defaulting to the
// side dock. Covers the single-window conversion of the contributed
// Panel/Split-View dual implementations: open → front tab, several coexist
// as tabs, the Inspector forces Show/Complete Polyhedra on while open and
// restores them on close, and the tab ≡ menu's Close item unregisters the
// transient window.
'use strict';
const H = require('../harness');

async function expandPanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).expand();
  }, id);
  await page.waitForTimeout(300);
}

function dockState(page) {
  return page.evaluate(() => {
    const docked = [...document.querySelectorAll('#splitPaneBody > .cv-panel')];
    return {
      active: document.getElementById('viewArea').classList.contains('split-active'),
      dockedIds: docked.map((el) => el.dataset.panelId),
      frontId: docked.find((el) => el.classList.contains('cv-front'))?.dataset.panelId ?? null,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page);

  // Enable polyhedra (YBCO default structure has them) and open the window.
  await H.clickById(page, 'showPolyhedra');
  await page.waitForTimeout(600);
  await expandPanel(page, 'polyhedra');
  const buttons = await page.evaluate(() => ({
    type: !!document.getElementById('openPolyhedraTypeHistogram'),
    inspector: !!document.getElementById('openPolyhedronInspector'),
    connectivity: !!document.getElementById('openPolyhedraConnectivityHistogram'),
  }));
  H.check('Polyhedra window offers one Open button per analysis',
    buttons.type && buttons.inspector && buttons.connectivity, JSON.stringify(buttons));

  // ---- Type histogram opens as the side dock's front tab -----------------
  await H.clickById(page, 'openPolyhedraTypeHistogram');
  await page.waitForTimeout(500);
  let s = await dockState(page);
  H.check('Type histogram window opens side-docked, front',
    s.active && s.frontId === 'polyhedraTypeHistogram', JSON.stringify(s));
  const typeCard = await page.evaluate(() =>
    !!document.querySelector('.cv-panel[data-panel-id="polyhedraTypeHistogram"] #polyhedra-type-histogram-item'));
  H.check('Type histogram card built', typeCard);

  // ---- Inspector joins as a second tab and forces the polyhedra toggles ---
  const before = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return { show: general.showPolyhedra, complete: general.completePolyhedra };
  });
  await H.clickById(page, 'openPolyhedronInspector');
  await page.waitForTimeout(600);
  s = await dockState(page);
  H.check('Inspector opens as a second tab (Type histogram kept)',
    s.dockedIds.length === 2 && s.frontId === 'polyhedronInspector', JSON.stringify(s));
  const forced = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const el = document.querySelector('.cv-panel[data-panel-id="polyhedronInspector"]');
    return {
      show: general.showPolyhedra,
      complete: general.completePolyhedra,
      togglesLocked: document.getElementById('showPolyhedra')?.disabled === true,
      hasViewport: !!el?.querySelector('#piViewport canvas'),
      hasSummary: !!el?.querySelector('#piSummary'),
    };
  });
  H.check('Inspector forces Show + Complete Polyhedra on (toggles locked)',
    forced.show && forced.complete && forced.togglesLocked, JSON.stringify(forced));
  H.check('Inspector mini 3D viewport + summary built', forced.hasViewport && forced.hasSummary);

  // ---- closing the Inspector restores the forced settings -----------------
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => t.dataset.panelId === 'polyhedronInspector');
    /** @type {HTMLElement} */ (tab.querySelector('.split-pane-tab-menu')).click();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((b) => b.textContent === 'Close')?.click();
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return {
      show: general.showPolyhedra,
      complete: general.completePolyhedra,
      togglesLocked: document.getElementById('showPolyhedra')?.disabled === true,
      inspectorGone: !document.querySelector('.cv-panel[data-panel-id="polyhedronInspector"]'),
    };
  });
  H.check('closing the Inspector restores the prior polyhedra settings',
    after.show === before.show && after.complete === before.complete && !after.togglesLocked,
    JSON.stringify({ before, after }));
  H.check('Inspector window unregistered on close (transient)', after.inspectorGone);

  // ---- Connectivity opens too --------------------------------------------
  await H.clickById(page, 'openPolyhedraConnectivityHistogram');
  await page.waitForTimeout(500);
  s = await dockState(page);
  H.check('Connectivity window opens as front tab alongside Type',
    s.dockedIds.includes('polyhedraConnectivityHistogram')
      && s.frontId === 'polyhedraConnectivityHistogram'
      && s.dockedIds.includes('polyhedraTypeHistogram'),
    JSON.stringify(s));
  const pcList = await page.evaluate(() =>
    !!document.querySelector('.cv-panel[data-panel-id="polyhedraConnectivityHistogram"] #pcList'));
  H.check('Connectivity drill-down list built', pcList);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
