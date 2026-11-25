// The Structure window's per-row editors are built on first open, not with
// the row. A 3D pick reveals the picked polyhedron's or atom's row, which
// builds its whole list (up to 1000 rows, or one page of a longer one); with
// a canvas colour picker and a material editor in every row, picking one
// polyhedron on a 5000-atom SrTiO3 cell took 1.5 s.
//  1. SrTiO3 5x5x5 with polyhedra: a polyhedron picked from the 3D side is
//     selected in under 150 ms (software GL), its row highlighted and
//     scrolled into view, and no row of the list has an editor built.
//  2. The row's Edit button builds its editor on that click; a colour typed
//     into it recolours the polyhedron (the drawn table's colour).
//  3. The same for an atom: the pick is fast, the row highlighted and in
//     view, editors unbuilt; Color builds the editor and its colour edit
//     recolours the atom (model colour and mesh instance colour).
//  4. A Structure-window rebuild reopens an open editor, built.
'use strict';
const H = require('../harness');

function poscar(n) {
  const a = 3.905;
  const basis = [['Sr', [0, 0, 0]], ['Ti', [0.5, 0.5, 0.5]], ['O', [0.5, 0.5, 0]], ['O', [0.5, 0, 0.5]], ['O', [0, 0.5, 0.5]]];
  const by = { Sr: [], Ti: [], O: [] };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    for (const [el, f] of basis) by[el].push([(f[0] + i) / n, (f[1] + j) / n, (f[2] + k) / n]);
  }
  const L = a * n;
  return [`SrTiO3 ${n}x${n}x${n}`, '1.0', `${L} 0 0`, `0 ${L} 0`, `0 0 ${L}`, 'Sr Ti O',
    `${by.Sr.length} ${by.Ti.length} ${by.O.length}`, 'Direct',
    ...['Sr', 'Ti', 'O'].flatMap((el) => by[el].map((p) => p.map((x) => x.toFixed(6)).join(' ')))].join('\n');
}

// Is the row inside the visible part of every scrolling ancestor?
const IN_VIEW = `(row) => {
  const r = row.getBoundingClientRect();
  const out = { row: [r.top, r.bottom], scrollers: [] };
  for (let el = row.parentElement; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY)) continue;
    const b = el.getBoundingClientRect();
    out.scrollers.push([el.id || el.className, b.top, b.bottom, el.scrollTop, el.scrollHeight]);
  }
  out.ok = r.height > 0 && r.bottom > 0 && r.top < innerHeight
    && out.scrollers.every(([, top, bottom]) => r.bottom > top && r.top < bottom);
  return out;
}`;

