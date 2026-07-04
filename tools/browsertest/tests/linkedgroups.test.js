// "Link periodic copies" applied to Bonds and Poly tabs (default ON): periodic
// copies of one physical bond/polyhedron are grouped into a single row (×N),
// edits fan out to all copies' style stores, and selection glows all copies.
// Also checks the toggle's new placement above the tab selector.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO — boundary-crossing bonds have copies

  // --- Toggle placement: above the tab selector, not inside the Atoms panel ------
  const placement = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const toggle = document.getElementById('linkPeriodicCopiesToggle');
    const control = document.getElementById('atomBondControl');
    return {
      exists: !!toggle,
      inAtomPanel: !!toggle?.closest('#atomPanel'),
      precedesTabs: !!(toggle && control
        && (toggle.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  H.check('toggle sits above the tab selector (outside the Atoms panel)',
    placement.exists && !placement.inAtomPanel && placement.precedesTabs,
    JSON.stringify(placement));

  // --- Atoms: linked selection glows ALL periodic copies --------------------------
  const atomSel = await page.evaluate(async () => {
    const { fileBrowser, groups, atomSelection } = await import('./state/store.js');
    const { updateAtomSelectionFrom3DHit } = await import('./ui/SelectAndHighlightModule.js');
    const s = fileBrowser.selectedStructure;
    // Source atom with several on-screen copies (YBCO corner/face atoms).
    const srcIndex = Number(Object.keys(s.atomImages)
      .reduce((a, b) => (s.atomImages[a].length >= s.atomImages[b].length ? a : b)));
    const images = s.atomImages[srcIndex];
    const glowAt = (i) => groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.getX(i);
    updateAtomSelectionFrom3DHit(
      { instanceId: images[0], object: groups.atomsMesh }, { scrollToSelection: false });
    const glows = images.map(glowAt);
    const selectedCount = atomSelection.selectedAtoms.length;
    // Parity with bonds/poly: picking a DIFFERENT copy of the same atom deselects.
    updateAtomSelectionFrom3DHit(
      { instanceId: images[1], object: groups.atomsMesh }, { scrollToSelection: false });
    return {
      srcIndex,
      copies: images.length,
      glows,
      selectedCount,
      deselected: atomSelection.selectedAtoms.length === 0,
      glowsAfter: images.map(glowAt),
    };
  });
  H.check('linked atom selection glows ALL periodic copies of the atom',
    atomSel.copies >= 2 && atomSel.selectedCount === 1
      && atomSel.glows.every((g) => g === 2.0),
    JSON.stringify(atomSel));
  H.check('picking a different copy of the selected atom toggles it off (all glows cleared)',
    atomSel.deselected && atomSel.glowsAfter.every((g) => g === 0),
    JSON.stringify({ deselected: atomSel.deselected, glowsAfter: atomSel.glowsAfter }));

  // --- Bonds: grouped rows -------------------------------------------------------
  const bondGroups = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { bondGroupKey } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    document.querySelector('#atomBondControlSwitch button[data-mode="bonds"]').click();
    document.querySelectorAll('#infoBondControls .bond-expand-icon')
      .forEach((icon) => /** @type {HTMLElement} */ (icon).click());
    const byGroup = new Map();
    s.bonds.forEach((b, i) => {
      const gk = bondGroupKey(s, b);
      if (!byGroup.has(gk)) byGroup.set(gk, []);
      byGroup.get(gk).push(i);
    });
    const rows = [...document.querySelectorAll('#infoBondControls .individual-bond-row')];
    const multi = [...byGroup.entries()].find(([, members]) => members.length >= 2) ?? null;
    const multiRow = multi
      ? rows.find((r) => /** @type {HTMLElement} */ (r).dataset.groupKey === multi[0])
      : null;
    return {
      totalBonds: s.bonds.length,
      groupCount: byGroup.size,
      rowCount: rows.length,
      allGrouped: rows.every((r) => /** @type {HTMLElement} */ (r).dataset.groupKey),
      multiGroupKey: multi?.[0] ?? null,
      multiMembers: multi?.[1] ?? [],
      multiRowText: multiRow?.textContent ?? '',
    };
  });
  H.check('Bonds tab lists one row per bond group (fewer rows than bonds, all with group keys)',
    bondGroups.rowCount === bondGroups.groupCount
      && bondGroups.rowCount < bondGroups.totalBonds
      && bondGroups.allGrouped,
    JSON.stringify({ bonds: bondGroups.totalBonds, groups: bondGroups.groupCount, rows: bondGroups.rowCount }));
  H.check('a multi-copy bond group exists and its row shows the ×N copy count',
    bondGroups.multiGroupKey !== null
      && new RegExp(`×${bondGroups.multiMembers.length}`).test(bondGroups.multiRowText),
    JSON.stringify({ key: bondGroups.multiGroupKey, members: bondGroups.multiMembers.length, text: bondGroups.multiRowText }));

  // --- Bonds: group edit fans out to every member's style store -------------------
  const bondEdit = await page.evaluate(async ({ multiGroupKey, multiMembers }) => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { bondKey } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const row = /** @type {HTMLElement} */ (
      document.querySelector(`#infoBondControls .individual-bond-row[data-group-key="${multiGroupKey}"]`));
    /** @type {HTMLElement} */ (row.querySelector('button[data-editor-button="color"]')).click();
    const alphaSlider = /** @type {HTMLInputElement} */ (
      row.querySelector('.bond-color-editor input[type="range"]'));
    alphaSlider.value = '0.4';
    alphaSlider.dispatchEvent(new Event('input', { bubbles: true }));
    const attrs = groups.bondsMesh.geometry.attributes;
    return {
      storeAlphas: multiMembers.map((i) => s.bondUserStyles[bondKey(s.bonds[i].indices)]?.alpha),
      meshOpacities: multiMembers.flatMap((i) =>
        (s.bonds[i].instanceIds ?? []).map((id) => attrs.instanceOpacity.getX(id))),
    };
  }, { multiGroupKey: bondGroups.multiGroupKey, multiMembers: bondGroups.multiMembers });
  H.check('group Alpha edit writes every member\'s store entry and paints all copies',
    bondEdit.storeAlphas.every((a) => a === 0.4)
      && bondEdit.meshOpacities.length >= 4
      && bondEdit.meshOpacities.every((o) => Math.abs(o - 0.4) < 1e-6),
    JSON.stringify(bondEdit));

  // --- Bonds: group selection glows all copies; any copy toggles it off -----------
  const bondSel = await page.evaluate(async ({ multiGroupKey, multiMembers }) => {
    const { fileBrowser, groups, highlightHover } = await import('./state/store.js');
    const { selectBondFromInstance } = await import('./ui/SelectAndHighlightModule.js');
    const s = fileBrowser.selectedStructure;
    const row = /** @type {HTMLElement} */ (
      document.querySelector(`#infoBondControls .individual-bond-row[data-group-key="${multiGroupKey}"]`));
    row.click();
    const state = highlightHover.currentlyHighlightedBond;
    const attrs = groups.bondsMesh.geometry.attributes;
    const glows = (state?.instanceIds ?? []).map((id) => attrs.instanceEmissiveIntensity.getX(id));
    // Toggle off from a NON-representative copy's instance (3D pick path).
    const otherMember = multiMembers.find((i) => i !== state.bondIndex);
    selectBondFromInstance(s.bonds[otherMember].instanceIds[0], { scrollToSelection: false });
    return {
      groupKey: state?.groupKey,
      memberCount: state?.bondIndexes?.length ?? 0,
      instanceCount: state?.instanceIds?.length ?? 0,
      glows,
      deselected: highlightHover.currentlyHighlightedBond === null,
    };
  }, { multiGroupKey: bondGroups.multiGroupKey, multiMembers: bondGroups.multiMembers });
  H.check('group selection glows all copies; picking any copy in 3D toggles the group off',
    bondSel.groupKey === bondGroups.multiGroupKey
      && bondSel.memberCount === bondGroups.multiMembers.length
      && bondSel.instanceCount === 2 * bondSel.memberCount
      && bondSel.glows.every((g) => g === 2.0)
      && bondSel.deselected,
    JSON.stringify(bondSel));

  // --- Poly: grouped rows ----------------------------------------------------------
  // YBCO's polyhedra are all cell-interior (no periodic copies). Load SrTiO3:
  // Ti sits at the cell corner, so its TiO6 octahedron has 8 image copies.
  const SRTIO3 = [
    'SrTiO3', '3.905',
    '1.0 0.0 0.0', '0.0 1.0 0.0', '0.0 0.0 1.0',
    'Sr Ti O', '1 1 3', 'Direct',
    '0.5 0.5 0.5',
    '0.0 0.0 0.0',
    '0.5 0.0 0.0',
    '0.0 0.5 0.0',
    '0.0 0.0 0.5',
  ].join('\n');
  await H.clickById(page, 'showPolyhedra');
  await page.evaluate(async (poscar) => {
    const { general } = await import('./state/store.js');
    const cv = await import('./core/crystal-viewer.js');
    // Suppress Sr-Ti "bonds": otherwise a big SrTi8 polyhedron wins the
    // nesting priority and swallows the corner TiO6 octahedra we need.
    general.bondLengths['Sr-Ti'] = { min: 0, max: 0 };
    general.bondVisibility['Sr-Ti'] = false;
    await cv.loadStructure(poscar, 'SrTiO3.vasp');
  }, SRTIO3);
  await H.waitFor(page, async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    return fileBrowser.selectedStructure?.elements?.includes('Ti')
      && (fileBrowser.selectedStructure?.polyhedra?.polyhedra?.length ?? 0) > 0
      && (groups.polyhedraGroup?.children?.length ?? 0) > 0;
  });
  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
  });
  const polyGroups = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"]').click();
    document.querySelectorAll('#infoPolyControls .poly-expand-icon')
      .forEach((icon) => /** @type {HTMLElement} */ (icon).click());
    const byGroup = new Map();
    s.polyhedra.polyhedra.forEach((p, i) => {
      const gk = p.groupKey ?? p.key;
      if (!byGroup.has(gk)) byGroup.set(gk, []);
      byGroup.get(gk).push(i);
    });
    const rows = [...document.querySelectorAll('#infoPolyControls .individual-polyhedron-row')];
    const multi = [...byGroup.entries()].find(([, members]) => members.length >= 2) ?? null;
    return {
      totalPolys: s.polyhedra.polyhedra.length,
      groupCount: byGroup.size,
      rowCount: rows.length,
      allGrouped: rows.every((r) => /** @type {HTMLElement} */ (r).dataset.polyGroupKey),
      multiGroupKey: multi?.[0] ?? null,
      multiMembers: multi?.[1] ?? [],
    };
  });
  H.check('Poly tab lists one row per polyhedron group (all rows carry group keys)',
    polyGroups.rowCount === polyGroups.groupCount && polyGroups.allGrouped,
    JSON.stringify({ polys: polyGroups.totalPolys, groups: polyGroups.groupCount, rows: polyGroups.rowCount }));

  // --- Poly: group edit + group selection (skipped gracefully if no multi group) ---
  if (polyGroups.multiGroupKey) {
    const polyEditSel = await page.evaluate(async ({ multiGroupKey, multiMembers }) => {
      const { fileBrowser, groups, highlightHover } = await import('./state/store.js');
      const { selectPolyhedronFromMesh } = await import('./ui/SelectAndHighlightModule.js');
      const s = fileBrowser.selectedStructure;
      const memberKeys = multiMembers.map((i) => s.polyhedra.polyhedra[i].key);
      const row = /** @type {HTMLElement} */ (
        document.querySelector(`#infoPolyControls .individual-polyhedron-row[data-poly-group-key="${multiGroupKey}"]`));
      /** @type {HTMLElement} */ (row.querySelector('button[data-editor-button="color"]')).click();
      const alphaSlider = /** @type {HTMLInputElement} */ (
        row.querySelector('.poly-color-editor input[type="range"]'));
      alphaSlider.value = '0.3';
      alphaSlider.dispatchEvent(new Event('input', { bubbles: true }));
      const memberMeshes = groups.polyhedraGroup.children.filter(
        (m) => m.userData?.type === 'polyhedron' && m.userData.groupKey === multiGroupKey);
      const storeAlphas = memberKeys.map((k) => s.polyhedraUserStyles[k]?.alpha);
      const meshOpacities = memberMeshes.map((m) => m.material.opacity);
      // Group selection via row click; toggle off from another member's mesh.
      row.click();
      const glows = memberMeshes.map((m) => m.material.emissive.getHex());
      const state = { ...highlightHover.currentlyHighlightedPolyhedron };
      const otherMesh = memberMeshes.find((m) => m.userData.key !== state.key);
      selectPolyhedronFromMesh(otherMesh, { scrollToSelection: false });
      const glowsAfter = memberMeshes.map((m) => m.material.emissive.getHex());
      return {
        storeAlphas, meshOpacities, glows, state,
        deselected: highlightHover.currentlyHighlightedPolyhedron === null,
        glowsAfter,
      };
    }, { multiGroupKey: polyGroups.multiGroupKey, multiMembers: polyGroups.multiMembers });
    H.check('poly group Alpha edit writes every member\'s store entry and restyles all copies',
      polyEditSel.storeAlphas.every((a) => a === 0.3)
        && polyEditSel.meshOpacities.length >= 2
        && polyEditSel.meshOpacities.every((o) => Math.abs(o - 0.3) < 1e-6),
      JSON.stringify({ storeAlphas: polyEditSel.storeAlphas, meshOpacities: polyEditSel.meshOpacities }));
    H.check('poly group selection glows all copies; picking another copy toggles off (all restored)',
      polyEditSel.state.groupKey === polyGroups.multiGroupKey
        && polyEditSel.glows.every((g) => g === 0xFF8C00)
        && polyEditSel.deselected
        && polyEditSel.glowsAfter.every((g) => g === 0x000000),
      JSON.stringify({ glows: polyEditSel.glows, glowsAfter: polyEditSel.glowsAfter, state: polyEditSel.state }));
  } else {
    H.check('poly multi-copy group found on YBCO (expected boundary-centered polyhedra)',
      false, 'no polyhedron group with >= 2 periodic copies found — grouped edit/selection unverified');
  }

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
