// Bugs listed in the manual repository's question file (.question/
// improvements.md on CrysViz_Manual_Draft, "app issues seen while retaking
// the walkthroughs"), one check each, fixed on claude/manual-bug-list-fixes.
//
//   1. Shortcuts work while a checkbox has focus (only text-like inputs keep
//      the keys for themselves).
//   2. Opening a window by its shortcut, or switching the Wyckoff editor on,
//      does not scroll the page (the left column was 22px taller than the
//      screen).
//   3. ≡ ▸ Default on a side-docked window whose home is the main dock leaves
//      no empty side dock with a stale tab.
//   4. A long press on Restore switches to Restore mode (highlighted) as well
//      as offering Restore All.
//   5. Switching the Wyckoff editor on shows the Wyckoff tab, also after a
//      bond pick left the Structure window on Bonds and it was closed (did
//      not reproduce; kept as a guard).
//   6. Clicking an orbit in the Wyckoff tab selects every atom of it (not only
//      its representative); the locked editor's orbit glow survives a
//      coordinate edit (it vanished while the row still counted as lit).
//   7. The selection bar's Coordinates boxes show x, y and z without cutting
//      z off; Copy still gives 8 decimals.
//   8. Modify Structure's number boxes (atom table, lattice, locked orbit
//      table) hold 4 decimals, floating and docked.
//   9. The inspectors show "Reset positions" only once a label was moved (a
//      display rule beat the hidden attribute).
//  10. The Polyhedron Inspector says to double-click a polyhedron.
//  11. Polyhedra Connectivity counts per cell, with the neighbours in the
//      next cells: rutile shares 2 edges and 8 corners per cell (was Edge 1),
//      a 2×2×2 rutile cell 16 and 64.
//  12. EOS: the Force tol box shows its value (it read "0.0"); the column
//      parsing itself is tools/unittest/eoscolumns.test.mjs.
//  14. The Bond Length Histogram's hover list numbers atoms from 1.
//  16. The Spins window's list shows 0.3, not 0.30000000000000004; the
//      docked Crystal Planes table fits, so ✕ no longer covers Filter.
//  19. A dashed measurement line ends in a dash at both atoms (it stopped up
//      to a period short of the second).
//  18. An atom exactly on a cut plane is drawn whole (it came out speckled on
//      real GPUs; SwiftShader shows no speckle either way, so this guards the
//      on-plane case rather than reproducing it).
'use strict';
const H = require('../harness');

