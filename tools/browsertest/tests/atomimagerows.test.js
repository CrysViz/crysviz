// The "Link periodic copies" toggle: when off, the Atoms tab lists one row per
// on-screen copy (periodic image) and Color/Alpha/Size edits apply to only that
// copy (structure.atomImageStyles, persistent across re-renders), with two-way
// selection sync targeting the exact copy.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO — boundary atoms have many periodic copies

  // --- Linked baseline: one row per source atom -----------------------------------
  const baseline = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    const { fileBrowser } = await import('./state/store.js');
    setStructurePanelOpen(true);
    document.querySelectorAll('#atomPanel .comp-row')
      .forEach((r) => /** @type {HTMLElement} */ (r).click()); // expand all elements
    const rows = [...document.querySelectorAll('#atomPanel .individual-atom-row')];
    return {
      rows: rows.length,
      atoms: fileBrowser.selectedStructure.atoms.length,
      withImageIndex: rows.filter((r) => /** @type {HTMLElement} */ (r).dataset.imageIndex != null).length,
      toggleExists: !!document.getElementById('linkPeriodicCopiesToggle'),
    };
  });
  H.check('linked mode lists one row per source atom (no image indices)',
    baseline.rows === baseline.atoms && baseline.withImageIndex === 0 && baseline.toggleExists,
    JSON.stringify(baseline));

  // --- Toggle off via the real UI --------------------------------------------------
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(300);
  const unlinked = await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const rows = [...document.querySelectorAll('#atomPanel .individual-atom-row')];
    const expectedRows = Object.values(s.atomImages).reduce((n, list) => n + list.length, 0);
    return {
      flag: general.linkPeriodicCopies,
      rows: rows.length,
      expectedRows,
      atoms: s.atoms.length,
      withImageIndex: rows.filter((r) => /** @type {HTMLElement} */ (r).dataset.imageIndex != null).length,
      sampleMeta: rows.find((r) => /copy \d+\/\d+/.test(r.textContent))?.querySelectorAll('span')[1]?.textContent ?? '',
    };
  });
  H.check('toggling off lists one row per on-screen copy with image indices and copy metadata',
    unlinked.flag === false
      && unlinked.rows === unlinked.expectedRows
      && unlinked.rows > unlinked.atoms
      && unlinked.withImageIndex === unlinked.rows
      && /copy \d+\/\d+\s+\(-?\d+,-?\d+,-?\d+\)/.test(unlinked.sampleMeta),
    JSON.stringify(unlinked));

  // --- Image rows are colour-only; the (0,0,0) copy keeps Position/Spin -------------
  const buttons = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#atomPanel .individual-atom-row')];
    const btnLabels = (r) => [...r.querySelectorAll('.atom-editor-button')].map((b) => b.textContent);
    const isPrimary = (r) => /\(0,0,0\)/.test(r.textContent);
    const primary = rows.find(isPrimary);
    const image = rows.find((r) => r.dataset.imageIndex != null && !isPrimary(r));
    return {
      primaryHasPosition: btnLabels(primary).includes('Position'),
      imageOnlyColor: btnLabels(image).length === 1 && btnLabels(image)[0] === 'Color',
      imageMarked: /↳/.test(image.textContent),
    };
  });
  H.check('periodic-image rows are colour-only and marked; the (0,0,0) copy keeps all buttons',
    buttons.primaryHasPosition && buttons.imageOnlyColor && buttons.imageMarked,
    JSON.stringify(buttons));

  // --- Unlinked Position slider drags live (no panel rebuild mid-drag) --------------
  // The (0,0,0) row must move on a slider *drag*, not only a click: with the
  // rebuild-on-input path the row is torn down each frame and the drag dies.
  const drag = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const rows = [...document.querySelectorAll('#atomPanel .individual-atom-row')];
    const primary = rows.find((r) => /\(0,0,0\)/.test(r.textContent));
    const atomIndex = Number(primary.dataset.atomIndex);
    const before = fileBrowser.selectedStructure.atoms[atomIndex].position[0];
    /** @type {HTMLElement} */ (
      [...primary.querySelectorAll('.atom-editor-button')].find((b) => b.textContent === 'Position')
    ).click();
    const slider = /** @type {HTMLInputElement} */ (primary.querySelector('.coord-axis-slider'));
    slider.value = String(before < 0.5 ? before + 0.2 : before - 0.2);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      stillConnected: slider.isConnected,
      moved: Math.abs(fileBrowser.selectedStructure.atoms[atomIndex].position[0] - before) > 1e-4,
    };
  });
  H.check('unlinked Position slider drags live: the row survives and the atom moves',
    drag.stillConnected && drag.moved, JSON.stringify(drag));

  // --- Per-copy color edit: only that instance changes ------------------------------
  const colored = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const M = await import('./render/AtomsFracUpdateModule.js');
    const s = fileBrowser.selectedStructure;
    // Pick a source atom with at least two on-screen copies.
    const srcIndex = Number(Object.keys(s.atomImages).find((k) => s.atomImages[k].length >= 2));
    const [img0, img1] = s.atomImages[srcIndex];
    M.setAtomImageStyle(s, img1, { color: '#ff0000', alpha: 0.4, radiusScale: 2 });
    M.updateSingleAtomImageColor(img1, '#ff0000');
    M.updateSingleAtomOpacity(img1, 0.4);
    M.updateSingleAtomDiameter(img1, s.elements[srcIndex], 2);
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
    const rgbAt = (i) => [
      groups.atomsMesh.instanceColor.getX(i),
      groups.atomsMesh.instanceColor.getY(i),
      groups.atomsMesh.instanceColor.getZ(i),
    ];
    return { srcIndex, img0, img1, edited: rgbAt(img1), sibling: rgbAt(img0) };
  });
  H.check('per-copy color paints only the edited instance (sibling copy unchanged)',
    colored.edited[0] === 1 && colored.edited[1] === 0 && colored.edited[2] === 0
      && !(colored.sibling[0] === 1 && colored.sibling[1] === 0 && colored.sibling[2] === 0),
    JSON.stringify(colored));

  // --- Per-copy styles survive an atoms re-render -----------------------------------
  const persisted = await page.evaluate(async ({ img0, img1 }) => {
    const { groups } = await import('./state/store.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    await updateVisualization({ reRenderAtoms: true, reRenderOther: false, reRenderComposition: false });
    const rgbAt = (i) => [
      groups.atomsMesh.instanceColor.getX(i),
      groups.atomsMesh.instanceColor.getY(i),
      groups.atomsMesh.instanceColor.getZ(i),
    ];
    const opacityAt = (i) => groups.atomsMesh.geometry.attributes.instanceOpacity.getX(i);
    return {
      edited: rgbAt(img1),
      sibling: rgbAt(img0),
      editedOpacity: opacityAt(img1),
      siblingOpacity: opacityAt(img0),
    };
  }, { img0: colored.img0, img1: colored.img1 });
  H.check('per-copy color and alpha survive a full atoms rebuild (keys re-derived)',
    persisted.edited[0] === 1 && persisted.edited[1] === 0 && persisted.edited[2] === 0
      && !(persisted.sibling[0] === 1 && persisted.sibling[1] === 0 && persisted.sibling[2] === 0)
      && Math.abs(persisted.editedOpacity - 0.4) < 1e-6
      && persisted.siblingOpacity === 1,
    JSON.stringify(persisted));

  // --- Selection targets the exact copy ---------------------------------------------
  const sel = await page.evaluate(async ({ img1 }) => {
    const { atomSelection } = await import('./state/store.js');
    const row = /** @type {HTMLElement} */ (
      document.querySelector(`#atomPanel .individual-atom-row[data-image-index="${img1}"]`));
    /** @type {HTMLElement} */ (row.querySelector('span')).click();
    const highlightedRows = [...document.querySelectorAll('#atomPanel .individual-atom-row')]
      .filter((r) => /** @type {HTMLElement} */ (r).style.borderLeft.includes('rgb(255, 179, 71)'));
    return {
      selectedInstance: atomSelection.selectedAtoms[0]?.instanceId,
      expected: img1,
      highlightedCount: highlightedRows.length,
      highlightedImage: Number(/** @type {HTMLElement} */ (highlightedRows[0])?.dataset.imageIndex),
    };
  }, { img1: colored.img1 });
  H.check('clicking a copy row selects exactly that instance (only its row amber)',
    sel.selectedInstance === sel.expected && sel.highlightedCount === 1 && sel.highlightedImage === sel.expected,
    JSON.stringify(sel));

  const sel3d = await page.evaluate(async ({ img0 }) => {
    const { groups } = await import('./state/store.js');
    const { updateAtomSelectionFrom3DHit } = await import('./ui/SelectAndHighlightModule.js');
    updateAtomSelectionFrom3DHit({ instanceId: img0, object: groups.atomsMesh }, { scrollToSelection: false });
    const highlighted = [...document.querySelectorAll('#atomPanel .individual-atom-row')]
      .find((r) => /** @type {HTMLElement} */ (r).style.borderLeft.includes('rgb(255, 179, 71)'));
    return { highlightedImage: Number(/** @type {HTMLElement} */ (highlighted)?.dataset.imageIndex), expected: img0 };
  }, { img0: colored.img0 });
  H.check('3D pick highlights the row of the exact copy that was hit',
    sel3d.highlightedImage === sel3d.expected, JSON.stringify(sel3d));

  // --- Toggle back on: source rows return, per-copy style still wins ----------------
  await H.clickById(page, 'linkPeriodicCopiesToggle');
  await page.waitForTimeout(300);
  const relinked = await page.evaluate(async ({ img1 }) => {
    const { fileBrowser, general, groups } = await import('./state/store.js');
    const rows = [...document.querySelectorAll('#atomPanel .individual-atom-row')];
    return {
      flag: general.linkPeriodicCopies,
      rows: rows.length,
      atoms: fileBrowser.selectedStructure.atoms.length,
      withImageIndex: rows.filter((r) => /** @type {HTMLElement} */ (r).dataset.imageIndex != null).length,
      editedStillRed: groups.atomsMesh.instanceColor.getX(img1) === 1
        && groups.atomsMesh.instanceColor.getY(img1) === 0,
    };
  }, { img1: colored.img1 });
  H.check('toggling back on restores source-atom rows; the per-copy override still shows',
    relinked.flag === true && relinked.rows === relinked.atoms
      && relinked.withImageIndex === 0 && relinked.editedStillRed,
    JSON.stringify(relinked));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
