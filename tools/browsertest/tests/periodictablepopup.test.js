// The element-picker popup (PeriodicTableSelectPanel.js, the ⚛ buttons).
//
// It renders under a fixed #periodicTablePopup id, so opening it twice used to
// append a second element sharing that id: every getElementById inside then
// addressed only the first, and the popup had to be closed once per time it had
// been opened. Escape and clicking outside did nothing at all — only the Close
// button dismissed it.
'use strict';
const H = require('../harness');

const count = (page) => page.evaluate(() =>
  document.querySelectorAll('#periodicTablePopup').length);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const open = () => page.evaluate(async () => {
    const { openPeriodicTable } = await import('./ui/PeriodicTableSelectPanel.js');
    openPeriodicTable(() => {});
  });

  // --- Opening twice leaves ONE popup, closable once ------------------------
  await open();
  await open();
  await page.waitForTimeout(100);
  const doubled = await count(page);
  H.check('opening twice does not stack a second popup', doubled === 1, String(doubled));

  await page.evaluate(() => {
    /** @type {HTMLElement} */ (
      document.querySelector('#periodicTablePopup .periodic-table-close')).click();
  });
  H.check('one Close dismisses it', await count(page) === 0);

  // --- Escape ---------------------------------------------------------------
  await open();
  await page.waitForTimeout(100);
  H.check('the popup is up again', await count(page) === 1);
  await page.keyboard.press('Escape');
  H.check('Escape dismisses it', await count(page) === 0);

  // --- Clicking outside -----------------------------------------------------
  await open();
  await page.waitForTimeout(100);
  // A click INSIDE must not dismiss it — picking an element is a click too.
  await page.evaluate(() => {
    /** @type {HTMLElement} */ (
      document.querySelector('#periodicTablePopup .element-button')).click();
  });
  H.check('clicking an element inside keeps it open', await count(page) === 1);

  await page.mouse.click(5, 5); // top-left corner, well outside the centred popup
  await page.waitForTimeout(100);
  H.check('clicking outside dismisses it', await count(page) === 0);

  // --- The opening click itself must not close it ---------------------------
  // The popup opens from a click that is still propagating to document, so a
  // naively-registered outside-click listener would see it and close at once.
  await page.evaluate(async () => {
    const { openPeriodicTable } = await import('./ui/PeriodicTableSelectPanel.js');
    const opener = document.createElement('button');
    opener.id = 'ptOpenerProbe';
    opener.addEventListener('click', () => openPeriodicTable(() => {}));
    document.body.appendChild(opener);
  });
  await H.clickById(page, 'ptOpenerProbe');
  await page.waitForTimeout(150);
  H.check('the click that opened it does not immediately close it',
    await count(page) === 1);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
