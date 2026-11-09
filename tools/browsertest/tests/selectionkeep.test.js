// Building a selection in the 3D view stays in the 3D view, and the selection
// survives the Structure window's "Link periodic copies" switch.
//
// - Ctrl/Shift double-clicks (real mouse events) grow the selection without
//   opening the Structure window's formula box: it used to pop open on the
//   second atom (the selection bar's 1 -> 2 reveal). When the box is already
//   showing, the per-atom lists still fold so the selection bar is in view.
// - Switching "Link periodic copies" off keeps every selected atom as the copy
//   it was picked on (only that copy glows); switching it on again merges
//   copies of one atom into one entry (all copies glow). A selected bond stays
//   selected too, as its group of copies or its one copy.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO — corner/face atoms have copies
  await page.waitForTimeout(800);

  // Screen points of front-facing atoms, one per source atom, plus a second
  // copy of the first one (for the unlinked check).
  const pts = await page.evaluate(async () => {
    const { groups, app, fileBrowser } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const src = fileBrowser.selectedStructure.periodic.visibleWrapped.srcIndex;
    const mesh = groups.atomsMesh;
    const m = new THREE.Matrix4(); const v = new THREE.Vector3();
    const rect = app.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    const hits = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); v.setFromMatrixPosition(m).applyMatrix4(mesh.matrixWorld);
      const p = v.clone().project(app.camera);
      const x = rect.left + (p.x + 1) / 2 * rect.width;
      const y = rect.top + (1 - p.y) / 2 * rect.height;
      ray.setFromCamera(new THREE.Vector2(p.x, p.y), app.camera);
      if (ray.intersectObject(mesh)[0]?.instanceId !== i) continue; // hidden behind another atom
      if (x < rect.left + 380 || x > rect.right - 40 || y < rect.top + 40 || y > rect.bottom - 40) continue;
      if (hits.some((q) => Math.hypot(q.x - x, q.y - y) < 40)) continue;
      hits.push({ i, src: src[i], x, y });
    }
    const one = [];
    for (const h of hits) if (one.length < 3 && !one.some((o) => o.src === h.src)) one.push(h);
    const copy = hits.find((h) => h.src === one[0]?.src && h.i !== one[0].i)
      ?? hits.find((h) => one.some((o) => o.src === h.src && o.i !== h.i)) ?? null;
    return { one, copy };
  });
  H.check('found three atoms to pick and a second copy of one of them',
    pts.one.length === 3 && !!pts.copy, JSON.stringify(pts));

  const state = () => page.evaluate(async () => {
    const { atomSelection, groups, fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const glow = groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity;
    const glowing = [];
    for (let i = 0; i < groups.atomsMesh.count; i++) if (glow.getX(i) > 0) glowing.push(i);
    const bar = document.getElementById('selectionActionBar');
    return {
      sel: atomSelection.selectedAtoms.map((a) => [a.sourceIndex, a.instanceId]),
      glowing,
      images: Object.fromEntries(atomSelection.selectedAtoms.map((a) => [a.sourceIndex, s.atomImages[a.sourceIndex]])),
      boxOpen: document.getElementById('composition').classList.contains('open'),
      openAtomLists: [...document.querySelectorAll('#atomPanel .individual-atoms')]
        .filter((e) => /** @type {HTMLElement} */ (e).style.display === 'block').length,
      barShown: !!bar && bar.offsetHeight > 0,
    };
  });
  const pick = async (p, key) => {
    await page.keyboard.down(key);
    await page.mouse.dblclick(p.x, p.y);
    await page.keyboard.up(key);
    await page.waitForTimeout(250);
  };

  // --- Ctrl/Shift picks with the formula box closed: it stays closed ----------
  let s = await state();
  H.check('the formula box starts closed', !s.boxOpen && s.sel.length === 0, JSON.stringify(s));
  await pick(pts.one[0], 'Control');
  await pick(pts.one[1], 'Control');
  s = await state();
  H.check('Ctrl-picking a second atom does not open the Structure window',
    s.sel.length === 2 && !s.boxOpen, JSON.stringify({ sel: s.sel, boxOpen: s.boxOpen }));
  await pick(pts.one[2], 'Shift');
  s = await state();
  H.check('nor does Shift-picking a third',
    s.sel.length === 3 && !s.boxOpen, JSON.stringify({ sel: s.sel, boxOpen: s.boxOpen }));

  // --- With the box already open: the lists fold to the selection bar --------
  await page.evaluate(async () => {
    const { clearSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    clearSelectedAtoms();
    (await import('./ui/StructureInfoPanel/General.js')).setStructurePanelOpen(true);
    // An expanded per-atom list, as when inspecting one atom.
    /** @type {HTMLElement} */ (document.querySelector('#atomPanel .comp-expand-icon'))?.click();
  });
  await page.waitForTimeout(200);
  const listsBefore = (await state()).openAtomLists;
  await pick(pts.one[0], 'Control');
  await pick(pts.one[1], 'Control');
  await pick(pts.one[2], 'Control');
  s = await state();
  H.check('with the box open, a Ctrl multi-pick keeps it open and folds the lists to the selection bar',
    s.boxOpen && s.sel.length === 3 && listsBefore >= 1 && s.openAtomLists === 0 && s.barShown,
    JSON.stringify({ listsBefore, lists: s.openAtomLists, boxOpen: s.boxOpen, bar: s.barShown }));

  // --- "Link periodic copies" off: the selection is kept ----------------------
  const linked = s;
  H.check('linked: every copy of each selected atom glows',
    linked.sel.every(([src]) => linked.images[src].every((i) => linked.glowing.includes(i))),
    JSON.stringify({ sel: linked.sel, glowing: linked.glowing }));
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(400);
  s = await state();
  H.check('switching "Link periodic copies" off keeps the selection, each atom as the copy picked',
    JSON.stringify(s.sel) === JSON.stringify(linked.sel), JSON.stringify({ before: linked.sel, after: s.sel }));
  H.check('unlinked: only the picked copies glow',
    JSON.stringify([...s.glowing].sort((a, b) => a - b))
      === JSON.stringify(s.sel.map(([, i]) => i).sort((a, b) => a - b)),
    JSON.stringify({ sel: s.sel, glowing: s.glowing }));
  const rowsMarked = await page.evaluate(() => [...document.querySelectorAll('#atomPanel .individual-atom-row')]
    .filter((r) => /** @type {HTMLElement} */ (r).style.borderLeft !== '')
    .map((r) => Number(/** @type {HTMLElement} */ (r).dataset.imageIndex)));
  H.check('the rebuilt per-copy rows mark the selected copies',
    JSON.stringify(rowsMarked.sort((a, b) => a - b)) === JSON.stringify(s.sel.map(([, i]) => i).sort((a, b) => a - b)),
    JSON.stringify({ rowsMarked, sel: s.sel }));

  // Unlinked, another copy of a selected atom is a separate pick. (The open
  // formula box floats over that atom: close it for the pick, then reopen it
  // for its switch.)
  const setBox = (open) => page.evaluate(async (open) =>
    (await import('./ui/StructureInfoPanel/General.js')).setStructurePanelOpen(open), open);
  await setBox(false);
  await pick(pts.copy, 'Control');
  await setBox(true);
  s = await state();
  const unlinked = s;
  H.check('unlinked: Ctrl-picking another copy of a selected atom adds it',
    s.sel.length === 4 && s.sel.some(([, i]) => i === pts.copy.i), JSON.stringify(s.sel));

  // --- Back on: copies of one atom merge -------------------------------------
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(400);
  s = await state();
  const srcs = s.sel.map(([src]) => src);
  H.check('switching it on again keeps the selection, merging the two copies of one atom',
    s.sel.length === 3 && new Set(srcs).size === 3
      && JSON.stringify([...new Set(unlinked.sel.map(([src]) => src))].sort()) === JSON.stringify([...srcs].sort()),
    JSON.stringify({ unlinked: unlinked.sel, relinked: s.sel }));
  H.check('linked again: every copy glows',
    s.sel.every(([src]) => s.images[src].every((i) => s.glowing.includes(i))),
    JSON.stringify({ sel: s.sel, glowing: s.glowing }));

  // --- A selected bond survives the switch too ---------------------------------
  const bond = await page.evaluate(async () => {
    const { fileBrowser, highlightHover } = await import('./state/store.js');
    const { bondGroupKey } = await import('./render/index.js');
    const { selectBondFromRow } = await import('./ui/SelectAndHighlightModule.js');
    const st = fileBrowser.selectedStructure;
    const counts = new Map();
    st.bonds.forEach((b) => counts.set(bondGroupKey(st, b), (counts.get(bondGroupKey(st, b)) ?? 0) + 1));
    const index = st.bonds.findIndex((b) => b.instanceIds?.length && counts.get(bondGroupKey(st, b)) >= 2);
    selectBondFromRow(index, null);
    const cur = highlightHover.currentlyHighlightedBond;
    return { index, members: cur?.bondIndexes?.length ?? 0 };
  });
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(400);
  const bondAfter = await page.evaluate(async () => {
    const { highlightHover, atomSelection } = await import('./state/store.js');
    const cur = highlightHover.currentlyHighlightedBond;
    return { index: cur?.bondIndex ?? null, groupKey: cur?.groupKey ?? null, atoms: atomSelection.selectedAtoms.length };
  });
  H.check('a selected bond stays selected when unlinking, as its one copy',
    bond.members >= 2 && bondAfter.index === bond.index && bondAfter.groupKey === null && bondAfter.atoms === 0,
    JSON.stringify({ bond, bondAfter }));

  // --- And a selected polyhedron (unlinked -> linked, Poly tab shown) ---------
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    return (groups.polyhedraGroup?.children?.length ?? 0) > 0;
  });
  const poly = await page.evaluate(async () => {
    const { groups, highlightHover } = await import('./state/store.js');
    const { polyhedronGroupKey } = await import('./render/index.js');
    const { selectPolyhedronFromMesh } = await import('./ui/SelectAndHighlightModule.js');
    /** @type {HTMLElement} */ (document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"]')).click();
    const meshes = groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const counts = new Map();
    meshes.forEach((m) => counts.set(polyhedronGroupKey(m.userData.key), (counts.get(polyhedronGroupKey(m.userData.key)) ?? 0) + 1));
    // YBCO's two polyhedra have no copies in the cell; the group is the one.
    const mesh = meshes[0];
    selectPolyhedronFromMesh(mesh, { scrollToSelection: false });
    return { key: mesh.userData.key, copies: counts.get(polyhedronGroupKey(mesh.userData.key)), sel: highlightHover.currentlyHighlightedPolyhedron?.key ?? null };
  });
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(400);
  const polyAfter = await page.evaluate(async () => {
    const { groups, highlightHover, general } = await import('./state/store.js');
    const cur = highlightHover.currentlyHighlightedPolyhedron;
    const glowing = groups.polyhedraGroup.children
      .filter((m) => m.userData?.type === 'polyhedron' && m.material?.emissiveIntensity === 1 && m.material.emissive.getHex() === 0xff8c00);
    const row = [...document.querySelectorAll('#infoPolyControls .individual-polyhedron-row')]
      .find((r) => /** @type {HTMLElement} */ (r).style.borderLeft !== '');
    return { linked: general.linkPeriodicCopies, key: cur?.key ?? null, groupKey: cur?.groupKey ?? null,
      glowing: glowing.length, rowGroup: /** @type {HTMLElement} */ (row)?.dataset.polyGroupKey ?? null };
  });
  H.check('a selected polyhedron stays selected when linking, as its group (its row marked)',
    poly.sel === poly.key && polyAfter.linked && polyAfter.key === poly.key && !!polyAfter.groupKey
      && polyAfter.glowing === poly.copies && polyAfter.rowGroup === polyAfter.groupKey,
    JSON.stringify({ poly, polyAfter }));

  // --- Rebuilding the atoms (Neighbour Bonds, periodic images) keeps it -------
  // These rebuild the main atoms mesh: the glow used to go with the old mesh
  // (the selection looked dropped), and the copies can be numbered anew. Each
  // selected copy is found again by its source atom and periodic offset.
  await H.clickById(page, 'linkPeriodicCopiesToggle'); // unlinked: exact copies
  await page.waitForTimeout(400);
  const picked = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomsByInstances, clearPolyhedronSelection } = await import('./ui/SelectAndHighlightModule.js');
    clearPolyhedronSelection();
    const st = fileBrowser.selectedStructure;
    const keys = st.atomImageKeys;
    const src = st.periodic.visibleWrapped.srcIndex;
    const away = keys.findIndex((k) => !k.endsWith(':0,0,0')); // a copy off the home cell
    const home = keys.findIndex((k, i) => k.endsWith(':0,0,0') && src[i] !== src[away]);
    selectAtomsByInstances([home, away]);
    return { keys: [keys[home], keys[away]] };
  });
  const rebuilt = () => page.evaluate(async () => {
    const { fileBrowser, atomSelection, groups, general } = await import('./state/store.js');
    const st = fileBrowser.selectedStructure;
    const glow = groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity;
    const glowing = [];
    for (let i = 0; i < groups.atomsMesh.count; i++) if (glow.getX(i) > 0) glowing.push(i);
    return {
      linked: general.linkPeriodicCopies,
      count: groups.atomsMesh.count,
      keys: atomSelection.selectedAtoms.map((a) => st.atomImageKeys[a.instanceId]),
      ids: atomSelection.selectedAtoms.map((a) => a.instanceId),
      onMesh: atomSelection.selectedAtoms.every((a) => a.object === groups.atomsMesh),
      glowing,
    };
  });
  const r0 = await rebuilt();
  await H.clickById(page, 'PBCBondToggle');
  await H.waitFor(page, async () => (await import('./state/store.js')).groups.atomsMesh?.count !== undefined);
  await page.waitForTimeout(600);
  const r1 = await rebuilt();
  H.check('Neighbour Bonds on: the same copies stay selected, and glow, in the rebuilt atoms',
    !r0.linked && r1.count > r0.count && JSON.stringify(r1.keys) === JSON.stringify(picked.keys)
      && r1.onMesh && JSON.stringify([...r1.glowing].sort((a, b) => a - b)) === JSON.stringify([...r1.ids].sort((a, b) => a - b)),
    JSON.stringify({ picked, r0: { count: r0.count, keys: r0.keys }, r1 }));
  await H.clickById(page, 'showPeriodic'); // periodic images off: the copy is gone
  await page.waitForTimeout(800);
  const r2 = await rebuilt();
  const srcOf = (k) => k && k.split(':')[0];
  H.check('periodic images off: an atom whose copy is gone stays selected as its own atom',
    r2.count < r1.count && r2.keys.length === 2 && r2.keys[0] === picked.keys[0]
      && srcOf(r2.keys[1]) === srcOf(picked.keys[1]) && r2.glowing.length === 2,
    JSON.stringify({ picked, r2 }));
  await H.clickById(page, 'showPeriodic');
  await H.clickById(page, 'PBCBondToggle');
  await page.waitForTimeout(800);

  // --- The Selection Inspector's note on linked copies ------------------------
  await page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).openSelectionInspector());
  await page.waitForTimeout(800);
  const note = () => page.evaluate(() => {
    const e = /** @type {HTMLElement} */ (document.getElementById('siLinkWarn'));
    return !!e && !e.hidden && e.offsetHeight > 0;
  });
  const unlinkedNote = await note();
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(400);
  const linkedNote = await note();
  await H.clickById(page, 'showPeriodic'); // no copies on screen: nothing to link
  await page.waitForTimeout(800);
  const noCopiesNote = await note();
  await H.clickById(page, 'showPeriodic');
  await page.waitForTimeout(800);
  const copiesAgainNote = await note();
  H.check('the inspector notes linked copies only while they are linked and on screen',
    !unlinkedNote && linkedNote && !noCopiesNote && copiesAgainNote,
    JSON.stringify({ unlinkedNote, linkedNote, noCopiesNote, copiesAgainNote }));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
