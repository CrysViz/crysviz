// Tiled PNG export (render/ImageExportModule.js): a source too large for one
// GL surface — per the Settings "Allocated GPU memory" budget — renders as a
// grid of bounded tiles composited on the CPU canvas, instead of either
// crashing the driver or silently upscaling. Two checks:
//   1. End-to-end raster equivalence: the same export rendered tiled (budget
//      floored to 0.25 GiB) and untiled (budget 8 GiB) must produce
//      near-identical pixels — this exercises setViewOffset tiling, the
//      edge-tile overlap clearing, and transparent compositing.
//   2. The ortho tracer tile-camera math (makeTileCamera's translated clone
//      with shrunken extents) cross-checked against three's own
//      setViewOffset: both cameras must project world points identically.
//      (A tracer tiled export end-to-end is not run here: forcing tiling
//      needs multi-megapixel traces, unaffordable under software GL.)
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- 1. tiled vs untiled raster export, pixel equivalence ---
  const pair = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { setPanelPref } = await import('./ui/panels/PanelManager.js');
    const opts = { width: 5000, height: 3750, transparent: true };
    const decode = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return { width: bmp.width, height: bmp.height, ctx };
    };
    const messages = [];
    const origInfo = console.info;
    console.info = (...a) => { messages.push(a.join(' ')); origInfo.apply(console, a); };
    let tiled; let single;
    try {
      setPanelPref('exportGpuMemoryGiB', 0.25);
      tiled = await decode(await captureSceneToPng(opts));
      setPanelPref('exportGpuMemoryGiB', 8);
      single = await decode(await captureSceneToPng(opts));
    } finally {
      console.info = origInfo;
      setPanelPref('exportGpuMemoryGiB', 1);
    }
    const tiledMsg = messages.find((m) => m.includes('tiles of'));
    // Sample a grid of pixels and measure the worst channel difference.
    let worst = 0;
    let outliers = 0;
    let samples = 0;
    let content = 0;
    for (let y = 40; y < tiled.height; y += 150) {
      for (let x = 40; x < tiled.width; x += 150) {
        const a = tiled.ctx.getImageData(x, y, 1, 1).data;
        const b = single.ctx.getImageData(x, y, 1, 1).data;
        let d = 0;
        for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[k] - b[k]));
        worst = Math.max(worst, d);
        if (d > 8) outliers += 1;
        if (a[3] > 0) content += 1;
        samples += 1;
      }
    }
    return {
      tiledMsg: tiledMsg || null,
      dims: { tiled: [tiled.width, tiled.height], single: [single.width, single.height] },
      worst, outliers, samples, content,
    };
  });
  H.check('oversized raster export actually rendered tiled',
    !!pair.tiledMsg, JSON.stringify(pair.tiledMsg));
  H.check('tiled and untiled exports have the requested dimensions',
    pair.dims.tiled[0] === 5000 && pair.dims.tiled[1] === 3750
      && pair.dims.single[0] === 5000 && pair.dims.single[1] === 3750,
    JSON.stringify(pair.dims));
  // The molecule covers a small fraction of the transparent frame; just
  // prove the sampling grid hit real content rather than an empty image.
  H.check('exports contain actual content at the sampled points',
    pair.content >= 20, JSON.stringify({ content: pair.content, samples: pair.samples }));
  // AA rounding at tile seams may differ by a hair on a few pixels; the
  // images must otherwise be the same picture.
  H.check('tiled export pixels match the untiled reference',
    pair.outliers <= pair.samples * 0.01,
    JSON.stringify({ worst: pair.worst, outliers: pair.outliers, samples: pair.samples }));

  // --- 2. ortho tracer tile camera vs three's setViewOffset ---
  const camCheck = await page.evaluate(async () => {
    const [{ makeTileCamera }, THREE] = await Promise.all([
      import('./render/ImageExportModule.js'),
      import('./external/three/three.module.js'),
    ]);
    const srcW = 4000; const srcH = 3000;
    const full = new THREE.OrthographicCamera(-30 * (4 / 3), 30 * (4 / 3), 30, -30, 0.1, 1000);
    full.zoom = 1.7;
    full.position.set(12, -7, 40);
    full.quaternion.setFromEuler(new THREE.Euler(0.4, -0.7, 0.2));
    full.updateProjectionMatrix();
    full.updateMatrixWorld(true);

    // Reference: three's own sub-window projection on a control clone.
    const tiles = [[0, 0, 1500, 1500], [2500, 1500, 1500, 1500], [1000, 700, 2000, 1600]];
    let worst = 0;
    for (const [tx, ty, tw, th] of tiles) {
      const control = full.clone();
      control.setViewOffset(srcW, srcH, tx, ty, tw, th);
      control.updateProjectionMatrix();
      control.updateMatrixWorld(true);
      const tile = makeTileCamera(full, srcW, srcH, tx, ty, tw, th, true).camera;
      // Project a spread of world points through both cameras; NDCs must agree.
      for (const [wx, wy, wz] of [[0, 0, 0], [15, 8, -12], [-20, 25, 10], [3, -30, -25]]) {
        const p = new THREE.Vector3(wx, wy, wz);
        const a = p.clone().project(control);
        const b = p.clone().project(tile);
        worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      }
    }
    return { worst };
  });
  H.check('ortho tracer tile camera matches three\'s setViewOffset sub-window',
    camCheck.worst < 1e-6, JSON.stringify(camCheck));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
