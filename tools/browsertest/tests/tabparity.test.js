// Equalized category headers across the Atoms/Bonds/Poly tabs: visibility
// checkbox, clickable pie dot -> group style editor, count (pct%), and
// cut-plane immunity toggle on every category row.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  // --- (a) Atoms: per-element visibility checkbox --------------------------------
  const atomHide = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updateAtoms } = await import('./render/index.js');
    setStructurePanelOpen(true);
    const s = fileBrowser.selectedStructure;
    const container = document.querySelector('#atomPanel .comp-container');
    const el = /** @type {HTMLElement} */ (container).dataset.element;
    const checkbox = /** @type {HTMLInputElement} */ (container.querySelector('.comp-left input[type="checkbox"]'));
    const srcIndices = s.elements.map((e, i) => (e === el ? i : -1)).filter((i) => i >= 0);
    const images = srcIndices.flatMap((i) => s.atomImages[i] ?? []);
    const normAt = (i) => {
      const a = groups.atomsMesh.instanceMatrix.array;
      const o = i * 16;
      return Math.hypot(a[o], a[o + 1], a[o + 2]);
    };
    checkbox.click(); // uncheck -> hide
    const hidden = images.map(normAt);
    await updateAtoms(1); // full repaint must keep them hidden
    const afterRepaint = images.map(normAt);
    checkbox.click(); // re-check -> show
    const restored = images.map(normAt);
    // Row click must still toggle expansion despite the new checkbox.
    /** @type {HTMLElement} */ (container.querySelector('.comp-row')).click();
    const expanded = /** @type {HTMLElement} */ (container.querySelector('.individual-atoms')).style.display !== 'none';
    return {
      el,
      flagAfter: general.atomVisibility[el],
      hidden, afterRepaint, restored, expanded,
    };
  });
  H.check('element checkbox zero-scales all its copies, survives a repaint, and restores',
    atomHide.hidden.every((n) => n === 0)
      && atomHide.afterRepaint.every((n) => n === 0)
      && atomHide.restored.every((n) => n > 0)
      && atomHide.flagAfter === true
      && atomHide.expanded,
    JSON.stringify({ el: atomHide.el, hidden: atomHide.hidden.length, expanded: atomHide.expanded }));

  // --- (e) Bonds: compact labels + count (pct%) + immunity toggle present --------
  const bondHeader = await page.evaluate(() => {
    document.querySelector('#atomBondControlSwitch button[data-mode="bonds"]').click();
    const controls = [...document.querySelectorAll('#infoBondControls .bond-control')];
    return {
      labels: controls.map((c) => c.querySelector('label')?.textContent ?? ''),
      counts: controls.map((c) => c.querySelector('.bond-count')?.textContent ?? ''),
      toggles: controls.filter((c) => c.querySelectorAll('.bond-checkbox input[type="checkbox"]').length >= 2).length,
      dotsClickable: controls.filter((c) => /** @type {HTMLElement} */ (c.querySelector('.dot'))?.onclick).length,
      total: controls.length,
    };
  });
  H.check('bond headers: compact pair labels, count (pct%), immunity toggle, clickable dot',
    bondHeader.total > 0
      && bondHeader.labels.every((l) => /^[A-Z][a-z]?-[A-Z][a-z]?$/.test(l))
      && bondHeader.counts.every((c) => /^\d+ \(\d+\.\d%\)$/.test(c))
      && bondHeader.toggles === bondHeader.total
      && bondHeader.dotsClickable === bondHeader.total,
    JSON.stringify(bondHeader));

  // --- (b) Bonds: category editor styles the whole pair, persists, per-copy wins --
  const catEdit = await page.evaluate(async () => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { bondKey } = await import('./render/index.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    const pairOf = (b) => (b.elements[0] < b.elements[1]
      ? `${b.elements[0]}-${b.elements[1]}` : `${b.elements[1]}-${b.elements[0]}`);
    // Pick a pair with at least 2 member bonds.
    const byPair = new Map();
    s.bonds.forEach((b, i) => {
      const p = pairOf(b);
      if (!byPair.has(p)) byPair.set(p, []);
      byPair.get(p).push(i);
    });
    const [pair, members] = [...byPair.entries()].find(([, m]) => m.length >= 2);
    const control = document.querySelector(`#infoBondControls .bond-control[data-pair="${pair}"]`);
    /** @type {HTMLElement} */ (control.querySelector('.dot')).click();
    const editorVisible = /** @type {HTMLElement} */ (control.querySelector('.bond-cat-editor')).style.display !== 'none';
    // Drive the Alpha range (first range input in the category editor).
    const alphaSlider = /** @type {HTMLInputElement} */ (
      control.querySelector('.bond-cat-editor input[type="range"]'));
    alphaSlider.value = '0.4';
    alphaSlider.dispatchEvent(new Event('input', { bubbles: true }));
    const attrs = groups.bondsMesh.geometry.attributes;
    const liveOpacities = members.flatMap((i) =>
      (s.bonds[i].instanceIds ?? []).map((id) => attrs.instanceOpacity.getX(id)));
    // Color via the category store + rebuild (what the picker onChange persists).
    s.bondCategoryStyles[pair].color = '#ff0000';
    // Per-copy override on one member must win after the rebuild.
    s.bondUserStyles[bondKey(s.bonds[members[0]].indices)] = {
      color: '#00ff00', elements: [...s.bonds[members[0]].elements],
    };
    const before = general.bondsBuildCounter;
    await updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
    for (let i = 0; i < 50 && general.bondsBuildCounter === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const rebuilt = members.map((i) => s.bonds[i]);
    return {
      pair,
      editorVisible,
      storeAlpha: s.bondCategoryStyles[pair].alpha,
      liveOpacities,
      overrideColor: rebuilt[0].color[0],
      categoryColors: rebuilt.slice(1).map((b) => b.color[0]),
      rebuiltAlphas: rebuilt.map((b) => b.alpha),
    };
  });
  H.check('bond category editor: alpha applies live to all members and persists in the store',
    catEdit.editorVisible && catEdit.storeAlpha === 0.4
      && catEdit.liveOpacities.length >= 4
      && catEdit.liveOpacities.every((o) => Math.abs(o - 0.4) < 1e-6)
      && catEdit.rebuiltAlphas.every((a) => a === 0.4),
    JSON.stringify(catEdit));
  H.check('after a rebuild the category color applies, with a per-copy override winning',
    catEdit.categoryColors.every((c) => c === '#ff0000') && catEdit.overrideColor === '#00ff00',
    JSON.stringify({ override: catEdit.overrideColor, category: catEdit.categoryColors }));

  // --- Polyhedra baseline (before the cut plane) ----------------------------------
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    return (groups.polyhedraGroup?.children?.length ?? 0) > 0;
  });
  const polyBaseline = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"]').click();
    const controls = [...document.querySelectorAll('#infoPolyControls .poly-control')];
    return {
      count: groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron').length,
      // A polyhedron survives a cut only if ALL its atoms do — the immunity
      // toggle marks center + vertex source atoms immune.
      memberAtoms: [...new Set(s.polyhedra.polyhedra
        .flatMap((p) => [p.centerIndex, ...(p.vertexSrcList ?? [])])
        .filter(Number.isInteger))],
      togglesPresent: controls.filter((c) =>
        c.querySelectorAll('.bond-checkbox input[type="checkbox"]').length >= 2).length,
      controls: controls.length,
    };
  });
  H.check('poly headers carry an immunity toggle (second checkbox) per category',
    polyBaseline.controls > 0 && polyBaseline.togglesPresent === polyBaseline.controls,
    JSON.stringify({ controls: polyBaseline.controls, toggles: polyBaseline.togglesPresent }));

  // --- (c) Bond immunity vs an active cut plane -----------------------------------
  const bondImmunity = await page.evaluate(async () => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updateBonds } = await import('./render/index.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    general.atomCutPlanes.push({ enabled: true, x: 1, y: 0, z: 0, r: 1.0, side: 'left' });
    const before = general.polyhedraBuildCounter;
    await updateVisualization({ reRenderComposition: false });
    for (let i = 0; i < 100 && general.polyhedraBuildCounter === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const normAt = (id) => {
      const a = groups.bondsMesh.instanceMatrix.array;
      const o = id * 16;
      return Math.hypot(a[o], a[o + 1], a[o + 2]);
    };
    const pairOf = (b) => (b.elements[0] < b.elements[1]
      ? `${b.elements[0]}-${b.elements[1]}` : `${b.elements[1]}-${b.elements[0]}`);
    const cut = s.bonds.find((b) => b.instanceIds && normAt(b.instanceIds[0]) === 0);
    if (!cut) return { cutFound: false };
    const pair = pairOf(cut);
    general.bondCutImmunity[pair] = true;
    await updateBonds(1);
    return {
      cutFound: true,
      pair,
      restoredNorm: normAt(cut.instanceIds[0]),
      polyCountUnderCut: groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron').length,
    };
  });
  H.check('per-pair bond immunity restores bonds culled by an active cut plane',
    bondImmunity.cutFound && bondImmunity.restoredNorm > 0,
    JSON.stringify(bondImmunity));

  // --- (d) Poly immunity (member atoms immune) restores cut polyhedra -------------
  const polyImmunity = await page.evaluate(async ({ baselineCount, memberAtoms }) => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updatePolyhedra } = await import('./render/index.js');
    const { setCutPlaneImmunityForAtoms } = await import('./ui/StructureInfoPanel/components/utils.js');
    const s = fileBrowser.selectedStructure;
    const countNow = () => groups.polyhedraGroup.children
      .filter((m) => m.userData?.type === 'polyhedron' && m.userData.mode === 'centered').length;
    const droppedCount = countNow();
    setCutPlaneImmunityForAtoms(memberAtoms, true); // what the header toggle does
    const before = general.polyhedraBuildCounter;
    updatePolyhedra();
    for (let i = 0; i < 100 && general.polyhedraBuildCounter === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      baselineCount,
      droppedCount,
      restoredCount: countNow(),
      atomFlag: s.atoms[memberAtoms[0]].cutPlaneImmune === true,
    };
  }, { baselineCount: polyBaseline.count, memberAtoms: polyBaseline.memberAtoms });
  H.check('poly immunity (member atoms immune) restores polyhedra dropped by the cut plane',
    polyImmunity.droppedCount < polyImmunity.baselineCount
      && polyImmunity.restoredCount === polyImmunity.baselineCount
      && polyImmunity.atomFlag,
    JSON.stringify(polyImmunity));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
