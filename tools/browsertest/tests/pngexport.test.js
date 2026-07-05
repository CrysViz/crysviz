// High-resolution PNG export (render/ImageExportModule.captureSceneToPng):
// - produces a real image/png Blob at the exact requested dimensions,
// - opaque export is fully opaque with visible content,
// - transparent export has real alpha (transparent bands) plus content,
// - the live view (renderer size) is restored afterwards.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  if (!(await H.webglAvailable(page))) {
    H.check('WebGL2 available', false);
    return H.finish(browser);
  }

  await H.loadDefaultStructure(page, 'defaultPOSCAR', 'YBCO');
  await page.waitForTimeout(500);

  // Add a distance measurement so the export also exercises the CSS2D label +
  // gizmo compositing paths (atoms render as an InstancedMesh, so build proxy
  // atom objects from the structure to feed addDistanceMeasurement).
  const labels = await page.evaluate(async () => {
    const { addDistanceMeasurement } = await import('./render/MeasurementModule.js');
    const { measurements, fileBrowser } = await import('./state/store.js');
    const { fracToCart } = await import('./math/index.js');
    const THREE = await import('./external/three/three.module.js');
    const s = fileBrowser.selectedStructure;
    if (!s || !s.atoms || s.atoms.length < 2) return 0;
    const mk = (i) => ({
      position: new THREE.Vector3(...fracToCart([s.atoms[i].position], s.lattice)[0]),
      userData: { atomIndex: i, element: s.elements[i] },
    });
    addDistanceMeasurement(mk(0), mk(1));
    return measurements.measureLabels.length;
  });
  H.check('measurement label present for export', labels > 0, `labels=${labels}`);

  const res = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app } = await import('./state/store.js');

    async function grab(opts) {
      const blob = await captureSceneToPng(opts);
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let minAlpha = 255;
      let transparentPx = 0;
      let contentPx = 0;
      const c0 = [d[0], d[1], d[2], d[3]];
      for (let i = 0; i < d.length; i += 4 * 331) {
        const a = d[i + 3];
        if (a < minAlpha) minAlpha = a;
        if (a === 0) transparentPx++;
        // "content" = differs from the top-left reference pixel
        if (Math.abs(d[i] - c0[0]) + Math.abs(d[i + 1] - c0[1]) +
            Math.abs(d[i + 2] - c0[2]) + Math.abs(a - c0[3]) > 24) contentPx++;
      }
      return { type: blob.type, w: bmp.width, h: bmp.height, minAlpha, transparentPx, contentPx };
    }

    const opaque = await grab({ width: 800, height: 600, margin: 0, transparent: false });
    const transparent = await grab({ width: 512, height: 512, margin: 20, transparent: true });

    const size = app.renderer.getSize(new (await import('./external/three/three.module.js')).Vector2());
    const view = document.getElementById('view');
    return {
      opaque, transparent,
      restoredW: Math.round(size.x), restoredH: Math.round(size.y),
      viewW: view.clientWidth, viewH: view.clientHeight,
    };
  });

  H.check('opaque: blob is image/png', res.opaque.type === 'image/png', res.opaque.type);
  H.check('opaque: exact dimensions', res.opaque.w === 800 && res.opaque.h === 600,
    `${res.opaque.w}x${res.opaque.h}`);
  H.check('opaque: fully opaque', res.opaque.minAlpha === 255, `minAlpha=${res.opaque.minAlpha}`);
  H.check('opaque: has content', res.opaque.contentPx > 0, `contentPx=${res.opaque.contentPx}`);

  H.check('transparent: exact dimensions', res.transparent.w === 512 && res.transparent.h === 512,
    `${res.transparent.w}x${res.transparent.h}`);
  H.check('transparent: has real alpha', res.transparent.minAlpha === 0 && res.transparent.transparentPx > 0,
    `minAlpha=${res.transparent.minAlpha} transp=${res.transparent.transparentPx}`);
  H.check('transparent: has content', res.transparent.contentPx > 0,
    `contentPx=${res.transparent.contentPx}`);

  H.check('live view restored after export',
    res.restoredW === res.viewW && res.restoredH === res.viewH,
    `renderer=${res.restoredW}x${res.restoredH} view=${res.viewW}x${res.viewH}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
