// The Atoms-tab Reset buttons: "Reset Colors" clears every color customization
// (all levels) while keeping alpha/size/visibility; "Reset Styling" (historic
// id resetAtomsBtn) clears everything the tabs can set — never positions, and
// never the Bonds tab's own bondLengths/bondVisibility settings.
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

  // --- Apply a mixed set of styling ------------------------------------------------
  const setup = await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    const { bondKey } = await import('./render/index.js');
    setStructurePanelOpen(true);
    const s = fileBrowser.selectedStructure;
    s.atoms[0].userColor = '#123456';
    s.atoms[0].color = '#123456';
    s.atoms[1].setOpacity(0.5);
    s.atoms[1].setRadiusScale(2);
    s.atoms[2].setCutPlaneImmune(true);
    const bond = s.bonds.find((b) => b.instanceIds);
    const bKey = bondKey(bond.indices);
    const pair = bond.elements[0] < bond.elements[1]
      ? `${bond.elements[0]}-${bond.elements[1]}` : `${bond.elements[1]}-${bond.elements[0]}`;
    s.bondUserStyles[bKey] = { elements: [...bond.elements], color: '#ff0000', alpha: 0.4 };
    const poly = s.polyhedra.polyhedra[0];
    s.polyhedraCategoryStyles[poly.catKey] = { color: '#00ff00', edgeColor: '#0000ff', alpha: 0.3 };
    general.atomVisibility[s.elements[0]] = false;
    general.bondCutImmunity[pair] = true;
    const bondLengthsSnapshot = JSON.stringify(general.bondLengths);
    return { bKey, pair, catKey: poly.catKey, el0: s.elements[0], bondLengthsSnapshot };
  });

  // --- Reset Colors: colors gone, everything else kept -----------------------------
  await H.clickById(page, 'resetAllColorsBtn');
  await page.waitForTimeout(1500);
  const afterColors = await page.evaluate(async ({ bKey, catKey, el0 }) => {
    const { fileBrowser, general } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return {
      atom0Color: s.atoms[0].color,
      atom0UserColor: s.atoms[0].userColor,
      defaultColor: s.getDefaultElementColor(s.elements[0]),
      bondEntry: s.bondUserStyles[bKey] ?? null,
      polyCatEntry: s.polyhedraCategoryStyles[catKey] ?? null,
      atom1Opacity: s.atoms[1].getOpacity(),
      atom1Scale: s.atoms[1].getRadiusScale(),
      visibilityKept: general.atomVisibility[el0] === false,
    };
  }, { bKey: setup.bKey, catKey: setup.catKey, el0: setup.el0 });
  H.check('Reset Colors: atom colors back to defaults, store color fields gone, alpha/size kept',
    afterColors.atom0Color === afterColors.defaultColor
      && afterColors.atom0UserColor == null
      && afterColors.bondEntry?.color == null && afterColors.bondEntry?.alpha === 0.4
      && afterColors.polyCatEntry?.color == null && afterColors.polyCatEntry?.edgeColor == null
      && afterColors.polyCatEntry?.alpha === 0.3
      && afterColors.atom1Opacity === 0.5 && afterColors.atom1Scale === 2
      && afterColors.visibilityKept,
    JSON.stringify(afterColors));

  // --- Reset Styling: everything cleared, bond lengths untouched -------------------
  const label = await page.evaluate(() => document.getElementById('resetAtomsBtn')?.textContent);
  H.check('resetAtomsBtn is relabeled "Reset Styling" (id unchanged)', label === 'Reset Styling', label);

  await H.clickById(page, 'resetAtomsBtn');
  await page.waitForTimeout(1500);
  const afterAll = await page.evaluate(async ({ bondLengthsSnapshot }) => {
    const { fileBrowser, general } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const storesEmpty = ['atomImageStyles', 'bondUserStyles', 'bondCategoryStyles',
      'polyhedraUserStyles', 'polyhedraCategoryStyles']
      .every((k) => Object.keys(s[k] ?? {}).length === 0);
    return {
      storesEmpty,
      atom1Opacity: s.atoms[1].getOpacity(),
      atom1Scale: s.atoms[1].getRadiusScale(),
      atom2Immune: !!s.atoms[2].cutPlaneImmune,
      atomVisibilityEmpty: Object.keys(general.atomVisibility).length === 0,
      bondCutImmunityEmpty: Object.keys(general.bondCutImmunity).length === 0,
      bondLengthsUntouched: JSON.stringify(general.bondLengths) === bondLengthsSnapshot,
    };
  }, { bondLengthsSnapshot: setup.bondLengthsSnapshot });
  H.check('Reset Styling: all stores empty, alpha/size/immunity/visibility reset, bond lengths kept',
    afterAll.storesEmpty
      && afterAll.atom1Opacity === 1 && afterAll.atom1Scale === 1
      && afterAll.atom2Immune === false
      && afterAll.atomVisibilityEmpty && afterAll.bondCutImmunityEmpty
      && afterAll.bondLengthsUntouched,
    JSON.stringify(afterAll));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