(async () => {
  const { browser, page, errors } = await H.launchApp();

  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'srtio3-555.vasp');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    general.linkPeriodicCopies = true;
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
  }, poscar(5));
  await page.waitForTimeout(500);
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { polyhedraInfo } = await import('./render/index.js');
    return polyhedraInfo().length > 100;
  });
  await page.waitForTimeout(500);

  // ---- 1. polyhedron pick ----
  const poly = await page.evaluate(async () => {
    const S = await import('./ui/SelectAndHighlightModule.js');
    const { polyhedraTable } = await import('./render/index.js');
    const { highlightHover } = await import('./state/store.js');
    const table = polyhedraTable();
    // a polyhedron well down its list, so revealing it has to scroll
    let i = Math.floor(table.n * 0.4);
    while (i < table.n && !table.faceCount[i]) i++;
    const t0 = performance.now();
    S.selectPolyhedronFromIndex(i);
    const ms = performance.now() - t0;
    const row = highlightHover.currentlyHighlightedRow;
    const list = row?.closest('.individual-polyhedra');
    return {
      index: i, n: table.n, ms: +ms.toFixed(1),
      groupKey: table.groupKey[i], rowGroupKey: row?.dataset.polyGroupKey ?? null,
      highlighted: !!row?.classList.contains('is-highlighted'),
      rows: list?.querySelectorAll('.individual-polyhedron-row').length ?? 0,
      builtEditors: list ? [...list.querySelectorAll('.poly-color-editor')].filter((e) => e.childElementCount > 0).length : -1,
      canvases: list?.querySelectorAll('canvas').length ?? -1,
      shells: list?.querySelectorAll('.individual-polyhedron-row > .poly-color-editor').length ?? 0,
    };
  });
  H.check('a 3D polyhedron pick selects in < 150 ms (row reveal included)',
    poly.ms < 150, JSON.stringify(poly));
  H.check('the picked polyhedron\'s row is highlighted',
    poly.highlighted && poly.rowGroupKey === poly.groupKey, JSON.stringify(poly));
  H.check('the revealed list builds no editor (one empty, closed shell per row, no canvas)',
    poly.rows > 50 && poly.shells === poly.rows && poly.builtEditors === 0 && poly.canvases === 0,
    JSON.stringify(poly));
  await page.waitForTimeout(3000); // smooth scroll
  const polyInView = await page.evaluate(async (inView) => {
    const { highlightHover } = await import('./state/store.js');
    // eslint-disable-next-line no-eval
    return eval(inView)(highlightHover.currentlyHighlightedRow);
  }, IN_VIEW);
  H.check('the picked polyhedron\'s row is scrolled into view', polyInView.ok, JSON.stringify(polyInView));

  // ---- 2. its editor, on the Edit click ----
  const polyEdit = await page.evaluate(async (index) => {
    const { highlightHover } = await import('./state/store.js');
    const { polyhedronInfo } = await import('./render/index.js');
    const row = highlightHover.currentlyHighlightedRow;
    const editor = row.querySelector('.poly-color-editor');
    const before = { children: editor.childElementCount, color: polyhedronInfo(index).color };
    row.querySelector('button[data-editor-button="color"]').click();
    const opened = {
      open: !editor.hidden,
      pickers: editor.querySelectorAll('.cv-colorpicker-inputs-wrap').length,
      material: !!editor.querySelector('.material-editor'),
      alpha: !!editor.querySelector('input[type="range"]'),
    };
    const hex = editor.querySelectorAll('.cv-colorpicker-input-field')[1];
    hex.value = '#12ab34';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return { before, opened, after: polyhedronInfo(index).color };
  }, poly.index);
  H.check('the Edit click builds the full editor (face + edge pickers, alpha, material) and opens it',
    polyEdit.before.children === 0 && polyEdit.opened.open
      && polyEdit.opened.pickers === 2 && polyEdit.opened.material && polyEdit.opened.alpha,
    JSON.stringify(polyEdit));
  H.check('a colour edit through the lazily built editor recolours the polyhedron',
    /^#?12ab34$/i.test(polyEdit.after) && !/12ab34/i.test(polyEdit.before.color), JSON.stringify(polyEdit));

  // ---- 3. atom pick ----
  const atom = await page.evaluate(async () => {
    const S = await import('./ui/SelectAndHighlightModule.js');
    const { groups, fileBrowser, highlightHover } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    // an O atom far down the O list (375 rows)
    const oIndices = s.elements.map((e, i) => (e === 'O' ? i : -1)).filter((i) => i >= 0);
    const atomIndex = oIndices[Math.floor(oIndices.length * 0.7)];
    const instanceId = s.atomImages[atomIndex][0];
    const t0 = performance.now();
    S.updateAtomSelectionFrom3DHit({ instanceId, object: groups.atomsMesh }, { scrollToSelection: true, revealPanel: true });
    const ms = performance.now() - t0;
    const row = highlightHover.currentlyHighlightedRow;
    const list = row?.closest('.individual-atoms');
    const editors = list ? [...list.querySelectorAll('.atom-color-editor, .atom-coord-editor, .atom-spin-editor')] : [];
    return {
      atomIndex, instanceId, ms: +ms.toFixed(1),
      rowAtom: Number(row?.dataset.atomIndex), highlighted: !!row?.classList.contains('is-highlighted'),
      rows: list?.querySelectorAll('.individual-atom-row').length ?? 0,
      shells: editors.length, built: editors.filter((e) => e.childElementCount > 0).length,
      closed: editors.every((e) => e.hidden),
      canvases: list?.querySelectorAll('canvas').length ?? -1,
    };
  });
  H.check('a 3D atom pick selects in < 150 ms (row reveal included)', atom.ms < 150, JSON.stringify(atom));
  H.check('the picked atom\'s row is highlighted', atom.highlighted && atom.rowAtom === atom.atomIndex, JSON.stringify(atom));
  H.check('the revealed atom list builds no editor (three empty, closed shells per row, no canvas)',
    atom.rows > 300 && atom.shells === 3 * atom.rows && atom.built === 0 && atom.closed && atom.canvases === 0,
    JSON.stringify(atom));
  await page.waitForTimeout(3000);
  const atomInView = await page.evaluate(async (inView) => {
    const { highlightHover } = await import('./state/store.js');
    // eslint-disable-next-line no-eval
    return eval(inView)(highlightHover.currentlyHighlightedRow);
  }, IN_VIEW);
  H.check('the picked atom\'s row is scrolled into view', atomInView.ok, JSON.stringify(atomInView));

  const atomEdit = await page.evaluate(async ({ atomIndex, instanceId }) => {
    const { groups, fileBrowser, highlightHover } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const row = highlightHover.currentlyHighlightedRow;
    const editor = row.querySelector('.atom-color-editor');
    const before = editor.childElementCount;
    row.querySelector('button[data-editor-button="color"]').click();
    const opened = {
      open: !editor.hidden,
      picker: !!editor.querySelector('.cv-colorpicker-inputs-wrap'),
      material: !!editor.querySelector('.material-editor'),
      sliders: editor.querySelectorAll(':scope > .si-row input[type="range"]').length,
      // Position and Spin/Force come with it, closed
      coord: row.querySelector('.atom-coord-editor').childElementCount > 0,
      spin: typeof row.querySelector('.atom-spin-editor').refresh === 'function',
    };
    const hex = editor.querySelectorAll('.cv-colorpicker-input-field')[1];
    hex.value = '#12ab34';
    hex.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const c = new THREE.Color();
    groups.atomsMesh.getColorAt(instanceId, c);
    return {
      before, opened,
      userColor: fileBrowser.selectedStructure.atoms[atomIndex].userColor,
      instance: '#' + c.getHexString(),
    };
  }, atom);
  H.check('the Color click builds the atom\'s editors (picker, alpha + size, material; Position, Spin/Force) and opens Color',
    atomEdit.before === 0 && atomEdit.opened.open && atomEdit.opened.picker
      && atomEdit.opened.material && atomEdit.opened.sliders === 2 && atomEdit.opened.coord && atomEdit.opened.spin,
    JSON.stringify(atomEdit));
  H.check('a colour edit through the lazily built atom editor recolours the atom (model + mesh instance)',
    /^#?12ab34$/i.test(atomEdit.userColor) && atomEdit.instance.toLowerCase() === '#12ab34',
    JSON.stringify(atomEdit));

  // ---- 4. a panel rebuild reopens the open editor, built ----
  const reopened = await page.evaluate(async (atomIndex) => {
    const { renderComposition } = await import('./ui/StructureInfoPanel/General.js');
    renderComposition('open');
    const row = document.querySelector(`#composition .individual-atom-row[data-atom-index="${atomIndex}"]`);
    const editor = row?.querySelector('.atom-color-editor');
    return { open: editor ? !editor.hidden : false, children: editor?.childElementCount ?? 0 };
  }, atom.atomIndex);
  H.check('a Structure-window rebuild reopens the open atom editor with its contents',
    reopened.open && reopened.children > 0, JSON.stringify(reopened));

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
