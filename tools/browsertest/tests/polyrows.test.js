// The Structure window's Poly tab: polyhedra categories (order + atom types)
// with group styling (color/alpha/visibility) that persists across the async
// polyhedra rebuilds, expandable individual rows with per-polyhedron editors,
// and two-way 3D highlight sync (emissive glow).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO — produces polyhedra

  // Pin per-copy mode (the default now groups periodic copies); grouped
  // behavior is covered by linkedgroups.test.js.
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(300);

  // --- Enable polyhedra via the real checkbox; compute is async -----------------
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    return (groups.polyhedraGroup?.children?.length ?? 0) > 0;
  });

  // --- Open the Structure window on the Poly tab ---------------------------------
  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"]').click();
  });
  await page.waitForTimeout(300);

  const panelShape = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('#infoPolyControls .poly-control')];
    return {
      controls: controls.length,
      withCatKey: controls.filter((c) => c.dataset.catKey).length,
      carets: document.querySelectorAll('#infoPolyControls .poly-expand-icon').length,
      labels: controls.map((c) => c.querySelector('label')?.textContent ?? ''),
      counts: controls.map((c) => c.querySelector('.poly-count')?.textContent ?? ''),
      rowsBeforeExpand: document.querySelectorAll('#infoPolyControls .individual-polyhedron-row').length,
    };
  });
  H.check('polyhedra category rows exist with cat keys, carets and (empty) lazy lists',
    panelShape.controls > 0
      && panelShape.withCatKey === panelShape.controls
      && panelShape.carets === panelShape.controls
      && panelShape.rowsBeforeExpand === 0,
    JSON.stringify(panelShape));
  H.check('category labels are composition only with a separate count (pct%) span',
    panelShape.labels.some((l) => /^[A-Z][a-z]?([A-Z][a-z]?\d*)+$/.test(l))
      && panelShape.counts.every((c) => /^\d+ \(\d+\.\d%\)$/.test(c)),
    JSON.stringify({ labels: panelShape.labels, counts: panelShape.counts }));

  // --- Expand all categories -----------------------------------------------------
  const expanded = await page.evaluate(() => {
    document.querySelectorAll('#infoPolyControls .poly-expand-icon')
      .forEach((icon) => /** @type {HTMLElement} */ (icon).click());
    const rows = [...document.querySelectorAll('#infoPolyControls .individual-polyhedron-row')];
    return {
      rows: rows.length,
      keyed: rows.filter((r) => /** @type {HTMLElement} */ (r).dataset.polyKey).length,
      editButtons: rows.filter((r) => r.querySelector('button[data-editor-button="color"]')?.textContent === 'Edit').length,
      sampleLabel: rows[0]?.querySelector('span')?.textContent ?? '',
      sampleMeta: rows[0]?.querySelectorAll('span')[1]?.textContent ?? '',
    };
  });
  H.check('expanding categories builds individual polyhedron rows with keys and Edit buttons',
    expanded.rows > 0 && expanded.keyed === expanded.rows && expanded.editButtons === expanded.rows,
    JSON.stringify(expanded));
  H.check('rows are labeled "<Cat> #n" with a center-atom meta line',
    /#\d+$/.test(expanded.sampleLabel) && /^(center [A-Z][a-z]?\d+|cage · CN \d+)$/.test(expanded.sampleMeta),
    JSON.stringify({ label: expanded.sampleLabel, meta: expanded.sampleMeta }));

  // --- Category style: applied in place, persists across an async rebuild --------
  const catStyled = await page.evaluate(async () => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updatePolyhedraColors } = await import('./render/index.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    const meshes = groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const catKey = meshes[0].userData.catKey;
    s.polyhedraCategoryStyles[catKey] = { color: '#ff0000', alpha: 0.3 };
    updatePolyhedraColors();
    const inCat = (m) => m.userData.catKey === catKey;
    const snapshot = (list) => ({
      members: list.filter(inCat).map((m) => [m.material.color.getHexString(), m.material.opacity]),
      other: list.find((m) => !inCat(m))
        ? [list.find((m) => !inCat(m)).material.color.getHexString(), list.find((m) => !inCat(m)).material.opacity]
        : null,
    });
    const before = snapshot(meshes);
    const counterBefore = general.polyhedraBuildCounter;
    updateVisualization({ reRenderOther: false, reRenderComposition: false }); // triggers async updatePolyhedra
    // Wait for the rebuild swap in-page (counter bumps after the atomic swap).
    for (let i = 0; i < 100 && general.polyhedraBuildCounter === counterBefore; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const after = snapshot(groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron'));
    return { catKey, before, after, rebuilt: general.polyhedraBuildCounter > counterBefore };
  });
  H.check('category color+alpha applies in place to all members (others untouched)',
    catStyled.before.members.length > 0
      && catStyled.before.members.every(([c, o]) => c === 'ff0000' && Math.abs(o - 0.3) < 1e-6)
      && (!catStyled.before.other || catStyled.before.other[0] !== 'ff0000'),
    JSON.stringify(catStyled.before));
  H.check('category style survives an async polyhedra rebuild on the new meshes',
    catStyled.rebuilt
      && catStyled.after.members.length > 0
      && catStyled.after.members.every(([c, o]) => c === 'ff0000' && Math.abs(o - 0.3) < 1e-6),
    JSON.stringify({ rebuilt: catStyled.rebuilt, after: catStyled.after }));

  // --- Individual override wins over the category ---------------------------------
  const indStyled = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updatePolyhedraColors } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const meshes = groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const catKey = Object.keys(s.polyhedraCategoryStyles)[0];
    const members = meshes.filter((m) => m.userData.catKey === catKey);
    const target = members[0];
    s.polyhedraUserStyles[target.userData.key] = { color: '#00ff00' };
    updatePolyhedraColors();
    return {
      targetColor: target.material.color.getHexString(),
      siblingColor: members[1] ? members[1].material.color.getHexString() : 'ff0000',
    };
  });
  H.check('individual override wins over the category style',
    indStyled.targetColor === '00ff00' && indStyled.siblingColor === 'ff0000',
    JSON.stringify(indStyled));

  // --- Category visibility hides member meshes ------------------------------------
  const vis = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updatePolyhedraColors } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const catKey = Object.keys(s.polyhedraCategoryStyles)[0];
    s.polyhedraCategoryStyles[catKey].visible = false;
    updatePolyhedraColors();
    const meshes = groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const result = {
      membersHidden: meshes.filter((m) => m.userData.catKey === catKey).every((m) => m.visible === false),
      othersVisible: meshes.filter((m) => m.userData.catKey !== catKey).every((m) => m.visible === true),
    };
    s.polyhedraCategoryStyles[catKey].visible = true; // restore for selection tests
    updatePolyhedraColors();
    return result;
  });
  H.check('category visibility=false hides exactly its member meshes',
    vis.membersHidden && vis.othersVisible, JSON.stringify(vis));

  // --- Two-way selection ----------------------------------------------------------
  const sel = await page.evaluate(async () => {
    const { highlightHover, groups } = await import('./state/store.js');
    const { selectPolyhedronFromRow } = await import('./ui/SelectAndHighlightModule.js');
    const row = /** @type {HTMLElement} */ (document.querySelector('#infoPolyControls .individual-polyhedron-row'));
    selectPolyhedronFromRow(row.dataset.polyKey, row);
    const state = highlightHover.currentlyHighlightedPolyhedron;
    const mesh = groups.polyhedraGroup.children.find((m) => m.userData?.key === state?.key);
    return {
      rowKey: row.dataset.polyKey,
      state,
      emissive: mesh ? mesh.material.emissive.getHex() : 0,
      rowHighlighted: row.style.borderLeft.includes('rgb(255, 179, 71)'),
    };
  });
  H.check('clicking a polyhedron row sets selection state, orange emissive and amber row',
    !!sel.state && sel.state.key === sel.rowKey && sel.emissive === 0xFF8C00 && sel.rowHighlighted,
    JSON.stringify(sel));

  const sel2 = await page.evaluate(async () => {
    const { highlightHover, groups } = await import('./state/store.js');
    const { selectPolyhedronFromMesh } = await import('./ui/SelectAndHighlightModule.js');
    const prevKey = highlightHover.currentlyHighlightedPolyhedron.key;
    const meshes = groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const other = meshes.find((m) => m.userData.key !== prevKey);
    selectPolyhedronFromMesh(other, { scrollToSelection: false });
    const prevMesh = meshes.find((m) => m.userData.key === prevKey);
    const row = document.querySelector(`#infoPolyControls .individual-polyhedron-row[data-poly-key="${other.userData.key}"]`);
    return {
      newKey: highlightHover.currentlyHighlightedPolyhedron?.key,
      expectedKey: other.userData.key,
      prevGlowCleared: prevMesh.material.emissive.getHex() === 0x000000,
      newGlow: other.material.emissive.getHex(),
      rowFoundAndListVisible: !!row
        && /** @type {HTMLElement} */ (row.closest('.individual-polyhedra')).style.display !== 'none',
    };
  });
  H.check('selectPolyhedronFromMesh moves the glow and opens/expands the right row',
    sel2.newKey === sel2.expectedKey && sel2.prevGlowCleared && sel2.newGlow === 0xFF8C00
      && sel2.rowFoundAndListVisible,
    JSON.stringify(sel2));

  const desel = await page.evaluate(async () => {
    const { highlightHover, groups } = await import('./state/store.js');
    const { selectPolyhedronFromMesh } = await import('./ui/SelectAndHighlightModule.js');
    const key = highlightHover.currentlyHighlightedPolyhedron.key;
    const mesh = groups.polyhedraGroup.children.find((m) => m.userData?.key === key);
    selectPolyhedronFromMesh(mesh); // same key → toggle off
    return {
      state: highlightHover.currentlyHighlightedPolyhedron,
      emissive: mesh.material.emissive.getHex(),
    };
  });
  H.check('re-selecting the same polyhedron deselects (state null, glow cleared)',
    desel.state === null && desel.emissive === 0x000000, JSON.stringify(desel));

  // --- Polyhedra follow bond-length settings, not bond visibility -----------------
  const bondsHidden = await page.evaluate(async () => {
    const { general, groups } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    Object.keys(general.bondVisibility).forEach((p) => { general.bondVisibility[p] = false; });
    general.showBonds = false;
    const before = general.polyhedraBuildCounter;
    await updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
    for (let i = 0; i < 100 && general.polyhedraBuildCounter === before; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      polys: groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron').length,
      bondsDrawn: !!groups.bondsMesh,
    };
  });
  H.check('polyhedra persist when bonds are hidden (per-pair visibility and global toggle)',
    bondsHidden.polys > 0 && bondsHidden.bondsDrawn === false,
    JSON.stringify(bondsHidden));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
