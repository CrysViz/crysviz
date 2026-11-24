// The Atomistic window's text fields follow the theme: the ASE server
// address and the PET-MAD "from a link…" box. Text inputs have no app-wide
// rule (selects and number boxes do), so both drew as the browser's white
// field with a grey inset border, a white box on the dark panels. They are
// now painted like the selects beside them, in every palette and mode.
'use strict';
const H = require('../harness');

const THEMES = [['default', 'dark'], ['default', 'light'], ['fluorite', 'light'], ['fluorite', 'dark']];

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('backend'));
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('#BackendPotentialSelector [data-potential="ase"]').click());
  await page.waitForTimeout(300);

  const seen = {};
  for (const [palette, mode] of THEMES) {
    const r = await page.evaluate(async ({ palette, mode }) => {
      const { applyTheme } = await import('./ui/ThemeManager.js');
      await applyTheme(palette, mode);
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const look = (sel) => {
        const s = getComputedStyle(document.querySelector(`#BackendPotentialSelector ${sel}`));
        return { bg: s.backgroundColor, fg: s.color, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}` };
      };
      return {
        server: look('[data-role="ase-url"]'),
        link: look('[data-role="mlip-link"]'),
        select: look('[data-role="mlip-backend"]'),
        shown: document.querySelector('[data-role="ase-url"]').getBoundingClientRect().width > 0,
      };
    }, { palette, mode });
    seen[`${palette}-${mode}`] = r.server.bg;
    const same = (a) => a.bg === r.select.bg && a.fg === r.select.fg && a.border === r.select.border;
    H.check(`${palette} ${mode}: the ASE server field is painted like the selects`, r.shown && same(r.server),
      JSON.stringify({ server: r.server, select: r.select }));
    H.check(`${palette} ${mode}: so is the PET-MAD link box`, same(r.link), JSON.stringify({ link: r.link, select: r.select }));
  }
  H.check('the field follows the palette (dark panel vs light panel)',
    seen['default-dark'] !== seen['fluorite-light'] && seen['fluorite-dark'] !== seen['fluorite-light'], JSON.stringify(seen));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
