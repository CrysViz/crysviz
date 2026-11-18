// Icon-only toolbars (Settings ▸ Icon-only toolbars; always on phones): the
// round buttons have no chip of their own and sit on the 3D scene, and their
// glyphs are white SVGs. Their polarity used to follow the palette, so on
// Default light (dark chrome, white scene) the white camera glyph vanished on
// the white scene, and the same happened with a light background picked by
// hand. ui/SceneTone.js now marks <html data-scene-tone> from the scene
// background and the glyphs invert on a light one. Checked by pixels: the
// camera glyph must stand out from the scene behind its button.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

/** Fraction of the camera button's inner pixels that contrast strongly with
 *  the scene colour, plus the tone and the glyph's filter. */
async function cameraGlyph(page) {
  const btn = page.locator('.cv-panel-compact-btn:has(img[src*="camera"])').first();
  const box = await btn.boundingBox();
  if (!box) return { found: false };
  const png = PNG.sync.read(await page.screenshot({
    clip: { x: box.x + box.width * 0.25, y: box.y + box.height * 0.25, width: box.width * 0.5, height: box.height * 0.5 },
  }));
  const state = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const img = document.querySelector('.cv-panel-compact-btn img[src*="camera"]');
    return {
      tone: document.documentElement.dataset.sceneTone,
      filter: img ? getComputedStyle(img).filter : null,
      scene: app.scene.background.getHexString(),
    };
  });
  const bg = [0, 2, 4].map((i) => parseInt(state.scene.slice(i, i + 2), 16));
  const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const bgLum = lum(...bg);
  let hits = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (Math.abs(lum(png.data[i], png.data[i + 1], png.data[i + 2]) - bgLum) > 0.5) hits++;
  }
  return { found: true, ...state, contrast: hits / (png.data.length / 4) };
}

async function setTheme(page, palette, mode) {
  await page.evaluate(async ({ palette, mode }) => {
    const tm = await import('./ui/ThemeManager.js');
    tm.applyTheme(palette, mode);
  }, { palette, mode });
  await page.waitForTimeout(800);
}

/** Pick a scene background through the Visual window's swatch and Apply. */
async function pickBackground(page, hex) {
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);
  await H.clickById(page, 'backgroundSwatch');
  await page.waitForTimeout(300);
  await page.evaluate((hex) => {
    const panel = document.querySelector('.cv-background-picker-panel');
    const inputs = [...panel.querySelectorAll('.cv-colorpicker-input-field')];
    const hexInput = inputs[inputs.length - 1];
    hexInput.value = hex;
    hexInput.dispatchEvent(new Event('change', { bubbles: true }));
    [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Apply').click();
  }, hex);
  await page.waitForTimeout(400);
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).closePanel('visual'));
  await page.waitForTimeout(400);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).setForcedIconMode(true));
  await page.waitForTimeout(600);
  await page.mouse.move(700, 880); // nothing hovered

  await setTheme(page, 'default', 'light');
  const light = await cameraGlyph(page);
  H.check('Default light (dark chrome, white scene): the camera glyph is drawn dark and shows',
    light.found && light.tone === 'light' && /invert/.test(light.filter) && light.contrast > 0.05, JSON.stringify(light));

  await setTheme(page, 'default', 'dark');
  const dark = await cameraGlyph(page);
  H.check('Default dark: the camera glyph stays white and shows',
    dark.found && dark.tone === 'dark' && !/invert/.test(dark.filter) && dark.contrast > 0.05, JSON.stringify(dark));

  await pickBackground(page, '#ffffff');
  const picked = await cameraGlyph(page);
  H.check('a white background picked by hand in dark mode: the glyph turns dark and shows',
    picked.found && picked.scene === 'ffffff' && picked.tone === 'light' && picked.contrast > 0.05, JSON.stringify(picked));

  await setTheme(page, 'fluorite', 'light');
  const fluorite = await cameraGlyph(page);
  H.check('Fluorite light: still dark on its light scene',
    fluorite.found && fluorite.tone === 'light' && fluorite.contrast > 0.05, JSON.stringify(fluorite));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
