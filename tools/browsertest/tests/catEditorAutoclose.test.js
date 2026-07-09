// Category color editors (element/bond/polyhedra dot -> "cat-editor" popover)
// must auto-close when the category's expand caret is toggled — previously
// they stayed open, hiding the live color change underneath.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    const { general } = await import('./state/store.js');
    general.structurePanelMode = 'atoms';
    setStructurePanelOpen(true);
  });
  await page.waitForTimeout(300);

  // --- Atoms: element-composition row ---
  const atomsResult = await page.evaluate(() => {
    const row = document.querySelector('.composition-row, [data-element]') ||
      [...document.querySelectorAll('div')].find(d => d.querySelector?.('.dot') && d.querySelector?.('.element-color-editor'));
    const container = document.getElementById('composition');
    const dot = container?.querySelector('.dot');
    const editor = container?.querySelector('.element-color-editor');
    dot?.click();
    const openedDisplay = editor?.style.display;
    const expandRow = editor?.closest('div')?.parentElement?.querySelector('div'); // best-effort
    return { hasDot: !!dot, hasEditor: !!editor, openedDisplay };
  });
  H.check('atoms: category dot + editor found', atomsResult.hasDot && atomsResult.hasEditor, JSON.stringify(atomsResult));
  H.check('atoms: clicking dot opens the editor', atomsResult.openedDisplay !== 'none', JSON.stringify(atomsResult));

  const atomsAfterExpand = await page.evaluate(() => {
    const container = document.getElementById('composition');
    const editor = container?.querySelector('.element-color-editor');
    const row = editor?.parentElement?.querySelector('div'); // the clickable row (first child)
    row?.click(); // toggles atom-list expand, should also close the editor
    return editor?.style.display;
  });
  H.check('atoms: expanding the atom list closes the category editor',
    atomsAfterExpand === 'none', `display=${atomsAfterExpand}`);

  // --- Bonds: bond-cat-editor / bond-expand-icon ---
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.structurePanelMode = 'bonds';
  });
  await page.waitForTimeout(300);

  const bondsResult = await page.evaluate(() => {
    const container = document.getElementById('composition');
    const dot = container?.querySelector('.bond-control .dot');
    const editor = container?.querySelector('.bond-cat-editor');
    dot?.click();
    return { hasDot: !!dot, hasEditor: !!editor, openedDisplay: editor?.style.display };
  });
  H.check('bonds: category dot + editor found', bondsResult.hasDot && bondsResult.hasEditor, JSON.stringify(bondsResult));
  H.check('bonds: clicking dot opens the editor', bondsResult.openedDisplay !== 'none', JSON.stringify(bondsResult));

  const bondsAfterExpand = await page.evaluate(() => {
    const container = document.getElementById('composition');
    const expandIcon = container?.querySelector('.bond-expand-icon');
    const editor = container?.querySelector('.bond-cat-editor');
    expandIcon?.click();
    return editor?.style.display;
  });
  H.check('bonds: expanding the bond list closes the category editor',
    bondsAfterExpand === 'none', `display=${bondsAfterExpand}`);

  // --- Polyhedra: poly-cat-editor / poly-expand-icon ---
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.polyhedraActive = true;
    general.structurePanelMode = 'polyhedra';
  });
  await page.waitForTimeout(300);

  const polyResult = await page.evaluate(() => {
    const container = document.getElementById('composition');
    const dot = container?.querySelector('.poly-control .dot');
    const editor = container?.querySelector('.poly-cat-editor');
    dot?.click();
    return { hasDot: !!dot, hasEditor: !!editor, openedDisplay: editor?.style.display };
  });
  if (polyResult.hasDot) {
    H.check('polyhedra: clicking dot opens the editor', polyResult.openedDisplay !== 'none', JSON.stringify(polyResult));
    const polyAfterExpand = await page.evaluate(() => {
      const container = document.getElementById('composition');
      const expandIcon = container?.querySelector('.poly-expand-icon');
      const editor = container?.querySelector('.poly-cat-editor');
      expandIcon?.click();
      return editor?.style.display;
    });
    H.check('polyhedra: expanding the list closes the category editor',
      polyAfterExpand === 'none', `display=${polyAfterExpand}`);
  } else {
    H.check('polyhedra: no polyhedra category in this structure (skip)', true);
  }

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
