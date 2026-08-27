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

    const opaque = await grab({ width: 800, height: 600, transparent: false });
    const transparent = await grab({ width: 512, height: 512, transparent: true });

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

  const overlap = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { app, general } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const view = document.getElementById('view');
    const renderer = app.renderer;
    const pipeline = app.pipeline;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalSetSize = pipeline?.setSize;
    const oldPaced = pipeline?._pacedExternally;
    const oldWidth = Object.getOwnPropertyDescriptor(view, 'clientWidth');
    const oldHeight = Object.getOwnPropertyDescriptor(view, 'clientHeight');
    const previous = {
      pixelRatio: renderer.getPixelRatio(),
      background: app.scene.background,
      alpha: renderer.getClearAlpha(),
      rtScale: general.rtResolutionScale,
      hold: app.offscreenRenderHold,
      paced: pipeline?._pacedExternally,
    };
    const sizes = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    HTMLCanvasElement.prototype.toBlob = function delayedToBlob(callback, type, quality) {
      return gate.then(() => originalToBlob.call(this, callback, type, quality));
    };
    if (pipeline?.setSize) {
      pipeline.setSize = (width, height) => {
        sizes.push([width, height]);
        return originalSetSize.call(pipeline, width, height);
      };
    }
    if (pipeline) pipeline._pacedExternally = false;
    renderer.setPixelRatio(1.4);
    renderer.setClearAlpha(0.27);
    general.rtResolutionScale = 0.61;
    app.offscreenRenderHold = false;
    try {
      const first = captureSceneToPng({ width: 320, height: 240, transparent: false });
      const second = await captureSceneToPng({ width: 64, height: 64, transparent: false })
        .then(() => ({ rejected: false }), (error) => ({ rejected: true, message: error.message }));
      Object.defineProperty(view, 'clientWidth', { configurable: true, value: 777 });
      Object.defineProperty(view, 'clientHeight', { configurable: true, value: 333 });
      const current = { width: view.clientWidth, height: view.clientHeight };
      release();
      await first;
      const size = renderer.getSize(new THREE.Vector2());
      return {
        second,
        current,
        finalRenderer: [Math.round(size.x), Math.round(size.y)],
        finalPipeline: sizes.at(-1),
        restored: {
          pixelRatio: renderer.getPixelRatio(),
          background: app.scene.background === previous.background,
          alpha: renderer.getClearAlpha(),
          rtScale: general.rtResolutionScale,
          hold: app.offscreenRenderHold,
          paced: pipeline?._pacedExternally,
        },
      };
    } finally {
      release();
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      if (oldWidth) Object.defineProperty(view, 'clientWidth', oldWidth);
      else delete view.clientWidth;
      if (oldHeight) Object.defineProperty(view, 'clientHeight', oldHeight);
      else delete view.clientHeight;
      if (pipeline?.setSize) pipeline.setSize = originalSetSize;
      if (pipeline) {
        if (oldPaced === undefined) delete pipeline._pacedExternally;
        else pipeline._pacedExternally = oldPaced;
      }
    }
  });
  H.check('overlapping PNG capture rejects while the first owns capture state',
    overlap.second.rejected && /already in progress/.test(overlap.second.message), overlap.second.message);
  H.check('PNG restoration follows live view dimensions after resize',
    overlap.finalRenderer[0] === overlap.current.width && overlap.finalRenderer[1] === overlap.current.height
      && overlap.finalPipeline[0] === overlap.current.width && overlap.finalPipeline[1] === overlap.current.height,
    JSON.stringify(overlap));
  H.check('PNG restoration preserves renderer and export state',
    overlap.restored.pixelRatio === 1.4 && overlap.restored.background
      && Math.abs(overlap.restored.alpha - 0.27) < 1e-6
      && overlap.restored.rtScale === 0.61 && overlap.restored.hold === false
      && overlap.restored.paced === false,
    JSON.stringify(overlap.restored));

  // Settings persistence: tweak the modal, close it, reopen it, and the
  // choices must be restored (from localStorage).
  const prefs = await page.evaluate(() => {
    document.getElementById('saveImageButton').click(); // open
    const aspect = document.getElementById('pngAspect');
    aspect.value = '1:1';
    aspect.dispatchEvent(new Event('change'));
    document.getElementById('pngTransparent').checked = true;
    document.getElementById('pngCancelBtn').click();  // close -> saves prefs

    document.getElementById('saveImageButton').click(); // reopen -> loads prefs
    const out = {
      aspect: document.getElementById('pngAspect').value,
      transparent: document.getElementById('pngTransparent').checked,
      width: document.getElementById('pngWidth').value,
      height: document.getElementById('pngHeight').value,
    };
    document.getElementById('pngCancelBtn').click();
    return out;
  });
  H.check('prefs: aspect restored', prefs.aspect === '1:1', prefs.aspect);
  H.check('prefs: transparent restored', prefs.transparent === true, String(prefs.transparent));
  H.check('prefs: 1:1 dimensions', prefs.width === prefs.height, `${prefs.width}x${prefs.height}`);

  // The Composition Display legend is a figure element, not app furniture, so
  // it has to land in the export — at its own place, and nowhere else. Two
  // captures either side of closing it: everything that changes must be inside
  // the box the legend occupied, and there has to be a real amount of it (the
  // sphere swatch and the label, not a stray pixel).
  await page.evaluate(() => document.getElementById('compositionLegendButton').click());
  await page.waitForTimeout(1200);

  const legend = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const { closeCompositionLegend } = await import('./ui/CompositionLegendWidget.js');
    const W = 700, H = 500;
    const grab = async () => {
      const blob = await captureSceneToPng({ width: W, height: H, transparent: false });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, W, H).data;
    };

    const widget = document.querySelector('.comp-legend-widget.cv-colorbar-floating');
    if (!widget) return { opened: false };
    const body = widget.querySelector('.comp-legend-body');
    const view = document.getElementById('view').getBoundingClientRect();
    const r = body.getBoundingClientRect();
    const box = {
      x0: ((r.left - view.left) / view.width) * W - 3,
      y0: ((r.top - view.top) / view.height) * H - 3,
      x1: ((r.right - view.left) / view.width) * W + 3,
      y1: ((r.bottom - view.top) / view.height) * H + 3,
    };

    const shown = await grab();
    closeCompositionLegend();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const hidden = await grab();

    let inside = 0, outside = 0;
    for (let i = 0; i < shown.length; i += 4) {
      const p = i / 4;
      const diff = Math.abs(shown[i] - hidden[i]) + Math.abs(shown[i + 1] - hidden[i + 1])
        + Math.abs(shown[i + 2] - hidden[i + 2]);
      if (diff <= 24) continue;
      const x = p % W, y = Math.floor(p / W);
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) inside++;
      else outside++;
    }
    return { opened: true, inside, outside, area: (box.x1 - box.x0) * (box.y1 - box.y0) };
  });

  H.check('the legend opened over the scene', legend.opened === true);
  H.check('the composition legend is drawn into the PNG',
    legend.inside > legend.area * 0.05, JSON.stringify(legend));
  H.check('and nothing else in the frame moved because of it',
    legend.outside === 0, JSON.stringify(legend));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
