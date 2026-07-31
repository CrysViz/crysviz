// Modify Structure panel: the atom-table highlight column and its two-way link
// with the 3D selection, plus the Structure Info coordinate slider being
// draggable (a live drag must not rebuild the composition panel out from under
// the slider). All three regressed the same "who rebuilds what" boundary.
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  // --- The table has a dedicated highlight column, one button per atom -------
  const column = await page.evaluate((sel) => {
    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    const panel = document.querySelector(sel);
    const rows = panel.querySelectorAll('#atomsTable tbody tr');
    return {
      rows: rows.length,
      buttons: panel.querySelectorAll('.atom-row-highlight').length,
    };
  }, MODIFY);
  H.check('every atom row carries a highlight button', column.rows === column.buttons && column.rows > 0,
    JSON.stringify(column));

  // --- Clicking a highlight button glows that atom in 3D and marks the row ---
  const outbound = await page.evaluate(async (sel) => {
    const { groups } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const before = new THREE.Color();
    groups.atomsMesh.getColorAt(0, before);

    const panel = document.querySelector(sel);
    const firstRow = panel.querySelector('#atomsTable tbody tr');
    /** @type {HTMLElement} */ (firstRow.querySelector('.atom-row-highlight')).click();

    const after = new THREE.Color();
    groups.atomsMesh.getColorAt(0, after);
    const rowBg = getComputedStyle(firstRow).backgroundColor;
    return {
      glowChanged: Math.abs(after.r - before.r) > 0.05 || Math.abs(after.g - before.g) > 0.05 || Math.abs(after.b - before.b) > 0.05,
      rowActive: rowBg.includes('255, 191, 0'),
    };
  }, MODIFY);
  H.check('the highlight button lights the atom in 3D and marks its row active',
    outbound.glowChanged && outbound.rowActive, JSON.stringify(outbound));

  // --- Selecting an atom in the 3D scene lights up its table row (reverse) ---
  const reverse = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomFromRow, clearSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const uuid = fileBrowser.selectedStructure.atoms[3].uuid;
    const panel = document.querySelector(sel);
    const row = panel.querySelector(`#atomsTable tbody tr[data-uuid="${uuid}"]`);

    selectAtomFromRow(3, null, null);
    const litOnSelect = getComputedStyle(row).backgroundColor.includes('255, 191, 0');

    clearSelectedAtoms();
    const clearedOnDeselect = !getComputedStyle(row).backgroundColor.includes('255, 191, 0');
    return { litOnSelect, clearedOnDeselect };
  }, MODIFY);
  H.check('a 3D selection lights the matching table row, deselect clears it',
    reverse.litOnSelect && reverse.clearedOnDeselect, JSON.stringify(reverse));

  // --- The Structure Info coordinate slider survives a live drag ------------
  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    const { general } = await import('./state/store.js');
    general.structurePanelMode = 'atoms';
    setStructurePanelOpen(true);
    const { selectAtomFromRow } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomFromRow(0, null, null); // expands atom 0's row
  });
  await page.waitForTimeout(300);

  const drag = await page.evaluate(async () => {
    const row = document.querySelector('.individual-atom-row[data-atom-index="0"]');
    /** @type {HTMLElement} */ (row.querySelector('[data-editor-button="coord"]')).click();
    /** @type {any} */ (row.querySelector('.coord-axis-slider'))._probe = true;
    const slider = /** @type {HTMLInputElement} */ (row.querySelector('.coord-axis-slider'));

    // A live drag is a stream of 'input' events; if the panel rebuilt on each
    // one the slider node would be replaced and the drag would die after frame
    // one. Fire a couple and confirm the same node is still there.
    slider.value = '0.42';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.value = '0.44';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const survived = slider.isConnected && /** @type {any} */ (slider)._probe === true;

    // The full path (Apply / release) DOES rebuild the composition, so the
    // probed node must then be gone — proving the live path really is lighter.
    const { updateAtomCoordinates } = await import('./ui/StructureInfoPanel/components/utils.js');
    updateAtomCoordinates(0, [0.1, 0.2, 0.3]);
    const rebuiltOnFullUpdate = !slider.isConnected;
    return { survived, rebuiltOnFullUpdate };
  });
  H.check('the coord slider survives a live drag but the full update rebuilds it',
    drag.survived && drag.rebuiltOnFullUpdate, JSON.stringify(drag));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
