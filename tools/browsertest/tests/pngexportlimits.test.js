// Oversized PNG exports must fail loudly, not produce empty images: browsers
// cap canvas dimensions/area without throwing (draws no-op, toBlob goes
// blank), and a failed WebGL surface allocation shrinks silently. The export
// now probes the output canvas up front and the GL drawing buffer at render
// time (render/ImageExportModule.js), so an impossible request rejects with
// a clear "reduce the export resolution" message BEFORE any long render —
// and, because it fails before live-view state is touched, a normal export
// still works immediately afterwards.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // An absurd output size: rejects with the clear guidance message.
  const oversize = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    try {
      await captureSceneToPng({ width: 32000, height: 32000 });
      return { rejected: false };
    } catch (e) {
      return { rejected: true, message: e?.message || String(e) };
    }
  });
  H.check('oversized export rejects with a clear message',
    oversize.rejected && /reduce the export resolution/i.test(oversize.message),
    JSON.stringify(oversize));

  // The failure happened before any live-view state was touched: a normal
  // export right after must still produce a correctly sized PNG.
  const normal = await page.evaluate(async () => {
    const { captureSceneToPng } = await import('./render/index.js');
    const blob = await captureSceneToPng({ width: 320, height: 240 });
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, size: blob.size };
  });
  H.check('a normal export still works after the rejected one',
    normal.width === 320 && normal.height === 240 && normal.size > 0,
    JSON.stringify(normal));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
