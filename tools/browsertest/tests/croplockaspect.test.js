// PNG export crop overlay: the "Lock aspect" toggle in the floating
// "Drag to reposition, corners to resize" toolbar (ui/CropOverlay.js).
// It starts with the export dialog's own Lock aspect value; while checked,
// corner drags preserve the crop's current aspect ratio (the behavior the
// overlay always had); unchecked, corners resize freely — and the exported
// PNG then derives its dimensions from the drawn shape (long edge kept).
// Changes persist back into the shared pngExport prefs, so the dialog shows
// the toggle's last state next time.
'use strict';
const H = require('../harness');

async function cropState(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('.cv-crop-rect');
    const lock = document.querySelector('.cv-crop-lock input');
    if (!rect || !lock) return null;
    const r = rect.getBoundingClientRect();
    const se = document.querySelector('.cv-crop-handle-se').getBoundingClientRect();
    return {
      width: r.width, height: r.height, aspect: r.width / r.height,
      locked: lock.checked,
      seX: se.left + se.width / 2, seY: se.top + se.height / 2,
    };
  });
}

async function dragSE(page, from, dx, dy) {
  await page.mouse.move(from.seX, from.seY);
  await page.mouse.down();
  await page.mouse.move(from.seX + dx, from.seY + dy, { steps: 5 });
  await page.mouse.up();
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Open the export dialog; note its dims and (default-checked) lock state.
  await page.evaluate(() => document.getElementById('savePngButton').click());
  const dialog = await page.evaluate(() => ({
    width: Number(document.getElementById('pngWidth').value),
    height: Number(document.getElementById('pngHeight').value),
    lock: document.getElementById('pngLock').checked,
  }));
  H.check('dialog opens with Lock aspect checked', dialog.lock === true,
    JSON.stringify(dialog));

  await page.evaluate(() => document.getElementById('pngDownloadBtn').click());
  let s = await cropState(page);
  H.check('overlay toolbar shows the lock toggle, carried over checked',
    !!s && s.locked === true, JSON.stringify(s));

  // Locked drag: shrink toward the anchor asymmetrically — ratio must hold.
  const before = s;
  await dragSE(page, s, -120, -30);
  s = await cropState(page);
  // Note: with the ratio enforced, the drag axis with the SMALLER motion
  // wins (the other follows), so the size change is modest by design.
  H.check('locked: corner drag preserves the aspect ratio',
    Math.abs(s.aspect - before.aspect) < 0.02 && s.width < before.width - 10,
    JSON.stringify({ before: before.aspect, after: s.aspect, w: s.width }));

  // Unlock in the toolbar: the same asymmetric drag now changes the shape.
  await page.evaluate(() => document.querySelector('.cv-crop-lock input').click());
  const unlockSaved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('crysviz.pngExportPrefs.v1')).lock);
  H.check('unchecking in the toolbar persists into the shared prefs',
    unlockSaved === false, String(unlockSaved));
  await dragSE(page, s, 40, -80);
  const drawn = await cropState(page);
  H.check('unlocked: corner drag resizes freely (aspect changes)',
    Math.abs(drawn.aspect - s.aspect) > 0.1,
    JSON.stringify({ before: s.aspect, after: drawn.aspect }));

  // Re-lock: dragging now preserves the freshly drawn shape, not the
  // dialog's original ratio.
  await page.evaluate(() => document.querySelector('.cv-crop-lock input').click());
  await dragSE(page, drawn, -60, -60);
  s = await cropState(page);
  H.check('re-locked: drags preserve the drawn shape',
    s.locked && Math.abs(s.aspect - drawn.aspect) < 0.02,
    JSON.stringify({ drawn: drawn.aspect, after: s.aspect }));

  // Unlock again (so the export takes the drawn-shape path), export at the
  // crop's current shape, and verify the PNG's dimensions: the dialog's
  // long edge kept, the short edge derived from the drawn aspect.
  await page.evaluate(() => document.querySelector('.cv-crop-lock input').click());
  const final = await cropState(page);
  const png = await page.evaluate(async () => {
    const orig = HTMLAnchorElement.prototype.click;
    let url = null;
    HTMLAnchorElement.prototype.click = function () { url = this.href; };
    try {
      document.querySelector('.cv-crop-confirm').click();
      // Raster pipeline: the capture is a handful of frames.
      for (let i = 0; i < 600 && !url; i++) await new Promise((r) => setTimeout(r, 100));
      if (!url) return null;
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });
  const longEdge = Math.max(dialog.width, dialog.height);
  const expected = final.aspect >= 1
    ? { width: Math.round(longEdge), height: Math.round(longEdge / final.aspect) }
    : { width: Math.round(longEdge * final.aspect), height: Math.round(longEdge) };
  // The measured rect includes the crop rectangle's CSS border, so the
  // aspect read here is a fraction of a percent off the overlay's internal
  // value — allow that slop on the derived (short) edge; the long edge is
  // exact.
  H.check('exported PNG dimensions follow the drawn shape (long edge kept)',
    !!png && png.width === expected.width
      && Math.abs(png.height - expected.height) <= expected.height * 0.005,
    JSON.stringify({ png, expected, cropAspect: final.aspect }));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
