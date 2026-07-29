// Modify Structure panel (#addButton): a LIVE editor on the loaded structure.
// Every edit applies immediately and persists when the panel closes; the
// New/Removed lists are derived from a diff kept on the structure, so they
// survive a close/reopen; the button REVERTS to the as-loaded structure, and
// the lattice section has its own Reset. The Add Structure panel
// (.add-structure-button) is the opposite - blank, staged, builds a new file.
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';
const ADD = '[data-panel-id="addStructure"]';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept()); // Revert asks for confirmation
  await H.loadDefaultStructure(page); // YBCO, 13 atoms

  // --- Opens prefilled with every atom + the real lattice, no bulk picker ----
  const opened = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    const panel = document.querySelector('[data-panel-id="modifyStructure"]');
    return {
      rows: panel.querySelectorAll('#atomsTable tbody tr').length,
      atoms: fileBrowser.selectedStructure.atoms.length,
      a: Number(/** @type {HTMLInputElement} */ (panel.querySelector('#latA')).value),
      hasBulkElementPicker: !!panel.querySelector('#selectElementForBulk'),
      button: panel.querySelector('#commitStructureEdits')?.textContent,
    };
  });
  H.check('prefills one row per atom, real lattice, no bulk picker, Revert button',
    opened.rows === opened.atoms && opened.atoms > 0 && Math.abs(opened.a - 10) > 0.01
      && !opened.hasBulkElementPicker && opened.button === 'Revert Changes',
    JSON.stringify(opened));

  // --- A coordinate typed in the table moves the atom in the scene live ------
  const liveMove = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    const row = panel.querySelectorAll('#atomsTable tbody tr')[2];
    const uuid = row.dataset.uuid;
    const idx = fileBrowser.selectedStructure.atoms.findIndex((a) => a.uuid === uuid);
    const input = /** @type {HTMLInputElement} */ (row.querySelector('.atom-x'));
    input.value = '0.321';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { x: fileBrowser.selectedStructure.atoms[idx].position[0] };
  }, MODIFY);
  H.check('a coordinate typed in the table moves the atom immediately',
    Math.abs(liveMove.x - 0.321) < 1e-6, JSON.stringify(liveMove));

  // --- Editing the same atom from the Structure Info panel reaches the table -
  const inbound = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const { updateAtomCoordinates } = await import('./ui/StructureInfoPanel/components/utils.js');
    const uuid = fileBrowser.selectedStructure.atoms[4].uuid;
    updateAtomCoordinates(4, [0.375, 0.125, 0.625]);
    const row = document.querySelector(`${sel} #atomsTable tbody tr[data-uuid="${uuid}"]`);
    return { x: row?.querySelector('.atom-x').value, z: row?.querySelector('.atom-z').value };
  }, MODIFY);
  H.check('a coordinate edited in the Structure Info panel updates the table',
    Number(inbound.x) === 0.375 && Number(inbound.z) === 0.625, JSON.stringify(inbound));

  // --- Adding a row adds the atom live and lists it under "New atoms" --------
  const added = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    const before = fileBrowser.selectedStructure.atoms.length;
    /** @type {HTMLElement} */ (panel.querySelector('#addNewRow')).click();
    const newRow = panel.querySelector('#atomsTable tbody tr:last-child');
    const set = (cls, v) => {
      const el = /** @type {HTMLInputElement} */ (newRow.querySelector(cls));
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('.atom-element', 'Ne'); set('.atom-x', '0.8'); set('.atom-y', '0.8'); set('.atom-z', '0.8');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const sep = panel.querySelector('.atom-new-separator');
    return {
      before,
      after: fileBrowser.selectedStructure.atoms.length,
      hasNe: fileBrowser.selectedStructure.elements.includes('Ne'),
      // Additions live in the table under a "Newly added" separator - there is
      // no separate "New atoms" summary list.
      separator: sep?.textContent.trim(),
      noNewList: !panel.textContent.includes('New atoms'),
    };
  }, MODIFY);
  H.check('adding a row adds the atom live, under a "Newly added" separator, no New-atoms list',
    added.after === added.before + 1 && added.hasNe && added.separator === 'Newly added' && added.noNewList,
    JSON.stringify(added));

  // --- Deleting an original removes it live and lists it under "Removed" -----
  const removed = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    const before = fileBrowser.selectedStructure.atoms.length;
    /** @type {HTMLElement} */ (panel.querySelector('.atom-row-delete')).click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      before,
      after: fileBrowser.selectedStructure.atoms.length,
      removedHeading: panel.textContent.includes('Removed atoms (1)'),
      parallel: fileBrowser.selectedStructure.atoms.length === fileBrowser.selectedStructure.elements.length,
    };
  }, MODIFY);
  H.check('deleting an original removes it live and lists it under Removed',
    removed.after === removed.before - 1 && removed.removedHeading && removed.parallel,
    JSON.stringify(removed));

  // --- Close and reopen: the edits and the New/Removed lists both persist ----
  const persisted = await page.evaluate(async (sel) => {
    const { removePanel } = await import('./ui/panels/PanelManager.js');
    const { fileBrowser } = await import('./state/store.js');
    removePanel('modifyStructure');
    const stillHasNe = fileBrowser.selectedStructure.elements.includes('Ne');
    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    const panel = document.querySelector(sel);
    return {
      stillHasNe,
      separator: panel.querySelector('.atom-new-separator')?.textContent.trim(),
      removedHeading: panel.textContent.includes('Removed atoms (1)'),
    };
  }, MODIFY);
  H.check('added/removed persist when the panel is closed and reopened',
    persisted.stillHasNe && persisted.separator === 'Newly added' && persisted.removedHeading,
    JSON.stringify(persisted));

  // --- Restoring a removed atom puts it back --------------------------------
  const restored = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    const before = fileBrowser.selectedStructure.atoms.length;
    const restoreBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent === '↺');
    restoreBtn.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // The restored original must rejoin the OLD stack (above the "Newly added"
    // separator), not sit among the new atoms: every row before the separator
    // is a baseline atom, every row after it is a new one.
    const baseline = fileBrowser.selectedStructure._modify.baseline;
    const rows = [...panel.querySelectorAll('#atomsTable tbody tr')];
    const sepIdx = rows.findIndex((r) => r.classList.contains('atom-new-separator'));
    const atomsBefore = rows.slice(0, sepIdx).filter((r) => r.dataset.uuid);
    const atomsAfter = rows.slice(sepIdx + 1).filter((r) => r.dataset.uuid);
    return {
      before,
      after: fileBrowser.selectedStructure.atoms.length,
      removedGone: !panel.textContent.includes('Removed atoms'),
      grouped: sepIdx > 0
        && atomsBefore.every((r) => baseline.has(r.dataset.uuid))
        && atomsAfter.length > 0 && atomsAfter.every((r) => !baseline.has(r.dataset.uuid)),
    };
  }, MODIFY);
  H.check('restoring a removed atom puts it back in the old stack, above the separator',
    restored.after === restored.before + 1 && restored.removedGone && restored.grouped,
    JSON.stringify(restored));

  // --- Reset Lattice restores the cell without touching the atoms -----------
  const latticeReset = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    const origA = fileBrowser.selectedStructure.original.lattice[0][0];
    const matInput = /** @type {HTMLInputElement} */ (panel.querySelector('.lat-mat[data-i="0"][data-j="0"]'));
    matInput.value = String(origA + 3);
    matInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const changed = fileBrowser.selectedStructure.lattice[0][0];
    const resetBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Reset Lattice');
    resetBtn.click();
    return {
      origA,
      changed,
      afterReset: fileBrowser.selectedStructure.lattice[0][0],
      shownA: Number(/** @type {HTMLInputElement} */ (panel.querySelector('#latA')).value),
    };
  }, MODIFY);
  H.check('Reset Lattice restores the cell and its input fields',
    Math.abs(latticeReset.changed - (latticeReset.origA + 3)) < 1e-6
      && Math.abs(latticeReset.afterReset - latticeReset.origA) < 1e-6
      && Math.abs(latticeReset.shownA - latticeReset.origA) < 1e-3,
    JSON.stringify(latticeReset));

  // --- Revert Changes restores the whole structure --------------------------
  const reverted = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    const origCount = fileBrowser.selectedStructure.original.atoms.length;
    /** @type {HTMLElement} */ (panel.querySelector('#commitStructureEdits')).click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      origCount,
      atoms: fileBrowser.selectedStructure.atoms.length,
      hasNe: fileBrowser.selectedStructure.elements.includes('Ne'),
      summaryEmpty: !panel.textContent.includes('New atoms') && !panel.textContent.includes('Removed atoms'),
    };
  }, MODIFY);
  H.check('Revert Changes restores the original atom set and clears the summary',
    reverted.atoms === reverted.origCount && !reverted.hasNe && reverted.summaryEmpty,
    JSON.stringify(reverted));

  // --- The Add Structure panel is still the blank, staged one ---------------
  const addPanel = await page.evaluate((sel) => {
    /** @type {HTMLElement} */ (document.querySelector('.add-structure-button')).click();
    const panel = document.querySelector(sel);
    const rows = [...panel.querySelectorAll('#atomsTable tbody tr')];
    return {
      rows: rows.length,
      empty: rows.every((row) => row.querySelector('.atom-element').value === ''),
      hasDeleteColumn: !!panel.querySelector('.atom-row-delete'),
      commitLabel: panel.querySelector('#commitStructureEdits').textContent.trim(),
    };
  }, ADD);
  H.check('the Add Structure panel still starts blank, staged, no per-row delete',
    addPanel.rows === 1 && addPanel.empty && !addPanel.hasDeleteColumn
      && addPanel.commitLabel === 'Create Structure',
    JSON.stringify(addPanel));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
