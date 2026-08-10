// The element-picker popup (PeriodicTableSelectPanel.js, the ⚛ buttons).
//
// It renders under a fixed #periodicTablePopup id, so opening it twice used to
// append a second element sharing that id: every getElementById inside then
// addressed only the first, and the popup had to be closed once per time it had
// been opened. Escape and clicking outside did nothing at all — only the Close
// button dismissed it.
'use strict';
const H = require('../harness');

const count = (page) => page.evaluate(() =>
  document.querySelectorAll('#periodicTablePopup').length);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const open = () => page.evaluate(async () => {
    const { openPeriodicTable } = await import('./ui/PeriodicTableSelectPanel.js');
    openPeriodicTable(() => {});
  });

  // --- Opening twice leaves ONE popup, closable once ------------------------
  await open();
  await open();
  await page.waitForTimeout(100);
  const doubled = await count(page);
  H.check('opening twice does not stack a second popup', doubled === 1, String(doubled));

  await page.evaluate(() => {
    /** @type {HTMLElement} */ (
      document.querySelector('#periodicTablePopup .periodic-table-close')).click();
  });
  H.check('one Close dismisses it', await count(page) === 0);

  // --- Escape ---------------------------------------------------------------
  await open();
  await page.waitForTimeout(100);
  H.check('the popup is up again', await count(page) === 1);
  await page.keyboard.press('Escape');
  H.check('Escape dismisses it', await count(page) === 0);

  // --- Clicking outside -----------------------------------------------------
  await open();
  await page.waitForTimeout(100);
  // A click INSIDE must not dismiss it — picking an element is a click too.
  await page.evaluate(() => {
    /** @type {HTMLElement} */ (
      document.querySelector('#periodicTablePopup .element-button')).click();
  });
  H.check('clicking an element inside keeps it open', await count(page) === 1);

  await page.mouse.click(5, 5); // top-left corner, well outside the centred popup
  await page.waitForTimeout(100);
  H.check('clicking outside dismisses it', await count(page) === 0);

  // --- The opening click itself must not close it ---------------------------
  // The popup opens from a click that is still propagating to document, so a
  // naively-registered outside-click listener would see it and close at once.
  await page.evaluate(async () => {
    const { openPeriodicTable } = await import('./ui/PeriodicTableSelectPanel.js');
    const opener = document.createElement('button');
    opener.id = 'ptOpenerProbe';
    opener.addEventListener('click', () => openPeriodicTable(() => {}));
    document.body.appendChild(opener);
  });
  await H.clickById(page, 'ptOpenerProbe');
  await page.waitForTimeout(150);
  H.check('the click that opened it does not immediately close it',
    await count(page) === 1);
  await page.keyboard.press('Escape');

  // --- The popup has to be a surface, in every palette -----------------------
  // It is appended to <body> and floats over the 3D scene, so it owns its own
  // background — it took --chrome-1, a 5%-alpha wash in the light palettes,
  // and the whole table went see-through over the structure. themecontrast
  // scans #ui only, so nothing saw it. Same for the tiles: their borders are
  // chemistry data picked against a dark popup, and the alkaline-earth yellow
  // left those six tiles with no visible edge at all on a light surface.
  const registry = await page.evaluate(async () => (await fetch('./themes/themes.json')).json());

  const PROBE = () => {
    const parse = (s) => (String(s).match(/[\d.]+/g) || []).map(Number);
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const over = (fg, bg) => { const a = fg.length > 3 ? fg[3] : 1; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)); };
    const ratio = (a, b) => { const [h, l] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (h + 0.05) / (l + 0.05); };

    const pop = document.getElementById('periodicTablePopup');
    const popBg = parse(getComputedStyle(pop).backgroundColor);
    const alpha = popBg.length > 3 ? popBg[3] : 1;
    const surface = over(popBg, parse(getComputedStyle(document.body).backgroundColor).slice(0, 3));

    // A tile is findable if EITHER its category border or the --tile-edge ring
    // inside it separates it from the popup surface — take the better of the
    // two, the same "one of the two has to work" rule themecontrast uses for
    // input fields.
    const edge = parse(getComputedStyle(pop).getPropertyValue('--tile-edge'));
    const ring = edge.length ? ratio(over(edge, surface), surface) : 0;
    let worst = { r: Infinity, el: '' };
    for (const tile of pop.querySelectorAll('.pt-tile')) {
      const b = parse(getComputedStyle(tile).borderTopColor);
      const r = Math.max(b.length ? ratio(over(b, surface), surface) : 0, ring);
      if (r < worst.r) worst = { r: +r.toFixed(2), el: tile.dataset.symbol };
    }
    return { alpha, worst };
  };

  async function probeTheme(palette, mode) {
    await page.evaluate((m) => document.querySelector(`.theme-btn[data-theme-option="${m}"]`).click(), mode);
    await page.waitForTimeout(200);
    await page.evaluate((p) => document.querySelector(`.theme-menu-item[data-palette-id="${p}"]`).click(), palette);
    await page.waitForTimeout(700); // theme CSS loads async
    await open();
    await page.waitForTimeout(200);
    const got = await page.evaluate(PROBE);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    return got;
  }

  // Default is the bar for tile edges, as in themecontrast: the category
  // colours are the same everywhere, only the surface under them changes.
  const base = registry.palettes[0];
  const floor = await probeTheme(base.id, Object.keys(base.modes)[0]);
  H.check('the probe measures the baseline palette (sanity check)',
    floor.alpha > 0 && floor.worst.r > 1, JSON.stringify(floor));

  for (const p of registry.palettes) {
    for (const mode of Object.keys(p.modes)) {
      const got = await probeTheme(p.id, mode);
      H.check(`${p.id}/${mode}: the scene does not show through the picker`,
        got.alpha >= 0.85, `background alpha ${got.alpha}`);
      H.check(`${p.id}/${mode}: every tile keeps a visible edge`,
        got.worst.r >= floor.worst.r - 0.05,
        `${got.worst.el} at ${got.worst.r} vs ${base.id}'s ${floor.worst.r}`);
    }
  }

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