function rutilePoscar(n) {
  const base = [['Ti', 0, 0, 0], ['Ti', 0.5, 0.5, 0.5], ['O', 0.3048, 0.3048, 0], ['O', 0.6952, 0.6952, 0], ['O', 0.8048, 0.1952, 0.5], ['O', 0.1952, 0.8048, 0.5]];
  const ti = [], o = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let l = 0; l < n; l++) {
    for (const [el, x, y, z] of base) (el === 'Ti' ? ti : o).push([(x + i) / n, (y + j) / n, (z + l) / n].map((v) => v.toFixed(6)).join(' '));
  }
  return ['rutile', '1.0', `${4.5937 * n} 0 0`, `0 ${4.5937 * n} 0`, `0 0 ${2.9587 * n}`, 'Ti O', `${ti.length} ${o.length}`, 'Direct', ...ti, ...o, ''].join('\n');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // ---- 1. a shortcut with a checkbox focused ----------------------------------------
  await page.evaluate(async () => {
    const { getPanel, closePanel } = await import('./ui/panels/PanelManager.js');
    if (getPanel('backend') && !getPanel('backend').closed) closePanel('backend');
  });
  await page.focus('#showCharges');
  const focused = await page.evaluate(() => `${document.activeElement?.id}:${document.activeElement?.type}`);
  await page.keyboard.press('Shift+Alt+KeyA');
  await page.waitForTimeout(500);
  const opened = await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).getPanel('backend')?.closed === false);
  H.check('1. Shift+Alt+A opens the Atomistic window while a checkbox has focus', focused === 'showCharges:checkbox' && opened,
    JSON.stringify({ focused, opened }));
  // …but typing into a text field still keeps the keys.
  const typed = await page.evaluate(async () => {
    const { getPanel, closePanel } = await import('./ui/panels/PanelManager.js');
    closePanel('backend');
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'zzTypingProbe';
    document.body.appendChild(input);
    return !!getPanel('backend');
  });
  await page.focus('#zzTypingProbe');
  await page.keyboard.press('Shift+Alt+KeyA');
  await page.waitForTimeout(400);
  const stayedClosed = await page.evaluate(async () => {
    document.getElementById('zzTypingProbe').remove();
    return (await import('./ui/panels/PanelManager.js')).getPanel('backend')?.closed === true;
  });
  H.check('1. …while a text field with focus still keeps the keys', typed && stayedClosed, String(stayedClosed));

  // ---- 2. no page scroll -----------------------------------------------------------------
  const scroll = () => page.evaluate(() => ({ y: window.scrollY, overflow: document.scrollingElement.scrollHeight - innerHeight }));
  const s0 = await scroll();
  await page.keyboard.press('Shift+Alt+KeyA');
  await page.waitForTimeout(600);
  await page.keyboard.press('Shift+Alt+KeyT');
  await page.waitForTimeout(600);
  const s1 = await scroll();
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('symmetry'));
  await page.waitForTimeout(1200);
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
  const s2 = await scroll();
  H.check('2. the page cannot scroll, and opening windows by shortcut or the Wyckoff editor leaves it at the top',
    s0.overflow <= 0 && s1.y === 0 && s2.y === 0, JSON.stringify({ s0, s1, s2 }));
  await H.clickById(page, 'getWyckoffBtn'); // off again
  await page.waitForTimeout(800);

  // ---- 3. ≡ ▸ Default from the side dock ---------------------------------------------
  const dockState = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const panel = getPanel('settings');
    const state = () => ({
      dock: panel.dock,
      inSideBody: panel.el.parentElement?.id === 'splitPaneBody',
      tabs: [...document.querySelectorAll('#splitPaneHeaderTabs [data-panel-id], #splitPaneHeaderTabs button, #splitPaneTabs button')]
        .map((t) => t.textContent.trim()).filter(Boolean),
    });
    panel.hooks.positionPanel(panel, 'right');
    await new Promise((r) => setTimeout(r, 300));
    const side = state();
    panel.hooks.positionPanel(panel, 'default');
    await new Promise((r) => setTimeout(r, 300));
    return { side, back: state(), title: panel.def.title };
  });
  H.check('3. ≡ ▸ Default brings a side-docked Settings window back to the main dock, leaving no tab behind',
    dockState.side.inSideBody && dockState.back.dock === 'left' && !dockState.back.inSideBody
      && !dockState.back.tabs.some((t) => t.includes(dockState.title)),
    JSON.stringify(dockState));

  // ---- 4. long press on Restore -----------------------------------------------------------
  await H.clickById(page, 'hideAtomsBtn');
  await page.waitForTimeout(400);
  const rect = await page.evaluate(() => { const r = document.getElementById('restoreBtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(rect.x, rect.y);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const restore = await page.evaluate(async () => {
    const { mode } = await import('./state/store.js');
    return {
      mode: mode.measureMode,
      restoreLit: document.getElementById('restoreBtn').classList.contains('active'),
      hideLit: document.getElementById('hideAtomsBtn').classList.contains('active'),
      popover: !document.getElementById('restorePopover')?.hidden,
    };
  });
  H.check('4. a long press on Restore switches to Restore mode (lit, Hide not) and offers Restore All',
    restore.mode === 'restore' && restore.restoreLit && !restore.hideLit && restore.popover, JSON.stringify(restore));
  await page.evaluate(() => document.getElementById('restoreCancelBtn')?.click());
  await H.clickById(page, 'restoreBtn'); // Restore off
  await page.waitForTimeout(300);

  const glow = () => page.evaluate(async () => {
    const { groups, atomSelection } = await import('./state/store.js');
    const a = groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity;
    let n = 0;
    for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++;
    return { glowing: n, selected: atomSelection.selectedAtoms.map((atom) => atom.sourceIndex).sort((x, y) => x - y).join(',') };
  });

  // ---- 5. the Wyckoff tab on lock ----------------------------------------------------------
  await page.evaluate(async () => {
    (await import('./ui/SelectAndHighlightModule.js')).selectBondFromInstance(0);
  });
  await page.waitForTimeout(400);
  const before5 = await page.evaluate(() => document.querySelector('#atomBondControlSwitch button.active')?.dataset.mode);
  await page.evaluate(async () => (await import('./ui/StructureInfoPanel/General.js')).setStructurePanelOpen(false));
  await page.keyboard.press('Escape');
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
  const tab5 = await page.evaluate(() => ({
    active: document.querySelector('#atomBondControlSwitch button.active')?.dataset.mode,
    shown: !!document.getElementById('wyckoffPanel')?.offsetParent,
    bondsShown: !!document.getElementById('infoBondControls')?.offsetParent,
  }));
  H.check('5. the Wyckoff editor opens the Structure window on the Wyckoff tab (after a bond pick on the Bonds tab)',
    before5 === 'bonds' && tab5.active === 'wyckoff' && tab5.shown && !tab5.bondsShown, JSON.stringify({ before5, tab5 }));

  // ---- 6. orbit selection in the Wyckoff tab ------------------------------------------------
  const orbit = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const groups = s.symmetry.orbitGroups;
    const pick = groups.find((g) => g.atomIndices.length > 1);
    const rows = [...document.querySelectorAll('#wyckoffPanel .individual-atom-row')];
    return {
      row: rows.findIndex((r) => Number(r.dataset.atomIndex) === pick.representativeIndex),
      atoms: [...pick.atomIndices].sort((a, b) => a - b).join(','),
      instances: pick.atomIndices.reduce((t, i) => t + (s.atomImages[i]?.length ?? 1), 0),
      orbitId: pick.orbitId,
    };
  });
  const clickOrbitRow = (mod) => page.evaluate(({ row, mod }) => {
    const el = document.querySelectorAll('#wyckoffPanel .individual-atom-row')[row];
    el.querySelector('.iar-name').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: mod === 'ctrl' }));
    return el.querySelector('.iar-name-container').title;
  }, { row: orbit.row, mod });
  const title6 = await clickOrbitRow();
  await page.waitForTimeout(300);
  const sel6 = await glow();
  await clickOrbitRow('ctrl');
  await page.waitForTimeout(300);
  const off6 = await glow();
  H.check('6. clicking an orbit in the Wyckoff tab selects (and lights) all its atoms; Ctrl-click takes it off again',
    orbit.row >= 0 && sel6.selected === orbit.atoms && sel6.glowing === orbit.instances && off6.selected === '' && off6.glowing === 0
      && /Select all \d+ atoms of this orbit/.test(title6), JSON.stringify({ orbit, sel6, off6, title6 }));

  // ---- 6. the locked editor's orbit glow through a coordinate edit --------------------------
  await page.evaluate(async () => (await import('./ui/addToStructureModule/AddStructureModule.js')).openModifyStructurePanel());
  await page.waitForTimeout(1500);
  const editorRow = () => [...document.querySelectorAll('[data-panel-id="modifyStructure"] tr')].find((r) => r.querySelector('.orbit-z:not(:disabled)'));
  const freeRow = await page.evaluate(`(${editorRow})()?.rowIndex ?? -1`);
  const edGlow = async () => (await glow()).glowing;
  const freeOrbitInstances = await page.evaluate(async (getRow) => {
    const row = eval(getRow)();
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const index = [...row.parentElement.children].filter((r) => r.querySelector('.orbit-z')).indexOf(row);
    const g = s.symmetry.orbitGroups[index];
    row.querySelector('td').click();
    return g.atomIndices.reduce((t, i) => t + (s.atomImages[i]?.length ?? 1), 0);
  }, `(${editorRow})`);
  await page.waitForTimeout(300);
  const lit = await edGlow();
  await page.evaluate((getRow) => {
    const input = eval(getRow)().querySelector('.orbit-z');
    input.value = String(Math.min(0.45, Number(input.value) + 0.01).toFixed(4));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, `(${editorRow})`);
  await page.waitForTimeout(900);
  const afterEdit = await edGlow();
  await page.evaluate((getRow) => eval(getRow)().querySelector('td').click(), `(${editorRow})`);
  await page.waitForTimeout(300);
  const clickedOff = await edGlow();
  H.check('6. the locked editor keeps an orbit lit through a coordinate edit, and the next click turns it off',
    freeRow >= 0 && lit === freeOrbitInstances && afterEdit === freeOrbitInstances && clickedOff === 0,
    JSON.stringify({ freeRow, freeOrbitInstances, lit, afterEdit, clickedOff }));

  // ---- 8. number boxes hold 4 decimals ------------------------------------------------------
  const fit = () => page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const root = document.querySelector('[data-panel-id="modifyStructure"]');
    const short = [];
    for (const input of root.querySelectorAll('input[type=number]:is(.lattice-num-input, .addstructure-num-input, .wyckoff-orbit-num-input)')) {
      if (!input.offsetParent) continue;
      const cs = getComputedStyle(input);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const sample = input.classList.contains('lattice-num-input') ? '11.6800' : '0.1769';
      if (ctx.measureText(sample).width > room + 0.5) short.push(`${input.id || input.className.split(' ')[0]} ${Math.round(room)}px`);
    }
    return short;
  });
  const shortWyckFloat = await fit();
  await page.evaluate(async () => { const { getPanel } = await import('./ui/panels/PanelManager.js'); const p = getPanel('modifyStructure'); p.hooks.positionPanel(p, 'left'); });
  await page.waitForTimeout(800);
  const shortWyckDocked = await fit();
  await page.evaluate(async () => { const { getPanel, closePanel } = await import('./ui/panels/PanelManager.js'); const p = getPanel('modifyStructure'); p.hooks.positionPanel(p, 'default'); closePanel('modifyStructure'); });
  await H.clickById(page, 'getWyckoffBtn'); // unlock
  await page.waitForTimeout(1200);
  await page.evaluate(async () => (await import('./ui/addToStructureModule/AddStructureModule.js')).openModifyStructurePanel());
  await page.waitForTimeout(1500);
  const shortFreeFloat = await fit();
  await page.evaluate(async () => { const { getPanel } = await import('./ui/panels/PanelManager.js'); const p = getPanel('modifyStructure'); p.hooks.positionPanel(p, 'left'); });
  await page.waitForTimeout(800);
  const shortFreeDocked = await fit();
  await page.evaluate(async () => { const { getPanel, closePanel } = await import('./ui/panels/PanelManager.js'); const p = getPanel('modifyStructure'); p.hooks.positionPanel(p, 'default'); closePanel('modifyStructure'); });
  H.check('8. Modify Structure\'s number boxes hold 0.1769 (lattice 11.6800), floating and docked, locked or not',
    !shortWyckFloat.length && !shortWyckDocked.length && !shortFreeFloat.length && !shortFreeDocked.length,
    JSON.stringify({ shortWyckFloat, shortWyckDocked, shortFreeFloat, shortFreeDocked }));

  // ---- 7. the selection bar's Coordinates boxes ----------------------------------------------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    (await import('./ui/StructureInfoPanel/General.js')).setStructurePanelOpen(true);
    (await import('./ui/SelectAndHighlightModule.js')).selectAtomsByInstances([0, 3, 4].map((i) => s.atomImages[i][0]));
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } });
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#selectionActionBar .si-selbar-coordinates-toggle')?.click());
  await page.waitForTimeout(400);
  const coords = await page.evaluate(async () => {
    const boxes = [...document.querySelectorAll('#selectionActionBar .si-selbar-coordinates textarea')];
    document.querySelector('#selectionActionBar .si-selbar-copy')?.click();
    await new Promise((r) => setTimeout(r, 100));
    return { boxes: boxes.map((t) => ({ fits: t.scrollWidth <= t.clientWidth, z: t.value.split('\n')[1]?.trim().split(/\s+/).length, tabs: t.value.split('\n')[1]?.split('\t').length === 4 })), copied: window.__copied[0] ?? '' };
  });
  const copiedRow = coords.copied.split('\n')[1]?.split('\t') ?? [];
  H.check('7. the Coordinates boxes show x, y and z in full (fractional and Cartesian), tab-separated; Copy gives 8 decimals',
    coords.boxes.length === 2 && coords.boxes.every((b) => b.fits && b.z === 5 && b.tabs) && copiedRow.length === 4 && /^\d+\.\d{8}$/.test(copiedRow[3]),
    JSON.stringify(coords));

  // ---- 9, 10, 11 on rutile ------------------------------------------------------------------
  const loadRutile = async (n) => {
    await page.evaluate(async (t) => { window.__load = (await import('./core/crystal-viewer.js')).loadStructure(t, 'POSCAR'); }, rutilePoscar(n));
    await page.evaluate(async () => { await window.__load; });
    await page.waitForTimeout(1500);
    if (!(await page.evaluate(() => document.getElementById('showPolyhedra').checked))) await H.clickById(page, 'showPolyhedra');
    await page.waitForTimeout(1500);
  };
  const connectivity = () => page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { computePolyhedraConnectivity } = await import('./render/PolyhedraAnalysisModule.js');
    const tally = {};
    for (const row of computePolyhedraConnectivity(fileBrowser.selectedStructure)) tally[row.sharing] = (tally[row.sharing] ?? 0) + 1;
    return tally;
  });
  await loadRutile(1);
  const c1 = await connectivity();
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('polyhedra')?.expand?.();
  });
  await page.waitForTimeout(300);
  await H.clickById(page, 'openPolyhedronInspector');
  await page.waitForTimeout(800);
  const placeholder = await page.evaluate(() => document.querySelector('.cv-panel[data-panel-id="polyhedronInspector"] .pi-summary-empty')?.textContent ?? '');
  H.check('10. the Polyhedron Inspector asks for a double-click on a polyhedron', /^Double-click a polyhedron/.test(placeholder), placeholder);
  await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const { selectPolyhedronFromMesh } = await import('./ui/SelectAndHighlightModule.js');
    let mesh = null;
    groups.polyhedraGroup?.traverse((o) => { if (!mesh && o.userData?.type === 'polyhedron') mesh = o; });
    selectPolyhedronFromMesh(mesh);
  });
  await page.waitForTimeout(1200);
  const reset = await page.evaluate(() => {
    const btn = document.getElementById('piResetPlaces');
    const cs = btn && getComputedStyle(btn);
    return { exists: !!btn, hidden: btn?.hidden, shown: !!btn && cs.display !== 'none' && cs.visibility !== 'hidden' };
  });
  H.check('9. "Reset positions" stays out of sight until a label is moved', reset.exists && reset.hidden && !reset.shown, JSON.stringify(reset));
  await page.evaluate(async () => {
    const { getPanel, closePanel } = await import('./ui/panels/PanelManager.js');
    if (getPanel('polyhedronInspector')) closePanel('polyhedronInspector');
  });
  await loadRutile(2);
  const c2 = await connectivity();
  H.check('11. Connectivity: rutile shares 2 edges and 8 corners per cell; a 2×2×2 cell 16 and 64',
    c1.edge === 2 && c1.corner === 8 && Object.keys(c1).length === 2 && c2.edge === 16 && c2.corner === 64 && Object.keys(c2).length === 2,
    JSON.stringify({ c1, c2 }));

  // ---- 18. an atom on a cut plane --------------------------------------------------------
  const cutShot = async (dz, name) => {
    await page.evaluate(async (dz) => {
      const THREE = await import('./external/three/three.module.js');
      const { general, groups } = await import('./state/store.js');
      const m = new THREE.Matrix4();
      groups.atomsMesh.getMatrixAt(0, m);
      const p = new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(groups.atomsMesh.matrixWorld);
      general.atomCutPlanes = [{ enabled: true, x: 0, y: 0, z: 1, r: p.z + dz, side: 'left' }];
      const { updateAtomCutPlaneState } = await import('./render/index.js');
      const { updateVisualization } = await import('./core/crystal-viewer.js');
      updateAtomCutPlaneState();
      updateVisualization({ atomsUpdate: false, bondsUpdate: false, reRenderAtoms: false, reRenderBonds: false,
        reRenderLattice: false, reRenderOther: false, reRenderComposition: false });
    }, dz);
    await page.waitForTimeout(700);
    return H.shotCanvas(page, name);
  };
  await loadRutile(1);
  await page.evaluate(() => document.getElementById('showPolyhedra').checked && document.getElementById('showPolyhedra').click());
  await page.waitForTimeout(800);
  const { PNG } = require('pngjs');
  const fs = require('fs');
  const onPlane = PNG.sync.read(fs.readFileSync(await cutShot(0, 'manualbugs-cut-on')));
  const justAbove = PNG.sync.read(fs.readFileSync(await cutShot(0.01, 'manualbugs-cut-above')));
  let differ = 0;
  for (let i = 0; i < onPlane.data.length; i += 4) {
    if (Math.abs(onPlane.data[i] - justAbove.data[i]) + Math.abs(onPlane.data[i + 1] - justAbove.data[i + 1]) + Math.abs(onPlane.data[i + 2] - justAbove.data[i + 2]) > 30) differ++;
  }
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.atomCutPlanes = [];
    (await import('./render/index.js')).updateAtomCutPlaneState();
    (await import('./core/crystal-viewer.js')).updateVisualization({ atomsUpdate: false, bondsUpdate: false, reRenderAtoms: false,
      reRenderBonds: false, reRenderLattice: false, reRenderOther: false, reRenderComposition: false });
  });
  H.check('18. an atom exactly on a cut plane is drawn as with the plane just above it (whole, not speckled)',
    differ < 20, `${differ} pixels differ`);

  // ---- 16. the Spins window's list ----------------------------------------------------------
  const spinList = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { Spin } = await import('./model/index.js');
    const s = fileBrowser.selectedStructure;
    s.spins = s.atoms.map(() => new Spin({ vector: [0.1 + 0.2, 0, 1.87] }));
    const { openPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('spins');
    getPanel('spins')?.expand?.();
    const { addSpinPanel } = await import('./ui/SpinPanel.js');
    addSpinPanel('cvPanelBody-spins');
    await new Promise((r) => setTimeout(r, 300));
    return document.getElementById('currentSpinsList')?.value ?? '';
  });
  H.check('16. the Spins window lists 0.3, not 0.30000000000000004',
    /^0\.3 0 1\.87 /m.test(spinList) && !/0000000/.test(spinList), spinList.split('\n')[0]);

  // ---- 16. the docked Crystal Planes table -------------------------------------------------
  await page.evaluate(async () => {
    const { openPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('planes');
    const p = getPanel('planes');
    p.hooks.positionPanel(p, 'left');
    p.expand?.();
  });
  await page.waitForTimeout(800);
  await H.clickById(page, 'addPlaneBtn');
  await page.waitForTimeout(1200);
  const planes = await page.evaluate(() => {
    const w = document.querySelector('[data-panel-id="planes"] .planes-table-wrapper');
    return { docked: !!w?.closest('.cv-docked'), cw: w?.clientWidth, sw: w?.scrollWidth, rows: w?.querySelectorAll('tbody tr').length };
  });
  H.check('16. docked, the Crystal Planes table fits its window (✕ covers no column)',
    planes.docked && planes.rows > 0 && planes.sw <= planes.cw, JSON.stringify(planes));

  // ---- 12. EOS Force tol --------------------------------------------------------------------
  const fmax = await page.evaluate(async () => {
    const { openPanel, getPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('eos');
    getPanel('eos')?.expand?.();
    await new Promise((r) => setTimeout(r, 500));
    const input = document.getElementById('eosComputeFmax');
    if (!input) return null;
    const cs = getComputedStyle(input);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return { room: Math.round(input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), need: Math.ceil(ctx.measureText('0.0001').width) };
  });
  H.check('12. EOS: the Force tol box holds 0.0001', !!fmax && fmax.room >= fmax.need, JSON.stringify(fmax));

  // ---- 14. Bond Length Histogram hover list -------------------------------------------------
  await H.loadDefaultStructure(page);
  await page.evaluate(async () => (await import('./ui/AnalysisPanels/BondLengthHistogram.js')).addBondLengthHistogramPanel());
  await page.waitForTimeout(800);
  // Cards start collapsed and a collapsed card draws nothing: open All Pairs.
  await page.evaluate(() => document.querySelector('[id^="blh-card__All"] .blh-collapse-toggle')?.click());
  await H.waitFor(page, () => [...document.querySelectorAll('[id^="bondLengthHistogramPlot__"]')].some((el) => el.data?.length), { timeout: 20000 });
  const hover = await page.evaluate(() => [...document.querySelectorAll('[id^="bondLengthHistogramPlot__"]')]
    .flatMap((el) => (el.data ?? []).flatMap((t) => t.hovertext ?? [])).join('\n'));
  const pairs = hover.match(/[A-Z][a-z]? \d+–[A-Z][a-z]? \d+/g) ?? [];
  const numbers = pairs.flatMap((pair) => pair.match(/\d+/g).map(Number));
  H.check('14. the Bond Length Histogram hover list numbers atoms from 1 (Ba 1–O 7)',
    pairs.length > 0 && numbers.every((n) => n >= 1 && n <= 13), `${pairs.length} bonds; ${pairs.slice(0, 3).join(', ')}`);

  // ---- 19. the measurement line's dashes ---------------------------------------------------
  const dashes = await page.evaluate(async () => {
    const THREE = await import('./external/three/three.module.js');
    const { fileBrowser, measurements } = await import('./state/store.js');
    const { addDistanceMeasurement, clearAllMeasurements } = await import('./render/MeasurementModule.js');
    clearAllMeasurements();
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const atom = (i) => ({ position: new THREE.Vector3(...w.cart[i]), userData: { atomIndex: w.srcIndex ? w.srcIndex[i] : i, element: w.elements[i], wrappedFrac: [...w.frac[i]] } });
    const out = [];
    // Same-element pairs: each end is trimmed back to its own atom's surface.
    const pairs = [];
    for (let i = 0; i < w.cart.length && pairs.length < 3; i++) {
      for (let j = i + 1; j < w.cart.length && pairs.length < 3; j++) {
        const d = Math.hypot(...w.cart[i].map((v, k) => v - w.cart[j][k]));
        if (w.elements[i] === w.elements[j] && d > 2.5 && d < 7 && !pairs.some(([a]) => w.elements[a] === w.elements[i])) pairs.push([i, j]);
      }
    }
    for (const [i, j] of pairs) {
      clearAllMeasurements();
      const a = atom(i), b = atom(j);
      addDistanceMeasurement(a, b);
      const group = measurements.measureLines.find((g) => g.userData?.type === 'distance');
      const axis = new THREE.Vector3().subVectors(b.position, a.position);
      const length = axis.length();
      axis.normalize();
      const meshes = [];
      group.traverse((o) => { if (o.geometry?.type === 'CylinderGeometry') meshes.push(o); });
      const spans = meshes.map((m) => {
        const along = new THREE.Vector3().subVectors(m.getWorldPosition(new THREE.Vector3()), a.position).dot(axis);
        const half = m.geometry.parameters.height * Math.abs(m.scale.y) / 2;
        return [along - half, along + half];
      }).sort((x, y) => x[0] - y[0]);
      out.push({ length: +length.toFixed(3), pieces: spans.length, startGap: +spans[0][0].toFixed(3), endGap: +(length - spans[spans.length - 1][1]).toFixed(3) });
    }
    clearAllMeasurements();
    return out;
  });
  H.check('19. a dashed measurement line starts and ends with a dash (the same bare stretch at both atoms)',
    dashes.every((d) => d.pieces > 1 && Math.abs(d.startGap - d.endGap) < 0.02), JSON.stringify(dashes));

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
