// The SVG half of the download dialog (ui/ImageExportPanel.js): one
// "Image…" entry and one modal serve both formats, so what matters is that
// the Format select actually switches what gets downloaded — file extension,
// blob type — that the SVG-only "Structure as" row appears only for SVG, and
// that the choice is remembered.
'use strict';
const H = require('../harness');

/** Open the dialog, optionally switch Format, and read it back. */
async function openDialog(page, format) {
  return page.evaluate((fmt) => {
    document.getElementById('saveImageButton').click();
    if (fmt) {
      const sel = document.getElementById('imgFormat');
      sel.value = fmt;
      sel.dispatchEvent(new Event('change'));
    }
    return {
      hidden: document.getElementById('pngExportModal').hidden,
      format: document.getElementById('imgFormat').value,
      structureRowHidden: document.getElementById('svgStructureRow').hidden,
      note: (document.getElementById('imgExportNote').textContent || '').slice(0, 80),
    };
  }, format || null);
}

/** Press Save with the anchor click stubbed; returns the download's name and
 *  the text its object URL resolves to (truncated). */
async function saveAndCapture(page) {
  return page.evaluate(async () => {
    const orig = HTMLAnchorElement.prototype.click;
    let name = null;
    let href = null;
    HTMLAnchorElement.prototype.click = function stub() {
      name = this.download;
      href = this.href;
    };
    try {
      document.getElementById('pngSaveBtn').click();
      for (let i = 0; i < 600 && !name; i++) await new Promise((r) => setTimeout(r, 100));
      if (!name) return null;
      const response = await fetch(href);
      const blob = await response.blob();
      const head = (await blob.text()).slice(0, 400);
      return {
        name, type: blob.type, head, modalClosed: document.getElementById('pngExportModal').hidden,
      };
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  const menu = await page.evaluate(() => {
    const btn = document.getElementById('saveImageButton');
    const m = document.getElementById('downloadMenu');
    return {
      single: !!btn && !!m && m.contains(btn)
        && !document.getElementById('savePngButton') && !document.getElementById('saveSvgButton'),
      formats: [...document.querySelectorAll('#imgFormat option')].map((o) => o.value),
    };
  });
  H.check('the download menu has one Image entry, the format lives in the dialog',
    menu.single && menu.formats.includes('png') && menu.formats.includes('svg'),
    JSON.stringify(menu));

  const firstOpen = await openDialog(page);
  H.check('first open defaults to PNG with the SVG row folded away',
    firstOpen.hidden === false && firstOpen.format === 'png' && firstOpen.structureRowHidden === true,
    JSON.stringify(firstOpen));
  await page.evaluate(() => document.getElementById('pngCancelBtn').click());

  const svgOpen = await openDialog(page, 'svg');
  H.check('switching Format to SVG',
    svgOpen.hidden === false && svgOpen.format === 'svg', JSON.stringify(svgOpen));
  H.check('and reveals the "Structure as" row',
    svgOpen.structureRowHidden === false, JSON.stringify(svgOpen));

  // Keep the export small: this is about plumbing, not resolution.
  await page.evaluate(() => {
    document.getElementById('pngAspect').value = '1:1';
    document.getElementById('pngAspect').dispatchEvent(new Event('change'));
    const w = document.getElementById('pngWidth');
    w.value = '320';
    w.dispatchEvent(new Event('input'));
  });
  const svgSaved = await saveAndCapture(page);
  H.check('Save downloads a .svg through captureSceneToSvg',
    !!svgSaved && /\.svg$/.test(svgSaved.name) && /svg\+xml/.test(svgSaved.type)
      && svgSaved.head.includes('<svg') && svgSaved.head.includes('inkscape'),
    JSON.stringify(svgSaved && { name: svgSaved.name, type: svgSaved.type }));
  H.check('and closes the modal', !!svgSaved && svgSaved.modalClosed);

  // The format is a pref: reopening lands on SVG; switching back to PNG
  // folds the SVG row away again.
  const reopened = await openDialog(page);
  H.check('reopening remembers Format=SVG', reopened.format === 'svg', JSON.stringify(reopened));
  await page.evaluate(() => document.getElementById('pngCancelBtn').click());
  const pngOpen = await openDialog(page, 'png');
  H.check('switching back to PNG hides the SVG row',
    pngOpen.format === 'png' && pngOpen.structureRowHidden === true,
    JSON.stringify(pngOpen));

  const pngSaved = await saveAndCapture(page);
  H.check('Save still downloads a .png in PNG mode',
    !!pngSaved && /\.png$/.test(pngSaved.name) && pngSaved.type === 'image/png',
    JSON.stringify(pngSaved && { name: pngSaved.name, type: pngSaved.type }));

  // "Structure as" is remembered, since it is the choice with a real cost.
  await page.evaluate(() => {
    document.getElementById('saveImageButton').click();
    const sel = document.getElementById('svgStructure');
    sel.value = 'vector';
    sel.dispatchEvent(new Event('change'));
    document.getElementById('pngCancelBtn').click();
    document.getElementById('saveImageButton').click();
  });
  const remembered = await page.evaluate(() => {
    const value = document.getElementById('svgStructure').value;
    document.getElementById('pngCancelBtn').click();
    return value;
  });
  H.check('the vector/raster choice is remembered', remembered === 'vector', remembered);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
