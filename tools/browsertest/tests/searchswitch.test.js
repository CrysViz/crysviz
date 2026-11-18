// Switching toggles from the feature search (FeatureSearch.js switchResults):
//   - Ctrl+F, "bonds off": the first result is "Show Bonds → off" (kind
//     Switch, "on now"); Enter switches the bonds off without going to the
//     toggle (no window opened, the palette closed); "bonds on" brings them
//     back; "show bonds: on", "turn off bonds", "switch on bonds" work too
//   - asking for the state it is in says so ("already on") and changes nothing
//   - "polyhedra on" draws the polyhedra
//   - a toggle whose window was never built: the result says its window opens
//     first, and Enter opens it and switches the toggle; "… off" right after
//     wins over the "on" still opening the window
//   - two-sided switches ("Perspective | Parallel") and queries without on/off
//     offer no switch; "on" alone offers none either
//   - each switch confirms in green at the top of the 3D view ("✓ Bonds
//     switched off", "✓ Bonds already off"), below a warning that is showing
//     (Forces + Spins), and goes away after a moment
'use strict';
const H = require('../harness');

async function typed(page, query) {
  await page.fill('#featureSearchInput', query);
  await page.waitForTimeout(150);
  return page.evaluate(() => [...document.querySelectorAll('#featureSearchResults .feature-search-result')].map((li) => ({
    type: li.dataset.type,
    kind: li.querySelector('.feature-search-kind')?.textContent || '',
    label: li.querySelector('.feature-search-label').textContent,
    path: li.querySelector('.feature-search-path')?.textContent || '',
  })));
}

async function openPalette(page) {
  await page.mouse.click(900, 450); // focus the scene, no control
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(250);
}

const switches = (list) => list.filter((r) => r.kind === 'Switch');

/** The green confirmation banner (ui/ConfirmBanner.js) as shown now. */
const CONFIRM = () => {
  const el = /** @type {HTMLElement|null} */ (document.querySelector('#view .cv-confirm-banner'));
  if (!el || getComputedStyle(el).display === 'none') return { shown: false };
  const probe = document.createElement('span');
  probe.style.color = 'var(--ok-bright)';
  document.body.appendChild(probe);
  const okBright = getComputedStyle(probe).color;
  probe.remove();
  const warning = document.querySelector('#view .cv-force-spin-warning');
  return {
    shown: true, text: el.textContent, green: getComputedStyle(el).color === okBright,
    top: el.getBoundingClientRect().top,
    warningBottom: warning && getComputedStyle(warning).display !== 'none' ? warning.getBoundingClientRect().bottom : null,
  };
};

const STATE = async () => {
  const { groups } = await import('./state/store.js');
  const { listPanels } = await import('./ui/panels/PanelManager.js');
  const checked = (id) => /** @type {HTMLInputElement|null} */ (document.getElementById(id))?.checked ?? null;
  return {
    bonds: checked('showBonds'),
    bondsDrawn: !!groups.bondsMesh?.visible && (groups.bondsMesh?.count ?? 0) > 0,
    polyhedra: checked('showPolyhedra'),
    polys: groups.polyhedraGroup?.children?.length ?? 0,
    open: listPanels().filter((p) => p.inSidebar && !p.closed && !p.collapsed).map((p) => p.id).sort().join(','),
    paletteOpen: document.getElementById('featureSearchOverlay')?.hidden === false,
  };
};

