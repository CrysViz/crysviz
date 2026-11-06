// Selection Inspector (ui/AnalysisPanels/SelectionInspector.js): the selected
// atoms in their own side-dock window — the bonds among them with their
// lengths, the angles between those bonds. Opened from the Structure window's
// selection bar (Inspect) or the search. Labels are hidden one by one with
// their × (shown on hover, or by a tap on touch — a click on the label itself
// hides nothing) and come back with "Show all labels"; the Add neighbours tool shows the
// bonded neighbours faintly while it is on, clicking one (in the mini view
// itself) adds it, and ending the tool clears the rest. The view never
// reframes itself for a change to the same atoms. Also checks the Polyhedron
// Inspector's label hiding (shared inspectorLabels.js). Driven with real
// mouse clicks on the mini views, located through the renderer's screen
// positions.
'use strict';
const H = require('../harness');

async function inspector(page) {
  return page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const { getSelectedAtoms } = await import('./ui/SelectAndHighlightModule.js');
    const s = getSelectionInspectorState();
    const summary = (document.querySelector('#siSummary')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return s && { ...s, selected: getSelectedAtoms().length, summary };
  });
}

/** The points (of `list`) where the inspector canvas is what a click hits —
 *  a floating window (the Structure window) can sit over part of the dock. */
async function onCanvas(page, list) {
  return page.evaluate((pts) => pts.filter((p) => document.elementFromPoint(p.x, p.y)?.classList.contains('pi-mini-canvas')), list);
}

/** The label × of a mini view (`#siViewport` / `#piViewport`): shown or
 *  not, and the page point at its centre. */
async function xButton(page, viewportSel) {
  return page.evaluate((sel) => {
    const hot = document.querySelector(`${sel} .pi-label-hotspot`);
    const btn = hot?.querySelector('.pi-label-remove');
    if (!hot || hot.hidden || !btn) return { shown: false };
    const r = btn.getBoundingClientRect();
    const h = hot.getBoundingClientRect();
    // gap: from the label's right end to the button; dy: off the label's middle.
    return { shown: true, x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width,
      gap: r.left - h.right, dy: r.top + r.height / 2 - (h.top + h.height / 2), icon: !!btn.querySelector('svg') };
  }, viewportSel);
}

