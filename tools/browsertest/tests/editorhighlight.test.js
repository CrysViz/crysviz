// Selecting an atom/bond glows it orange (SelectAndHighlightModule's
// ATOM_HIGHLIGHT_COLOR), which overwrites the instance color outright.
// Opening the atom/bond color editor must suppress that glow so a live
// color change is actually visible, and restore it when the editor closes.
'use strict';
const H = require('../harness');

const differs = (a, b) => Math.abs(a.r - b.r) > 0.05 || Math.abs(a.g - b.g) > 0.05 || Math.abs(a.b - b.b) > 0.05;

async function instanceColor(page, instanceId) {
  return page.evaluate(async (instanceId) => {
    const { groups } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const c = new THREE.Color();
    groups.atomsMesh.getColorAt(instanceId, c);
    return { r: c.r, g: c.g, b: c.b };
  }, instanceId);
}

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

  const baseline = await instanceColor(page, 0);

  const selInfo = await page.evaluate(async () => {
    const { atomSelection } = await import('./state/store.js');
    const { selectAtomFromRow } = await import('./ui/SelectAndHighlightModule.js');
    selectAtomFromRow(0, null, null);
    return atomSelection.selectedAtoms[0]?.instanceId;
  });
  const instanceId = selInfo ?? 0;
  const selected = await instanceColor(page, instanceId);
  H.check('selecting an atom applies the 3D highlight glow (color changes)',
    differs(baseline, selected), `baseline=${JSON.stringify(baseline)} selected=${JSON.stringify(selected)}`);

  const setup = await page.evaluate(() => {
    const row = document.querySelector('.individual-atom-row[data-atom-index="0"]');
    return { hasRow: !!row, hasBtn: !!row?.querySelector('[data-editor-button="color"]') };
  });
  H.check('atom row + color-edit button found', setup.hasRow && setup.hasBtn, JSON.stringify(setup));

  await page.evaluate(() => {
    const row = document.querySelector('.individual-atom-row[data-atom-index="0"]');
    row.querySelector('[data-editor-button="color"]').click();
  });
  await page.waitForTimeout(150);
  const whileEditing = await instanceColor(page, instanceId);
  H.check('glow is suppressed while the color editor is open (color back to real)',
    !differs(baseline, whileEditing), `baseline=${JSON.stringify(baseline)} whileEditing=${JSON.stringify(whileEditing)}`);

  await page.evaluate(() => {
    const row = document.querySelector('.individual-atom-row[data-atom-index="0"]');
    row.querySelector('[data-editor-button="color"]').click();
  });
  await page.waitForTimeout(150);
  const afterClose = await instanceColor(page, instanceId);
  H.check('glow is restored after the color editor closes',
    differs(baseline, afterClose), `baseline=${JSON.stringify(baseline)} afterClose=${JSON.stringify(afterClose)}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
