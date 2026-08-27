// PNG export dialog (ui/ImageExportPanel.js): two green primary actions —
// Save (the direct programmatic path: whole view + scene-border margin, no
// crop step, same as the Python API) and Choose region… (the crop overlay).
// Choose region seeds its starting selection from the automatic content box
// (structure + visible floating overlays, grown to the locked aspect) when
// that box fits the view; otherwise the overlay's default inset box is used.
'use strict';
const H = require('../harness');

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

async function openDialog(page) {
  await page.evaluate(() => document.getElementById('saveImageButton').click());
}

async function cropRect(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.cv-crop-rect');
    const view = document.getElementById('view').getBoundingClientRect();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left - view.left, top: r.top - view.top, width: r.width, height: r.height };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- dialog anatomy ---
  await openDialog(page);
  const anatomy = await page.evaluate(() => ({
    save: document.getElementById('pngSaveBtn')?.className,
    region: document.getElementById('pngDownloadBtn')?.className,
    regionLabel: document.getElementById('pngDownloadBtn')?.textContent,
    margin: !!document.getElementById('pngMargin'),
    structureOnly: !!document.getElementById('pngStructureOnly'),
  }));
  H.check('dialog has the two green primary buttons, margin, and structure-only',
    anatomy.save === 'png-primary' && anatomy.region === 'png-primary'
      && /choose region/i.test(anatomy.regionLabel || '') && anatomy.margin
      && anatomy.structureOnly,
    JSON.stringify(anatomy));

  // --- Save: direct export at the dialog's size with margin ---
  const saved = await page.evaluate(async () => {
    const widthInput = document.getElementById('pngWidth');
    widthInput.value = '800';
    widthInput.dispatchEvent(new Event('input')); // lock adjusts height
    const height = Number(document.getElementById('pngHeight').value);
    document.getElementById('pngMargin').value = '40';
    const orig = HTMLAnchorElement.prototype.click;
    let url = null;
    HTMLAnchorElement.prototype.click = function () { url = this.href; };
    try {
      document.getElementById('pngSaveBtn').click();
      for (let i = 0; i < 600 && !url; i++) await new Promise((r) => setTimeout(r, 100));
      if (!url) return null;
      const img = new Image();
      img.src = url;
      await img.decode();
      return {
        width: img.naturalWidth, height: img.naturalHeight, expectedHeight: height,
        modalClosed: document.getElementById('pngExportModal').hidden,
      };
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });
  H.check('Save downloads a PNG at the dialog size and closes the modal',
    !!saved && saved.width === 800 && saved.height === saved.expectedHeight && saved.modalClosed,
    JSON.stringify(saved));

  // --- Choose region: automatic starting selection frames the content ---
  await openDialog(page);
  const expected = await page.evaluate(async () => {
    const { computeContentScreenBox } = await import('./render/index.js');
    const box = computeContentScreenBox();
    const view = document.getElementById('view');
    const width = Number(document.getElementById('pngWidth').value);
    const height = Number(document.getElementById('pngHeight').value);
    return { box, vw: view.clientWidth, vh: view.clientHeight, aspect: width / height };
  });
  await page.evaluate(() => document.getElementById('pngDownloadBtn').click());
  const auto = await cropRect(page);
  // Recompute the panel's aspect-growth + clamp here for comparison.
  let bw = expected.box.width; let bh = expected.box.height;
  if (bw / Math.max(bh, 1) > expected.aspect) bh = bw / expected.aspect;
  else bw = bh * expected.aspect;
  const fits = bw <= expected.vw && bh <= expected.vh;
  H.check('auto box fits the view for the default structure', fits,
    JSON.stringify({ bw, bh, vw: expected.vw, vh: expected.vh }));
  // The rect element carries a border, so allow a few px.
  H.check('starting selection frames the content box (aspect-grown)',
    !!auto && near(auto.width, bw, 6) && near(auto.height, bh, 6),
    JSON.stringify({ auto, bw, bh }));
  await page.keyboard.press('Escape');

  // --- overflow: content larger than the view falls back to the default ---
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.zoom *= 3;
    app.camera.updateProjectionMatrix();
  });
  await openDialog(page);
  await page.evaluate(() => document.getElementById('pngDownloadBtn').click());
  const fallback = await cropRect(page);
  const inset = Math.min(expected.vw, expected.vh) * 0.08;
  let dw = expected.vw - inset * 2; let dh = expected.vh - inset * 2;
  if (dw / dh > expected.aspect) dw = dh * expected.aspect; else dh = dw / expected.aspect;
  H.check('overflowing content falls back to the default inset box',
    !!fallback && near(fallback.width, dw, 6) && near(fallback.height, dh, 6),
    JSON.stringify({ fallback, dw, dh }));
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.zoom /= 3;
    app.camera.updateProjectionMatrix();
  });

  // --- structure-only: smaller auto box, and no gizmo in the capture ---
  const so = await page.evaluate(async () => {
    const { computeContentScreenBox, captureSceneToPng } = await import('./render/index.js');
    const full = computeContentScreenBox();
    const bare = computeContentScreenBox({ structureOnly: true });
    const gizmo = document.getElementById('axesGizmo')?.getBoundingClientRect();
    const view = document.getElementById('view').getBoundingClientRect();
    const decode = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return ctx;
    };
    // Full-view transparent captures at view scale: count alpha inside the
    // gizmo's on-screen rect with and without structureOnly.
    const W = view.width; const Hh = view.height;
    const count = (ctx) => {
      let n = 0;
      const gx = Math.round(gizmo.left - view.left); const gy = Math.round(gizmo.top - view.top);
      const d = ctx.getImageData(gx, gy, Math.round(gizmo.width), Math.round(gizmo.height)).data;
      for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n += 1;
      return n;
    };
    const a = count(await decode(await captureSceneToPng({
      width: Math.round(W), height: Math.round(Hh), transparent: true })));
    const b = count(await decode(await captureSceneToPng({
      width: Math.round(W), height: Math.round(Hh), transparent: true, structureOnly: true })));
    return {
      fullBox: full, bareBox: bare,
      gizmoAlphaDefault: a, gizmoAlphaStructureOnly: b,
    };
  });
  H.check('structure-only auto box is not larger than the full box',
    so.bareBox.width <= so.fullBox.width + 1 && so.bareBox.height <= so.fullBox.height + 1
      && (so.bareBox.width < so.fullBox.width - 1 || so.bareBox.height < so.fullBox.height - 1),
    JSON.stringify({ full: so.fullBox, bare: so.bareBox }));
  H.check('structure-only export omits the axes gizmo',
    so.gizmoAlphaDefault > 20 && so.gizmoAlphaStructureOnly < so.gizmoAlphaDefault * 0.1,
    JSON.stringify({ def: so.gizmoAlphaDefault, so: so.gizmoAlphaStructureOnly }));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
