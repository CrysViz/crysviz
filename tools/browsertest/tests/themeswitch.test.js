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


  await pickMode(page, 'light');
  const lightBg = await sceneBg(page);
  const lightHref = await activeStyleHref(page);
  H.check('Light resolves to a DIFFERENT scene color than Dark (modes actually differ)',
    lightBg !== '' && lightBg !== dark.sceneBg.toLowerCase(),
    `dark=${dark.sceneBg} light=${lightBg}`);
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

  // ---- switching PALETTE repaints the chrome, not just the scene -----------
  // The mode axis only ever moved --scene-bg; a palette has to reach the panel
  // itself, which is the whole point of the two-axis split.
  const second = registry.palettes[1];
  if (second) {
    await pickMode(page, 'dark');
    const before = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        panel: cs.getPropertyValue('--panel-bg').trim(),
        scene: cs.getPropertyValue('--scene-bg').trim(),
      };
    });
    await pickPalette(page, second.id);
    const after = await page.evaluate(async () => {
      const { app } = await import('./state/store.js');
      const cs = getComputedStyle(document.documentElement);
      return {
        panel: cs.getPropertyValue('--panel-bg').trim(),
        scene: cs.getPropertyValue('--scene-bg').trim(),
        dataPalette: document.documentElement.getAttribute('data-palette'),
        appBg: '#' + app.scene.background.getHexString(),
        // A palette must disable any mode button it cannot render, rather than
        // leave a selection pointing at a mode with no stylesheet.
        modeState: [...document.querySelectorAll('.theme-btn[data-theme-option]')]
          .map((el) => [el.dataset.themeOption, el.disabled]),
      };
    });
    H.check(`switching to the ${second.id} palette repaints the PANEL, not only the scene`,
      after.panel !== before.panel && after.panel !== '',
      `before=${before.panel} after=${after.panel}`);
    H.check(`switching to the ${second.id} palette also moves the scene into three.js`,
      after.scene !== before.scene && after.appBg.toLowerCase() === after.scene.toLowerCase(),
      JSON.stringify({ before, after }));
    H.check('the palette is stamped on <html data-palette>',
      after.dataPalette === second.id, JSON.stringify(after));
    H.check('a mode the palette does not offer is disabled, not silently broken',
      after.modeState.every(([id, off]) =>
        off === (id !== 'auto' && !Object.prototype.hasOwnProperty.call(second.modes, id))),
      `${second.id} modes=${JSON.stringify(Object.keys(second.modes))} row=${JSON.stringify(after.modeState)}`);
  }

  // The side panel is a fixed width; anything that overflows it horizontally
  // is a bug, not a scroll affordance. A fourth mode button pinned at a
  // hardcoded `left: 286px` is what put a scrollbar there.
  const overflow = await page.evaluate(async () => {
    const reg = await (await fetch('./themes/themes.json')).json();
    const ui = document.getElementById('ui');
    const out = [];
    for (const p of reg.palettes) {
      for (const mode of Object.keys(p.modes)) {
        document.querySelector(`.theme-btn[data-theme-option="${mode}"]`).click();
        document.querySelector(`.theme-menu-item[data-palette-id="${p.id}"]`).click();
        await new Promise((r) => requestAnimationFrame(r));
        if (ui.scrollWidth > ui.clientWidth + 1) {
          out.push(`${p.id}/${mode}: ${ui.scrollWidth} > ${ui.clientWidth}`);
        }
      }
    }
    return out;
  });
  H.check('the side panel never scrolls horizontally, in any palette or mode',
    overflow.length === 0, overflow.join('; '));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
