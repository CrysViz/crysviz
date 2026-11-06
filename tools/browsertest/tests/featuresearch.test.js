// Feature search palette (docs/ui/FeatureSearch.js), on a first-run browser
// (only the essential windows in the sidebar):
//   - Ctrl+F opens it with the input focused; Ctrl+F again closes it and is
//     NOT prevented (the browser's own find gets that press); the sidebar
//     field opens it too; Escape closes
//   - the search vocabulary: "lattice vibrations" -> Phonons, "relaxation" ->
//     Atomistic, "geometry optimization" -> Atomistic (British phrase), ...
//   - fuzzy: a typo ("phonom"), initials ("rbl") and word prefixes find
//     their targets; window results carry their keyboard shortcut
//   - a control in a store window is badged "Not in sidebar"; choosing it
//     adds the window, selects its tab (Atomistic ▸ MD), and focuses it
//   - a control in a sidebar window: Visual ▸ Atom Size is scrolled to,
//     flashed and focused — unfolding the sidebar first when it is hidden
//   - a popup-menu item (Files ▸ Download ▸ CASTEP cell) opens its menu
//   - a Structure-window tab control (Bonds ▸ Reset Bond Lengths) opens the
//     formula box on the Bonds tab
//   - View / Measure / Structure keep their folded title bar
//   - the Structure window's content: an element ("cu", "copper"), a bond
//     pair either way round ("o-cu"), a single atom ("O5", selected as if
//     picked in 3D), a polyhedra category, a Wyckoff site — each opens the
//     right tab at its row
//   - actions run: "Add panels" opens the panels popup; "Reset to
//     essentials" resets the sidebar there, with its Undo on screen
'use strict';
const H = require('../harness');

// The P6_3/m cell of wyckoffeditor.test.js: three Wyckoff orbits (C1 6h,
// N1 6h, N2 2d) once symmetry is detected.
const C6N8_POSCAR = `C6 N8
1.0
   3.2252631334172732   -5.5863196148575156    0.0000000000000000
   3.2252631334172732    5.5863196148575156    0.0000000000000000
   0.0000000000000000    0.0000000000000000    2.4231400000000001
C N
6 8
direct
   0.7732450000000001    0.5949050000000000    0.7500000000000000
   0.4050950000000000    0.1783400000000000    0.7500000000000000
   0.8216599999999991    0.2267549999999990    0.7500000000000000
   0.2267549999999990    0.4050950000000000    0.2500000000000000
   0.5949050000000000    0.8216599999999991    0.2500000000000000
   0.1783400000000000    0.7732450000000001    0.2500000000000000
   0.0333069999999990    0.7034199999999990    0.7500000000000000
   0.2965800000000000    0.3298870000000000    0.7500000000000000
   0.6701130000000000    0.9666929999999990    0.7500000000000000
   0.9666929999999990    0.2965800000000000    0.2500000000000000
   0.7034199999999990    0.6701130000000000    0.2500000000000000
   0.3298870000000000    0.0333069999999990    0.2500000000000000
   0.6666666666666661    0.3333333333333330    0.7500000000000000
   0.3333333333333330    0.6666666666666661    0.2500000000000000
`;


async function results(page, query) {
  return page.evaluate(async (q) => {
    const fs = await import('./ui/FeatureSearch.js');
    fs.openFeatureSearch(q);
    await new Promise((r) => requestAnimationFrame(() => r()));
    return [...document.querySelectorAll('#featureSearchResults .feature-search-result')].map((li) => ({
      type: li.dataset.type,
      label: li.querySelector('.feature-search-label').textContent,
      path: li.querySelector('.feature-search-path')?.textContent || '',
      badge: li.querySelector('.feature-search-badge')?.textContent || '',
      kbd: li.querySelector('.feature-search-kbd')?.textContent || '',
    }));
  }, query);
}

