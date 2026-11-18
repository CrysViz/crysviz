// Cel screen-space outline (CelOutlinePass.js) at a wide line: the line is the
// silhouette dilated by the edge detector's taps, so with too few sample
// directions a thick line comes out polygonal/stepped and sharp corners
// (arrow tips) star-shaped. Around a small sphere (a few pixels, like an
// arrow tip) the outline's outer edge must stay round. Measured at a 33 px
// line: the old four directions (eight rays) gave an 8-lobe ripple of 2.3 px
// in the outer radius; with taps that grow with the width it is 0.05 px.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require('pngjs');

const XYZ = ['1', 'Lattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3', 'Na 5 5 5'].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'one.xyz'), XYZ);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const t = document.getElementById('showLattice'); if (t && t.checked) t.click(); });
  // A small atom: around a big one, missing directions change the outer
  // radius by under 1%; on a few-pixel feature (like an arrow tip or a thin
  // shaft end) they show as a polygonal, stepped line.
  await page.evaluate(() => {
    const el = document.getElementById('atomSize');
    el.value = '0.02';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('visual'));
  await page.waitForTimeout(400);
  await H.setSelect(page, 'renderStyleMenu', 'cel');
  await page.waitForTimeout(700);
  await H.setSelect(page, 'celOutlineModeMenu', 'screen');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const el = document.getElementById('celOutlineWidth');
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const { app } = await import('./state/store.js');
    app.camera.zoom *= 10; // a ~33 px line: the old pattern's ripple well above pixel quantization
    app.camera.updateProjectionMatrix();
    (await import('./render/index.js')).requestRender();
  });
  await page.waitForTimeout(900);
  const width = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const cam = app.camera;
    const h = app.renderer.domElement.height;
    return general.celOutlineWidth * (h * cam.zoom) / (cam.top - cam.bottom);
  });

  const png = PNG.sync.read(fs.readFileSync(await H.shotCanvas(page, 'cel_round_outline')));
  const { width: w, height: h, data } = png;
  const lumAt = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  // Bilinear luminance, for a sub-pixel edge position.
  const lum = (fx, fy) => {
    const x0 = Math.floor(fx); const y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return 255;
    const tx = fx - x0; const ty = fy - y0;
    return (lumAt(x0, y0) * (1 - tx) + lumAt(x0 + 1, y0) * tx) * (1 - ty)
      + (lumAt(x0, y0 + 1) * (1 - tx) + lumAt(x0 + 1, y0 + 1) * tx) * ty;
  };
  // Centre: centroid of the dark (outline) pixels.
  let sx = 0; let sy = 0; let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lumAt(x, y) < 60) { sx += x; sy += y; n++; }
  const cx = sx / n; const cy = sy / n;
  // Outer edge of the dark ring (luminance 128) along 720 rays, to 1/8 pixel.
  const N = 720;
  const radii = [];
  for (let k = 0; k < N; k++) {
    const a = (2 * Math.PI * k) / N;
    let last = 0;
    for (let r = 1; r < Math.min(w, h) / 2; r += 0.125) {
      if (lum(cx + r * Math.cos(a), cy + r * Math.sin(a)) < 128) last = r;
    }
    radii.push(last);
  }
  const mean = radii.reduce((t, r) => t + r, 0) / N;
  // Ripple at 8 lobes around the ring: the old pattern's eight sample rays
  // left exactly that (deepest between the rays, 22.5 degrees off them).
  let re = 0; let im = 0;
  radii.forEach((r, k) => { const a = (2 * Math.PI * k * 8) / N; re += (r - mean) * Math.cos(a); im += (r - mean) * Math.sin(a); });
  const ripple8 = (2 / N) * Math.hypot(re, im);
  H.check('a wide line is drawn (tens of pixels)', width > 25 && n > 1000, JSON.stringify({ widthPx: width, darkPx: n }));
  // The pixel grid alone leaves ~0.5 px at 8 lobes (the line's edge is pixel-
  // quantized); the old eight-ray pattern added ~w(1 - cos 22.5 deg)/2 on top.
  H.check('the outline around a small atom stays round at a wide width (8-lobe ripple under 0.8 px)',
    mean > 0 && ripple8 < 0.8,
    JSON.stringify({ meanRadius: +mean.toFixed(2), ripple8: +ripple8.toFixed(3), widthPx: +width.toFixed(1) }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