(async () => {
  const { browser, page, errors } = await H.launchApp({ firstRunFeatures: true });
  await H.loadDefaultStructure(page);
  const state = () => page.evaluate(STATE);
  const before = await state();
  H.check('bonds are on to start with', before.bonds === true && before.bondsDrawn, JSON.stringify(before));

  // ---- "bonds off" / "bonds on" ------------------------------------------------------------
  await openPalette(page);
  let list = await typed(page, 'bonds off');
  H.check('"bonds off": the first result switches Show Bonds off, and says it is on now',
    list[0]?.label === 'Show Bonds → off' && list[0]?.kind === 'Switch' && /on now$/.test(list[0]?.path), JSON.stringify(list.slice(0, 4)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const off = await state();
  H.check('Enter switches the bonds off, without opening a window; the palette closes',
    off.bonds === false && !off.bondsDrawn && off.open === before.open && !off.paletteOpen, JSON.stringify({ before, off }));
  const confirmed = await page.evaluate(CONFIRM);
  H.check('it confirms in green: "✓ Bonds switched off"', confirmed.shown && confirmed.text === '✓ Bonds switched off' && confirmed.green, JSON.stringify(confirmed));

  await openPalette(page);
  list = await typed(page, 'bonds off');
  H.check('asked again, it says it is already off', list[0]?.label === 'Show Bonds → off' && /already off$/.test(list[0]?.path), JSON.stringify(list[0]));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const again = await page.evaluate(CONFIRM);
  H.check('and Enter leaves it off, confirming "✓ Bonds already off"', (await state()).bonds === false && again.text === '✓ Bonds already off', JSON.stringify(again));
  await page.waitForTimeout(3000);
  H.check('the confirmation goes away after a moment', !(await page.evaluate(CONFIRM)).shown);

  await openPalette(page);
  list = await typed(page, 'show bonds: on');
  H.check('"show bonds: on" switches them back on', list[0]?.label === 'Show Bonds → on' && /off now$/.test(list[0]?.path), JSON.stringify(list[0]));
  // With the Forces + Spins warning on screen, the confirmation goes below it.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.forcesActive = true; general.spinsActive = true;
    (await import('./ui/ForceSpinWarningBanner.js')).updateForceSpinWarning();
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const on = await state();
  H.check('the bonds are drawn again', on.bonds === true && on.bondsDrawn, JSON.stringify(on));
  const below = await page.evaluate(CONFIRM);
  H.check('"✓ Bonds switched on" sits below the Forces + Spins warning', below.text === '✓ Bonds switched on' && below.warningBottom !== null && below.top >= below.warningBottom, JSON.stringify(below));
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.forcesActive = false; general.spinsActive = false;
    (await import('./ui/ForceSpinWarningBanner.js')).updateForceSpinWarning();
  });

  await openPalette(page);
  const turned = {};
  for (const q of ['turn off bonds', 'switch on bonds', 'Turn Off show bonds']) turned[q] = (await typed(page, q))[0]?.label;
  H.check('"turn off bonds", "switch on bonds" work too',
    turned['turn off bonds'] === 'Show Bonds → off' && turned['switch on bonds'] === 'Show Bonds → on' && turned['Turn Off show bonds'] === 'Show Bonds → off',
    JSON.stringify(turned));
  await page.keyboard.press('Escape');

  // ---- "polyhedra on" ------------------------------------------------------------------------
  await openPalette(page);
  list = await typed(page, 'polyhedra on');
  H.check('"polyhedra on" offers Show Polyhedra first', list[0]?.label === 'Show Polyhedra → on', JSON.stringify(switches(list)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  const poly = await state();
  H.check('Enter draws the polyhedra', poly.polyhedra === true && poly.polys > 0, JSON.stringify(poly));

  // ---- a toggle whose window was never built --------------------------------------------------
  const unbuilt = await page.evaluate(async () => {
    const { CONTROL_INDEX } = await import('./ui/search/controlIndex.js');
    // Polyhedra window settings: a store window, not built at a first start.
    const prefer = ['polyhedraChemicalFilterToggle', 'polyhedraUseWasmToggle', 'asuHighlightChk', 'disableLeaveWarningToggle'];
    const hit = prefer.map((id) => CONTROL_INDEX.find((c) => c.id === id)).find((c) => c && !document.getElementById(c.id));
    return hit ? { id: hit.id, label: hit.label } : null;
  });
  H.check('a Polyhedra window toggle is not in the page yet (its window never built)', !!unbuilt, JSON.stringify(unbuilt));
  if (unbuilt) {
    await openPalette(page);
    list = await typed(page, `${unbuilt.label} on`);
    const first = list[0];
    H.check('its switch result says the window opens first', first?.label === `${unbuilt.label} → on` && /opens its window first$/.test(first?.path), JSON.stringify(first));
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => document.getElementById(id)?.checked === true, unbuilt.id, { timeout: 8000 }).catch(() => {});
    const got = await page.evaluate((id) => ({ exists: !!document.getElementById(id), checked: document.getElementById(id)?.checked }), unbuilt.id);
    H.check('Enter opens the window and switches the toggle on', got.exists && got.checked === true, JSON.stringify(got));
    // Straight away, while the "on" is still scrolling its window to the
    // toggle: the late "on" must not undo this "off".
    await openPalette(page);
    list = await typed(page, `${unbuilt.label} off`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => document.getElementById(id)?.checked === false, unbuilt.id, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate((id) => ({ checked: document.getElementById(id)?.checked, count: document.querySelectorAll(`[id="${id}"]`).length }), unbuilt.id);
    H.check('and "… off" switches it off again', after.checked === false, JSON.stringify({ after, list: switches(list) }));
  }

  // ---- no switch -------------------------------------------------------------------------------
  await openPalette(page);
  const none = {};
  for (const q of ['parallel on', 'perspective off', 'bonds', 'on', 'off', 'show bonds onn']) none[q] = switches(await typed(page, q)).map((r) => r.label);
  H.check('two-sided switches, a query without on/off, or "on" alone offer no switch',
    Object.values(none).every((l) => l.length === 0), JSON.stringify(none));
  list = await typed(page, 'bonds off');
  H.check('the toggle itself is still in the list below its switch (to go to it)',
    list.some((r) => r.type === 'control' && r.label === 'Show Bonds'), JSON.stringify(list.slice(0, 8).map((r) => r.label)));
  await page.keyboard.press('Escape');

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
