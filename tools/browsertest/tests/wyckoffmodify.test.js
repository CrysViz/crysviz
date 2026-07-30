// Modify Structure panel while the structure is Wyckoff-locked
// (StructureEditorPanel.js's buildWyckoffModifyEditor). The point of this file
// is that locking symmetry must not cost the user half the panel: the same
// edits are on offer as unlocked - cell, element, colour, coordinates, add,
// remove - but the unit is a whole orbit, and the cell is projected onto what
// the lock allows. Reverting releases the lock, so the body must swap back to
// the free-form atom table rather than keep showing orbits for a structure
// that has none.
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';

async function enableWyckoff(page) {
  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('symmetry');
  });
  await page.waitForTimeout(1500);
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
}

const openModify = (page) => page.evaluate(() => {
  /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
});

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO, several orbits
  await enableWyckoff(page);

  const locked = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    return fileBrowser.selectedStructure?.symmetry?.mode === 'wyckoff';
  });
  H.check('structure is Wyckoff-locked before modifying', locked);

  // --- The locked panel offers the whole editor, not a cut-down one ----------
  await openModify(page);
  await page.waitForTimeout(600);

  const shape = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const panel = document.querySelector(sel);
    return {
      title: document.querySelector(`${sel} .cv-panel-title, ${sel} .panel-title`)?.textContent?.trim() || '',
      orbitRows: panel.querySelectorAll('.orbit-element').length,
      orbits: fileBrowser.selectedStructure.symmetry.orbitGroups.length,
      hasLatticeParams: !!panel.querySelector('#latA') && !!panel.querySelector('#latAlpha'),
      hasAddSite: !!panel.querySelector('#wyckoffAddSite'),
      hasRevert: !!panel.querySelector('#commitStructureEdits'),
      // The free-form per-atom table must NOT be there: one row per atom would
      // let a single atom of a multiplicity-N site be dragged off on its own.
      hasAtomTable: !!panel.querySelector('#atomsTable'),
    };
  }, MODIFY);
  H.check('locked panel has one row per orbit, a lattice, Add Site and Revert - and no per-atom table',
    shape.orbitRows === shape.orbits && shape.orbitRows > 1 && shape.hasLatticeParams
      && shape.hasAddSite && shape.hasRevert && !shape.hasAtomTable,
    JSON.stringify(shape));
  H.check('one title for both modes', shape.title === 'Modify Structure', shape.title);

  // --- A coordinate edit moves the whole orbit ------------------------------
  const moved = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    // Orbit rows only: the lattice and Add-Site tables have rows of their own,
    // and counting those makes the row index disagree with the orbit index.
    const rows = [...panel.querySelectorAll('tr')].filter((r) => r.querySelector('.orbit-element'));

    // Pick a row whose z is editable, i.e. an orbit with a free axis.
    const rowIndex = rows.findIndex((r) => r.querySelector('.orbit-z') && !r.querySelector('.orbit-z').disabled);
    const orbit = s.symmetry.orbitGroups[rowIndex];
    const before = orbit.atomIndices.map((i) => [...s.atoms[i].position]);

    const input = rows[rowIndex].querySelector('.orbit-z');
    input.value = String(Number(before[0][2]) + 0.07);
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const after = orbit.atomIndices.map((i) => [...s.atoms[i].position]);
    return {
      multiplicity: orbit.atomIndices.length,
      // Every atom of the orbit has to have moved, not just the representative.
      allMoved: before.every((p, k) => Math.hypot(...p.map((v, ax) => v - after[k][ax])) > 1e-6),
      stillWyckoff: s.symmetry.mode === 'wyckoff',
      shown: rows[rowIndex].querySelector('.orbit-z').value,
      actual: after[0][2],
    };
  }, MODIFY);
  H.check('editing a representative coordinate moves every atom of its orbit',
    moved.allMoved && moved.multiplicity > 1 && moved.stillWyckoff, JSON.stringify(moved));
  // The move is projected onto the site's degrees of freedom, so the box must
  // show where the atom landed, not what was typed.
  H.check('the box shows the projected position, not the typed one',
    Math.abs(parseFloat(moved.shown) - moved.actual) < 1e-3, JSON.stringify(moved));

  // --- Re-elementing an orbit hits all of its atoms -------------------------
  const reElemented = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const orbit = s.symmetry.orbitGroups[0];
    const indices = [...orbit.atomIndices];
    const input = document.querySelector(`${sel} tbody tr .orbit-element`);
    input.value = 'Fe';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      elements: indices.map((i) => s.elements[i]),
      parallel: s.elements.length === s.atoms.length,
      inUnique: s.uniqueElements.includes('Fe'),
      stillWyckoff: s.symmetry.mode === 'wyckoff',
    };
  }, MODIFY);
  H.check('an orbit re-elements as one unit, arrays stay parallel',
    reElemented.elements.every((e) => e === 'Fe') && reElemented.parallel
      && reElemented.inUnique && reElemented.stillWyckoff,
    JSON.stringify(reElemented));

  // --- Adding a site adds the whole orbit ----------------------------------
  const added = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    const before = s.atoms.length;
    const orbitsBefore = s.symmetry.orbitGroups.length;

    panel.querySelector('#wyckoffNewElement').value = 'Mg';
    const coords = { X: 0.31, Y: 0.17, Z: 0.23 };
    for (const [axis, value] of Object.entries(coords)) {
      const input = panel.querySelector(`#wyckoffNew${axis}`);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // The panel promises a count before the add; it has to be the count that lands.
    const promised = panel.textContent.match(/Adds (\d+) atom/);
    panel.querySelector('#wyckoffAddSite').click();

    const orbit = s.symmetry.orbitGroups[s.symmetry.orbitGroups.length - 1];
    return {
      before,
      after: s.atoms.length,
      promised: promised ? Number(promised[1]) : null,
      newOrbitSize: orbit.atomIndices.length,
      newOrbitElements: [...new Set(orbit.atomIndices.map((i) => s.elements[i]))],
      orbitsBefore,
      orbitsAfter: s.symmetry.orbitGroups.length,
      parallel: s.elements.length === s.atoms.length,
      stillWyckoff: s.symmetry.mode === 'wyckoff',
      indicesInRange: s.symmetry.orbitGroups.every((g) =>
        g.atomIndices.every((i) => i >= 0 && i < s.atoms.length)
        && g.representativeIndex >= 0 && g.representativeIndex < s.atoms.length),
      rows: panel.querySelectorAll('.orbit-element').length,
    };
  }, MODIFY);
  H.check('adding a site adds exactly the orbit the panel promised',
    added.promised !== null && added.after === added.before + added.promised
      && added.newOrbitSize === added.promised && added.promised > 1,
    JSON.stringify(added));
  H.check('the added orbit is one new element group, lock intact, indices in range',
    added.orbitsAfter === added.orbitsBefore + 1 && added.newOrbitElements.join() === 'Mg'
      && added.parallel && added.stillWyckoff && added.indicesInRange
      && added.rows === added.orbitsAfter,
    JSON.stringify(added));

  // --- Deleting an orbit drops all of its atoms -----------------------------
  const removed = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const before = s.atoms.length;
    const orbitsBefore = s.symmetry.orbitGroups.length;
    const victimSize = s.symmetry.orbitGroups[0].atomIndices.length;

    const panel = document.querySelector(sel);
    const removeBtn = [...panel.querySelectorAll('.orbit-remove')].find((b) => !b.disabled);
    removeBtn.click();

    return {
      before,
      victimSize,
      after: s.atoms.length,
      parallel: s.elements.length === s.atoms.length,
      orbitsBefore,
      orbitsAfter: s.symmetry.orbitGroups.length,
      stillWyckoff: s.symmetry.mode === 'wyckoff',
      indicesInRange: s.symmetry.orbitGroups.every((g) =>
        g.atomIndices.every((i) => i >= 0 && i < s.atoms.length)
        && g.representativeIndex >= 0 && g.representativeIndex < s.atoms.length),
      rows: panel.querySelectorAll('.orbit-element').length,
    };
  }, MODIFY);
  H.check('removing an orbit drops all its atoms and keeps arrays parallel',
    removed.after === removed.before - removed.victimSize && removed.parallel,
    JSON.stringify(removed));
  H.check('the lock survives with one fewer orbit, indices renumbered in range',
    removed.stillWyckoff && removed.orbitsAfter === removed.orbitsBefore - 1
      && removed.indicesInRange && removed.rows === removed.orbitsAfter,
    JSON.stringify(removed));

  // --- Added and removed orbits are shown, and a removal can be undone ------
  const diff = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    // The heading is its own div; its parent's textContent runs the entries in
    // after it, so match the innermost node that starts with it.
    const heading = [...panel.querySelectorAll('div')]
      .map((node) => node.textContent?.trim())
      .filter((text) => text?.startsWith('Removed orbits'))
      .pop();
    const before = {
      // The Mg orbit added earlier is still there and must be marked as new.
      separator: !!panel.querySelector('.orbit-new-separator'),
      heading,
      atoms: s.atoms.length,
      orbits: s.symmetry.orbitGroups.length,
    };
    // ↺ puts the removed orbit back, whole.
    const restore = [...panel.querySelectorAll('button')].find((b) => b.textContent === '↺');
    restore.click();
    return {
      before,
      restored: {
        atoms: s.atoms.length,
        orbits: s.symmetry.orbitGroups.length,
        stillWyckoff: s.symmetry.mode === 'wyckoff',
        headingGone: ![...panel.querySelectorAll('div')]
          .map((node) => node.textContent).some((text) => text?.startsWith('Removed orbits')),
        indicesInRange: s.symmetry.orbitGroups.every((g) =>
          g.atomIndices.every((i) => i >= 0 && i < s.atoms.length)),
      },
    };
  }, MODIFY);
  H.check('an added orbit sits under a "Newly added" separator and a removed one is listed',
    diff.before.separator && diff.before.heading === 'Removed orbits (1)', JSON.stringify(diff.before));
  H.check('restoring a removed orbit brings back all its atoms and clears the list',
    diff.restored.atoms === diff.before.atoms + removed.victimSize
      && diff.restored.orbits === diff.before.orbits + 1
      && diff.restored.stillWyckoff && diff.restored.headingGone && diff.restored.indicesInRange,
    JSON.stringify(diff.restored));

  // --- The cell is editable, but only along what the symmetry allows --------
  const cell = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const { latticeParameters } = await import('./math/index.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);

    const before = latticeParameters(s.lattice);
    const angleInputs = ['latAlpha', 'latBeta', 'latGamma'].map((id) => panel.querySelector(`#${id}`));
    // YBCO is orthorhombic, so every angle is fixed at 90 by the group and the
    // panel must say so by disabling the boxes.
    const anglesLocked = angleInputs.every((input) => input.disabled);

    const aInput = panel.querySelector('#latA');
    aInput.value = String(before.a + 0.5);
    aInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const after = latticeParameters(s.lattice);
    return {
      anglesLocked,
      aBefore: before.a,
      aAfter: after.a,
      angles: [after.alpha, after.beta, after.gamma],
      stillWyckoff: s.symmetry.mode === 'wyckoff',
    };
  }, MODIFY);
  H.check('cell angles the group fixes are disabled, not merely corrected',
    cell.anglesLocked, JSON.stringify(cell));
  H.check('a length edit reaches the structure and keeps the angles the group fixes',
    Math.abs(cell.aAfter - cell.aBefore) > 1e-4
      && cell.angles.every((angle) => Math.abs(angle - 90) < 1e-6)
      && cell.stillWyckoff,
    JSON.stringify(cell));

  // --- Reset Lattice must not change the mode -------------------------------
  const afterResetLattice = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Reset Lattice').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const now = document.querySelector(sel);
    return {
      stillWyckoff: s.symmetry?.mode === 'wyckoff',
      orbitRows: now.querySelectorAll('.orbit-element').length,
      hasAtomTable: !!now.querySelector('#atomsTable'),
      a: Number(/** @type {HTMLInputElement} */ (now.querySelector('#latA')).value),
    };
  }, MODIFY);
  H.check('Reset Lattice restores the cell and stays in Wyckoff mode',
    afterResetLattice.stillWyckoff && afterResetLattice.orbitRows > 1
      && !afterResetLattice.hasAtomTable && Math.abs(afterResetLattice.a - 3.82) < 1e-3,
    JSON.stringify(afterResetLattice));

  // --- Revert restores the structure and KEEPS the lock --------------------
  // It used to unlock and drop the user into the free-form atom table, which
  // reads as the panel changing mode on its own. Reverting restores exactly the
  // structure the lock was built from, so the lock is rebuilt at the same
  // tolerance instead.
  const reverted = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const originalCount = s.original.atoms.length;
    window.confirm = () => true; // the revert asks first
    /** @type {HTMLElement} */ (document.querySelector(`${sel} #commitStructureEdits`)).click();
    return { originalCount };
  }, MODIFY);
  // Re-locking re-runs moyo, so the re-mount is asynchronous.
  await page.waitForFunction(
    (sel) => document.querySelectorAll(`${sel} .orbit-element`).length > 1, MODIFY, { timeout: 20000 });

  const relocked = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    return {
      atoms: s.atoms.length,
      stillWyckoff: s.symmetry?.mode === 'wyckoff',
      orbitRows: panel.querySelectorAll('.orbit-element').length,
      orbits: s.symmetry?.orbitGroups?.length ?? 0,
      hasAtomTable: !!panel.querySelector('#atomsTable'),
      // The Newly-added / Removed diff belonged to the old lock and must be gone.
      separator: !!panel.querySelector('.orbit-new-separator'),
      removedHeading: [...panel.querySelectorAll('div')]
        .map((node) => node.textContent).some((text) => text?.startsWith('Removed orbits')),
    };
  }, MODIFY);
  H.check('Revert restores the as-loaded atoms', relocked.atoms === reverted.originalCount,
    JSON.stringify({ ...relocked, expected: reverted.originalCount }));
  H.check('Revert stays in Wyckoff mode, with the diff reset',
    relocked.stillWyckoff && !relocked.hasAtomTable
      && relocked.orbitRows === relocked.orbits && relocked.orbitRows > 1
      && !relocked.separator && !relocked.removedHeading,
    JSON.stringify(relocked));

  // --- Cubic: the coupled case YBCO cannot exercise ------------------------
  // Orthorhombic leaves a, b, c independent, so it passes even when coupling is
  // broken. CsCl (Pm-3m) is the case that caught a cubic cell being given three
  // different lengths.
  await page.evaluate(async () => {
    const { createNewStructureFromAtoms } = await import('./ui/addToStructureModule/CommitAtoms.js');
    createNewStructureFromAtoms([
      { element: 'Cs', x: 0, y: 0, z: 0 },
      { element: 'Cl', x: 0.5, y: 0.5, z: 0.5 },
    ], { lattice: [[4, 0, 0], [0, 4, 0], [0, 0, 4]], fileName: 'cscl.test' });
  });
  await page.waitForTimeout(1200);
  await enableWyckoff(page);
  await openModify(page);
  await page.waitForTimeout(600);

  const cubic = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const { latticeParameters } = await import('./math/index.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    const read = (id) => /** @type {HTMLInputElement} */ (panel.querySelector(`#${id}`));

    const disabled = {
      b: read('latB').disabled, c: read('latC').disabled,
      alpha: read('latAlpha').disabled, beta: read('latBeta').disabled, gamma: read('latGamma').disabled,
      a: read('latA').disabled,
    };

    const aInput = read('latA');
    aInput.value = '5';
    aInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const landed = latticeParameters(s.lattice);
    return {
      group: s.symmetry?.number,
      disabled,
      shown: { a: read('latA').value, b: read('latB').value, c: read('latC').value },
      landed: { a: landed.a, b: landed.b, c: landed.c },
    };
  }, MODIFY);
  H.check('cubic locks b and c to a, and every angle', cubic.group === 221
    && cubic.disabled.b && cubic.disabled.c && !cubic.disabled.a
    && cubic.disabled.alpha && cubic.disabled.beta && cubic.disabled.gamma,
    JSON.stringify(cubic));
  H.check('typing a drives b and c with it, in the boxes and in the structure',
    Math.abs(cubic.landed.a - 5) < 1e-6 && Math.abs(cubic.landed.b - 5) < 1e-6
      && Math.abs(cubic.landed.c - 5) < 1e-6
      && Number(cubic.shown.b) === 5 && Number(cubic.shown.c) === 5,
    JSON.stringify(cubic));

  // The Wyckoff site chooser needs the 8.9 MB table, fetched on mount.
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} #wyckoffNewSite`)?.options.length > 1
      || document.querySelector(`${sel} #wyckoffNewForm`)?.textContent === 'free',
    MODIFY, { timeout: 30000 });

  const sites = await page.evaluate(async (sel) => {
    const panel = document.querySelector(sel);
    const select = /** @type {HTMLSelectElement} */ (panel.querySelector('#wyckoffNewSite'));
    const labels = [...select.options].map((option) => option.textContent);
    // Pick site b (1b, at 1/2 1/2 1/2 in Pm-3m): all three coordinates are
    // determined by the site, so the boxes must go read-only and show them.
    select.value = 'b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      enabled: !select.disabled,
      labels,
      form: panel.querySelector('#wyckoffNewForm').textContent,
      coordsFrozen: ['X', 'Y', 'Z'].map((axis) => panel.querySelector(`#wyckoffNew${axis}`).disabled),
      coords: ['X', 'Y', 'Z'].map((axis) => panel.querySelector(`#wyckoffNew${axis}`).value),
    };
  }, MODIFY);
  H.check('the Add Site row offers this group\'s Wyckoff sites',
    sites.enabled && sites.labels.includes('1a (m-3m)') && sites.labels.includes('3c (4/mm.m)'),
    JSON.stringify(sites.labels));
  H.check('choosing a fixed site freezes the coordinates and fills in its position',
    sites.coordsFrozen.every(Boolean) && sites.coords.every((value) => Number(value) === 0.5),
    JSON.stringify(sites));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
