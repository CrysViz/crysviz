// Panel selection — the feature store (docs/ui/panels/featureStore.js) and
// its "Add panels" popup (ui/FeatureStoreModal.js):
//   - a first-run browser gets only the essential feature windows (Features,
//     Visual, Cell & Supercell) plus the fixed ones (Files, Settings); the
//     rest wait on the hidden shelf, still in the document (their controls
//     resolve by id), and are listed in the store popup
//   - the popup's Add puts a window in the dock (folded), Remove and the ≡
//     menu's "Remove from sidebar" take it out; choices persist over a
//     reload and survive Reset UI
//   - presets: Add all adds every store panel; Reset to Essentials removes
//     the rest, reports how many, and Undo restores them; both survive an
//     immediate reload and a new browser session
//   - opening a store window by any route (a shortcut here) adds it
//   - the button counts removed features the selected structure has data
//     for (a trajectory with forces -> Trajectory, Forces, Lattice Analysis)
//   - a browser that used CrysViz before the store (a remembered panelLayout,
//     no featureStore record) keeps its full sidebar
'use strict';
const H = require('../harness');
const { OUTCAR } = require('../searchIndexSetup');

const ESSENTIAL = ['features', 'visual', 'cell'];
const FIXED = ['files', 'settings'];

async function dockIds(page) {
  return page.evaluate(() => [...document.querySelectorAll('#dock > .cv-panel')].map((el) => el.dataset.panelId));
}

async function storeState(page) {
  return page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    return pm.listStoreFeatures().map((f) => ({ id: f.id, inSidebar: f.inSidebar, suggested: f.suggested }));
  });
}