const sameCamera = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
// Screen distance from p to the nearest OTHER point of list (points arrive as
// fresh copies from the page, so "other" is by position, not identity).
const clearOf = (p, list) => Math.min(...list.map((q) => Math.hypot(q.x - p.x, q.y - p.y)).filter((d) => d > 0.5), 1e9);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO

  // A Cu and the O atoms bonded to it, as displayed instances.
  const pick = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { getBondCutoff, getBondMinCutoff } = await import('./render/BondsFracUpdateModule.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    const d = (i, j) => Math.hypot(...[0, 1, 2].map((k) => w.cart[i][k] - w.cart[j][k]));
    const bonded = (i, j) => d(i, j) <= getBondCutoff(w.elements[i], w.elements[j]) && d(i, j) >= getBondMinCutoff(w.elements[i], w.elements[j]) && d(i, j) > 0.1;
    let best = null;
    for (let c = 0; c < w.cart.length; c++) {
      if (w.elements[c] !== 'Cu') continue;
      const os = w.cart.map((_, i) => i).filter((i) => w.elements[i] === 'O' && bonded(c, i));
      if (!best || os.length > best.os.length) best = { c, os };
    }
    return best;
  });
  H.check('found a Cu with two bonded O', pick?.os.length >= 2, JSON.stringify(pick));

  await page.evaluate(async ({ c, os }) => {
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    selectAtomsByInstances([c, os[0], os[1]]);
    setStructurePanelOpen(true);
  }, pick);
  await page.waitForTimeout(500);
  const btn = await page.evaluate(() => {
    const b = document.getElementById('selectionInspectBtn');
    return b ? { text: b.textContent, title: b.title } : null;
  });
  H.check('the selection bar offers Inspect, with an explanation', btn?.text === 'Inspect' && /Selection Inspector/.test(btn.title),
    JSON.stringify(btn));
  await H.clickById(page, 'selectionInspectBtn');
  await page.waitForTimeout(1200);

  let s = await inspector(page);
  const poly = await page.evaluate(async () => (await import('./state/store.js')).general.showPolyhedra);
  const docked = await page.evaluate(() => !!document.querySelector('#splitPaneBody > .cv-panel[data-panel-id="selectionInspector"]'));
  H.check('Inspect opens the Selection Inspector in the side dock, without forcing polyhedra on',
    docked && !poly && s?.atoms === 3, JSON.stringify({ docked, poly, atoms: s?.atoms }));
  H.check('it shows the atoms, their bonds and angles, and a summary',
    s.bonds === 2 && s.angles === 1 && s.labels.length === 3 && /^Atoms ?3 \(Cu O2\)/.test(s.summary),
    JSON.stringify({ bonds: s.bonds, angles: s.angles, labels: s.labels.length, summary: s.summary }));
  await H.shotCanvas(page, 'selectioninspector-3atoms');

  // ---- bonds are drawn where the main render draws them -------------------------------
  // Each inspector bond starts and ends where the main view's own Bond does
  // (model/Bond.js r1/r2) — reused, not re-derived — so a change to the main
  // render's bond geometry carries over.
  const reuse = await page.evaluate(async () => {
    const { getSelectionInspectorState } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    const { fileBrowser } = await import('./state/store.js');
    const key = (p) => p.map((v) => v.toFixed(3)).join(',');
    const mainOf = (a, b) => {
      for (const bond of fileBrowser.selectedStructure.bonds) {
        const [p, q] = bond.positions;
        if (key(p) === key(a) && key(q) === key(b)) return { bond, ends: [bond.r1, bond.r2] };
        if (key(p) === key(b) && key(q) === key(a)) return { bond, ends: [bond.r2, bond.r1] };
      }
      return null;
    };
    const s = getSelectionInspectorState();
    const same = s.bondEnds.every((e) => {
      const m = mainOf(e.a, e.b);
      return m && Math.abs(m.ends[0] - e.trimA) < 1e-12 && Math.abs(m.ends[1] - e.trimB) < 1e-12;
    });
    // Move one main-view bond end and refresh: the inspector follows.
    const m = mainOf(s.bondEnds[0].a, s.bondEnds[0].b);
    const before = m.bond.r1;
    m.bond.r1 = before + 0.05;
    document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
    const after = getSelectionInspectorState().bondEnds[0];
    const followed = Math.abs((m.ends[0] === before ? after.trimA : after.trimB) - (before + 0.05)) < 1e-12;
    m.bond.r1 = before;
    document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
    return { n: s.bondEnds.length, same, followed };
  });
  H.check('inspector bonds end where the main render ends them, and follow it',
    reuse.n > 0 && reuse.same && reuse.followed, JSON.stringify(reuse));

  // ---- labels -------------------------------------------------------------------
  const inView = (p) => p.x > s.viewport.left + 8 && p.x < s.viewport.right - 8
    && p.y > s.viewport.top + 8 && p.y < s.viewport.bottom - 8;
  const target = (await onCanvas(page, s.labels.filter((l) => l.visible && inView(l))))[0];
  // A click on the label itself hides nothing: it shows the label's ×.
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);
  s = await inspector(page);
  let x = await xButton(page, '#siViewport');
  H.check('a click on a label hides nothing; it shows the label\'s × just right of it, clear of the value',
    s.hiddenLabels.length === 0 && x.shown && x.icon && x.gap >= 2 && x.gap <= 5 && Math.abs(x.dy) < 1.5 && x.size >= 18,
    JSON.stringify({ hidden: s.hiddenLabels, x }));
  // Pointing elsewhere takes it away again; pointing at the label brings it.
  await page.mouse.move(s.viewport.left + 10, s.viewport.bottom - 10, { steps: 3 });
  await page.waitForTimeout(500);
  const away = await xButton(page, '#siViewport');
  await page.mouse.move(target.x, target.y, { steps: 3 });
  await page.waitForTimeout(200);
  x = await xButton(page, '#siViewport');
  H.check('the × goes when the pointer leaves the label, and comes back on hover', !away.shown && x.shown,
    JSON.stringify({ away, x }));
  await page.mouse.move(x.x, x.y, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.click(x.x, x.y);
  await page.waitForTimeout(300);
  s = await inspector(page);
  const showBtn = await page.evaluate(() => {
    const b = /** @type {HTMLButtonElement} */ (document.getElementById('siShowLabels'));
    return { text: b.textContent, disabled: b.disabled };
  });
  H.check('its × hides just that label',
    s.hiddenLabels.length === 1 && s.hiddenLabels[0] === target.key && s.labels.length === 2
      && !showBtn.disabled && /1 hidden/.test(showBtn.text) && !(await xButton(page, '#siViewport')).shown,
    JSON.stringify({ hidden: s.hiddenLabels, labels: s.labels.length, showBtn }));
  await H.clickById(page, 'siShowLabels');
  await page.waitForTimeout(300);
  s = await inspector(page);
  H.check('Show all labels brings it back', s.hiddenLabels.length === 0 && s.labels.length === 3,
    JSON.stringify({ hidden: s.hiddenLabels, labels: s.labels.length }));
  // On touch there is no hover: a tap on the label shows its ×, a tap on the
  // × hides it.
  // Synthetic pointers cannot be captured (the orbit controls try to):
  // capture is stubbed for the tap, as in gizmoui.test.js.
  const touchTap = (pt) => page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const capture = [Element.prototype.setPointerCapture, Element.prototype.releasePointerCapture];
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    try {
      const fire = (type) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      fire('pointerdown');
      fire('pointerup');
      el.closest('button')?.click();
    } finally {
      [Element.prototype.setPointerCapture, Element.prototype.releasePointerCapture] = capture;
    }
    return el.className;
  }, pt);
  const tapLabel = (await onCanvas(page, s.labels.filter((l) => l.visible && inView(l))))[0];
  await touchTap(tapLabel);
  await page.waitForTimeout(200);
  const tx = await xButton(page, '#siViewport');
  s = await inspector(page);
  const shownAfterTap = tx.shown && s.hiddenLabels.length === 0;
  await touchTap(tx);
  await page.waitForTimeout(300);
  s = await inspector(page);
  H.check('touch: a tap on a label shows its ×, a tap on the × hides the label',
    shownAfterTap && s.hiddenLabels.length === 1 && s.hiddenLabels[0] === tapLabel.key,
    JSON.stringify({ shownAfterTap, hidden: s.hiddenLabels, key: tapLabel.key }));
  await H.clickById(page, 'siShowLabels');
  await page.waitForTimeout(300);
  s = await inspector(page);

  await H.clickById(page, 'siLengthsToggle');
  await page.waitForTimeout(300);
  s = await inspector(page);
  H.check('Lengths hides the bond-length labels, angles stay',
    s.labels.length === 1 && s.labels[0].key.startsWith('a:'), JSON.stringify(s.labels.map((l) => l.key)));
  await H.clickById(page, 'siLengthsToggle');
  await page.waitForTimeout(300);

  // ---- no auto reframing ------------------------------------------------------------
  s = await inspector(page);
  const cam0 = s.camera;
  await page.evaluate(async ({ os }) => {
    const { addAtomsToSelectionByInstances } = await import('./ui/SelectAndHighlightModule.js');
    if (os[2] != null) addAtomsToSelectionByInstances([os[2]]);
  }, pick);
  await page.waitForTimeout(400);
  s = await inspector(page);
  H.check('adding an atom (main view) leaves the view where it was',
    sameCamera(cam0, s.camera) && s.atoms === (pick.os[2] != null ? 4 : 3), JSON.stringify({ cam0, cam: s.camera, atoms: s.atoms }));

  // ---- neighbours tool: the add-neighbour button at the top, explained behind an ⓘ ---------
  const top = await page.evaluate(async () => {
    const row = document.getElementById('siNeighbourRow');
    const eye = document.getElementById('siNeighboursTool');
    const view = document.getElementById('siViewport');
    const info = row.querySelector('.info-button');
    info.click();
    await new Promise((r) => setTimeout(r, 600));
    const panel = document.querySelector('.info-panel-content')?.textContent ?? '';
    document.querySelector('.info-panel-close')?.click();
    return {
      icon: eye.querySelector('img')?.getAttribute('src'),
      aboveView: row.getBoundingClientRect().bottom <= view.getBoundingClientRect().top,
      info: /Bonded neighbours/.test(panel),
    };
  });
  H.check('the neighbours tool is the add-neighbour button at the top, with its explanation behind ⓘ',
    /add-neighbour-icon\.svg$/.test(top.icon ?? '') && top.aboveView && top.info, JSON.stringify(top));

  // ---- Add neighbours tool ----------------------------------------------------------
  H.check('the tool is off until pressed: no faint atoms', s.neighbours === 0 && !s.neighbourTool && s.offered > 0,
    JSON.stringify({ neighbours: s.neighbours, tool: s.neighbourTool, offered: s.offered }));
  await H.clickById(page, 'siNeighboursTool');
  await page.waitForTimeout(400);
  s = await inspector(page);
  const pressed = await page.evaluate(() => document.getElementById('siNeighboursTool').getAttribute('aria-pressed'));
  H.check('pressing Add neighbours shows every bonded neighbour faintly, without moving the view',
    s.neighbourTool && pressed === 'true' && s.neighbours === s.offered && sameCamera(cam0, s.camera),
    JSON.stringify({ pressed, neighbours: s.neighbours, offered: s.offered }));

  // Double-click an empty corner: re-centre on everything, faint atoms included.
  await page.mouse.dblclick(s.viewport.left + 6, s.viewport.top + 6);
  await page.waitForTimeout(400);
  s = await inspector(page);
  H.check('double-click re-centres to show the faint atoms too',
    s.ghostScreen.every((g) => g.x >= s.viewport.left && g.x <= s.viewport.right && g.y >= s.viewport.top && g.y <= s.viewport.bottom),
    JSON.stringify({ ghosts: s.ghostScreen.length }));
  await H.shotCanvas(page, 'selectioninspector-neighbours');

  const others = [...s.solidScreen, ...s.labels];
  const ghost = (await onCanvas(page, s.ghostScreen.filter(inView)))
    .map((g) => ({ ...g, clear: Math.min(clearOf(g, others), clearOf(g, s.ghostScreen)) }))
    .sort((a, b) => b.clear - a.clear)[0];
  const before = s.selected;
  const cam1 = s.camera;
  await page.mouse.click(ghost.x, ghost.y);
  await page.waitForTimeout(500);
  s = await inspector(page);
  H.check('clicking a faint neighbour adds it (main view too); the tool stays on; the view stays',
    s.selected === before + 1 && s.atoms === before + 1 && s.neighbourTool && sameCamera(cam1, s.camera),
    JSON.stringify({ before, selected: s.selected, atoms: s.atoms, tool: s.neighbourTool }));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  s = await inspector(page);
  H.check('Esc ends the tool: the remaining faint atoms disappear, the selection stays',
    !s.neighbourTool && s.neighbours === 0 && s.selected === before + 1,
    JSON.stringify({ tool: s.neighbourTool, neighbours: s.neighbours, selected: s.selected }));
  await H.clickById(page, 'siNeighboursTool');
  await page.waitForTimeout(300);
  await H.clickById(page, 'siNeighboursTool');
  await page.waitForTimeout(300);
  s = await inspector(page);
  H.check('pressing the button again also ends it', !s.neighbourTool && s.neighbours === 0,
    JSON.stringify({ tool: s.neighbourTool, neighbours: s.neighbours }));

  // Ctrl-click a selected atom in the mini view removes it again.
  const victim = (await onCanvas(page, s.solidScreen.filter(inView)))
    .map((a) => ({ ...a, clear: Math.min(clearOf(a, s.solidScreen), clearOf(a, s.labels)) }))
    .sort((a, b) => b.clear - a.clear)[0];
  const n0 = s.selected;
  await page.keyboard.down('Control');
  await page.mouse.click(victim.x, victim.y);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  s = await inspector(page);
  H.check('Ctrl-click on a selected atom in the inspector removes it', s.selected === n0 - 1,
    JSON.stringify({ n0, selected: s.selected }));

  const offered = s.offered;
  const n1 = s.selected;
  await H.clickById(page, 'siAddAllNeighbours');
  await page.waitForTimeout(600);
  s = await inspector(page);
  H.check('Add all grows the selection', offered > 0 && s.selected > n1,
    JSON.stringify({ offered, before: n1, after: s.selected }));

  // ---- search ---------------------------------------------------------------------------
  await page.evaluate(async () => (await import('./ui/AnalysisPanels/SelectionInspector.js')).removeSelectionInspectorPanel());
  await page.waitForTimeout(300);
  const found = await page.evaluate(async () => {
    const fs = await import('./ui/FeatureSearch.js');
    fs.openFeatureSearch('inspect selection');
    await new Promise((r) => requestAnimationFrame(() => r()));
    return [...document.querySelectorAll('#featureSearchResults .feature-search-result')]
      .map((li) => li.querySelector('.feature-search-label').textContent);
  });
  const index = found.indexOf('Selection Inspector');
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const reopened = await page.evaluate(() => !!document.querySelector('.cv-panel[data-panel-id="selectionInspector"]'));
  H.check('the search finds "Selection Inspector" and opens it', index >= 0 && reopened,
    JSON.stringify({ index, top: found.slice(0, 4), reopened }));

  // ---- Move labels: the view stops turning, labels drag, a leader ties each
  // one to its bond or arc; pressing the button again turns the view again.
  // Last in the Selection Inspector part: turning the view leaves it coasting
  // (inertia), which would upset the "the view stays" checks above.
  s = await inspector(page);
  const modeState = () => page.evaluate(() => ({
    pressed: document.getElementById('siPlaceLabels').getAttribute('aria-pressed'),
    reset: !document.getElementById('siResetPlaces').hidden,
    hint: document.getElementById('siHint').textContent,
  }));
  const emptySpot = { x: s.viewport.left + 30, y: s.viewport.bottom - 30 };
  const dragFrom = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  };
  await H.clickById(page, 'siPlaceLabels');
  await page.waitForTimeout(200);
  let mode = await modeState();
  const placeCam0 = (await inspector(page)).camera;
  await dragFrom(emptySpot, 120, 40);
  s = await inspector(page);
  H.check('Move labels: the button is on, the hint says how, and dragging the view no longer turns it',
    mode.pressed === 'true' && /Drag a label/.test(mode.hint) && sameCamera(s.camera, placeCam0),
    JSON.stringify({ mode, placeCam0, cam: s.camera }));
  const grab = (await onCanvas(page, s.labels.filter((l) => l.visible && inView(l))))
    .map((l) => ({ ...l, clear: clearOf(l, s.labels) })).sort((p, q) => q.clear - p.clear)[0];
  await dragFrom(grab, 70, -45);
  s = await inspector(page);
  let movedLabel = s.labels.find((l) => l.key === grab.key);
  mode = await modeState();
  H.check('dragging a label moves it with the pointer, draws its leader, and offers Reset positions',
    movedLabel && Math.abs(movedLabel.x - grab.x - 70) < 3 && Math.abs(movedLabel.y - grab.y + 45) < 3 && movedLabel.moved && movedLabel.leader
      && movedLabel.visible && mode.reset && s.labels.filter((l) => l.moved).length === 1,
    JSON.stringify({ grab: { x: grab.x, y: grab.y }, movedLabel, mode }));
  // Touch drags a label too (pointer events; capture stubbed for synthetic ones).
  const touchGrab = (await onCanvas(page, s.labels.filter((l) => l.visible && !l.moved && inView(l))))[0];
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('#siViewport canvas');
    const capture = [Element.prototype.setPointerCapture, Element.prototype.releasePointerCapture];
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    try {
      const fire = (type, px, py) => canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: px, clientY: py, bubbles: true, cancelable: true,
      }));
      fire('pointerdown', x, y);
      for (let k = 1; k <= 5; k++) fire('pointermove', x - 8 * k, y + 6 * k);
      fire('pointerup', x - 40, y + 30);
    } finally {
      [Element.prototype.setPointerCapture, Element.prototype.releasePointerCapture] = capture;
    }
  }, touchGrab);
  await page.waitForTimeout(250);
  s = await inspector(page);
  const touched = s.labels.find((l) => l.key === touchGrab.key);
  H.check('a touch drag places a label too', touched?.moved && Math.abs(touched.x - touchGrab.x + 40) < 3 && Math.abs(touched.y - touchGrab.y - 30) < 3,
    JSON.stringify({ from: { x: touchGrab.x, y: touchGrab.y }, to: touched }));
  // Each moved label carries a ↺ while placing: it puts that one label back,
  // depth-tested again, without a leader.
  const returns = () => page.evaluate(() => [...document.querySelectorAll('#siViewport .pi-label-hotspot:not([hidden]) .pi-label-return')]
    .map((b) => { const r = b.getBoundingClientRect(); const h = b.parentElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, cx: h.left + h.width / 2, cy: h.top + h.height / 2, gap: h.left - r.right, icon: !!b.querySelector('svg') }; }));
  let rets = await returns();
  const placedNow = s.labels.filter((l) => l.moved);
  H.check('while placing, every moved label (and only those) carries a ↺ just left of it',
    rets.length === placedNow.length && rets.length === 2 && rets.every((r) => r.icon && r.gap >= 2 && r.gap <= 5 && Math.abs(r.y - r.cy) < 1.5)
      && placedNow.every((l) => rets.some((r) => Math.hypot(r.cx - l.x, r.cy - l.y) < 2)) && placedNow.every((l) => !l.depthTested),
    JSON.stringify({ rets, placedNow }));
  // The × still hides a label while placing: on hover, top-right corner.
  const placedOne = placedNow.find((l) => l.key === grab.key);
  await page.mouse.move(placedOne.x, placedOne.y, { steps: 3 });
  await page.waitForTimeout(200);
  const xWhilePlacing = await xButton(page, '#siViewport');
  const retOfIt = (await returns()).find((r) => Math.hypot(r.cx - placedOne.x, r.cy - placedOne.y) < 2);
  H.check('while placing, pointing at a label still shows its × — right of it, the ↺ left of it',
    xWhilePlacing.shown && xWhilePlacing.x > placedOne.x && retOfIt && retOfIt.x < placedOne.x
      && Math.abs(xWhilePlacing.y - retOfIt.y) < 2,
    JSON.stringify({ x: xWhilePlacing, ret: retOfIt, label: placedOne }));
  await page.mouse.move(emptySpot.x, emptySpot.y, { steps: 3 });
  await page.waitForTimeout(450);
  const back = rets.find((r) => Math.hypot(r.cx - touched.x, r.cy - touched.y) < 2);
  await page.mouse.click(back.x, back.y);
  await page.waitForTimeout(250);
  s = await inspector(page);
  const putBack = s.labels.find((l) => l.key === touchGrab.key);
  rets = await returns();
  H.check('its ↺ puts that label back on its bond: no leader, depth-tested again; the other stays placed',
    putBack && !putBack.moved && !putBack.leader && putBack.depthTested
      && Math.hypot(putBack.x - putBack.anchor.x, putBack.y - putBack.anchor.y) < 2
      && rets.length === 1 && s.labels.find((l) => l.key === grab.key)?.moved,
    JSON.stringify({ putBack, rets: rets.length }));
  // Off again: the view turns, the placed labels keep their place beside their bond.
  await H.clickById(page, 'siPlaceLabels');
  await page.waitForTimeout(200);
  mode = await modeState();
  await dragFrom(emptySpot, 60, 25);
  s = await inspector(page);
  movedLabel = s.labels.find((l) => l.key === grab.key);
  const offsetNow = movedLabel?.anchor ? Math.hypot(movedLabel.x - movedLabel.anchor.x, movedLabel.y - movedLabel.anchor.y) : 0;
  H.check('pressing Move labels again lets the view turn; placed labels stay placed, on their leaders, without ↺',
    mode.pressed === 'false' && !/Drag a label/.test(mode.hint) && !sameCamera(s.camera, placeCam0)
      && movedLabel?.moved && movedLabel.leader && offsetNow > 30 && (await returns()).length === 0,
    JSON.stringify({ mode, movedLabel, offsetNow }));
  await H.clickById(page, 'siResetPlaces');
  await page.waitForTimeout(250);
  s = await inspector(page);
  mode = await modeState();
  H.check('Reset positions puts every label back on its bond or angle, without leaders',
    s.labels.every((l) => !l.moved && !l.leader) && !mode.reset, JSON.stringify({ labels: s.labels, mode }));


  // ---- a narrow window ------------------------------------------------------------
  // At ≤ 1024 px the app's large-tap rung (styles/responsive.css) enlarges
  // .btn-mini; the inspector's row buttons are left out of it: they keep
  // their height and text size, never wrap their text or spill out of their
  // border, and the add-neighbour icon keeps its size.
  const layoutAt = (w) => page.evaluate(async (w) => {
    const btns = [...document.querySelectorAll('#selection-inspector-item .pi-btn')].filter((b) => b.offsetParent);
    const img = document.querySelector('#siNeighboursTool img').getBoundingClientRect();
    return {
      w,
      buttons: btns.length,
      bad: btns.map((b) => {
        const cs = getComputedStyle(b);
        return { id: b.id || b.textContent.trim(), h: b.getBoundingClientRect().height, fs: cs.fontSize,
          spills: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1 };
      }).filter((b) => Math.abs(b.h - 28) > 0.5 || b.fs !== '11px' || b.spills),
      icon: { w: Math.round(img.width), h: Math.round(img.height) },
      // Notes move to the next line, whole, instead of being cut off.
      notes: [...document.querySelectorAll('#selection-inspector-item .pi-ctl-note')]
        .filter((n) => n.offsetParent && n.textContent.trim())
        .map((n) => ({ text: n.textContent.trim().slice(0, 30), cut: n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1 })),
    };
  }, w);
  const wide = await layoutAt(1400);
  const narrowAt = async (w) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(800);
    return layoutAt(w);
  };
  const narrow = await narrowAt(900);
  const narrower = await narrowAt(800);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(800);
  H.check('in a narrow window the inspector buttons keep their size and text; the add-neighbour icon keeps its size',
    [wide, narrow, narrower].every((l) => l.buttons >= 6 && l.bad.length === 0 && l.icon.w === 28 && l.icon.h === 21),
    JSON.stringify({ wide, narrow, narrower }));
  H.check('and the notes beside them are shown whole (on the next line when there is no room)',
    [wide, narrow, narrower].every((l) => l.notes.length >= 1 && l.notes.every((n) => !n.cut)),
    JSON.stringify([wide, narrow, narrower].map((l) => l.notes)));

  // ---- the Polyhedron Inspector hides labels the same way --------------------------------
  await page.evaluate(async () => {
    const { removeSelectionInspectorPanel } = await import('./ui/AnalysisPanels/SelectionInspector.js');
    removeSelectionInspectorPanel();
  });
  await H.clickById(page, 'showPolyhedra'); // the Polyhedra window needs polyhedra on
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('polyhedra').expand();
  });
  await page.waitForTimeout(400);
  await H.clickById(page, 'openPolyhedronInspector');
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { selectAtomsByInstances } = await import('./ui/SelectAndHighlightModule.js');
    const s = fileBrowser.selectedStructure;
    const poly = s.polyhedra.polyhedra.find((p) => p.type === 'centered');
    selectAtomsByInstances([s.periodic.visibleWrapped.srcIndex.indexOf(poly.centerIndex)]);
  });
  // Opening the inspector forces Complete Polyhedra on, and the polyhedra are
  // recomputed over a few passes (a vertex can switch between two equally
  // distant images on the way) — wait until the labels stop moving.
  let p = null;
  for (let tries = 0, last = ''; tries < 20; tries++) {
    await page.waitForTimeout(400);
    p = await page.evaluate(async () => (await import('./ui/AnalysisPanels/PolyhedronInspector.js')).getInspectorState());
    const sig = JSON.stringify(p.labels.map((l) => [l.key, Math.round(l.x), Math.round(l.y), l.visible]));
    if (sig === last) break;
    last = sig;
  }
  const pv = p.viewport;
  // The label furthest (on screen) from every atom and other label: one at an
  // atom's edge can be occluded from one frame to the next.
  const plabel = (await onCanvas(page, p.labels.filter((l) => l.visible && l.x > pv.left + 8 && l.x < pv.right - 8 && l.y > pv.top + 8 && l.y < pv.bottom - 8)))
    .map((l) => ({ ...l, clear: Math.min(clearOf(l, p.atomScreen), clearOf(l, p.labels)) }))
    .sort((a, b) => b.clear - a.clear)[0];
  await page.mouse.move(plabel.x, plabel.y, { steps: 3 });
  await page.waitForTimeout(200);
  const px = await xButton(page, '#piViewport');
  if (px.shown) {
    await page.mouse.move(px.x, px.y, { steps: 3 });
    await page.mouse.click(px.x, px.y);
  }
  await page.waitForTimeout(300);
  p = await page.evaluate(async () => (await import('./ui/AnalysisPanels/PolyhedronInspector.js')).getInspectorState());
  H.check('Polyhedron Inspector: a polyhedron; a label\'s × hides it',
    !!p.polyKey && p.hiddenLabels.length === 1 && p.hiddenLabels[0] === plabel.key,
    JSON.stringify({ polyKey: p.polyKey, hidden: p.hiddenLabels }));
  await H.clickById(page, 'piShowLabels');
  await page.waitForTimeout(300);
  p = await page.evaluate(async () => (await import('./ui/AnalysisPanels/PolyhedronInspector.js')).getInspectorState());
  H.check('Polyhedron Inspector: Show all labels', p.hiddenLabels.length === 0, JSON.stringify(p.hiddenLabels));

  H.check('no page errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
