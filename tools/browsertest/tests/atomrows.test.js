// Atoms tab two-way sync: clicking an individual atom row highlights that atom
// in the 3D view (mirror of 3D dblclick -> row), with toggle-off, ctrl-multi-
// select, and mutual exclusion with bond selection.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  // --- Open the Structure window and expand the first element category ----------
  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    /** @type {HTMLElement} */ (document.querySelector('#atomPanel .comp-row')).click();
  });
  await page.waitForTimeout(200);

  // --- Click an atom row's name area -> selected in state, 3D and UI ------------
  const sel = await page.evaluate(async () => {
    const { atomSelection, groups } = await import('./state/store.js');
    const row = /** @type {HTMLElement} */ (document.querySelector('#atomPanel .individual-atom-row'));
    /** @type {HTMLElement} */ (row.querySelector('span')).click(); // the name span
    const selected = atomSelection.selectedAtoms;
    return {
      rowAtomIndex: Number(row.dataset.atomIndex),
      count: selected.length,
      sourceIndex: selected[0]?.sourceIndex,
      glow: selected.length
        ? groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.getX(selected[0].instanceId)
        : 0,
      rowHighlighted: row.style.borderLeft.includes('rgb(255, 179, 71)'),
    };
  });
  H.check('clicking an atom row selects that atom (state + orange 3D glow + amber row)',
    sel.count === 1 && sel.sourceIndex === sel.rowAtomIndex && sel.glow === 2.0 && sel.rowHighlighted,
    JSON.stringify(sel));

  // --- Clicking the same row again deselects -------------------------------------
  const desel = await page.evaluate(async () => {
    const { atomSelection } = await import('./state/store.js');
    const row = /** @type {HTMLElement} */ (document.querySelector('#atomPanel .individual-atom-row'));
    /** @type {HTMLElement} */ (row.querySelector('span')).click();
    return { count: atomSelection.selectedAtoms.length, rowHighlighted: row.style.borderLeft !== '' };
  });
  H.check('clicking the selected row again deselects it',
    desel.count === 0 && !desel.rowHighlighted, JSON.stringify(desel));

  // --- Ctrl-click builds a multi-selection ---------------------------------------
  const multi = await page.evaluate(async () => {
    const { atomSelection } = await import('./state/store.js');
    const rows = document.querySelectorAll('#atomPanel .individual-atom-row');
    const clickName = (row, init) => row.querySelector('span').dispatchEvent(
      new MouseEvent('click', { bubbles: true, ...init }));
    clickName(rows[0], {});
    clickName(rows[1], { ctrlKey: true });
    return {
      count: atomSelection.selectedAtoms.length,
      indices: atomSelection.selectedAtoms.map((a) => a.sourceIndex),
      rowIndices: [Number(rows[0].dataset.atomIndex), Number(rows[1].dataset.atomIndex)],
    };
  });
  H.check('ctrl-clicking a second row adds it to the selection',
    multi.count === 2
      && multi.indices.includes(multi.rowIndices[0]) && multi.indices.includes(multi.rowIndices[1]),
    JSON.stringify(multi));

  // --- Mutual exclusion with bond selection --------------------------------------
  const exclusion = await page.evaluate(async () => {
    const { atomSelection, highlightHover } = await import('./state/store.js');
    // Switch to the Bonds tab, expand all categories (some pairs have no
    // bonds), click the first bond row found.
    /** @type {HTMLElement} */ (document.querySelector('#atomBondControlSwitch button[data-mode="bonds"]')).click();
    document.querySelectorAll('#infoBondControls .bond-expand-icon')
      .forEach((icon) => /** @type {HTMLElement} */ (icon).click());
    /** @type {HTMLElement} */ (document.querySelector('#infoBondControls .individual-bond-row')).click();
    const afterBond = {
      atoms: atomSelection.selectedAtoms.length,
      bond: !!highlightHover.currentlyHighlightedBond,
    };
    // Back to Atoms, click an atom row: bond selection must clear.
    /** @type {HTMLElement} */ (document.querySelector('#atomBondControlSwitch button[data-mode="atoms"]')).click();
    const row = /** @type {HTMLElement} */ (document.querySelector('#atomPanel .individual-atom-row'));
    /** @type {HTMLElement} */ (row.querySelector('span')).click();
    const afterAtom = {
      atoms: atomSelection.selectedAtoms.length,
      bond: !!highlightHover.currentlyHighlightedBond,
    };
    return { afterBond, afterAtom };
  });
  H.check('selecting a bond clears the atom selection, and vice versa',
    exclusion.afterBond.atoms === 0 && exclusion.afterBond.bond === true
      && exclusion.afterAtom.atoms === 1 && exclusion.afterAtom.bond === false,
    JSON.stringify(exclusion));

  // --- Editor buttons still work (row click must not swallow them) ---------------
  const editorStillWorks = await page.evaluate(async () => {
    const { atomSelection } = await import('./state/store.js');
    const before = atomSelection.selectedAtoms.map((a) => a.sourceIndex).join(',');
    const row = document.querySelector('#atomPanel .individual-atom-row');
    /** @type {HTMLElement} */ (row.querySelector('button[data-editor-button="color"]')).click();
    const editorOpen = /** @type {HTMLElement} */ (row.querySelector('.atom-color-editor')).style.display !== 'none';
    const after = atomSelection.selectedAtoms.map((a) => a.sourceIndex).join(',');
    return { editorOpen, selectionUnchanged: before === after };
  });
  H.check('the Color button opens its editor without changing the selection',
    editorStillWorks.editorOpen && editorStillWorks.selectionUnchanged, JSON.stringify(editorStillWorks));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
