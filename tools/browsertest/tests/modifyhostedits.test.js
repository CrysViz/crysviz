// The Modify Structure window and edits made elsewhere while it is open (the
// host's add_atoms / remove_atoms / set_element / move_atoms / set_lattice, as
// Claude makes them over MCP: the last two commit through the window's own commit).
// The window commits its WHOLE table on every keystroke, so a table that missed
// such an edit used to write itself back over it: the next keystroke deleted an
// atom the host had added, or resurrected one it had removed.
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const result = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const structure = () => fileBrowser.selectedStructure;
    const rows = () => document.querySelectorAll(`${sel} #atomsTable tbody tr[data-uuid]`);
    const elements = () => structure().atoms.map((a) => a.getRepresentativeElement());
    /** Type a coordinate into the table's row `k`, as the user would. */
    const type = async (k, value) => {
      const input = /** @type {HTMLInputElement} */ (rows()[k].querySelector('.atom-x'));
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await frames();
    };
    const host = (command, args) => window.crysvizHost.dispatch({ command, args });

    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    await frames();
    const n0 = structure().atoms.length;

    // 1. The host adds an atom while the window is open; then the user types.
    const added = await host('add_atoms', { atoms: [{ element: 'He', position: [0.111, 0.222, 0.333] }], force: true });
    await frames();
    const rowsAfterAdd = rows().length;
    await type(0, 0.0123);
    const afterTypeAdd = { atoms: structure().atoms.length, he: elements().includes('He') };

    // 2. The host removes it again; the user types; it must not come back.
    const heIndex = elements().indexOf('He');
    const removed = await host('remove_atoms', { atoms: [heIndex] });
    await frames();
    const rowsAfterRemove = rows().length;
    await type(0, 0.0234);
    const afterTypeRemove = { atoms: structure().atoms.length, he: elements().includes('He') };

    // 3. The host changes an element; the user types; it must stay changed.
    const changed = await host('set_element', { atoms: [1], element: 'Ne' });
    await frames();
    const rowElement = /** @type {HTMLInputElement|null} */ (rows()[1].querySelector('.atom-element'))?.value;
    await type(0, 0.0345);
    const afterTypeElement = elements()[1];
    const typedLanded = Math.abs(structure().atoms[0].position[0] - 0.0345) < 1e-6;

    // 4. The host moves an atom: the table shows it, the revision (atom identity) stays,
    //    and the user's next keystroke does not move it back.
    const x = (k) => Number(/** @type {HTMLInputElement} */ (rows()[k].querySelector('.atom-x')).value);
    const before = await host('get_state', { include: [] });
    const moved = await host('move_atoms', { atoms: [1], to: [[0.4321, 0.25, 0.75]], expectedRevision: before.result.structure.revision });
    await frames();
    const rowAfterMove = x(1);
    await type(0, 0.0456);
    const afterTypeMove = structure().atoms[1].position[0];

    // 5. The host sets the cell: the window's lattice matrix shows it; positions stay fractional.
    const fracBefore = structure().atoms.map((a) => a.position.slice());
    const lattice = structure().lattice.map((row, i) => row.map((v, j) => (i === j ? v * 1.05 : v)));
    const latticed = await host('set_lattice', { lattice });
    await frames();
    const shownA = Number(/** @type {HTMLInputElement} */ (document.querySelector(`${sel} .lat-mat[data-i="0"][data-j="0"]`)).value);
    const fracKept = structure().atoms.every((a, i) => a.position.every((v, k) => Math.abs(v - fracBefore[i][k]) < 1e-12));
    await type(0, 0.0567);

    return {
      moved: moved.ok && moved.result.committed === true && moved.result.revision === before.result.structure.revision,
      rowAfterMove, afterTypeMove,
      latticed: latticed.ok, shownA, wantA: lattice[0][0],
      latticeKept: structure().lattice.every((row, i) => row.every((v, j) => Math.abs(v - lattice[i][j]) < 1e-9)),
      fracKept,
      n0, added: added.ok, removed: removed.ok, changed: changed.ok,
      rowsAfterAdd, afterTypeAdd, rowsAfterRemove, afterTypeRemove,
      rowElementHasNe: String(rowElement).includes('Ne'), afterTypeElement,
      typedLanded,
    };
  }, MODIFY);

  H.check('host edits while the window is open succeed', result.added && result.removed && result.changed, JSON.stringify(result));
  H.check('a host-added atom shows up in the open table', result.rowsAfterAdd === result.n0 + 1, JSON.stringify(result));
  H.check('typing in the table keeps the atom the host added', result.afterTypeAdd.atoms === result.n0 + 1 && result.afterTypeAdd.he, JSON.stringify(result));
  H.check('a host-removed atom leaves the table', result.rowsAfterRemove === result.n0, JSON.stringify(result));
  H.check('typing in the table does not bring back the atom the host removed', result.afterTypeRemove.atoms === result.n0 && !result.afterTypeRemove.he, JSON.stringify(result));
  H.check('typing in the table keeps the element the host set', result.afterTypeElement === 'Ne', JSON.stringify(result));
  H.check('the user\'s own typing still applies', result.typedLanded, JSON.stringify(result));

  H.check('move_atoms commits as the window does: revision kept, committed', result.moved, JSON.stringify(result));
  H.check('a host move shows in the open table', Math.abs(result.rowAfterMove - 0.4321) < 1e-4, JSON.stringify(result));
  H.check('typing in the table keeps the host\'s move', Math.abs(result.afterTypeMove - 0.4321) < 1e-9, JSON.stringify(result));
  H.check('set_lattice shows in the open window and survives typing', result.latticed && Math.abs(result.shownA - result.wantA) < 1e-3 && result.latticeKept, JSON.stringify(result));
  H.check('set_lattice keeps fractional positions', result.fracKept, JSON.stringify(result));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
