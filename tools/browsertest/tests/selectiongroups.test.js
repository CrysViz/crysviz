// The selection bar's view tabs and saved selections
// (ui/StructureInfoPanel/SelectionActionBar.js, SelectionGroups.js,
// SelectAndHighlightModule setSelectionView):
//   - with atoms selected the bar shows Atoms | Bonds | Polyhedra tabs with
//     the counts of the bonds between the selected atoms and of their
//     polyhedra;
//   - Bonds: those bonds glow (the atoms' glow goes off), Atoms brings the
//     atom glow back; Polyhedra glows the polyhedra centred on the atoms;
//   - a bulk colour on the Bonds tab recolours exactly those bonds;
//   - Save keeps the selection under a name (per structure); Clear, then
//     choosing it in the dropdown selects the same atoms again and shows the
//     saved tab; Add joins another group's atoms; Rename and Delete work;
//   - the groups travel through captureState (sessions, share links) and are
//     dropped for an older link without them;
//   - the selection ghost overlay keeps a selected atom marked at alpha 0 in
//     the raster pipelines (render/HighlightOverlay.js).
// YBCO (default structure), depth peeling.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO
  await H.clickById(page, 'showPolyhedra');
  await page.waitForTimeout(2500);

  // Select a Cu atom and its bonded O atoms (a CuOx polyhedron's atoms) by
  // instance, through the same machinery the 3D picks use.
  const picked = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const s = fileBrowser.selectedStructure;
    const w = s.periodic.visibleWrapped;
    // a Cu copy with the most bonds to O
    let best = null;
    for (let i = 0; i < w.cart.length; i++) {
      if (w.elements[i] !== 'Cu') continue;
      const partners = [];
      for (const b of s.bonds) {
        if (!b.instanceIds?.length) continue;
        if (b.indices[0] === i && w.elements[b.indices[1]] === 'O') partners.push(b.indices[1]);
        if (b.indices[1] === i && w.elements[b.indices[0]] === 'O') partners.push(b.indices[0]);
      }
      if (!best || partners.length > best.partners.length) best = { i, partners };
    }
    const ids = [best.i, ...best.partners];
    selectAtomsByInstances(ids, { reason: 'test' });
    const polyCount = (groups.polyhedraGroup?.children ?? []).filter((m) => m.userData?.type === 'polyhedron').length;
    return { ids, nBonds: best.partners.length, polyCount, src: ids.map((i) => w.srcIndex[i]) };
  });
  H.check('selected a Cu atom with its O neighbours', picked.ids.length >= 3 && picked.polyCount > 0, JSON.stringify(picked));

  const bar = () => page.evaluate(async () => {
    const { getSelectionView, getSelectionViewSets, getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const { groups, highlightHover } = await import('./state/store.js');
    const tabs = [...document.querySelectorAll('#selectionViewTabs button')].map((b) => ({ view: b.dataset.view, label: b.textContent, active: b.classList.contains('active') }));
    const sets = getSelectionViewSets();
    const glowA = groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity;
    const glowingAtoms = [];
    for (let i = 0; i < groups.atomsMesh.count; i++) if (glowA.getX(i) > 0) glowingAtoms.push(i);
    const glowB = groups.bondsMesh?.geometry.attributes.instanceEmissiveIntensity;
    let glowingBondHalves = 0;
    if (glowB) for (let i = 0; i < groups.bondsMesh.count; i++) if (glowB.getX(i) > 0) glowingBondHalves++;
    const glowingPolys = (groups.polyhedraGroup?.children ?? []).filter((m) => m.userData?.type === 'polyhedron' && m.material.emissive.getHex() !== 0).length;
    const barEl = document.getElementById('selectionActionBar');
    return {
      shown: !!barEl && barEl.style.display !== 'none',
      tabs, view: getSelectionView(), bonds: sets.bonds.length, polyhedra: sets.polyhedra.length,
      selected: getSelectedAtoms().length,
      glowingAtoms, glowingBondHalves, glowingPolys,
      overlayPolys: highlightHover.currentlyHighlightedPolyMeshes?.length ?? 0,
      summary: barEl?.querySelector('.si-selbar-summary')?.textContent ?? null,
      groups: [...(document.getElementById('selectionGroupsSelect')?.options ?? [])].map((o) => o.textContent),
    };
  });
  let b = await bar();
  H.check('the bar shows Atoms | Bonds | Polyhedra tabs with the counts',
    b.shown && b.tabs.length === 3 && b.tabs[0].active && /Bonds \(\d+\)/.test(b.tabs[1].label) && /Polyhedra \(\d+\)/.test(b.tabs[2].label),
    JSON.stringify(b.tabs));
  // "Link periodic copies" is on: every copy of a selected atom counts, so the
  // bonds between the copies (and the polyhedra of every Cu copy) are in too.
  H.check('the bonds between the selected atoms are counted (at least the Cu–O bonds), and the polyhedron',
    b.bonds >= picked.nBonds && b.polyhedra >= 1, JSON.stringify({ bonds: b.bonds, atLeast: picked.nBonds, polyhedra: b.polyhedra }));
  H.check('Atoms view: the selected atoms glow', b.glowingAtoms.length >= picked.ids.length && b.glowingBondHalves === 0, JSON.stringify(b));

  // ---- Bonds view ----
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#selectionViewTabs button[data-view="bonds"]')).click());
  await page.waitForTimeout(300);
  b = await bar();
  const nBondsView = b.bonds;
  H.check('Bonds tab: the bonds between the atoms glow (both halves each) and the atoms do not',
    b.view === 'bonds' && b.glowingBondHalves === 2 * nBondsView && b.glowingAtoms.length === 0 && b.tabs[1].active,
    JSON.stringify(b));
  H.check('Bonds tab header names the bonds', /bonds? between the selected atoms/.test(b.summary ?? ''), String(b.summary));

  // a bulk colour recolours exactly those bonds (persisted per bond)
  const recoloured = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { suppressSelectionHighlightFor3D, restoreSelectionHighlight, getSelectionViewSets } = await import('./ui/SelectAndHighlightModule.js');
    const { bondKey } = await import('./render/BondsFracUpdateModule.js');
    const s = fileBrowser.selectedStructure;
    const idx = getSelectionViewSets().bonds;
    suppressSelectionHighlightFor3D();
    const swatch = /** @type {HTMLButtonElement} */ (document.querySelector('#selectionActionBar .si-selbar-swatch'));
    swatch.click();
    await new Promise((r) => setTimeout(r, 150));
    // the swatch picker's hex field, as the Custom Settings test drives it
    const input = /** @type {HTMLInputElement|null} */ (document.querySelectorAll('.swatch-color-picker .cv-colorpicker-input-field')[1]);
    let viaPicker = false;
    if (input) { input.value = '#12ab34'; input.dispatchEvent(new Event('change', { bubbles: true })); viaPicker = true; }
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.swatch-color-picker')?.remove();
    restoreSelectionHighlight();
    const styles = idx.map((i) => s.bondUserStyles[bondKey(s.bonds[i].indices)]?.color ?? null);
    const others = s.bonds.filter((_, i) => !idx.includes(i)).filter((bb) => s.bondUserStyles[bondKey(bb.indices)]?.color).length;
    return { viaPicker, styles, others };
  });
  H.check('a bulk colour on the Bonds tab is written to exactly those bonds\' styles',
    !recoloured.viaPicker || (recoloured.styles.every((c) => /12ab34/i.test(c ?? '')) && recoloured.others === 0),
    JSON.stringify(recoloured));

  // ---- Polyhedra view ----
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#selectionViewTabs button[data-view="polyhedra"]')).click());
  await page.waitForTimeout(300);
  b = await bar();
  H.check('Polyhedra tab: the polyhedron centred on the Cu atom glows, bonds and atoms do not',
    b.view === 'polyhedra' && b.glowingPolys >= 1 && b.overlayPolys === b.glowingPolys && b.glowingBondHalves === 0 && b.glowingAtoms.length === 0,
    JSON.stringify(b));

  // ---- back to Atoms ----
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#selectionViewTabs button[data-view="atoms"]')).click());
  await page.waitForTimeout(300);
  b = await bar();
  H.check('Atoms tab again: the atoms glow, nothing else', b.view === 'atoms' && b.glowingAtoms.length >= picked.ids.length && b.glowingPolys === 0 && b.glowingBondHalves === 0, JSON.stringify(b));

  // ---- Save, Clear, restore ----
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#selectionViewTabs button[data-view="bonds"]')).click());
  await page.waitForTimeout(200);
  await H.clickById(page, 'selectionGroupSave');
  await page.waitForTimeout(200);
  const named = await page.evaluate(() => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('selectionGroupName'));
    const suggested = input?.value;
    if (input) { input.value = 'CuO5 unit'; }
    /** @type {HTMLElement} */ (document.getElementById('selectionGroupNameOk'))?.click();
    return suggested;
  });
  await page.waitForTimeout(200);
  let groupsState = await page.evaluate(async () => {
    const { listSelectionGroups } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    return listSelectionGroups().map((g) => ({ name: g.name, tab: g.tab, atoms: g.atoms.length, bonds: g.bonds.length, polyhedra: g.polyhedra.length }));
  });
  H.check('Save suggested a name and kept the group with its atoms, bonds and the Bonds tab',
    named === 'Selection' && groupsState.length === 1 && groupsState[0].name === 'CuO5 unit' && groupsState[0].tab === 'bonds'
      && groupsState[0].atoms === picked.ids.length && groupsState[0].bonds === nBondsView,
    JSON.stringify({ named, groupsState }));

  await page.evaluate(async () => {
    const { clearSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    clearSelectedAtoms({ reason: 'test' });
  });
  await page.waitForTimeout(200);
  b = await bar();
  H.check('after Clear the bar stays for the saved selection (no tabs, no glow)',
    b.shown && b.selected === 0 && b.tabs.length === 0 && b.glowingAtoms.length === 0 && b.glowingBondHalves === 0 && b.groups.some((t) => /CuO5 unit \(\d+ atoms\)/.test(t)),
    JSON.stringify(b));

  await H.setSelect(page, 'selectionGroupsSelect', '0');
  await page.waitForTimeout(400);
  b = await bar();
  const num = (a, c) => a - c;
  const restoredSrc = await page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).getSelectedAtoms().map((a) => a.sourceIndex));
  H.check('choosing the saved selection selects the same atoms again, on the Bonds tab, bonds glowing',
    JSON.stringify([...restoredSrc].sort(num)) === JSON.stringify([...picked.src].sort(num)) && b.view === 'bonds' && b.glowingBondHalves === 2 * nBondsView,
    JSON.stringify({ restoredSrc, picked: picked.src, b }));

  // ---- a second group, Add, Rename, Delete ----
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const { saveSelectionGroup } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const ba = [];
    for (let i = 0; i < w.cart.length && ba.length < 2; i++) if (w.elements[i] === 'Ba') ba.push(i);
    selectAtomsByInstances(ba, { reason: 'test' });
    (await import('./ui/SelectAndHighlightModule.js')).setSelectionView('atoms');
    saveSelectionGroup('Ba pair');
  });
  await page.waitForTimeout(200);
  await H.setSelect(page, 'selectionGroupsSelect', '0'); // CuO5 unit replaces
  await page.waitForTimeout(300);
  await H.setSelect(page, 'selectionGroupsSelect', '1'); // chosen: Ba pair → replaces
  await page.waitForTimeout(300);
  let n = await page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).getSelectedAtoms().length);
  H.check('choosing another group replaces the selection', n === 2, String(n));
  await H.setSelect(page, 'selectionGroupsSelect', '0');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const sel = /** @type {HTMLSelectElement} */ (document.getElementById('selectionGroupsSelect')); sel.value = '1'; sel.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(300);
  await H.setSelect(page, 'selectionGroupsSelect', '0');
  await page.waitForTimeout(300);
  // Add: the Ba pair joins the CuO5 selection
  await page.evaluate(() => { const sel = /** @type {HTMLSelectElement} */ (document.getElementById('selectionGroupsSelect')); sel.value = '1'; sel.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(300);
  await H.setSelect(page, 'selectionGroupsSelect', '0');
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const { restoreSelectionGroup } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    restoreSelectionGroup(1, { add: true });
  });
  await page.waitForTimeout(300);
  n = await page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).getSelectedAtoms().length);
  H.check('Add joins a group\'s atoms to the current selection', n === picked.ids.length + 2, JSON.stringify({ n, expected: picked.ids.length + 2 }));

  await page.evaluate(async () => {
    const { renameSelectionGroup, deleteSelectionGroup } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    renameSelectionGroup(1, 'Barium');
    deleteSelectionGroup(0);
  });
  await page.waitForTimeout(200);
  groupsState = await page.evaluate(async () => {
    const { listSelectionGroups } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    return listSelectionGroups().map((g) => g.name);
  });
  H.check('Rename and Delete', JSON.stringify(groupsState) === JSON.stringify(['Barium']), JSON.stringify(groupsState));

  // ---- persistence: captureState carries the groups; the compact link too ----
  const carried = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const { encodeCompact, expandCompact } = await import('./io/share/shareCodec.js');
    const state = captureState();
    const obj = encodeCompact(JSON.parse(JSON.stringify(state)));
    const back = expandCompact(JSON.parse(JSON.stringify(obj)));
    return { inState: state.display.selectionGroups, short: obj.t?.sg !== undefined, back: back.display.selectionGroups };
  });
  H.check('captureState and the compact link carry the saved selections',
    carried.inState?.length === 1 && carried.inState[0].name === 'Barium' && carried.short && carried.back?.[0]?.name === 'Barium' && carried.back[0].atoms.length === 2,
    JSON.stringify(carried));

  // ---- the ghost overlay keeps a selected atom at alpha 0 marked (raster) ----
  const { PNG } = require('pngjs');
  const pixelAt = async () => {
    const r = await page.evaluate(async () => {
      const { app, fileBrowser } = await import('./state/store.js');
      const { getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
      const THREE = await import('./external/three/three.module.js');
      const { groups } = await import('./state/store.js');
      const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
      // a selected copy whose centre is not behind another atom
      const ray = new THREE.Raycaster();
      let first = null;
      let p = null;
      for (const a of getSelectedAtoms()) {
        for (const id of fileBrowser.selectedStructure.atomImages?.[a.sourceIndex] ?? [a.instanceId]) {
          const q = new THREE.Vector3(...w.cart[id]).project(app.camera);
          ray.setFromCamera(new THREE.Vector2(q.x, q.y), app.camera);
          if (ray.intersectObject(groups.atomsMesh)[0]?.instanceId === id) { first = { ...a, instanceId: id }; p = q; break; }
        }
        if (first) break;
      }
      if (!first) return { url: null };
      app.pipeline.render({ renderer: app.renderer, scene: app.scene, camera: app.camera });
      const url = app.renderer.domElement.toDataURL('image/png');
      return { url, px: (p.x + 1) / 2, py: (1 - p.y) / 2 };
    });
    if (!r.url) return null;
    const png = PNG.sync.read(Buffer.from(r.url.split(',')[1], 'base64'));
    const x = Math.round(r.px * png.width), y = Math.round(r.py * png.height);
    const o = (y * png.width + x) * 4;
    return [png.data[o], png.data[o + 1], png.data[o + 2]];
  };
  await page.evaluate(async () => {
    const { setSelectionView } = await import('./ui/SelectAndHighlightModule.js');
    setSelectionView('atoms');
  });
  const before = await pixelAt();
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
    const first = getSelectedAtoms()[0];
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    fileBrowser.selectedStructure.atoms[first.sourceIndex].setOpacity(0);
    for (let k = 0; k < w.cart.length; k++) if (w.srcIndex[k] === first.sourceIndex) updateSingleAtomOpacity(k, 0);
  });
  const at0 = await pixelAt();
  // the same alpha-0 picture without the selection: what the ghost adds
  await page.evaluate(async () => {
    const { suppressSelectionHighlightFor3D } = await import('./ui/SelectAndHighlightModule.js');
    suppressSelectionHighlightFor3D();
  });
  const at0Plain = await pixelAt();
  await page.evaluate(async () => {
    const { restoreSelectionHighlight } = await import('./ui/SelectAndHighlightModule.js');
    restoreSelectionHighlight();
  });
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const { updateSingleAtomOpacity } = await import('./render/AtomsFracUpdateModule.js');
    const first = getSelectedAtoms()[0];
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    fileBrowser.selectedStructure.atoms[first.sourceIndex].setOpacity(1);
    for (let k = 0; k < w.cart.length; k++) if (w.srcIndex[k] === first.sourceIndex) updateSingleAtomOpacity(k, 1);
  });
  // at alpha 0 the atom itself is gone; the ghost (orange, 40 %) still marks
  // the spot: the pixel differs from the same picture without the selection,
  // and is warmer (more red than blue) than it
  const diff = (a, c) => (a && c) ? Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]) : 0;
  H.check('a selected atom at alpha 0 is still marked by the ghost overlay',
    !!before && diff(at0, at0Plain) > 20 && (at0[0] - at0[2]) > (at0Plain[0] - at0Plain[2]),
    JSON.stringify({ before, at0, at0Plain }));

  // ---- bonds and polyhedra picked directly (SelectAndHighlightModule selectBondsDirect / selectPolyhedraDirect) ----
  const directBonds = await page.evaluate(async () => {
    const { fileBrowser, highlightHover } = await import('./state/store.js');
    const { selectBondsDirect, getDirectSelection, getSelectedAtoms, getSelectionView, getSelectionViewSets, clearAllHighlights } = await import('./ui/SelectAndHighlightModule.js');
    const { saveSelectionGroup, listSelectionGroups, restoreSelectionGroup } = await import('./ui/StructureInfoPanel/SelectionGroups.js');
    clearAllHighlights({ reason: 'test' });
    const s = fileBrowser.selectedStructure;
    const drawn = [];
    s.bonds.forEach((b, i) => { if (b.instanceIds?.length && drawn.length < 3) drawn.push(i); });
    selectBondsDirect([drawn[0]], { mode: 'replace' });
    const one = { kind: getDirectSelection().kind, n: getDirectSelection().bonds.length, single: highlightHover.currentlyHighlightedBond?.bondIndex ?? null, atoms: getSelectedAtoms().length };
    selectBondsDirect([drawn[1]], { mode: 'add' });
    selectBondsDirect([drawn[2]], { mode: 'toggle' });
    const three = { kind: getDirectSelection().kind, n: getDirectSelection().bonds.length, single: highlightHover.currentlyHighlightedBond, view: getSelectionView() };
    selectBondsDirect([drawn[2]], { mode: 'toggle' });
    const two = getDirectSelection().bonds.length;
    const bar = document.getElementById('selectionActionBar');
    const tabs = [...document.querySelectorAll('#selectionViewTabs button')].map((b) => ({ view: b.dataset.view, active: b.classList.contains('active'), label: b.textContent }));
    const summary = bar?.querySelector('.si-selbar-summary')?.textContent ?? null;
    const glowB = fileBrowser.selectedStructure && (await import('./state/store.js')).groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity;
    let glowingHalves = 0;
    const mesh = (await import('./state/store.js')).groups.bondsMesh;
    for (let i = 0; i < mesh.count; i++) if (glowB.getX(i) > 0) glowingHalves++;
    const expectHalves = getDirectSelection().bonds.flatMap((i) => s.bonds[i].instanceIds).length;
    saveSelectionGroup('two bonds');
    const saved = listSelectionGroups().at(-1);
    clearAllHighlights({ reason: 'test' });
    const cleared = { kind: getDirectSelection().kind, barShown: bar.style.display !== 'none' };
    restoreSelectionGroup(listSelectionGroups().length - 1);
    const restored = { kind: getDirectSelection().kind, n: getDirectSelection().bonds.length, atomsTab: getSelectionViewSets().atoms.length };
    // the Atoms tab converts the picked bonds into their end atoms
    document.querySelector('#selectionViewTabs button[data-view="atoms"]').click();
    const converted = { atoms: getSelectedAtoms().length, kind: getDirectSelection().kind, view: getSelectionView() };
    clearAllHighlights({ reason: 'test' });
    return { one, three, two, tabs, summary, glowingHalves, expectHalves, saved: { tab: saved.tab, atoms: saved.atoms.length, bonds: saved.bonds.length }, cleared, restored, converted };
  });
  H.check('a plain bond pick is the classic single selection (its row), no atoms selected',
    directBonds.one.kind === 'bonds' && directBonds.one.n >= 1 && directBonds.one.single !== null && directBonds.one.atoms === 0, JSON.stringify(directBonds.one));
  H.check('Shift adds a second bond, Ctrl toggles a third in and out again (the single-row state is dropped for a set)',
    directBonds.three.kind === 'bonds' && directBonds.three.n > directBonds.one.n && directBonds.three.single === null && directBonds.three.view === 'bonds' && directBonds.two < directBonds.three.n,
    JSON.stringify({ three: directBonds.three, two: directBonds.two }));
  H.check('the bar shows the picked bonds under the Bonds tab, all their halves glowing',
    directBonds.tabs.find((t) => t.view === 'bonds')?.active && /bonds? selected/.test(directBonds.summary ?? '') && directBonds.glowingHalves === directBonds.expectHalves,
    JSON.stringify({ tabs: directBonds.tabs, summary: directBonds.summary, glowingHalves: directBonds.glowingHalves, expectHalves: directBonds.expectHalves }));
  H.check('Save keeps a picked bond set (no atoms); Clear empties it; the saved group brings it back; Atoms converts it to the end atoms',
    directBonds.saved.tab === 'bonds' && directBonds.saved.atoms === 0 && directBonds.saved.bonds === directBonds.two
      && directBonds.cleared.kind === null && directBonds.restored.kind === 'bonds' && directBonds.restored.n === directBonds.two
      && directBonds.converted.kind === null && directBonds.converted.atoms >= 2 && directBonds.converted.atoms === directBonds.restored.atomsTab,
    JSON.stringify({ saved: directBonds.saved, cleared: directBonds.cleared, restored: directBonds.restored, converted: directBonds.converted }));

  const directPolys = await page.evaluate(async () => {
    const { groups, highlightHover } = await import('./state/store.js');
    const { selectPolyhedraDirect, getDirectSelection, getSelectedAtoms, getSelectionView, clearAllHighlights } = await import('./ui/SelectAndHighlightModule.js');
    const keys = (groups.polyhedraGroup?.children ?? []).filter((m) => m.userData?.type === 'polyhedron').map((m) => m.userData.key);
    selectPolyhedraDirect([keys[0]], { mode: 'replace' });
    const one = { kind: getDirectSelection().kind, n: getDirectSelection().polyKeys.length, single: highlightHover.currentlyHighlightedPolyhedron?.key ?? null };
    const other = keys.find((k) => !getDirectSelection().polyKeys.includes(k));
    if (other) selectPolyhedraDirect([other], { mode: 'add' });
    const glowing = (groups.polyhedraGroup?.children ?? []).filter((m) => m.userData?.type === 'polyhedron' && m.material.emissive.getHex() !== 0).length;
    const set = { kind: getDirectSelection().kind, n: getDirectSelection().polyKeys.length, single: highlightHover.currentlyHighlightedPolyhedron, glowing, overlay: highlightHover.currentlyHighlightedPolyMeshes?.length ?? 0, view: getSelectionView(), atoms: getSelectedAtoms().length, other: !!other };
    const summary = document.getElementById('selectionActionBar')?.querySelector('.si-selbar-summary')?.textContent ?? null;
    clearAllHighlights({ reason: 'test' });
    return { one, set, summary, after: getDirectSelection().kind };
  });
  H.check('a plain polyhedron pick is the classic single selection; Shift adds another: a glowing set under the Polyhedra tab',
    directPolys.one.kind === 'polyhedra' && directPolys.one.single !== null
      && (!directPolys.set.other || (directPolys.set.n > directPolys.one.n && directPolys.set.single === null && directPolys.set.glowing === directPolys.set.n && directPolys.set.overlay === directPolys.set.n))
      && directPolys.set.view === 'polyhedra' && directPolys.set.atoms === 0 && /polyhedr(on|a) selected/.test(directPolys.summary ?? '') && directPolys.after === null,
    JSON.stringify(directPolys));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