(async () => {
  // ---- first run ---------------------------------------------------------
  const { browser, page, errors } = await H.launchApp({ firstRunFeatures: true });
  let dock = await dockIds(page);
  H.check('first run: the dock holds the essential + fixed windows only',
    [...ESSENTIAL, ...FIXED].every((id) => dock.includes(id)) && dock.length === ESSENTIAL.length + FIXED.length,
    JSON.stringify(dock));

  const shelf = await page.evaluate(() => {
    const s = document.getElementById('cvPanelShelf');
    return {
      hidden: !!s && s.hidden,
      ids: s ? [...s.children].map((el) => el.dataset.panelId) : [],
      // Atomistic is persistent and adopts #backendControlGroup: it must be
      // built on the shelf, not left visible in the sidebar's raw markup.
      backendInShelf: !!s && s.contains(document.getElementById('backendControlGroup')),
      backendModeSwitch: !!document.getElementById('BackendModeSwitch'),
    };
  });
  H.check('removed windows wait on the hidden shelf', shelf.hidden && shelf.ids.includes('eos') && shelf.ids.includes('backend'), JSON.stringify(shelf.ids));
  H.check('a shelved persistent window is built in place (controls resolve by id)', shelf.backendInShelf && shelf.backendModeSwitch);

  const btn = await page.evaluate(() => {
    const b = document.getElementById('featureStoreButton');
    const reset = document.getElementById('resetEssentialsButton');
    const r = b?.getBoundingClientRect();
    const rr = reset?.getBoundingClientRect();
    const search = document.getElementById('featureSearchButton')?.getBoundingClientRect();
    const row = b?.parentElement;
    return {
      shown: !!r && r.width > 100 && r.height > 20,
      underSearch: row?.previousElementSibling?.id === 'featureSearchButton' && !!search && r.top >= search.bottom,
      aboveDock: row?.nextElementSibling?.id === 'dock',
      resetBeside: !!rr && rr.width > 0 && Math.abs(rr.top - r.top) < 4 && rr.left >= r.right,
    };
  });
  H.check('the solid "Add panels" button and "Reset to Essentials" sit side by side under the search field',
    btn.shown && btn.underSearch && btn.aboveDock && btn.resetBeside, JSON.stringify(btn));

  await page.click('#featureStoreButton');
  await page.waitForTimeout(300);
  const modal = await page.evaluate(() => {
    const m = document.getElementById('featureStoreModal');
    const cards = [...document.querySelectorAll('.feature-store-card')];
    return {
      open: !!m && !m.hidden,
      count: cards.length,
      inSidebar: cards.filter((c) => c.classList.contains('in-sidebar')).map((c) => c.dataset.featureId),
      categories: [...document.querySelectorAll('.feature-store-category h4')].map((h) => h.textContent),
    };
  });
  const stateAll = await storeState(page);
  H.check('the popup opens with one card per store window', modal.open && modal.count === stateAll.length && modal.count >= 15, `${modal.count} cards`);
  H.check('only the essentials are marked in the sidebar', JSON.stringify(modal.inSidebar.sort()) === JSON.stringify([...ESSENTIAL].sort()), JSON.stringify(modal.inSidebar));
  H.check('cards are grouped by category', modal.categories[0] === 'Display' && modal.categories.includes('Analysis'), JSON.stringify(modal.categories));

  // Add EOS from its card: docked, folded, recorded.
  await page.click('.feature-store-card[data-feature-id="eos"] .feature-store-toggle');
  await page.waitForTimeout(300);
  const added = await page.evaluate(() => {
    const el = document.querySelector('#dock > .cv-panel[data-panel-id="eos"]');
    return {
      docked: !!el,
      collapsed: !!el && el.classList.contains('cv-collapsed'),
      card: document.querySelector('.feature-store-card[data-feature-id="eos"]')?.classList.contains('in-sidebar'),
      stored: JSON.parse(localStorage.getItem('featureStore') || '{}').enabled?.eos,
    };
  });
  H.check('Add docks the window folded and records the choice', added.docked && added.collapsed && added.card && added.stored === true, JSON.stringify(added));

  await page.click('.feature-store-card[data-feature-id="eos"] .feature-store-toggle');
  await page.waitForTimeout(300);
  dock = await dockIds(page);
  H.check('Remove takes it out again', !dock.includes('eos'));

  // Escape closes the popup.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  H.check('Escape closes the popup', await page.evaluate(() => document.getElementById('featureStoreModal').hidden));

  // A first-run browser that made no choice yet stays first-run on its next
  // load, although its layout is saved by now.
  await page.waitForTimeout(400); // debounced layout save
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  dock = await dockIds(page);
  H.check('a reload keeps the first-run sidebar (not taken for a pre-store browser)',
    dock.length === ESSENTIAL.length + FIXED.length, JSON.stringify(dock));

  // ---- a shortcut opens (and adds) a store window; ≡ menu removes it ------
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down('Shift'); await page.keyboard.down('Alt');
  await page.keyboard.press('KeyK'); // Symmetry
  await page.keyboard.up('Alt'); await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  dock = await dockIds(page);
  H.check('opening a store window by shortcut adds it to the sidebar', dock.includes('symmetry'), JSON.stringify(dock));

  const menu = await page.evaluate(async () => {
    const el = document.querySelector('#dock > .cv-panel[data-panel-id="symmetry"]');
    el.querySelector('.cv-panel-menu-btn').click();
    await new Promise((r) => setTimeout(r, 100));
    const items = [...document.querySelectorAll('.cv-panel-menu .cv-panel-menu-item')];
    const remove = items.find((b) => b.textContent === 'Remove from sidebar');
    if (remove) remove.click();
    await new Promise((r) => setTimeout(r, 200));
    return { hadItem: !!remove, gone: !document.querySelector('#dock > .cv-panel[data-panel-id="symmetry"]') };
  });
  H.check('the ≡ menu offers "Remove from sidebar" and it works', menu.hadItem && menu.gone, JSON.stringify(menu));

  // ---- persistence + Reset UI ---------------------------------------------
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.addStoreFeature('planes', { expand: false });
  });
  await page.waitForTimeout(400); // debounced layout save
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  dock = await dockIds(page);
  // Added in a session that has a remembered layout: it takes its default
  // slot (Crystal Planes sits before Cell & Supercell), not the end below Settings.
  H.check('an added window is still in the sidebar after a reload, in its default slot',
    dock.join() === 'files,features,visual,planes,cell,settings', JSON.stringify(dock));

  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.resetAllPanels();
  });
  await page.waitForTimeout(300);
  dock = await dockIds(page);
  H.check('Reset UI keeps the feature selection', dock.includes('planes') && !dock.includes('eos'), JSON.stringify(dock));

  // ---- presets -------------------------------------------------------------
  await page.click('#featureStoreButton');
  await page.waitForTimeout(200);
  await page.click('.feature-store-preset[data-preset="all"]');
  await page.waitForTimeout(400);
  let st = await storeState(page);
  dock = await dockIds(page);
  H.check('Add all puts every store panel in the sidebar', st.every((f) => f.inSidebar)
    && st.filter((f) => f.id !== 'trajectory' && f.id !== 'latticeAnalysis' && f.id !== 'phonon').every((f) => dock.includes(f.id)),
    JSON.stringify(st.filter((f) => !f.inSidebar)));
  // The choice is written at once, not debounced: reload straight away.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  st = await storeState(page);
  H.check('Add all survives an immediate reload', st.length > 0 && st.every((f) => f.inSidebar),
    JSON.stringify(st.filter((f) => !f.inSidebar)));

  await page.click('#featureStoreButton');
  await page.waitForTimeout(200);
  await page.click('.feature-store-preset[data-preset="essentials"]');
  await page.waitForTimeout(400);
  st = await storeState(page);
  dock = await dockIds(page);
  H.check('Reset to Essentials leaves only the essentials',
    st.filter((f) => f.inSidebar).map((f) => f.id).sort().join() === [...ESSENTIAL].sort().join()
      && dock.length === ESSENTIAL.length + FIXED.length,
    JSON.stringify(dock));
  const removedCount = st.length - ESSENTIAL.length;
  let notice = await page.evaluate(() => ({
    shown: !document.getElementById('featureStoreNotice').hidden,
    text: document.getElementById('featureStoreNoticeText').textContent,
  }));
  H.check('...and says what it removed', notice.shown && notice.text === `Removed ${removedCount} panels from the sidebar.`, JSON.stringify(notice));
  await page.click('#featureStoreUndo');
  await page.waitForTimeout(400);
  st = await storeState(page);
  H.check('Undo puts every panel back', st.every((f) => f.inSidebar), JSON.stringify(st.filter((f) => !f.inSidebar)));

  // The sidebar's "Reset to Essentials" asks first, naming what it removes,
  // without opening the Panels dialog; Cancel changes nothing.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.click('#resetEssentialsButton');
  await page.waitForTimeout(300);
  const ask = await page.evaluate(() => ({
    open: !document.getElementById('confirmModal').hidden,
    title: document.getElementById('confirmModalTitle').textContent,
    message: document.getElementById('confirmModalMessage').textContent,
    panelsDialog: !document.getElementById('featureStoreModal').hidden,
  }));
  H.check('the sidebar\'s "Reset to Essentials" asks first, naming the panels it removes',
    ask.open && ask.title === 'Reset to Essentials?' && !ask.panelsDialog
      && ask.message.startsWith(`Removing ${removedCount} panels from the sidebar: `) && /Bonds/.test(ask.message),
    JSON.stringify(ask));
  await page.click('#resetEssentialsCancel');
  await page.waitForTimeout(300);
  st = await storeState(page);
  H.check('...Cancel leaves the sidebar as it was', st.every((f) => f.inSidebar), JSON.stringify(st.filter((f) => !f.inSidebar)));
  await page.click('#resetEssentialsButton');
  await page.waitForTimeout(300);
  await page.click('#resetEssentialsConfirm');
  await page.waitForTimeout(400);
  st = await storeState(page);
  H.check('...and confirming leaves only the essentials',
    st.filter((f) => f.inSidebar).map((f) => f.id).sort().join() === [...ESSENTIAL].sort().join(),
    JSON.stringify(st.filter((f) => f.inSidebar).map((f) => f.id)));
  await page.click('#featureStoreButton');
  await page.waitForTimeout(200);
  await page.click('.feature-store-preset[data-preset="essentials"]');
  await page.waitForTimeout(400);
  notice = await page.evaluate(() => document.getElementById('featureStoreNotice').hidden);
  await page.click('.feature-store-preset[data-preset="essentials"]');
  await page.waitForTimeout(200);
  const again = await page.evaluate(() => ({
    text: document.getElementById('featureStoreNoticeText').textContent,
    undo: !document.getElementById('featureStoreUndo').hidden,
  }));
  H.check('resetting an already-essential sidebar says so, without an Undo',
    !notice && /already shows only the essentials/.test(again.text) && !again.undo, JSON.stringify(again));
  await page.click('.feature-store-card[data-feature-id="symmetry"] .feature-store-toggle');
  await page.keyboard.press('Escape');
  const want = [...ESSENTIAL, 'symmetry'].sort().join();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  st = await storeState(page);
  H.check('Essentials + one added window survive an immediate reload',
    st.filter((f) => f.inSidebar).map((f) => f.id).sort().join() === want, JSON.stringify(st.filter((f) => f.inSidebar)));

  // A new browser session on the same profile (what closing and reopening the
  // browser amounts to): the saved storage alone brings the sidebar back.
  const restored = await browser.newContext({ viewport: { width: 1400, height: 900 }, storageState: await page.context().storageState() });
  const page2 = await restored.newPage();
  await page2.goto(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html', { waitUntil: 'load', timeout: 90000 });
  await page2.waitForTimeout(5000);
  const restoredState = await storeState(page2);
  const restoredDock = await dockIds(page2);
  // ...in its default slot (after Cell & Supercell), not at the top: it was
  // added back before the debounced layout save could record a slot.
  H.check('a new browser session restores the same sidebar, in default order',
    restoredState.filter((f) => f.inSidebar).map((f) => f.id).sort().join() === want
      && restoredDock.join() === 'files,features,visual,cell,symmetry,settings', JSON.stringify(restoredDock));
  await restored.close();

  // Back to the essentials for the data-hint section below.
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.removeStoreFeature('symmetry');
  });

  // ---- data hint ------------------------------------------------------------
  const badgeBefore = await page.evaluate(() => document.getElementById('featureStoreBadge').hidden);
  await page.evaluate(async (outcar) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(outcar, 'OUTCAR_store');
  }, OUTCAR);
  await page.waitForTimeout(2500);
  const badge = await page.evaluate(() => {
    const b = document.getElementById('featureStoreBadge');
    return { hidden: b.hidden, text: b.textContent, title: b.title };
  });
  st = await storeState(page);
  const hinted = st.filter((f) => f.suggested).map((f) => f.id);
  H.check('a trajectory with forces is hinted: Trajectory, Forces, Lattice Analysis (not Spins: all-zero moments)',
    ['trajectory', 'forces', 'latticeAnalysis'].every((id) => hinted.includes(id)) && !hinted.includes('spins'), JSON.stringify(hinted));
  H.check('the button shows the hint count', badgeBefore && !badge.hidden && /^\d+ with data$/.test(badge.text) && /Trajectory/.test(badge.title), JSON.stringify(badge));

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors (first-run browser)', real.length === 0, real.join(' | '));
  await browser.close();

  // ---- a browser from before the store ----------------------------------------
  const second = await H.launchApp({ firstRunFeatures: true, navigate: false });
  await second.page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.removeItem('featureStore');
      localStorage.setItem('panelLayout', JSON.stringify({ version: 4, dockOrder: [], panels: {}, rightDock: {} }));
    }
  });
  await second.page.goto(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html', { waitUntil: 'load', timeout: 90000 });
  await second.page.waitForTimeout(5000);
  const st2 = await storeState(second.page);
  const rec = await second.page.evaluate(() => JSON.parse(localStorage.getItem('featureStore') || 'null'));
  H.check('a pre-store browser keeps every store window', st2.length > 0 && st2.every((f) => f.inSidebar), JSON.stringify(st2.filter((f) => !f.inSidebar)));
  H.check('...and records that, so a later Reset UI does not change it', !!rec && rec.allByDefault === true, JSON.stringify(rec));
  const real2 = second.errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors (pre-store browser)', real2.length === 0, real2.join(' | '));
  await H.finish(second.browser);
})().catch(H.crash);
