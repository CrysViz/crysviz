// Category-level styles apply to the WHOLE trajectory, individual edits stay
// per frame (model/materializeFrame.js SHARED_STYLE_DICTS / FRAME_STYLE_DICTS,
// TrajectoryContainer._sharedStyles). A polyhedra category hidden on one
// frame stays hidden on every frame (fast and full path) until it is shown
// again on any frame; the same for a bond pair colour, an element material
// and the polyhedra settings (Detect Cages). A per-atom colour is still per
// frame. A category edit never holds playback off the fast path, and a
// .crysviz session round-trips the shared styles.
'use strict';
const H = require('../harness');

const AP = 3.905;

/** Extended-XYZ trajectory of SrTiO3 n×n×n, jittered per frame. */
function trajectory(n, frames) {
  const basis = [['Sr', [0, 0, 0]], ['Ti', [0.5, 0.5, 0.5]], ['O', [0.5, 0.5, 0]], ['O', [0.5, 0, 0.5]], ['O', [0, 0.5, 0.5]]];
  const sites = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    for (const [el, f] of basis) sites.push([el, (f[0] + i) * AP, (f[1] + j) * AP, (f[2] + k) * AP]);
  }
  const L = n * AP;
  const out = [];
  for (let t = 0; t < frames; t++) {
    out.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
    sites.forEach(([el, x, y, z], s) => {
      const w = (k) => 0.04 * Math.sin(0.9 * t + 1.7 * s + 2.1 * k);
      const wrap = (v) => ((v % L) + L) % L;
      out.push(`${el} ${wrap(x + w(0)).toFixed(5)} ${wrap(y + w(1)).toFixed(5)} ${wrap(z + w(2)).toFixed(5)}`);
    });
  }
  return out.join('\n');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, general } = await import('./state/store.js');
    general.showPolyhedra = true;
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'sto_shared.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
  }, trajectory(2, 8));

  const r = await page.evaluate(async () => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const trace = await import('./debug/debugTrace.js');
    const settle = (ms) => new Promise((res) => setTimeout(res, ms));
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    const play = (f) => {
      const c0 = trace.counters();
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      const c1 = trace.counters();
      return (c1.playbackFast || 0) > (c0.playbackFast || 0) ? 'fast' : ((c1.playbackFull || 0) > (c0.playbackFull || 0) ? 'full' : 'none');
    };
    const full = async (f) => {
      showTrajectoryFrame(f, c, { full: true });
      await settle(300);
      await P.updatePolyhedra();
      await settle(100);
    };
    const s = () => fileBrowser.selectedStructure;
    const view = () => ({
      step: c.frameIndexOf(s()),
      drawn: P.polyhedraDrawnCount(),
      shown: P.polyhedraDrawnCount({ shownOnly: true }),
    });
    const out = {};

    // --- polyhedra category hidden on frame 0 --------------------------------
    await full(0);
    const table = P.polyhedraTable();
    let row = 0;
    for (let i = 0; i < table.n; i++) if (String(table.catKey[i]).includes('Ti')) { row = i; break; }
    const cat = table.catKey[row];
    out.cat = cat;
    out.start = view();
    s().polyhedraCategoryStyles[cat] = { ...(s().polyhedraCategoryStyles[cat] ?? {}), visible: false };
    P.updatePolyhedraColors();
    await settle(100);
    out.hidden0 = view();
    const stats0 = F.polyhedraFastFrameStats().fastFrames;
    out.path1 = play(1);
    out.f1 = { ...view(), cat: s().polyhedraCategoryStyles[cat] ?? null };
    await full(2);
    out.f2 = { ...view(), cat: s().polyhedraCategoryStyles[cat] ?? null };
    await full(0);
    out.back0 = { ...view(), cat: s().polyhedraCategoryStyles[cat] ?? null };
    out.records = [0, 1, 2].map((k) => c.hasFrameStyles(k));
    // unhide on frame 2: visible everywhere
    await full(2);
    delete s().polyhedraCategoryStyles[cat];
    P.updatePolyhedraColors();
    await settle(100);
    out.unhid2 = view();
    await full(0);
    out.unhid0 = view();
    out.path1b = play(1);
    out.unhid1 = view();

    // --- bond pair colour and element material set on frame 1 -----------------
    s().bondCategoryStyles['O-Ti'] = { color: '#ff0000' };
    s().atomMaterials.Ti = { type: 'metal', roughness: 0.2 };
    out.path2 = play(2);
    out.f2Bond = { cat: s().bondCategoryStyles['O-Ti'] ?? null, mat: s().atomMaterials.Ti ?? null };
    await full(3);
    const bond = s().bonds.find((b) => b.instanceIds && b.elements.includes('Ti') && b.elements.includes('O'));
    out.f3Bond = { cat: s().bondCategoryStyles['O-Ti'] ?? null, rendered: bond?.color?.[0] ?? null, mat: s().atomMaterials.Ti ?? null };
    const det = await Promise.resolve(c.frameAtDetached(6));
    out.detached6 = { cat: det.bondCategoryStyles['O-Ti'] ?? null, mat: det.atomMaterials.Ti ?? null,
      copy: det.bondCategoryStyles !== s().bondCategoryStyles };

    // --- Detect Cages off on frame 3 -----------------------------------------
    s().polyhedraSettings.detectCages = false;
    out.path4 = play(4);
    out.f4Settings = { ...s().polyhedraSettings };
    await full(5);
    out.f5Settings = { ...s().polyhedraSettings };

    // --- a per-atom colour on frame 5 stays per frame -------------------------
    s().atoms[0].userColor = '#ff0000';
    out.path6 = play(6);
    out.f6Atom = s().atoms[0].userColor;
    await full(5);
    out.f5Atom = s().atoms[0].userColor;
    out.records5 = c.hasFrameStyles(5);
    out.records6 = c.hasFrameStyles(6);

    // --- fast path after category edits: a forward run --------------------------
    s().polyhedraCategoryStyles[cat] = { visible: false };
    P.updatePolyhedraColors();
    await full(0);
    const fastBefore = F.polyhedraFastFrameStats().fastFrames;
    out.run = [];
    for (let f = 1; f < 5; f++) out.run.push(play(f));
    out.polyFastRun = F.polyhedraFastFrameStats().fastFrames - fastBefore;
    out.runEnd = { ...view(), cat: s().polyhedraCategoryStyles[cat] ?? null };
    out.polyFastFirst = F.polyhedraFastFrameStats().fastFrames - stats0;
    out.cageOff = s().polyhedraSettings.detectCages;
    return out;
  });

  const hiddenCount = r.hidden0.drawn - r.hidden0.shown;
  console.log(`  category ${r.cat}: ${r.start.drawn} polyhedra, ${hiddenCount} hidden on frame 0`);
  H.check('hiding a polyhedra category on frame 0 hides some polyhedra', hiddenCount > 0 && r.start.shown === r.start.drawn, JSON.stringify([r.start, r.hidden0]));
  H.check('frame 1 (fast path) keeps the category hidden',
    r.path1 === 'fast' && r.f1.cat?.visible === false && r.f1.drawn - r.f1.shown === hiddenCount, JSON.stringify([r.path1, r.f1]));
  H.check('frame 2 (full path) keeps the category hidden',
    r.f2.cat?.visible === false && r.f2.drawn > r.f2.shown, JSON.stringify(r.f2));
  H.check('back on frame 0 the category is still hidden',
    r.back0.cat?.visible === false && r.back0.drawn > r.back0.shown, JSON.stringify(r.back0));
  H.check('a category edit writes no per-frame record', r.records.every((x) => x === false), JSON.stringify(r.records));
  H.check('shown again on frame 2: visible on frames 2, 0 and 1',
    r.unhid2.shown === r.unhid2.drawn && r.unhid0.shown === r.unhid0.drawn && r.unhid1.shown === r.unhid1.drawn,
    JSON.stringify([r.unhid2, r.unhid0, r.path1b, r.unhid1]));
  H.check('a bond pair colour and an element material follow to other frames (fast and full)',
    r.f2Bond.cat?.color === '#ff0000' && r.f2Bond.mat?.type === 'metal'
      && r.f3Bond.cat?.color === '#ff0000' && r.f3Bond.rendered === '#ff0000' && r.f3Bond.mat?.type === 'metal',
    JSON.stringify([r.path2, r.f2Bond, r.f3Bond]));
  H.check('a detached frame carries copies of the shared styles',
    r.detached6.cat?.color === '#ff0000' && r.detached6.mat?.type === 'metal' && r.detached6.copy, JSON.stringify(r.detached6));
  H.check('Detect Cages off on frame 3 stays off on frames 4 and 5',
    r.f4Settings.detectCages === false && r.f5Settings.detectCages === false && r.f5Settings.useChemicalFilter === true,
    JSON.stringify([r.path4, r.f4Settings, r.f5Settings]));
  H.check('a per-atom colour stays on its frame (6 default, 5 red)',
    r.f6Atom === null && r.f5Atom === '#ff0000' && r.records5 && !r.records6, JSON.stringify([r.f6Atom, r.f5Atom, r.records5, r.records6]));
  H.check('playback after category edits takes the fast path and keeps the category hidden',
    r.run.every((x) => x === 'fast') && r.polyFastRun === r.run.length && r.runEnd.cat?.visible === false
      && r.runEnd.drawn > r.runEnd.shown,
    JSON.stringify([r.run, r.polyFastRun, r.runEnd]));

  // --- session round trip --------------------------------------------------------
  const sess = await page.evaluate(async (cat) => {
    const { structureShip, fileBrowser, general } = await import('./state/store.js');
    const { captureState, applySharedState, waitForStateRestoration } = await import('./ui/ShareModule.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const settle = (ms) => new Promise((res) => setTimeout(res, ms));
    const state = JSON.parse(JSON.stringify(captureState({ includeFrames: true })));
    const before = structureShip.container.length;
    applySharedState(state, 'shared.crysviz');
    await waitForStateRestoration();
    await settle(300);
    const c = structureShip.container[structureShip.container.length - 1];
    const fresh = structureShip.container.length > before;
    showTrajectoryFrame(2, c, { full: true });
    await settle(300);
    const s = fileBrowser.selectedStructure;
    const shared = c.sharedStyles();
    const det = await Promise.resolve(c.frameAtDetached(7));
    return {
      fresh,
      frames: c.frameCount,
      saved: { poly: state.colors.polyhedraCategoryStyles?.[cat] ?? null, bond: state.colors.bondCategoryStyles?.['O-Ti'] ?? null },
      f2: { poly: s.polyhedraCategoryStyles[cat] ?? null, bond: s.bondCategoryStyles['O-Ti'] ?? null, mat: s.atomMaterials.Ti ?? null },
      f7: { poly: det.polyhedraCategoryStyles[cat] ?? null, bond: det.bondCategoryStyles['O-Ti'] ?? null },
      sharedKeys: Object.keys(shared?.dicts ?? {}).sort(),
      polyOn: general.showPolyhedra,
    };
  }, r.cat);
  H.check('a .crysviz session round-trips the shared styles onto every frame',
    sess.fresh && sess.frames === 8 && sess.saved.poly?.visible === false && sess.saved.bond?.color === '#ff0000'
      && sess.f2.poly?.visible === false && sess.f2.bond?.color === '#ff0000' && sess.f2.mat?.type === 'metal'
      && sess.f7.poly?.visible === false && sess.f7.bond?.color === '#ff0000',
    JSON.stringify(sess));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly|esm\.sh|Failed to load resource/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