/** Type a query into the open palette and press Enter on result `index`. */
async function choose(page, query, pick) {
  const list = await results(page, query);
  const index = list.findIndex(pick);
  if (index < 0) return { list, index };
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  return { list, index };
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ firstRunFeatures: true });

  // ---- open / close ---------------------------------------------------------
  await page.mouse.click(900, 450); // focus the page (the scene), no control
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => ({
    open: !document.getElementById('featureSearchOverlay')?.hidden,
    focused: document.activeElement?.id === 'featureSearchInput',
    count: document.querySelectorAll('#featureSearchResults .feature-search-result').length,
  }));
  H.check('Ctrl+F opens the palette with the input focused', opened.open && opened.focused && opened.count > 5, JSON.stringify(opened));

  const second = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true });
    document.getElementById('featureSearchInput').dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, open: !document.getElementById('featureSearchOverlay').hidden };
  });
  H.check('Ctrl+F again closes it and leaves the press to the browser', !second.open && !second.prevented, JSON.stringify(second));

  await page.click('#featureSearchButton');
  await page.waitForTimeout(200);
  H.check('the sidebar search field opens it', await page.evaluate(() => !document.getElementById('featureSearchOverlay').hidden));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  H.check('Escape closes it', await page.evaluate(() => document.getElementById('featureSearchOverlay').hidden));

  // ---- matching ---------------------------------------------------------------
  let list = await results(page, 'phonom');
  H.check('a typo finds the window ("phonom" -> Phonons)', list[0]?.label === 'Phonons' && list[0]?.type === 'window', JSON.stringify(list.slice(0, 3)));
  H.check('a store window is badged "Not in sidebar"', /Not in sidebar/.test(list[0]?.badge), list[0]?.badge);

  list = await results(page, 'rbl');
  H.check('initials find a control ("rbl" -> Reset Bond Lengths)', list[0]?.label === 'Reset Bond Lengths', JSON.stringify(list.slice(0, 3)));
  list = await results(page, 'supercell');
  H.check('a word finds window and controls ("supercell")', list.some((r) => r.label === 'Cell & Supercell' && r.type === 'window'),
    JSON.stringify(list.slice(0, 4)));
  list = await results(page, 'symmetry');
  const sym = list.find((r) => r.type === 'window' && r.label === 'Symmetry');
  H.check('a window result shows its shortcut', !!sym && /K$/.test(sym.kbd), JSON.stringify(sym));
  list = await results(page, 'castep');
  H.check('popup-menu items are searchable ("castep" -> Download › CASTEP cell)',
    list[0]?.label === 'CASTEP cell' && /Download/.test(list[0]?.path), JSON.stringify(list.slice(0, 2)));

  // ---- the search vocabulary (search/concepts.js) ------------------------------
  // What people call a feature when they don't know its CrysViz name; word
  // forms and British/American spelling are folded (search/fuzzy.js stem()).
  for (const [query, want, why] of [
    ['lattice vibrations', 'Phonons', 'lattice vibrations'],
    ['vibrational modes', 'Phonons', 'vibrational modes'],
    ['density of states', 'Phonons', 'density of states'],
    ['relaxation', 'Atomistic', 'relaxation'],
    ['geometry optimization', 'Atomistic', 'geometry optimisation'],
    ['molecular dynamics', 'Atomistic', 'molecular dynamics'],
    ['space group', 'Symmetry', null],
    ['charge density', 'Volumetric Field', null],
    ['magnetic moments', 'Spins', 'magnetic moments'],
    ['make supercell', 'Cell & Supercell', 'make supercell'],
    ['screenshot', 'Image', 'screenshot'],
    ['bond angle', 'Angle', 'bond angle'],
    ['equation of state', 'EOS Fitting', null],
  ]) {
    list = await results(page, query);
    const top = list[0] || {};
    H.check(`"${query}" -> ${want}${why ? ` (≈ ${why})` : ''}`,
      top.label === want && (!why || top.path.includes(`≈ ${why}`)), JSON.stringify(list.slice(0, 3)));
  }

  // ---- a control in a store window --------------------------------------------
  let r = await choose(page, 'npt', (x) => x.label === 'NPT');
  H.check('a store-window control is badged before choosing it', /Not in sidebar/.test(r.list[r.index]?.badge || ''), JSON.stringify(r.list.slice(0, 3)));
  let state = await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    const npt = [...document.querySelectorAll('#dock .cv-panel[data-panel-id="backend"] button')].find((b) => b.textContent.trim() === 'NPT');
    const md = document.querySelector('#BackendModeSwitch button[data-mode="md"]');
    return {
      inSidebar: pm.isPanelInSidebar('backend'),
      docked: !!document.querySelector('#dock > .cv-panel[data-panel-id="backend"]'),
      mdActive: !!md && md.classList.contains('md'), // the switch marks its mode by class
      focused: document.activeElement === npt,
    };
  });
  H.check('choosing it adds the window, selects the MD tab and focuses the control',
    state.inSidebar && state.docked && state.mdActive && state.focused, JSON.stringify(state));

  // ---- a control in a sidebar window, with the sidebar folded away (☰) -------
  await page.click('#mobileMenuToggle');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => document.getElementById('ui').classList.contains('panel-hidden'));
  r = await choose(page, 'atom size', (x) => x.label === 'Atom Size');
  H.check('jumping into a folded sidebar unfolds it first', hidden
    && await page.evaluate(() => !document.getElementById('ui').classList.contains('panel-hidden')));
  state = await page.evaluate(() => {
    const el = document.getElementById('atomSize');
    const rect = el.getBoundingClientRect();
    return {
      focused: document.activeElement === el,
      onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0,
      visualOpen: !document.querySelector('.cv-panel[data-panel-id="visual"]').classList.contains('cv-collapsed'),
      top: r0(rect.top),
    };
    function r0(v) { return Math.round(v); }
  });
  H.check('Visual › Atom Size: scrolled to, focused, window open', r.index >= 0 && state.focused && state.onScreen && state.visualOpen, JSON.stringify(state));

  // ---- popup menu item --------------------------------------------------------
  r = await choose(page, 'castep', (x) => x.label === 'CASTEP cell');
  state = await page.evaluate(() => ({
    menuOpen: !document.getElementById('downloadMenu').hidden,
    focused: document.activeElement?.id === 'saveCellButton',
  }));
  H.check('Download › CASTEP cell opens the menu and focuses the item', state.menuOpen && state.focused, JSON.stringify(state));
  await page.keyboard.press('Escape');
  await page.mouse.click(900, 450);

  // ---- a Structure-window tab ---------------------------------------------------
  r = await choose(page, 'reset bond lengths', (x) => x.label === 'Reset Bond Lengths');
  state = await page.evaluate(() => {
    const btn = document.querySelector('#atomBondControlSwitch button[data-mode="bonds"]');
    const target = [...document.querySelectorAll('.cv-panel[data-panel-id="info"] button')].find((b) => b.textContent.trim() === 'Reset Bond Lengths');
    return {
      boxOpen: !!document.getElementById('composition')?.classList.contains('open'),
      bondsTab: !!btn && btn.classList.contains('active'),
      focused: !!target && document.activeElement === target,
    };
  });
  H.check('Structure › Bonds › Reset Bond Lengths opens the box on the Bonds tab', r.index >= 0 && state.boxOpen && state.bondsTab && state.focused, JSON.stringify(state));

  // ---- an action ------------------------------------------------------------------
  r = await choose(page, 'add panels', (x) => x.type === 'action' && x.label === 'Add panels');
  H.check('the "Add panels" action opens the panels popup', r.index >= 0 && await page.evaluate(() => !document.getElementById('featureStoreModal').hidden));
  await page.keyboard.press('Escape');

  // Atomistic was added by the NPT jump above: resetting removes it again.
  r = await choose(page, 'reset sidebar', (x) => x.type === 'action' && x.label === 'Reset to Essentials');
  const ask = await page.evaluate(() => ({
    open: !document.getElementById('confirmModal').hidden,
    message: document.getElementById('confirmModalMessage').textContent,
  }));
  if (ask.open) {
    await page.click('#resetEssentialsConfirm');
    await page.waitForTimeout(400);
  }
  state = await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).isPanelInSidebar('backend'));
  H.check('"Reset to Essentials" from search asks first, naming Atomistic, then resets',
    r.index >= 0 && ask.open && /^Removing \d+ panels? from the sidebar: .*Atomistic/.test(ask.message) && state === false,
    JSON.stringify({ ask, backendInSidebar: state }));
  await page.keyboard.press('Escape');

  // ---- scene windows keep their folded title bar ------------------------------
  // View / Measure / Structure float with the title bar shrunk to a strip by
  // default; the search (like a keyboard shortcut) must not restore it.
  const bars = () => page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    return Object.fromEntries(['view', 'measure', 'info'].map((id) => [id, pm.getPanel(id).barCollapsed]));
  });
  const barsBefore = await bars();
  await page.mouse.click(900, 450);
  r = await choose(page, 'view x axis', (x) => x.label === 'View X axis');
  const xFocused = await page.evaluate(() => document.activeElement?.id === 'viewX');
  r = await choose(page, 'measure', (x) => x.type === 'window' && x.label === 'Measure');
  r = await choose(page, 'structure', (x) => x.type === 'window' && x.label === 'Structure');
  const barsAfter = await bars();
  H.check('View/Measure/Structure title bars stay as they were (search into View, open Measure and Structure)',
    xFocused && JSON.stringify(barsBefore) === JSON.stringify(barsAfter) && barsBefore.view && barsBefore.measure,
    JSON.stringify({ barsBefore, barsAfter, xFocused }));

  // ...and their flash rings the visible box, not the folded strip's row above it.
  await page.mouse.click(900, 450);
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(150);
  await page.keyboard.type('view', { delay: 30 });
  await page.waitForTimeout(250);
  const viewIdx = await page.evaluate(() => [...document.querySelectorAll('#featureSearchResults .feature-search-result')]
    .findIndex((li) => li.dataset.type === 'window' && li.querySelector('.feature-search-label').textContent === 'View'));
  for (let i = 0; i < viewIdx; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const flashed = await page.waitForFunction(() => {
    const view = document.querySelector('.cv-panel[data-panel-id="view"]');
    const f = view?.classList.contains('cv-shortcut-flash') ? view : view?.querySelector('.cv-shortcut-flash');
    if (!f) return null;
    const strip = view.querySelector('.cv-panel-titlebar').getBoundingClientRect();
    return { isBody: f.classList.contains('cv-panel-body'), belowStrip: f.getBoundingClientRect().top >= strip.bottom };
  }, null, { timeout: 4000, polling: 16 }).then((h) => h.jsonValue()).catch(() => null);
  H.check('the View window flash rings its body, below the folded title strip', !!flashed && flashed.isBody && flashed.belowStrip, JSON.stringify(flashed));
  await page.waitForTimeout(600);

  // ---- the Structure window's own content ---------------------------------------
  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  list = await results(page, 'cu');
  H.check('an element of the structure is a result ("cu" -> Element Cu)',
    list[0]?.type === 'structure' && list[0]?.label === 'Cu' && /Atoms · Copper/.test(list[0]?.path), JSON.stringify(list.slice(0, 3)));
  list = await results(page, 'copper');
  H.check('...found by its name too ("copper")', list[0]?.label === 'Cu', JSON.stringify(list.slice(0, 2)));
  await page.keyboard.press('Escape');
  r = await choose(page, 'cu', (x) => x.type === 'structure' && x.label === 'Cu');
  state = await page.evaluate(() => {
    const row = document.querySelector('#atomPanel .comp-container[data-element="Cu"] .comp-row');
    const rect = row?.getBoundingClientRect();
    return {
      boxOpen: !!document.getElementById('composition')?.classList.contains('open'),
      atomsTab: !!document.querySelector('#atomBondControlSwitch button[data-mode="atoms"].active'),
      rowOnScreen: !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  H.check('choosing Cu opens the formula box on Atoms with the Cu row in view', state.boxOpen && state.atomsTab && state.rowOnScreen, JSON.stringify(state));

  list = await results(page, 'o-cu');
  H.check('a bond pair is found either way round ("o-cu" -> Cu-O)', list[0]?.type === 'structure' && list[0]?.label === 'Cu-O' && /Bonds/.test(list[0]?.path), JSON.stringify(list.slice(0, 2)));
  await page.keyboard.press('Escape');
  r = await choose(page, 'cu-o', (x) => x.type === 'structure' && x.label === 'Cu-O');
  state = await page.evaluate(() => {
    const ctl = document.querySelector('.bond-control[data-pair="Cu-O"]');
    const rect = ctl?.getBoundingClientRect();
    return {
      bondsTab: !!document.querySelector('#atomBondControlSwitch button[data-mode="bonds"].active'),
      onScreen: !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  H.check('choosing Cu-O switches to Bonds with the pair in view', r.index >= 0 && state.bondsTab && state.onScreen, JSON.stringify(state));

  // "colour" leads with the Structure window's colour dots: choosing a dots
  // result opens its tab and flashes every dot.
  for (const [label, mode, selector] of [
    ['Element colors', 'atoms', '#atomPanel .comp-container .dot'],
    ['Bond pair colors', 'bonds', '.bond-control[data-pair] .bond-cat-dot'],
  ]) {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__flashed = new Set();
      w.__flashObs?.disconnect();
      w.__flashObs = new MutationObserver((ms) => ms.forEach((m) => {
        if (/** @type {Element} */ (m.target).classList?.contains('cv-dot-flash')) w.__flashed.add(m.target);
      }));
      w.__flashObs.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    });
    r = await choose(page, 'colour', (x) => x.type === 'structure' && x.label === label);
    state = await page.evaluate(({ mode, selector }) => {
      const dots = [...document.querySelectorAll(selector)];
      const flashed = /** @type {any} */ (window).__flashed;
      return {
        tab: !!document.querySelector(`#atomBondControlSwitch button[data-mode="${mode}"].active`),
        dots: dots.length,
        flashed: dots.filter((d) => flashed.has(d)).length,
      };
    }, { mode, selector });
    H.check(`"colour" lists ${label} first and choosing it flashes every dot`,
      r.index >= 0 && r.index <= 1 && state.tab && state.dots > 0 && state.flashed === state.dots, JSON.stringify({ index: r.index, ...state }));
  }

  r = await choose(page, 'o5', (x) => x.type === 'structure' && x.label === 'O5');
  state = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const sel = (await import('./ui/SelectAndHighlightModule.js')).getSelectedAtoms();
    const want = fileBrowser.selectedStructure.elements.map((e, i) => [e, i]).filter(([e]) => e === 'O')[4][1];
    const row = [...document.querySelectorAll('#atomPanel .individual-atom-row')].find((el) => el.querySelector('.iar-name')?.textContent.trim() === 'O5');
    const rect = row?.getBoundingClientRect();
    return {
      want,
      selected: sel.map((a) => a.atomIndex ?? a.index ?? a.sourceIndex),
      rowOnScreen: !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  H.check('choosing atom O5 selects it and brings its row into view',
    r.index >= 0 && state.selected.includes(state.want) && state.rowOnScreen, JSON.stringify(state));

  // A polyhedra category (Poly tab, polyhedra on).
  await page.evaluate(() => {
    const cb = document.getElementById('showPolyhedra');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1500);
  const cat = await page.evaluate(() => document.querySelector('.poly-control .phl-cat-label')?.textContent.trim());
  r = await choose(page, cat || 'no polyhedra', (x) => x.type === 'structure' && x.label === cat);
  state = await page.evaluate(() => {
    const ctl = document.querySelector('.poly-control');
    const rect = ctl?.getBoundingClientRect();
    return {
      polyTab: !!document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"].active'),
      onScreen: !!rect && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  H.check(`a polyhedra category is a result ("${cat}") and opens the Poly tab at it`, !!cat && r.index >= 0 && state.polyTab && state.onScreen, JSON.stringify(state));

  // A Wyckoff site (symmetry-generated structure: the Wyckoff tab replaces Atoms).
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'C6N8');
  }, C6N8_POSCAR);
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('symmetry');
  });
  await page.waitForTimeout(1500);
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
  list = await results(page, 'n2 2d');
  H.check('a Wyckoff site is a result ("n2 2d" -> N2 2d)', list[0]?.type === 'structure' && list[0]?.label === 'N2 2d', JSON.stringify(list.slice(0, 2)));
  await page.keyboard.press('Escape');
  r = await choose(page, 'n2 2d', (x) => x.type === 'structure' && x.label === 'N2 2d');
  state = await page.evaluate(async () => {
    const sel = (await import('./ui/SelectAndHighlightModule.js')).getSelectedAtoms();
    return {
      wyckoffTab: !!document.querySelector('#atomBondControlSwitch button[data-mode="wyckoff"].active'),
      selected: sel.map((a) => a.atomIndex ?? a.index ?? a.sourceIndex),
    };
  });
  H.check('choosing it opens the Wyckoff tab and selects the site', r.index >= 0 && state.wyckoffTab && state.selected.includes(12), JSON.stringify(state));

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
