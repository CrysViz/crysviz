// Picking what the user can see (render/pickVisible.js, ui/SceneInteraction.js).
// A raycast used to pick any atom under the cursor — at alpha 0, inside an
// opaque polyhedron, behind a bond — and an atom anywhere along the ray beat a
// bond in front of it. Now the nearest VISIBLE object wins:
//   - a double-click on an atom at alpha 0 does not select it;
//   - a double-click where a bond is nearer than the atom behind it selects
//     the bond;
//   - with polyhedra at alpha 1, a double-click on a face whose centre atom is
//     behind it selects the polyhedron; at alpha 0.5 the atom behind the face
//     is selected (see-through faces are only a fallback);
//   - the measure tools skip an alpha-0 atom too.
// YBCO (default structure), depth peeling.
'use strict';
const H = require('../harness');

// In-page geometry helpers: every candidate's screen point with the raw
// raycast order there, so the test can choose points with a known layout.
const PROBE = `
  const THREE = await import('./external/three/three.module.js');
  const { app, groups, fileBrowser } = await import('./state/store.js');
  const rect = app.renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  const toScreen = (v) => {
    const p = v.clone().project(app.camera);
    return { nx: p.x, ny: p.y, x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
  };
  const castAt = (nx, ny) => {
    ray.setFromCamera(new THREE.Vector2(nx, ny), app.camera);
    const atom = groups.atomsMesh ? ray.intersectObject(groups.atomsMesh)[0] : null;
    const bond = groups.bondsMesh ? ray.intersectObject(groups.bondsMesh)[0] : null;
    // all polyhedra are one mesh: hits carry polyIndex, a row of its table
    const table = groups.polyhedraGroup?.userData?.polyTable;
    const polys = table
      ? ray.intersectObjects(groups.polyhedraGroup.children, false).filter((h) => Number.isInteger(h.polyIndex)) : [];
    return { atom: atom ? { i: atom.instanceId, d: atom.distance } : null,
      bond: bond ? { i: bond.instanceId, d: bond.distance } : null,
      poly: polys[0] ? { key: table.key[polys[0].polyIndex], d: polys[0].distance, centre: table.centerIndex[polys[0].polyIndex] } : null };
  };
  const onCanvas = (pt) => Math.abs(pt.nx) < 0.9 && Math.abs(pt.ny) < 0.9
    && document.elementFromPoint(pt.x, pt.y) === app.renderer.domElement;
`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.zoom = 1; // the default fit
  });

  const state = () => page.evaluate(async () => {
    const { atomSelection, highlightHover } = await import('./state/store.js');
    return {
      atoms: atomSelection.selectedAtoms.map((a) => a.sourceIndex),
      bond: highlightHover.currentlyHighlightedBond?.bondIndex ?? null,
      poly: highlightHover.currentlyHighlightedPolyhedron?.key ?? null,
    };
  });
  const clearAll = () => page.evaluate(async () => {
    const { clearAllHighlights } = await import('./ui/SelectAndHighlightModule.js');
    clearAllHighlights({ reason: 'test' });
  });

  // ---- 1. an atom at alpha 0 is not picked ----
  const target = await page.evaluate(`(async () => { ${PROBE}
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    for (let i = 0; i < w.cart.length; i++) {
      const pt = toScreen(new THREE.Vector3(...w.cart[i]));
      if (!onCanvas(pt)) continue;
      const c = castAt(pt.nx, pt.ny);
      if (c.atom?.i === i && (!c.bond || c.bond.d > c.atom.d)) return { i, src: w.srcIndex[i], x: pt.x, y: pt.y, behind: c };
    }
    return null;
  })()`);
  H.check('found an atom whose centre is the nearest thing under the cursor', !!target, JSON.stringify(target));
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(300);
  let s = await state();
  H.check('visible: the double-click selects that atom', s.atoms.length === 1 && s.atoms[0] === target.src, JSON.stringify(s));
  await clearAll();
  await page.evaluate(async (i) => {
    const { fileBrowser } = await import('./state/store.js');
    const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const src = w.srcIndex[i];
    fileBrowser.selectedStructure.atoms[src].setOpacity(0);
    for (let k = 0; k < w.cart.length; k++) if (w.srcIndex[k] === src) updateSingleAtomOpacity(k, 0);
  }, target.i);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(300);
  s = await state();
  H.check('at alpha 0 the same double-click does not select that atom', !s.atoms.includes(target.src), JSON.stringify(s));
  await clearAll();

  // the measure tool skips it too
  await page.evaluate(async () => { (await import('./state/store.js')).mode.measureMode = 'distance'; });
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);
  const measured = await page.evaluate(async () => (await import('./state/store.js')).measurements.selectedAtoms.map((a) => a.userData.atomIndex));
  H.check('a measure click on the alpha-0 atom picks nothing of it', !measured.includes(target.src), JSON.stringify(measured));
  await page.evaluate(async () => {
    const { mode, measurements } = await import('./state/store.js');
    mode.measureMode = 'none';
    measurements.selectedAtoms = [];
  });
  await page.evaluate(async (i) => { // alpha back
    const { fileBrowser } = await import('./state/store.js');
    const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const src = w.srcIndex[i];
    fileBrowser.selectedStructure.atoms[src].setOpacity(1);
    for (let k = 0; k < w.cart.length; k++) if (w.srcIndex[k] === src) updateSingleAtomOpacity(k, 1);
  }, target.i);

  // ---- 2. a bond in front of an atom wins ----
  const bondPt = await page.evaluate(`(async () => { ${PROBE}
    const m = groups.bondsMesh;
    if (!m) return null;
    const mat = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, mat);
      const e = mat.elements;
      if (e[0] === 0 && e[5] === 0) continue;
      // a few points along the half's axis
      for (const f of [-0.3, -0.15, 0, 0.15, 0.3]) {
        v.set(0, f, 0).applyMatrix4(mat);
        const pt = toScreen(v);
        if (!onCanvas(pt)) continue;
        const c = castAt(pt.nx, pt.ny);
        if (c.bond && c.atom && c.bond.d < c.atom.d - 0.05) return { i, x: pt.x, y: pt.y, cast: c };
      }
    }
    return null;
  })()`);
  H.check('found a point where a bond is in front of an atom', !!bondPt, JSON.stringify(bondPt));
  if (bondPt) {
    await page.mouse.dblclick(bondPt.x, bondPt.y);
    await page.waitForTimeout(400);
    s = await state();
    H.check('the double-click there selects the bond, not the atom behind it', s.bond !== null && s.atoms.length === 0, JSON.stringify(s));
    await clearAll();
  }

  // ---- 3. opaque polyhedra occlude their centre atom; see-through ones do not ----
  await H.clickById(page, 'showPolyhedra');
  await page.waitForTimeout(2500);
  const setPolyAlpha = (alpha) => page.evaluate(async (alpha) => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const { updatePolyhedraColors } = await import('./render/PolyhedraModule.js');
    const s = fileBrowser.selectedStructure;
    s.polyhedraCategoryStyles ??= {};
    const table = groups.polyhedraGroup?.userData?.polyTable;
    for (const catKey of new Set(table?.catKey ?? [])) {
      if (!catKey) continue;
      s.polyhedraCategoryStyles[catKey] = { ...(s.polyhedraCategoryStyles[catKey] ?? {}), alpha };
    }
    updatePolyhedraColors();
    return table ? [...Array(table.n).keys()].filter((i) => table.faceCount[i]).map((i) => table.opacity[i]) : [];
  }, alpha);
  const opaqueAlphas = await setPolyAlpha(1);
  H.check('polyhedra set to alpha 1', opaqueAlphas.length > 0 && opaqueAlphas.every((a) => a === 1), JSON.stringify(opaqueAlphas));
  await page.waitForTimeout(300);
  const facePt = await page.evaluate(`(async () => { ${PROBE}
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const centre = new THREE.Vector3();
    const table = groups.polyhedraGroup?.userData?.polyTable;
    for (let i = 0; table && i < table.n; i++) {
      if (!table.faceCount[i] || !table.visible[i]) continue;
      centre.set(table.center[3 * i], table.center[3 * i + 1], table.center[3 * i + 2]);
      // points around the projected centre: a face in front of an atom (the centre atom)
      const c0 = toScreen(centre);
      for (const [dx, dy] of [[0, 0], [0.01, 0.01], [-0.01, 0.01], [0.01, -0.01], [-0.01, -0.01], [0.02, 0], [0, 0.02]]) {
        const pt = { nx: c0.nx + dx, ny: c0.ny + dy };
        pt.x = rect.left + (pt.nx + 1) / 2 * rect.width; pt.y = rect.top + (1 - pt.ny) / 2 * rect.height;
        if (!onCanvas(pt)) continue;
        const c = castAt(pt.nx, pt.ny);
        if (c.poly && c.atom && c.poly.d < c.atom.d - 0.05 && (!c.bond || c.poly.d < c.bond.d - 0.05)) {
          return { key: table.key[i], x: pt.x, y: pt.y, atomSrc: w.srcIndex[c.atom.i], cast: c };
        }
      }
    }
    return null;
  })()`);
  H.check('found a polyhedron face with an atom behind it', !!facePt, JSON.stringify(facePt));
  if (facePt) {
    await page.mouse.dblclick(facePt.x, facePt.y);
    await page.waitForTimeout(400);
    s = await state();
    H.check('alpha 1: the double-click selects the polyhedron, not the atom inside', s.poly !== null && s.atoms.length === 0, JSON.stringify(s));
    await clearAll();
    await setPolyAlpha(0.5);
    await page.waitForTimeout(300);
    await page.mouse.dblclick(facePt.x, facePt.y);
    await page.waitForTimeout(400);
    s = await state();
    H.check('alpha 0.5: the same double-click selects the atom seen through the face',
      s.atoms.length === 1 && s.atoms[0] === facePt.atomSrc && s.poly === null, JSON.stringify(s));
    await clearAll();
  }

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
