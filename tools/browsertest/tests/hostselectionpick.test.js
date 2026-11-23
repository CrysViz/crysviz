// The host (MCP) sees the user's bond / polyhedron picks and saved selections
// (docs/host/query.js userPick, savedUserSelections):
//   - a click on bonds or polyhedra replaces the atom selection, so get_state
//     reports it as selection.pick (bonds as source-atom pairs, polyhedra by
//     centre atom), and the next command's sinceLastCall says so;
//   - the user's saved selections are listed in get_state selection.saved and
//     reported in sinceLastCall when they change;
//   - apply select / clear say they replaced or cleared a pick.
// YBCO (default structure) with polyhedra on.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO
  await H.clickById(page, 'showPolyhedra');
  await page.waitForTimeout(2500);

  const r = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const sel = await import('./ui/SelectAndHighlightModule.js');
    const { saveSelectionGroup, deleteSelectionGroup } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    const host = (command, args) => window.crysvizHost.dispatch({ command, args });
    const state = async () => (await host('get_state', { include: ['selection'] })).result;
    const s = fileBrowser.selectedStructure;
    const out = {};

    out.before = (await state()).selection;

    // The user clicks one bond (with its periodic copies).
    const bondIndex = s.bonds.findIndex((b) => b.instanceIds?.length);
    sel.selectBondsDirect([bondIndex]);
    const expectedPair = [...s.bonds[bondIndex].srcIndices].sort((a, b) => a - b);
    out.expectedPair = expectedPair;
    const afterBond = await state();
    out.bondNotice = afterBond.sinceLastCall ?? null;
    out.bondPick = afterBond.selection;

    // The user saves it under a name.
    saveSelectionGroup('Cu-O bond');
    const afterSave = await state();
    out.saveNotice = afterSave.sinceLastCall ?? null;
    out.saved = afterSave.selection.saved ?? null;

    // The host selects atoms: that replaces the user's bond pick, and says so.
    out.select = (await host('apply', { action: 'select', atoms: [0] })).result;
    out.kindAfterSelect = sel.getDirectSelection().kind;

    // The user clicks a polyhedron.
    const poly = (groups.polyhedraGroup?.children ?? []).find((m) => m.userData?.type === 'polyhedron' && m.userData.centerSrcIndex !== undefined);
    sel.selectPolyhedraDirect([poly.userData.key], { mode: 'replace' });
    out.expectedCentre = poly.userData.centerSrcIndex;
    const afterPoly = await state();
    out.polyNotice = afterPoly.sinceLastCall ?? null;
    out.polyPick = afterPoly.selection;

    // The host clears the selection: the pick goes too, and the result says so.
    out.clear = (await host('apply', { action: 'clear', what: 'selection' })).result;
    out.kindAfterClear = sel.getDirectSelection().kind;
    out.afterClear = (await state()).selection;

    deleteSelectionGroup(0);
    out.deleteNotice = (await host('get_state', { include: [] })).result.sinceLastCall ?? null;
    return out;
  });

  H.check('no pick and no saved selections at first', !r.before.pick && !r.before.saved, r.before);
  H.check('a bond pick is reported as selection.pick with its source-atom pair',
    r.bondPick.pick?.kind === 'bonds' && r.bondPick.pick.count === 1
      && JSON.stringify(r.bondPick.pick.bonds) === JSON.stringify([r.expectedPair]) && r.bondPick.count === 0,
    { pick: r.bondPick, expected: r.expectedPair });
  H.check('sinceLastCall says the user picked a bond',
    r.bondNotice?.selection?.pick?.kind === 'bonds' && /picked 1 bond\b/.test(r.bondNotice?.note || ''), r.bondNotice);
  H.check('a saved selection is listed in get_state and noticed',
    r.saved?.length === 1 && r.saved[0].name === 'Cu-O bond' && r.saved[0].bonds >= 1
      && JSON.stringify(r.saveNotice?.savedSelections) === JSON.stringify(['Cu-O bond']), { saved: r.saved, notice: r.saveNotice });
  H.check('apply select says it replaced the user\'s bond pick, and the pick is gone',
    r.select?.replacedUserPick?.kind === 'bonds' && r.select.replacedUserPick.count === 1 && r.kindAfterSelect === null, r.select);
  H.check('a polyhedron pick is reported by its centre atom',
    r.polyPick.pick?.kind === 'polyhedra' && r.polyPick.pick.centres?.includes(r.expectedCentre)
      && /picked \d+ polyhedr(on|a)/.test(r.polyNotice?.note || ''), { pick: r.polyPick.pick, notice: r.polyNotice });
  H.check('apply clear selection clears the pick and says so',
    r.clear?.clearedUserPick?.kind === 'polyhedra' && r.kindAfterClear === null && !r.afterClear.pick, r.clear);
  H.check('deleting the last saved selection is noticed',
    Array.isArray(r.deleteNotice?.savedSelections) && r.deleteNotice.savedSelections.length === 0, r.deleteNotice);
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
