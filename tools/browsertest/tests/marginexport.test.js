// Programmatic scene-border margin (render/ImageExportModule.js): margin
// widens the capture window so the band shows the scene CONTINUING beyond
// the captured area — not blank fill. Checks: (1) a margin export is
// pixel-equivalent to the same export expressed as an explicitly expanded
// crop (margin == window expansion, by construction); (2) with the camera
// zoomed so the structure overflows the view, the band contains real scene
// content; (3) an impossible margin rejects clearly; (4) dimensions hold.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  const res = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app } = await import('./state/store.js');
    // Zoom in so the structure overflows the view edges — the margin band
    // then has real scene to show.
    const prevZoom = app.camera.zoom;
    app.camera.zoom *= 3;
    app.camera.updateProjectionMatrix();
    const decode = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return { width: bmp.width, height: bmp.height, ctx };
    };
    try {
      const W = 800; const Hh = 600; const M = 100;
      const withMargin = await decode(await captureSceneToPng({
        width: W, height: Hh, margin: M, transparent: true }));
      const ax = M / (W - 2 * M);
      const ay = M / (Hh - 2 * M);
      const asCrop = await decode(await captureSceneToPng({
        width: W, height: Hh, transparent: true,
        crop: { x0: -ax, y0: -ay, x1: 1 + ax, y1: 1 + ay },
      }));
      // Sampled pixel comparison of the two.
      let worst = 0; let outliers = 0; let samples = 0;
      for (let y = 10; y < Hh; y += 37) {
        for (let x = 10; x < W; x += 37) {
          const a = withMargin.ctx.getImageData(x, y, 1, 1).data;
          const b = asCrop.ctx.getImageData(x, y, 1, 1).data;
          let d = 0;
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[k] - b[k]));
          worst = Math.max(worst, d);
          if (d > 8) outliers += 1;
          samples += 1;
        }
      }
      // Band content: with a transparent background, any alpha in the band
      // ring is scene content that continued past the captured area (the
      // zoomed structure overflows the view). Scan the WHOLE ring — which
      // sides overflow depends on the structure's shape.
      let bandContent = 0;
      const d = withMargin.ctx.getImageData(0, 0, W, Hh).data;
      for (let y = 0; y < Hh; y += 3) {
        for (let x = 0; x < W; x += 3) {
          const inBand = x < M || x >= W - M || y < M || y >= Hh - M;
          if (inBand && d[(y * W + x) * 4 + 3] > 0) bandContent += 1;
        }
      }
      let rejected = null;
      try {
        await captureSceneToPng({ width: 300, height: 200, margin: 150 });
      } catch (e) {
        rejected = e?.message || String(e);
      }
      return {
        dims: [withMargin.width, withMargin.height],
        worst, outliers, samples, bandContent, rejected,
      };
    } finally {
      app.camera.zoom = prevZoom;
      app.camera.updateProjectionMatrix();
    }
  });

  H.check('margin export has the requested dimensions',
    res.dims[0] === 800 && res.dims[1] === 600, JSON.stringify(res.dims));
  H.check('margin equals an explicitly window-expanded crop (pixelwise)',
    res.outliers <= res.samples * 0.01,
    JSON.stringify({ worst: res.worst, outliers: res.outliers, samples: res.samples }));
  H.check('the margin band shows scene content, not blank fill',
    res.bandContent > 10, JSON.stringify({ bandContent: res.bandContent }));
  H.check('an impossible margin rejects with a clear message',
    !!res.rejected && /margin is too large/i.test(res.rejected), String(res.rejected));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
