// Theming (ui/ThemeManager.js + themes/themes.json) — the whole CSS
// consolidation exists to make this work: switching the theme must actually
// change resolved colors, not just toggle a class. This is what stops a
// future refactor from silently severing a theme from the app (e.g. renaming
// a token in theme.css without updating ThemeManager's reader, or vice
// versa). Assertions target the RELATIONSHIP (a value changes between
// themes, a stylesheet actually loaded) rather than pinning exact palette
// values, per CLAUDE.md.
//
// Theming is two axes: a PALETTE from the dropdown and a MODE from the icon
// row. The registry is read from themes.json rather than hardcoded here, so
// adding a palette doesn't break this file — only the mode ids, which are
// structural (they are the icon row), are named directly.
'use strict';
const H = require('../harness');

async function sceneBg(page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim().toLowerCase());
}

async function activeStyleHref(page) {
  return page.evaluate(() => document.getElementById('theme-active')?.getAttribute('href'));
}

async function pickMode(page, id) {
  await page.evaluate((id) => document.querySelector(`.theme-btn[data-theme-option="${id}"]`).click(), id);
  await page.waitForTimeout(300); // theme CSS loads async (link 'load' event)
}

async function pickPalette(page, id) {
  await page.evaluate((id) => document.querySelector(`.theme-menu-item[data-palette-id="${id}"]`).click(), id);
  await page.waitForTimeout(300);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const registry = await page.evaluate(async () => {
    const res = await fetch('./themes/themes.json');
    return res.json();
  });

  // ---- switching modes changes the resolved scene color --------------------
  await pickMode(page, 'dark');
  const dark = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      dataPalette: document.documentElement.getAttribute('data-palette'),
      sceneBg: getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim(),
      appBg: '#' + app.scene.background.getHexString(),
      storedMode: localStorage.getItem('theme'),
      storedPalette: localStorage.getItem('themePalette'),
      activeBtn: document.querySelector('.theme-btn.active')?.dataset.themeOption,
    };
  });
  H.check('picking Dark stamps the effective mode and the palette, and persists both',
    dark.dataTheme === 'dark' && dark.storedMode === 'dark'
    && dark.dataPalette === registry.palettes[0].id && dark.storedPalette === registry.palettes[0].id,
    JSON.stringify(dark));
  H.check('picking Dark actually recolors the THREE.js scene (not just a class toggle)',
    dark.appBg.toLowerCase() === dark.sceneBg.toLowerCase(), JSON.stringify(dark));
  H.check('the mode row highlights the picked mode',
    dark.activeBtn === 'dark', JSON.stringify(dark));
  const darkHref = await activeStyleHref(page);
  H.check('a real theme stylesheet was applied (href points at dark/theme.css)',
    /dark\/theme\.css$/.test(darkHref || ''), String(darkHref));

  await pickMode(page, 'twilight');
  const twilightBg = await sceneBg(page);
  const twilightHref = await activeStyleHref(page);
  H.check('Twilight resolves to a DIFFERENT scene color than Dark (modes actually differ)',
    twilightBg !== '' && twilightBg !== dark.sceneBg.toLowerCase(), `dark=${dark.sceneBg} twilight=${twilightBg}`);
  H.check('Twilight loads its own stylesheet', /twilight\/theme\.css$/.test(twilightHref || ''), String(twilightHref));

  await pickMode(page, 'light');
  const lightBg = await sceneBg(page);
  const lightHref = await activeStyleHref(page);
  H.check('Light differs from both Dark and Twilight',
    lightBg !== dark.sceneBg.toLowerCase() && lightBg !== twilightBg,
    `dark=${dark.sceneBg} twilight=${twilightBg} light=${lightBg}`);
  // The Default palette maps Light to null — falling back to the base theme is
  // itself the behavior under test, not a missing feature.
  H.check('Default/Light has no override stylesheet (falls back cleanly to the base theme)',
    !lightHref, String(lightHref));

  // ---- the dropdown lists palettes, not modes -------------------------------
  await page.click('#themeMenuToggle');
  await page.waitForTimeout(150);
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll('#themeMenu .theme-menu-item')].map((el) => el.dataset.paletteId));
  const expectedPalettes = registry.palettes.map((p) => p.id);
  H.check('the dropdown lists exactly the registered palettes (and no modes)',
    menu.length === expectedPalettes.length && expectedPalettes.every((id) => menu.includes(id))
    && !menu.includes('dark') && !menu.includes('auto'),
    `menu=${JSON.stringify(menu)} registry=${JSON.stringify(expectedPalettes)}`);

  // ---- Auto is a mode, and follows the OS through the palette's pair --------
  await page.emulateMedia({ colorScheme: 'dark' });
  await pickMode(page, 'auto');
  const pair = registry.palettes[0].auto;
  let auto = await page.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute('data-theme'),
    stored: localStorage.getItem('theme'),
    activeBtn: document.querySelector('.theme-btn.active')?.dataset.themeOption,
    resolvedBtn: document.querySelector('.theme-btn.resolved')?.dataset.themeOption,
  }));
  H.check('Auto with the OS in dark mode resolves to the dark side of the palette pair',
    auto.dataTheme === pair[1] && auto.stored === 'auto', `${JSON.stringify(auto)} pair=${pair}`);
  H.check('the row highlights Auto as SELECTED and marks the mode it resolved to',
    auto.activeBtn === 'auto' && auto.resolvedBtn === pair[1], JSON.stringify(auto));

  // Live-follows the OS while Auto stays selected (no re-click needed).
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  const autoLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  H.check('Auto re-resolves live when the OS color scheme flips, without re-selecting it',
    autoLight === pair[0], `${autoLight} pair=${pair}`);

  // ---- a palette only offers the modes it registers -------------------------
  const modeState = await page.evaluate(() =>
    [...document.querySelectorAll('.theme-btn[data-theme-option]')]
      .map((el) => ({ id: el.dataset.themeOption, disabled: el.disabled })));
  const offered = Object.keys(registry.palettes[0].modes);
  H.check('modes the palette registers are enabled, the rest disabled, and Auto always available',
    modeState.every((m) => m.disabled === (m.id !== 'auto' && !offered.includes(m.id))),
    `${JSON.stringify(modeState)} offered=${JSON.stringify(offered)}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
