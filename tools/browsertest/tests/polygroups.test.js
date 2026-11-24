// The Structure window's Poly tab groups the polyhedra categories by centre
// element: one row per element (and one for the cages) whose eye, colour and
// alpha act on all of its categories, with the categories nested beneath it.
// The element row is a style layer of its own (polyhedraElementStyles:
// individual > category > element > default), so it also covers categories
// that first appear on a later trajectory frame.
// Structure: SrTiO3 doubled along a with the second Ti moved 0.5 Å along b,
// off one of its O (TiO5) — one centre element in two categories.
'use strict';
const H = require('../harness');

const POSCAR = [
  'SrTiO3 2x1x1, one Ti off-centre', '1.0',
  '7.81 0 0', '0 3.905 0', '0 0 3.905',
  'Sr Ti O', '2 2 6', 'Direct',
  '0 0 0', '0.5 0 0',
  '0.25 0.5 0.5', '0.75 0.628 0.5',
  '0 0.5 0.5', '0.5 0.5 0.5', // along a
  '0.25 0 0.5', '0.75 0 0.5', // along b
  '0.25 0.5 0', '0.75 0.5 0', // along c
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'sto_vacancy.vasp');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    // Ti–O bonds up to 2.2 Å: the moved Ti's far O (2.45 Å) is not bonded.
    const { general } = await import('./state/store.js');
    general.bondLengths['O-Ti'] = { ...(general.bondLengths['O-Ti'] ?? { min: 0 }), max: 2.2 };
  }, POSCAR);
  await page.waitForTimeout(400);
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { polyhedraDrawnCount } = await import('./render/index.js');
    return polyhedraDrawnCount() > 0;
  });
  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    /** @type {HTMLElement} */ (document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"]')).click();
  });
  await page.waitForTimeout(300);

  const shape = await page.evaluate(async () => {
    const { polyhedraInfo } = await import('./render/index.js');
    const groups = [...document.querySelectorAll('#infoPolyControls .phl-group')].map((g) => ({
      key: /** @type {HTMLElement} */ (g).dataset.groupKey,
      title: g.querySelector('.phl-group-label')?.textContent,
      count: g.querySelector('.phl-group-count')?.textContent,
      cats: [...g.querySelectorAll('.poly-control[data-cat-key]')].map((c) => /** @type {HTMLElement} */ (c).dataset.catKey),
      open: /** @type {HTMLElement} */ (g.querySelector('.phl-group-body')).style.display !== 'none',
    }));
    const tiPolys = polyhedraInfo().filter((m) => m.catKey.startsWith('c:Ti:')).length;
    return { groups, tiPolys };
  });
  const ti = shape.groups.find((g) => g.key === 'Ti');
  H.check('a Ti group row holds both Ti categories, with the right counts, collapsed',
    !!ti && ti.title === 'Ti' && ti.cats.length === 2
      && ti.count === `${shape.tiPolys} polyhedra, 2 types` && !ti.open,
    JSON.stringify(shape));

  const hidden = await page.evaluate(async () => {
    const { polyhedraDrawnCount, polyhedraInfo } = await import('./render/index.js');
    const g = document.querySelector('#infoPolyControls .phl-group[data-group-key="Ti"]');
    const eye = /** @type {HTMLInputElement} */ (g.querySelector('.phl-group-eye'));
    const all = polyhedraDrawnCount({ shownOnly: true });
    eye.click();
    const cats = [...g.querySelectorAll('.poly-control > .bond-checkbox > .toggle_switch input')]
      .map((c) => /** @type {HTMLInputElement} */ (c).checked);
    const tiShown = polyhedraInfo().filter((m) => m.catKey.startsWith('c:Ti:') && m.visible).length;
    const tiTotal = polyhedraInfo().filter((m) => m.catKey.startsWith('c:Ti:')).length;
    return { all, after: polyhedraDrawnCount({ shownOnly: true }), tiTotal, tiShown, cats, eye: eye.checked, ind: eye.indeterminate };
  });
  H.check('unchecking the Ti eye hides every Ti polyhedron and unchecks both Ti categories',
    hidden.tiTotal > 0 && hidden.tiShown === 0 && hidden.after === hidden.all - hidden.tiTotal
      && hidden.cats.length === 2 && hidden.cats.every((c) => !c) && !hidden.eye && !hidden.ind,
    JSON.stringify(hidden));

  const mixed = await page.evaluate(() => {
    const g = document.querySelector('#infoPolyControls .phl-group[data-group-key="Ti"]');
    const cat = /** @type {HTMLInputElement} */ (g.querySelector('.poly-control > .bond-checkbox > .toggle_switch input'));
    cat.click();
    const eye = /** @type {HTMLInputElement} */ (g.querySelector('.phl-group-eye'));
    const res = { indeterminate: eye.indeterminate };
    eye.click(); // indeterminate -> all shown
    res.afterClick = [...g.querySelectorAll('.poly-control > .bond-checkbox > .toggle_switch input')]
      .map((c) => /** @type {HTMLInputElement} */ (c).checked);
    res.eye = eye.checked;
    res.indeterminateAfter = eye.indeterminate;
    return res;
  });
  H.check('re-checking one Ti category makes the Ti eye indeterminate; clicking it shows all',
    mixed.indeterminate && mixed.afterClick.every(Boolean) && mixed.eye && !mixed.indeterminateAfter,
    JSON.stringify(mixed));

  const recolour = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { polyhedraInfo } = await import('./render/index.js');
    const g = document.querySelector('#infoPolyControls .phl-group[data-group-key="Ti"]');
    /** @type {HTMLElement} */ (g.querySelector('.phl-group-dot')).click();
    const editor = /** @type {HTMLElement} */ (g.querySelector('.phl-group-editor'));
    const open = editor.style.display !== 'none';
    // The face colour picker's HEX field (RGB first, then HEX).
    const hex = /** @type {HTMLInputElement} */ (editor.querySelectorAll('.cv-colorpicker-input-field')[1]);
    hex.value = '#FF00FF';
    hex.dispatchEvent(new Event('change'));
    const s = fileBrowser.selectedStructure;
    const tiKeys = Object.keys(s.polyhedraCategoryStyles).filter((k) => k.startsWith('c:Ti:'));
    return {
      open,
      element: s.polyhedraElementStyles.Ti?.color ?? null,
      catColors: tiKeys.map((k) => s.polyhedraCategoryStyles[k].color ?? null),
      drawn: [...new Set(polyhedraInfo().filter((m) => m.catKey.startsWith('c:Ti:')).map((m) => m.color.toLowerCase()))],
      others: polyhedraInfo().filter((m) => !m.catKey.startsWith('c:Ti:')).map((m) => m.color.toLowerCase()),
    };
  });
  H.check('the Ti swatch editor recolours both Ti categories through the element entry (others untouched)',
    recolour.open && /^#ff00ff$/i.test(recolour.element ?? '')
      && recolour.catColors.every((c) => c === null)
      && recolour.drawn.length === 1 && recolour.drawn[0] === '#ff00ff'
      && recolour.others.every((c) => c !== '#ff00ff'),
    JSON.stringify(recolour));

  const pick = await page.evaluate(async () => {
    const { highlightHover } = await import('./state/store.js');
    const { polyhedraInfo } = await import('./render/index.js');
    const { selectPolyhedronFromIndex } = await import('./ui/SelectAndHighlightModule.js');
    const g = /** @type {any} */ (document.querySelector('#infoPolyControls .phl-group[data-group-key="Ti"]'));
    g._setExpanded(false);
    const target = polyhedraInfo().find((m) => m.catKey.startsWith('c:Ti:'));
    selectPolyhedronFromIndex(target.index, { scrollToSelection: false });
    await new Promise((r) => setTimeout(r, 100));
    const sel = highlightHover.currentlyHighlightedPolyhedron;
    const row = /** @type {HTMLElement|null} */ (document.querySelector(
      `#infoPolyControls .poly-control[data-cat-key="${target.catKey}"] .individual-polyhedron-row`
      + (sel?.groupKey ? `[data-poly-group-key="${sel.groupKey}"]` : `[data-poly-key="${target.key}"]`)));
    return {
      selected: sel?.key === target.key || (!!sel?.groupKey && sel.groupKey === target.key.split(':').slice(0, 2).join(':')),
      groupOpen: g.querySelector('.phl-group-body').style.display !== 'none',
      rowVisible: !!row?.offsetParent,
      rowHighlighted: !!row && getComputedStyle(row).borderLeftColor === 'rgb(255, 179, 71)',
    };
  });
  H.check('a 3D pick opens the collapsed Ti group and highlights the category row inside it',
    pick.selected && pick.groupOpen && pick.rowVisible && pick.rowHighlighted, JSON.stringify(pick));

  const kept = await page.evaluate(async () => {
    const { capturePolyGroupExpansion } = await import('./ui/PolyhedraListPanel.js');
    const before = capturePolyGroupExpansion(document.getElementById('infoPolyControls'));
    document.dispatchEvent(new CustomEvent('crysviz:polyhedra-rebuilt'));
    return { before, after: capturePolyGroupExpansion(document.getElementById('infoPolyControls')) };
  });
  H.check('a rebuild keeps which element groups are open',
    kept.before.Ti === true && JSON.stringify(kept.before) === JSON.stringify(kept.after),
    JSON.stringify(kept));

  // --- Trajectory: a category that first appears on a later frame ----------------
  // The element row is a style layer (structure.polyhedraElementStyles, whole
  // trajectory) under the category styles, so it also covers TiO5, found
  // only at the full rebuild of frame 1 where the second Ti moves 0.6 Å.
  const xyz = [0, 0.6, 0.6].flatMap((dy) => [
    '10', 'Lattice="7.81 0 0 0 3.905 0 0 0 3.905" Properties=species:S:1:pos:R:3',
    'Sr 0 0 0', 'Sr 3.905 0 0',
    'Ti 1.9525 1.9525 1.9525', `Ti 5.8575 ${(1.9525 + dy).toFixed(4)} 1.9525`,
    'O 0 1.9525 1.9525', 'O 3.905 1.9525 1.9525',
    'O 1.9525 0 1.9525', 'O 5.8575 0 1.9525',
    'O 1.9525 1.9525 0', 'O 5.8575 1.9525 0',
  ]).join('\n');
  const traj = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const P = await import('./render/PolyhedraModule.js');
    const trace = await import('./debug/debugTrace.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'sto_traj.xyz');
    while (structureShip.container.length === before) await settle(100);
    const { general } = await import('./state/store.js');
    general.bondLengths['O-Ti'] = { ...(general.bondLengths['O-Ti'] ?? { min: 0 }), max: 2.2 };
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    const full = async (f) => {
      showTrajectoryFrame(f, c, { full: true });
      await settle(300);
      await P.updatePolyhedra();
      await settle(300);
    };
    const fast = (f) => {
      const c0 = trace.counters();
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      return (trace.counters().playbackFast || 0) > (c0.playbackFast || 0) ? 'fast' : 'other';
    };
    const ti = () => P.polyhedraInfo().filter((m) => m.catKey.startsWith('c:Ti:'));
    const group = () => document.querySelector('#infoPolyControls .phl-group[data-group-key="Ti"]');
    const eye = () => /** @type {HTMLInputElement} */ (group()?.querySelector('.phl-group-eye'));
    const catSwitch = (k) => /** @type {HTMLInputElement} */ (document.querySelector(
      `#infoPolyControls .poly-control[data-cat-key="${k}"] > .bond-checkbox > .toggle_switch input`));
    const out = {};
    await full(0);
    out.f0 = { cats: [...new Set(ti().map((m) => m.catKey))], n: ti().length };
    eye().click(); // Ti off on frame 0, where only TiO6 exists
    out.f0off = { shown: ti().filter((m) => m.visible).length, el: fileBrowser.selectedStructure.polyhedraElementStyles.Ti ?? null };
    out.path1 = fast(1);
    await settle(200);
    out.f1fast = { shown: ti().filter((m) => m.visible).length, n: ti().length };
    await full(1);
    const cats1 = [...new Set(ti().map((m) => m.catKey))];
    out.f1full = {
      cats: cats1, shown: ti().filter((m) => m.visible).length, n: ti().length,
      switches: cats1.map((k) => catSwitch(k)?.checked ?? null),
      eye: [eye().checked, eye().indeterminate],
    };
    catSwitch('c:Ti:O5').click(); // show just this one
    out.one = {
      shownCats: [...new Set(ti().filter((m) => m.visible).map((m) => m.catKey))],
      eye: [eye().checked, eye().indeterminate],
      catStyle: fileBrowser.selectedStructure.polyhedraCategoryStyles['c:Ti:O5'] ?? null,
    };
    /** @type {HTMLElement} */ (group().querySelector('.phl-group-dot')).click();
    /** @type {HTMLElement} */ (group().querySelector('.phl-group-reset')).click();
    await settle(100);
    const s = fileBrowser.selectedStructure;
    out.reset = {
      shown: ti().filter((m) => m.visible).length, n: ti().length,
      el: s.polyhedraElementStyles.Ti ?? null,
      cats: Object.keys(s.polyhedraCategoryStyles).filter((k) => k.startsWith('c:Ti:')),
      eye: [eye().checked, eye().indeterminate],
    };
    eye().click(); // off again, for the session round trip
    return out;
  }, xyz);
  H.check('trajectory frame 0: one Ti category; the Ti switch writes the element entry and hides it',
    traj.f0.cats.length === 1 && traj.f0off.shown === 0 && traj.f0off.el?.visible === false, JSON.stringify([traj.f0, traj.f0off]));
  H.check('fast path to frame 1 keeps every Ti polyhedron hidden',
    traj.path1 === 'fast' && traj.f1fast.n > 0 && traj.f1fast.shown === 0, JSON.stringify([traj.path1, traj.f1fast]));
  H.check('full rebuild of frame 1: the new TiO5 category is hidden too, its switch off',
    traj.f1full.cats.includes('c:Ti:O5') && traj.f1full.shown === 0
      && traj.f1full.switches.every((v) => v === false) && traj.f1full.eye[0] === false && !traj.f1full.eye[1],
    JSON.stringify(traj.f1full));
  H.check('switching TiO5 on shows it alone (its own override); the Ti switch reads half-way',
    JSON.stringify(traj.one.shownCats) === '["c:Ti:O5"]' && traj.one.catStyle?.visible === true && traj.one.eye[1] === true,
    JSON.stringify(traj.one));
  H.check('the Ti Reset clears the element entry and its categories: all Ti shown',
    traj.reset.shown === traj.reset.n && traj.reset.n > 0 && traj.reset.el === null && traj.reset.cats.length === 0
      && traj.reset.eye[0] === true && !traj.reset.eye[1],
    JSON.stringify(traj.reset));

  const sess = await page.evaluate(async () => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const { captureState, applySharedState, waitForStateRestoration } = await import('./ui/ShareModule.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const P = await import('./render/PolyhedraModule.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const state = JSON.parse(JSON.stringify(captureState({ includeFrames: true })));
    const before = structureShip.container.length;
    applySharedState(state, 'shared.crysviz');
    await waitForStateRestoration();
    await settle(300);
    const c = structureShip.container[structureShip.container.length - 1];
    showTrajectoryFrame(2, c, { full: true });
    await settle(300);
    await P.updatePolyhedra();
    await settle(300);
    const ti = P.polyhedraInfo().filter((m) => m.catKey.startsWith('c:Ti:'));
    return {
      fresh: structureShip.container.length > before,
      saved: state.colors.polyhedraElementStyles ?? null,
      restored: fileBrowser.selectedStructure.polyhedraElementStyles ?? null,
      ti: ti.length, shown: ti.filter((m) => m.visible).length,
    };
  });
  H.check('a .crysviz session round-trips the element styles (Ti off on frame 2 of the copy)',
    sess.fresh && sess.saved?.Ti?.visible === false && sess.restored?.Ti?.visible === false
      && sess.ti > 0 && sess.shown === 0,
    JSON.stringify(sess));

  if (process.env.POLYGROUPS_SHOT) {
    await page.evaluate(() => {
      document.querySelectorAll('#infoPolyControls .phl-group-editor').forEach((e) => { /** @type {HTMLElement} */ (e).style.display = 'none'; });
    });
    const el = await page.$('#infoPolyControls');
    await el.screenshot({ path: process.env.POLYGROUPS_SHOT });
  }

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
