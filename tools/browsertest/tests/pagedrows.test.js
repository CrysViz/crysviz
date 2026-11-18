// Paged row lists in the Structure window (ui/StructureInfoPanel/components/PagedRows.js).
// A 3D pick reveals the picked atom's row, which built one heavy row per atom
// of its element: on a 50k-atom trajectory that took minutes and gigabytes.
//  1. Small structure: the element's list holds every row, no pager — as before.
//  2. 1728 Si atoms: picking atom 1500 opens its element list on the page that
//     holds it — one page of rows, the picked row highlighted; the pager steps
//     pages and "Go to #" jumps; a composition rebuild keeps the page.
//  3. Picking a bond opens the pair's list on the bond's page, row highlighted.
//  4. Element numbering ("Si12") from the shared per-batch pass equals the
//     per-row scan it replaces, hidden atoms included.
//  5. A selected atom keeps its highlight colour on force-map fast frames.
'use strict';
const H = require('../harness');

function trajectory(n, frames) {
  const a = 5.43;
  const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
    [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
  const L = n * a;
  const sites = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    for (const f of base) sites.push([(f[0] + i) * a + 0.3, (f[1] + j) * a + 0.3, (f[2] + k) * a + 0.3]);
  }
  const parts = [];
  for (let t = 0; t < frames; t++) {
    parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3:forces:R:3`);
    sites.forEach((p, s) => {
      const d = 0.05 * Math.sin(0.9 * t + 1.7 * s);
      parts.push(`Si ${(p[0] + d).toFixed(4)} ${p[1].toFixed(4)} ${p[2].toFixed(4)} ${(((s * 7 + t * 3) % 11) * 0.9).toFixed(3)} 0 0`);
    });
  }
  return parts.join('\n');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const load = (text, name) => page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, general } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, name);
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    general.linkPeriodicCopies = true;
    await new Promise((r) => setTimeout(r, 300));
  }, { text, name });

  // ---- 1. Small structure: every row, no pager ----
  await load(trajectory(2, 1), 'small.xyz');
  const small = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const sel = await import('./ui/SelectAndHighlightModule.js');
    sel.updateAtomSelectionFrom3DHit({ instanceId: 10, object: groups.atomsMesh }, { scrollToSelection: false, revealPanel: true });
    const list = document.querySelector('.comp-container[data-element="Si"] .individual-atoms');
    return {
      rows: list.querySelectorAll('.individual-atom-row').length,
      pager: !!list.querySelector('.row-pager'),
      directChildren: [...list.children].every((c) => c.classList.contains('individual-atom-row')),
    };
  });
  H.check('small structure: the list holds every atom row, no pager (unchanged)',
    small.rows === 64 && !small.pager && small.directChildren, JSON.stringify(small));

  // ---- 2-5. 1728 atoms ----
  await load(trajectory(6, 3), 'large.xyz');
  const big = await page.evaluate(async () => {
    const { groups, fileBrowser, highlightHover, general, structureShip } = await import('./state/store.js');
    const sel = await import('./ui/SelectAndHighlightModule.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { getElementAtomIndices, elementAtomNumber } = await import('./ui/StructureInfoPanel/components/utils.js');
    const { ROW_PAGE_SIZE } = await import('./ui/StructureInfoPanel/components/PagedRows.js');
    const s = fileBrowser.selectedStructure;
    const out = { atoms: s.atoms.length };
    const list = () => document.querySelector('.comp-container[data-element="Si"] .individual-atoms');
    const rowIndices = () => [...list().querySelectorAll('.individual-atom-row')].map((r) => Number(r.dataset.atomIndex));
    const range = () => list().querySelector('.row-pager-range')?.textContent ?? null;

    // 2. Pick atom 1500 (no periodic images drawn: instance = source atom).
    const inst = s.atomImages[1500][0];
    const t = performance.now();
    sel.updateAtomSelectionFrom3DHit({ instanceId: inst, object: groups.atomsMesh }, { scrollToSelection: false, revealPanel: true });
    out.pickMs = Math.round(performance.now() - t);
    out.pick = { rows: rowIndices().length, first: rowIndices()[0], range: range(), open: list().style.display !== 'none',
      highlighted: highlightHover.currentlyHighlightedRow?.dataset.atomIndex, connected: highlightHover.currentlyHighlightedRow?.isConnected };
    list().querySelector('.row-pager-next').click();
    out.next = { first: rowIndices()[0], range: range() };
    const go = list().querySelector('.row-pager-goto');
    go.value = '5'; go.dispatchEvent(new Event('change'));
    out.goto = { first: rowIndices()[0], hasSi5: rowIndices().includes(getElementAtomIndices('Si', { includeHidden: true })[4]) };
    // Back to the picked page, then a composition rebuild keeps it.
    sel.updateAtomSelectionFrom3DHit({ instanceId: s.atomImages[200][0], object: groups.atomsMesh }, { scrollToSelection: false, revealPanel: true });
    sel.updateAtomSelectionFrom3DHit({ instanceId: inst, object: groups.atomsMesh }, { scrollToSelection: false, revealPanel: true });
    updateVisualization({ bondsUpdate: false, reRenderAtoms: false, reRenderBonds: false, reRenderLattice: false, reRenderOther: false, reRenderComposition: 'open' });
    out.rebuilt = { rows: rowIndices().length, first: rowIndices()[0], open: list().style.display !== 'none' };

    // 3. Bond pick.
    const half = groups.bondsMesh.count - 7;
    const bondIndex = s.bondObjectMapping[half][0];
    sel.selectBondFromInstance(half, { scrollToSelection: false });
    const bondRows = [...document.querySelectorAll('.individual-bond-row')];
    out.bond = { rows: bondRows.length, pager: document.querySelector('.individual-bonds .row-pager-range')?.textContent ?? null,
      highlighted: highlightHover.currentlyHighlightedRow?.classList.contains('individual-bond-row') && highlightHover.currentlyHighlightedRow.isConnected,
      group: highlightHover.currentlyHighlightedBond?.groupKey === highlightHover.currentlyHighlightedRow?.dataset.groupKey,
      bondIndex };
    sel.clearAllHighlights({});

    // 4. Numbering, with some atoms hidden.
    [3, 50, 900].forEach((i) => { s.atoms[i].hidden = true; });
    const visible = getElementAtomIndices('Si');
    const probe = [0, 2, 3, 4, 51, 899, 901, 1727];
    out.numbers = probe.every((i) => elementAtomNumber('Si', i) === visible.indexOf(i) + 1);
    // Inside a list build (one shared pass) the numbers are the same.
    const { fillRows } = await import('./ui/StructureInfoPanel/components/PagedRows.js');
    const inBatch = [];
    fillRows(document.createElement('div'), probe.length, (k) => { inBatch.push(elementAtomNumber('Si', probe[k])); return document.createElement('div'); });
    out.numbersBatch = inBatch.every((n, k) => n === visible.indexOf(probe[k]) + 1);
    [3, 50, 900].forEach((i) => { s.atoms[i].hidden = false; });
    out.numbersFresh = elementAtomNumber('Si', 4) === 5;
    out.pageSize = ROW_PAGE_SIZE;
    return out;
  });
  H.check(`picking atom 1500 of ${big.atoms} opens its list on the page holding it, row highlighted (${big.pickMs} ms)`,
    big.pick.rows === big.pageSize && big.pick.open && big.pick.highlighted === '1500' && big.pick.connected
      && big.pick.first === 1500 && /1,501–1,600 of 1,728 atoms/.test(big.pick.range), JSON.stringify(big.pick));
  H.check('the pager steps to the next page', big.next.first === 1600 && /1,601–1,700/.test(big.next.range), JSON.stringify(big.next));
  H.check('"Go to #" brings up the page holding that number', big.goto.first === 0 && big.goto.hasSi5, JSON.stringify(big.goto));
  H.check('a composition rebuild keeps the open list on its page',
    big.rebuilt.open && big.rebuilt.first === 1500 && big.rebuilt.rows === big.pageSize, JSON.stringify(big.rebuilt));
  H.check('picking a bond opens its pair list on the bond\'s page, row highlighted',
    big.bond.rows > 0 && big.bond.rows <= big.pageSize && /of [\d,]+ bonds/.test(big.bond.pager) && big.bond.highlighted && big.bond.group, JSON.stringify(big.bond));
  H.check('element numbering from the shared pass equals the per-row scan (hidden atoms included), and is not cached past a list build',
    big.numbers && big.numbersBatch && big.numbersFresh, JSON.stringify({ numbers: big.numbers, batch: big.numbersBatch, fresh: big.numbersFresh }));

  // ---- 5. Highlight through force-map fast frames ----
  const hl = await page.evaluate(async () => {
    const { groups, fileBrowser, general, structureShip } = await import('./state/store.js');
    const sel = await import('./ui/SelectAndHighlightModule.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const trace = await import('./debug/debugTrace.js');
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    general.atomsColor = 'force'; general.ForceMin = 0; general.ForceMax = 9;
    showTrajectoryFrame(0, c, { full: true, recenter: false });
    const s = fileBrowser.selectedStructure;
    const inst = s.atomImages[700][0];
    const other = s.atomImages[701][0];
    sel.updateAtomSelectionFrom3DHit({ instanceId: inst, object: groups.atomsMesh }, { scrollToSelection: false, revealPanel: false });
    const rgb = (i) => Array.from(groups.atomsMesh.instanceColor.array.slice(i * 3, i * 3 + 3)).map((x) => x.toFixed(3)).join();
    const before = { sel: rgb(inst), other: rgb(other) };
    const c0 = trace.counters();
    showTrajectoryFrame(1, c, { full: false, playback: { forceFull: false }, recenter: false });
    const fast = (trace.counters().playbackFast || 0) - (c0.playbackFast || 0);
    const after = { sel: rgb(inst), other: rgb(other), glow: groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.getX(inst) };
    sel.clearAllHighlights({});
    general.atomsColor = 'elements';
    return { fast, before, after };
  });
  H.check('a selected atom keeps its highlight colour on a force-map fast frame (others recoloured)',
    hl.fast === 1 && hl.after.sel === hl.before.sel && hl.after.glow > 0 && hl.after.other !== hl.before.other, JSON.stringify(hl));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
