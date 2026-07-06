// Polyhedra edge styling: edgeColor/edgeAlpha in the category and individual
// style stores, resolved individual > category > default, applied to per-poly
// edge materials and surviving rebuilds.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    return (groups.polyhedraGroup?.children?.length ?? 0) > 0;
  });

  // --- Category edge style applies to members only, in place ---------------------
  const catEdge = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updatePolyhedraColors } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const meshes = () => groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const edgeOf = (m) => m.children.find((c) => c.userData?.type === 'polyhedron-edges');
    const catKey = meshes()[0].userData.catKey;
    s.polyhedraCategoryStyles[catKey] = { edgeColor: '#ff0000', edgeAlpha: 0.9 };
    updatePolyhedraColors();
    const members = meshes().filter((m) => m.userData.catKey === catKey);
    const others = meshes().filter((m) => m.userData.catKey !== catKey);
    return {
      catKey,
      memberEdges: members.map((m) => [edgeOf(m).material.color.getHexString(), edgeOf(m).material.opacity]),
      otherEdges: others.map((m) => [edgeOf(m).material.color.getHexString(), edgeOf(m).material.opacity]),
    };
  });
  H.check('category edgeColor/edgeAlpha restyle member edge materials in place',
    catEdge.memberEdges.length > 0
      && catEdge.memberEdges.every(([c, o]) => c === 'ff0000' && Math.abs(o - 0.9) < 1e-6),
    JSON.stringify(catEdge.memberEdges));
  H.check('non-member edges keep the default edge style (006c99 / 0.85)',
    catEdge.otherEdges.every(([c, o]) => c === '006c99' && Math.abs(o - 0.85) < 1e-6),
    JSON.stringify(catEdge.otherEdges));

  // --- Individual override wins; both survive an async rebuild --------------------
  const survived = await page.evaluate(async ({ catKey }) => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { updatePolyhedraColors } = await import('./render/index.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const s = fileBrowser.selectedStructure;
    const meshes = () => groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const edgeOf = (m) => m.children.find((c) => c.userData?.type === 'polyhedron-edges');
    const members = meshes().filter((m) => m.userData.catKey === catKey);
    const targetKey = members[0].userData.key;
    s.polyhedraUserStyles[targetKey] = { edgeColor: '#00ff00' };
    updatePolyhedraColors();
    const before = general.polyhedraBuildCounter;
    updateVisualization({ reRenderOther: false, reRenderComposition: false });
    for (let i = 0; i < 100 && general.polyhedraBuildCounter === before; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const rebuilt = meshes().filter((m) => m.userData.catKey === catKey);
    const target = rebuilt.find((m) => m.userData.key === targetKey);
    const sibling = rebuilt.find((m) => m.userData.key !== targetKey);
    return {
      targetEdge: edgeOf(target).material.color.getHexString(),
      siblingEdge: sibling ? edgeOf(sibling).material.color.getHexString() : 'ff0000',
    };
  }, { catKey: catEdge.catKey });
  H.check('individual edgeColor wins over category and survives a rebuild',
    survived.targetEdge === '00ff00' && survived.siblingEdge === 'ff0000',
    JSON.stringify(survived));

  // --- Editors expose the Edge controls -------------------------------------------
  const editorUi = await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    document.querySelector('#atomBondControlSwitch button[data-mode="polyhedra"]').click();
    const control = document.querySelector('#infoPolyControls .poly-control');
    /** @type {HTMLElement} */ (control.querySelector('.dot')).click();
    const catEditor = /** @type {HTMLElement} */ (control.querySelector('.poly-cat-editor'));
    document.querySelectorAll('#infoPolyControls .poly-expand-icon')
      .forEach((icon) => /** @type {HTMLElement} */ (icon).click());
    const row = document.querySelector('#infoPolyControls .individual-polyhedron-row');
    /** @type {HTMLElement} */ (row.querySelector('button[data-editor-button="color"]')).click();
    const rowEditor = /** @type {HTMLElement} */ (row.querySelector('.poly-color-editor'));
    const pickers = (el) => (el.textContent.match(/HEX:/g) || []).length;
    return {
      catVisible: catEditor.style.display !== 'none',
      catPickers: pickers(catEditor),
      catHasEdgeAlpha: catEditor.textContent.includes('Edge alpha'),
      rowPickers: pickers(rowEditor),
      rowHasEdgeAlpha: rowEditor.textContent.includes('Edge alpha'),
    };
  });
  H.check('category and individual editors both expose face + edge pickers and Edge alpha',
    editorUi.catVisible && editorUi.catPickers === 2 && editorUi.catHasEdgeAlpha
      && editorUi.rowPickers === 2 && editorUi.rowHasEdgeAlpha,
    JSON.stringify(editorUi));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
