// Session persistence of the style stores: bondUserStyles, bondCategoryStyles,
// polyhedraUserStyles, polyhedraCategoryStyles (incl. edge fields) round-trip
// through captureState -> applySharedState and render on the restored structure.
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

  // --- Style everything, capture, and verify the capture --------------------------
  const captured = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { bondKey } = await import('./render/index.js');
    const { captureState } = await import('./ui/ShareModule.js');
    const s = fileBrowser.selectedStructure;
    const bond = s.bonds.find((b) => b.instanceIds);
    const bKey = bondKey(bond.indices);
    const pair = bond.elements[0] < bond.elements[1]
      ? `${bond.elements[0]}-${bond.elements[1]}` : `${bond.elements[1]}-${bond.elements[0]}`;
    const poly = s.polyhedra.polyhedra[0];
    s.bondUserStyles[bKey] = { elements: [...bond.elements], color: '#ff0000', alpha: 0.4 };
    s.bondCategoryStyles[pair] = { radiusScale: 2 };
    s.polyhedraUserStyles[poly.key] = { color: '#00ff00' };
    s.polyhedraCategoryStyles[poly.catKey] = { alpha: 0.3, edgeColor: '#0000ff', edgeAlpha: 0.9 };
    const state = captureState();
    return {
      bKey, pair, polyKey: poly.key, catKey: poly.catKey,
      version: state.version,
      hasAll: !!(state.colors.bondUserStyles && state.colors.bondCategoryStyles
        && state.colors.polyhedraUserStyles && state.colors.polyhedraCategoryStyles),
      state,
    };
  });
  H.check('captureState v2.4 includes all four style-store blocks',
    captured.version === '2.4' && captured.hasAll,
    JSON.stringify({ version: captured.version, hasAll: captured.hasAll }));

  // --- Round-trip: apply the captured state (fresh structure) ---------------------
  const restored = await page.evaluate(async ({ state, bKey, pair, polyKey, catKey }) => {
    const { fileBrowser, groups, general } = await import('./state/store.js');
    const { applySharedState } = await import('./ui/ShareModule.js');
    const before = general.polyhedraBuildCounter;
    applySharedState(state, 'roundtrip.vasp');
    // Wait for the post-restore polyhedra recompute to land.
    for (let i = 0; i < 150 && general.polyhedraBuildCounter === before; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
    const s = fileBrowser.selectedStructure;
    const bond = s.bonds.find((b) => b.instanceIds
      && (b.indices[0] <= b.indices[1] ? `${b.indices[0]}_${b.indices[1]}` : `${b.indices[1]}_${b.indices[0]}`) === bKey);
    const attrs = groups.bondsMesh.geometry.attributes;
    const polyMesh = groups.polyhedraGroup.children.find((m) => m.userData?.key === polyKey);
    const edge = polyMesh?.children.find((c) => c.userData?.type === 'polyhedron-edges');
    return {
      stores: {
        bondUser: s.bondUserStyles[bKey],
        bondCat: s.bondCategoryStyles[pair],
        polyUser: s.polyhedraUserStyles[polyKey],
        polyCat: s.polyhedraCategoryStyles[catKey],
      },
      bondColor: bond?.color?.[0],
      bondOpacity: bond ? attrs.instanceOpacity.getX(bond.instanceIds[0]) : null,
      polyFace: polyMesh?.material.color.getHexString(),
      polyFaceOpacity: polyMesh?.material.opacity,
      polyEdge: edge?.material.color.getHexString(),
      polyEdgeOpacity: edge?.material.opacity,
    };
  }, { state: captured.state, bKey: captured.bKey, pair: captured.pair, polyKey: captured.polyKey, catKey: captured.catKey });
  H.check('all four stores restored onto the fresh structure',
    restored.stores.bondUser?.color === '#ff0000'
      && restored.stores.bondCat?.radiusScale === 2
      && restored.stores.polyUser?.color === '#00ff00'
      && restored.stores.polyCat?.edgeColor === '#0000ff',
    JSON.stringify(restored.stores));
  H.check('restored styles actually render (bond color/alpha, poly face + edge materials)',
    restored.bondColor === '#ff0000'
      && Math.abs(restored.bondOpacity - 0.4) < 1e-6
      && restored.polyFace === '00ff00'
      && Math.abs(restored.polyFaceOpacity - 0.3) < 1e-6
      && restored.polyEdge === '0000ff'
      && Math.abs(restored.polyEdgeOpacity - 0.9) < 1e-6,
    JSON.stringify(restored));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
