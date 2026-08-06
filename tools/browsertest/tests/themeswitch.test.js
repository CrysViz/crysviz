// Theming (ui/ThemeManager.js + themes/themes.json) — the whole CSS
// consolidation exists to make this work: switching the theme must actually
// change resolved colors, not just toggle a class. This is what stops a
// future refactor from silently severing a theme from the app (e.g. renaming
// a token in theme.css without updating ThemeManager's reader, or vice
// versa). Assertions target the RELATIONSHIP (a value changes between
// themes, a stylesheet actually loaded) rather than pinning exact palette
// values, per CLAUDE.md.
'use strict';
const H = require('../harness');

async function sceneBg(page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim().toLowerCase());
}

async function activeStyleHref(page) {
  return page.evaluate(() => document.getElementById('theme-active')?.getAttribute('href'));
}

async function pickTheme(page, id) {
  await page.evaluate((id) => document.querySelector(`.theme-btn[data-theme-option="${id}"]`).click(), id);
  await page.waitForTimeout(300); // theme CSS loads async (link 'load' event)
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // ---- switching concrete themes changes the resolved scene color ----------
  await pickTheme(page, 'dark');
  const dark = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      sceneBg: getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim(),
      appBg: '#' + app.scene.background.getHexString(),
      storedSelection: localStorage.getItem('theme'),
      activeBtn: document.querySelector('.theme-btn.active')?.dataset.themeOption,
    };
  });
  H.check('picking Dark sets data-theme and persists the selection',
    dark.dataTheme === 'dark' && dark.storedSelection === 'dark', JSON.stringify(dark));
  H.check('picking Dark actually recolors the THREE.js scene (not just a class toggle)',
    dark.appBg.toLowerCase() === dark.sceneBg.toLowerCase(), JSON.stringify(dark));
  H.check('the dark icon in the toggle row reflects the effective theme',
    dark.activeBtn === 'dark', JSON.stringify(dark));
  const darkHref = await activeStyleHref(page);
  H.check('a real theme stylesheet was applied (href points at dark/theme.css)',
    /dark\/theme\.css$/.test(darkHref || ''), String(darkHref));

  await pickTheme(page, 'twilight');
  const twilightBg = await sceneBg(page);
  const twilightHref = await activeStyleHref(page);
  H.check('Twilight resolves to a DIFFERENT scene color than Dark (themes actually differ)',
    twilightBg !== '' && twilightBg !== dark.sceneBg.toLowerCase(), `dark=${dark.sceneBg} twilight=${twilightBg}`);
  H.check('Twilight loads its own stylesheet', /twilight\/theme\.css$/.test(twilightHref || ''), String(twilightHref));

  await pickTheme(page, 'light');
  const lightBg = await sceneBg(page);
  const lightHref = await activeStyleHref(page);
  H.check('Light differs from both Dark and Twilight',
    lightBg !== dark.sceneBg.toLowerCase() && lightBg !== twilightBg,
    `dark=${dark.sceneBg} twilight=${twilightBg} light=${lightBg}`);
  // Light has no override file (themes.json: css:null) — falling back to the
  // base theme is itself the behavior under test, not a missing feature.
  H.check('Light has no override stylesheet (falls back cleanly to the base theme)',
    !lightHref, String(lightHref));

  // ---- the dropdown lists every theme and Auto follows the OS setting ------
  await page.click('#themeMenuToggle');
  await page.waitForTimeout(150);
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll('#themeMenu .theme-menu-item')].map((el) => el.dataset.themeId));
  H.check('theme dropdown lists all four registry entries (incl. Auto)',
    ['auto', 'light', 'dark', 'twilight'].every((id) => menu.includes(id)) && menu.length === 4,
    JSON.stringify(menu));

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('#themeMenu .theme-menu-item[data-theme-id="auto"]');
  await page.waitForTimeout(300);
  let auto = await page.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute('data-theme'),
    menuActive: document.querySelector('.theme-menu-item.active')?.dataset.themeId,
    stored: localStorage.getItem('theme'),
  }));
  H.check('Auto with the OS in dark mode resolves to the dark side of the pair',
    auto.dataTheme === 'dark' && auto.stored === 'auto', JSON.stringify(auto));
  H.check('the dropdown highlights the SELECTION (Auto), separate from the effective-theme icons',
    auto.menuActive === 'auto', JSON.stringify(auto));

  // Live-follows the OS while Auto stays selected (no re-click needed).
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  const autoLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  H.check('Auto re-resolves live when the OS color scheme flips, without re-selecting it',
    autoLight === 'twilight', autoLight);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
