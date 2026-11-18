// PNG export dialog (ui/ImageExportPanel.js): the area chosen with "Choose
// region" is remembered for the browser session — the next Choose region
// starts from it instead of the automatic content box, through a reload of
// the tab (sessionStorage), until "Forget region" in the dialog drops it.
'use strict';
const H = require('../harness');

const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

const openDialog = (page) => page.evaluate(() => document.getElementById('saveImageButton').click());
const chooseRegion = (page) => page.evaluate(() => document.getElementById('pngDownloadBtn').click());

/** The crop rect in #view CSS px. */
async function cropRect(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.cv-crop-rect');
    const view = document.getElementById('view').getBoundingClientRect();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left - view.left, top: r.top - view.top, width: r.width, height: r.height };
  });
}

async function dragHandleBy(page, corner, dx, dy) {
  const from = await page.evaluate((c) => {
    const r = document.querySelector(`.cv-crop-handle-${c}`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, corner);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

/** Confirm the crop; the download is intercepted, the overlay closes itself. */
async function confirmCrop(page) {
  return page.evaluate(async () => {
    const orig = HTMLAnchorElement.prototype.click;
    let url = null;
    HTMLAnchorElement.prototype.click = function () { url = this.href; };
    try {
      document.querySelector('.cv-crop-confirm').click();
      for (let i = 0; i < 600 && !url; i++) await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 50 && document.querySelector('.cv-crop-overlay'); i++) await new Promise((r) => setTimeout(r, 100));
      return { downloaded: !!url, overlayGone: !document.querySelector('.cv-crop-overlay') };
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });
}

const forgetVisible = (page) => page.evaluate(() => {
  const b = document.getElementById('pngForgetRegionBtn');
  return !!b && !b.hidden && getComputedStyle(b).display !== 'none';
});

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Nothing remembered yet: no Forget button, the automatic starting box.
  await openDialog(page);
  H.check('a fresh session has no "Forget region" button', !(await forgetVisible(page)));
  await chooseRegion(page);
  const auto = await cropRect(page);
  // Shrink the selection from its south-east corner, then export it.
  await dragHandleBy(page, 'se', -60, -40);
  const chosen = await cropRect(page);
  H.check('the selection was changed', !!auto && !!chosen && chosen.width < auto.width - 30, JSON.stringify({ auto, chosen }));
  const done = await confirmCrop(page);
  H.check('the crop exported and the overlay closed', done.downloaded && done.overlayGone, JSON.stringify(done));

  // Reopened: Choose region starts from the exported area.
  await openDialog(page);
  H.check('"Forget region" appears once an area is remembered', await forgetVisible(page));
  await chooseRegion(page);
  const again = await cropRect(page);
  H.check('Choose region starts from the last area',
    !!again && near(again.left, chosen.left) && near(again.top, chosen.top) && near(again.width, chosen.width) && near(again.height, chosen.height),
    JSON.stringify({ chosen, again }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // A reload of the tab keeps it (sessionStorage).
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await H.loadDefaultStructure(page);
  await openDialog(page);
  await chooseRegion(page);
  const afterReload = await cropRect(page);
  H.check('the area survives a reload of the tab',
    !!afterReload && near(afterReload.left, chosen.left) && near(afterReload.top, chosen.top) && near(afterReload.width, chosen.width),
    JSON.stringify({ chosen, afterReload }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Forget region: back to the automatic framing, button gone.
  await openDialog(page);
  await page.evaluate(() => document.getElementById('pngForgetRegionBtn').click());
  H.check('"Forget region" hides itself', !(await forgetVisible(page)));
  await chooseRegion(page);
  const forgotten = await cropRect(page);
  H.check('after Forget region the automatic box is back',
    !!forgotten && near(forgotten.width, auto.width, 6) && near(forgotten.height, auto.height, 6),
    JSON.stringify({ auto, forgotten }));
  await page.keyboard.press('Escape');

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
