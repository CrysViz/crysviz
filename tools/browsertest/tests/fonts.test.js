// Self-hosted CrysViz Sans faces are available to CSS and canvas text,
// including per-glyph fallback to the separately bundled math face.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([
      document.fonts.load("400 12px 'CrysViz Sans'", 'Aa'),
      document.fonts.load("700 12px 'CrysViz Sans'", 'Aa'),
      document.fonts.load("400 12px 'CrysViz Sans Math'", '∫'),
    ]);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // The math face has no unicode-range, so an explicit Math-only canvas
    // measurement exercises its integral glyph. U+E000 is a private-use
    // missing-glyph control in the bundled Noto Sans Math face; comparing the
    // widths keeps the assertion deterministic without screenshot pixels.
    ctx.font = "12px 'CrysViz Sans Math'";
    const integralWidth = ctx.measureText('∫').width;
    const missingWidth = ctx.measureText('\uE000').width;
    return {
      regular: document.fonts.check("400 12px 'CrysViz Sans'"),
      bold: document.fonts.check("700 12px 'CrysViz Sans'"),
      math: document.fonts.check("400 12px 'CrysViz Sans Math'"),
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      integralWidth,
      missingWidth,
    };
  });

  H.check('regular CrysViz Sans is loaded', fontState.regular);
  H.check('variable-weight CrysViz Sans is loaded at 700', fontState.bold);
  H.check('CrysViz Sans Math is loaded', fontState.math);
  H.check(
    'body starts with the CrysViz Sans family',
    fontState.bodyFontFamily.startsWith('"CrysViz Sans"'),
    fontState.bodyFontFamily,
  );
  H.check(
    'integral glyph is served by CrysViz Sans Math',
    fontState.integralWidth > 0
      && Math.abs(fontState.integralWidth - fontState.missingWidth) > 0.01,
    `integral=${fontState.integralWidth}, missing=${fontState.missingWidth}`,
  );

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
