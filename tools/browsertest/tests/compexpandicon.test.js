// The element-group expand caret (▶) must be selected by its own class, not
// `.comp-left span:last-child`. That positional selector matched the per-
// element visibility toggle's inner <span class="toggle_slider"> and, on the
// composition rebuild that follows an Apply/Reset in an atom row, rotated it
// 90deg - flipping the pill onto its side. Regression guard.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    const { general } = await import('./state/store.js');
    general.structurePanelMode = 'atoms';
    setStructurePanelOpen(true);
    // Expand the first element group through its caret (records it as expanded).
    /** @type {HTMLElement} */ (document.querySelector('.comp-container .comp-expand-icon')).click();
  });
  await page.waitForTimeout(200);

  // The rebuild that Apply/Reset triggers: re-render the composition, which runs
  // the expansion-restore path (General.js) that used to hit the toggle.
  await page.evaluate(async () => {
    const { updateAtomCoordinates } = await import('./ui/StructureInfoPanel/components/utils.js');
    updateAtomCoordinates(0, [0.1, 0.2, 0.3]);
  });
  await page.waitForTimeout(200);

  const res = await page.evaluate(() => {
    const sliders = [...document.querySelectorAll('.toggle_slider')];
    const carets = [...document.querySelectorAll('.comp-expand-icon')];
    return {
      // No toggle pill may carry a rotate transform.
      rotatedSliders: sliders.filter((s) => /rotate/.test(s.style.transform)).length,
      totalSliders: sliders.length,
      // The expanded group's caret is the one that should be rotated.
      rotatedCarets: carets.filter((c) => c.style.transform.includes('rotate(90deg)')).length,
      // And the toggle box stays wider-than-tall (horizontal pill).
      firstSliderFlipped: sliders[0]
        ? sliders[0].getBoundingClientRect().height > sliders[0].getBoundingClientRect().width
        : false,
    };
  });

  H.check('no toggle_slider gets a rotate transform on the composition rebuild',
    res.rotatedSliders === 0 && res.totalSliders > 0, JSON.stringify(res));
  H.check('the expanded group caret is the element that rotates',
    res.rotatedCarets >= 1, JSON.stringify(res));
  H.check('the toggle pill stays horizontal (not flipped on its side)',
    !res.firstSliderFlipped, JSON.stringify(res));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
