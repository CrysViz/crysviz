// Polyhedra ▸ Colour by: the range over a trajectory, the grey for the
// polyhedra a property does not apply to, the edge colours, and the reset
// when the Polyhedra window leaves the sidebar
// (render/PolyhedraFrameModule.js, ui/PolyhedraColorControls.js). Checks:
//  (a) on a 3-frame trajectory whose frame 3 is the most distorted, choosing
//      the property on frame 1 fits the bar to frame 3's maximum (all three
//      frames read, said under the bar); the sampling keeps first and last;
//  (b) the same fit in timer slices (the large-trajectory path): the bar
//      shows frame 1's range first, then the trajectory's;
//  (c) Grey the rest: a cuboctahedron under a tilt is grey with the switch
//      on, its style colour with it off;
//  (d) Edges: grey / the face's colour / the style's, in the table and the
//      GPU buffer;
//  (e) a collapse or a rebuild of the window keeps the colouring; taking the
//      window out of the sidebar resets Colour by to Style with the style
//      colours and no bar, and re-adding it starts at Style.
'use strict';
const H = require('../harness');

const AP = 3.905;

/** SrTiO3 2×2×2, 3 frames: a small jitter, and in frame 3 one O pushed
 *  0.3 Å along its Ti–O bond. */
function trajectory() {
  const n = 2;
  const basis = [['Sr', [0, 0, 0]], ['Ti', [0.5, 0.5, 0.5]], ['O', [0.5, 0.5, 0]], ['O', [0.5, 0, 0.5]], ['O', [0, 0.5, 0.5]]];
  const sites = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    for (const [el, f] of basis) sites.push([el, (f[0] + i) * AP, (f[1] + j) * AP, (f[2] + k) * AP]);
  }
  const L = n * AP;
  const wrap = (v) => ((v % L) + L) % L;
  const out = [];
  for (let t = 0; t < 3; t++) {
    out.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
    sites.forEach(([el, x, y, z], s) => {
      const w = (k) => 0.02 * Math.sin(0.9 * t + 1.7 * s + 2.1 * k);
      // site 2 is the O at (½, ½, 0) of Ti 1 (½, ½, ½): pushed along −z
      const push = t === 2 && s === 2 ? -0.3 : 0;
      out.push(`${el} ${wrap(x + w(0)).toFixed(5)} ${wrap(y + w(1)).toFixed(5)} ${wrap(z + w(2) + push).toFixed(5)}`);
    });
  }
  return out.join('\n');
}

async function loadText(page, text, name) {
  await page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, name);
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
  }, { text, name });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await loadText(page, trajectory(), 'sto_range.xyz');

  // ---------------------------------------------------------------- (a), (b)
  const a = await page.evaluate(async () => {
    const { structureShip, general } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const CC = await import('./ui/PolyhedraColorControls.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    general.showPolyhedra = true;
    general.polyhedraColor = 'style';
    showTrajectoryFrame(0, c, { full: true });
    await settle(300);
    await P.updatePolyhedra();
    openPanel('polyhedra');
    for (let i = 0; i < 25 && !document.getElementById('polyhedraColorBy'); i++) await settle(200);
    const sel = document.getElementById('polyhedraColorBy');
    const set = (value) => { sel.value = value; sel.dispatchEvent(new Event('change')); };
    const out = { frames: c.frameCount, kind: c.motionProfile().kind };
    // each frame's own maximum (fitted on that frame alone: a fresh fit
    // while it is shown — every frame is read again, so compare the values)
    const maxOf = () => Math.max(...Array.from(F.polyhedraPropertyValues()).filter(Number.isFinite));
    general.polyhedraColor = 'bld';
    const own = [];
    for (const f of [2, 1, 0]) {
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      await settle(50);
      own[f] = maxOf();
    }
    general.polyhedraColor = 'style';
    P.updatePolyhedraColors();
    await settle(50);
    // (a) choose the property on frame 1
    set('bld');
    await settle(200);
    out.own = own;
    out.max = general.polyhedraColorMax;
    out.info = F.polyhedraColorRangeInfo();
    out.note = document.getElementById('polyhedraColorRangeNote')?.textContent;
    out.noteShown = document.getElementById('polyhedraColorRangeNote')?.style.display !== 'none';
    out.bar = !!CC.polyhedraColorBar();
    out.samples = { s3: F.sampleFrameSteps(3), s1000: F.sampleFrameSteps(1000) };
    // (b) the sliced path: frame 1's range first, the trajectory's after
    F.setPolyhedraRangeSyncLimit(1);
    general.polyhedraColorMin = null;
    general.polyhedraColorMax = null;
    P.updatePolyhedraColors();
    out.slicedFirst = { max: general.polyhedraColorMax, info: F.polyhedraColorRangeInfo(), note: document.getElementById('polyhedraColorRangeNote')?.textContent };
    for (let i = 0; i < 40 && F.polyhedraColorRangeInfo().pending; i++) await settle(50);
    out.slicedAfter = { max: general.polyhedraColorMax, info: F.polyhedraColorRangeInfo(), note: document.getElementById('polyhedraColorRangeNote')?.textContent };
    // typed limits while a sliced fit runs are kept
    general.polyhedraColorMin = null;
    general.polyhedraColorMax = null;
    P.updatePolyhedraColors();
    general.polyhedraColorMin = 0;
    general.polyhedraColorMax = 0.5;
    P.updatePolyhedraColors();
    for (let i = 0; i < 40 && F.polyhedraColorRangeInfo().pending; i++) await settle(50);
    out.typedKept = [general.polyhedraColorMin, general.polyhedraColorMax];
    document.dispatchEvent(new CustomEvent('crysviz:polyhedra-rebuilt'));
    out.typedNote = document.getElementById('polyhedraColorRangeNote')?.style.display;
    F.setPolyhedraRangeSyncLimit();
    return out;
  });
  console.log(`  ${a.frames} frames (${a.kind}); own max per frame ${a.own.map((x) => x.toFixed(4)).join(', ')}; bar max ${a.max?.toFixed(4)}; note "${a.note}"`);
  H.check('(a) the trajectory is a 3-frame motion', a.frames === 3 && a.kind === 'trajectory', JSON.stringify(a));
  H.check('(a) frame 3 is the most distorted', a.own[2] > a.own[0] + 0.01 && a.own[2] > a.own[1] + 0.01, JSON.stringify(a.own));
  H.check('(a) chosen on frame 1, the bar max is frame 3\'s value',
    Math.abs(a.max - a.own[2]) < 1e-5 * Math.max(1, a.own[2]), `${a.max} vs ${a.own[2]}`);
  H.check('(a) the range read all three frames, and says so under the bar',
    a.info.frames === 3 && a.info.of === 3 && !a.info.pending && a.noteShown && /all 3 frames/.test(a.note ?? ''), JSON.stringify(a));
  H.check('(a) sampling: every frame of 3; 25 of 1000 with first and last',
    a.samples.s3.join() === '0,1,2' && a.samples.s1000.length === 25 && a.samples.s1000[0] === 0 && a.samples.s1000[24] === 999,
    JSON.stringify(a.samples));
  H.check('(b) sliced fit: frame 1\'s range first, pending',
    a.slicedFirst.info.pending && Math.abs(a.slicedFirst.max - a.own[0]) < 1e-5 && /reading/.test(a.slicedFirst.note ?? ''), JSON.stringify(a.slicedFirst));
  H.check('(b) sliced fit: then the trajectory\'s range',
    !a.slicedAfter.info.pending && a.slicedAfter.info.frames === 3 && Math.abs(a.slicedAfter.max - a.own[2]) < 1e-5,
    JSON.stringify(a.slicedAfter));
  H.check('(b) limits typed while it runs are kept, without the range note',
    a.typedKept[0] === 0 && a.typedKept[1] === 0.5 && a.typedNote === 'none', JSON.stringify([a.typedKept, a.typedNote]));

  // ---------------------------------------------------------------- (c), (d)
  const c = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const P = await import('./render/PolyhedraModule.js');
    const F = await import('./render/PolyhedraFrameModule.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const sel = document.getElementById('polyhedraColorBy');
    const set = (el, value) => { el.value = value; el.dispatchEvent(new Event('change')); };
    const grey = /** @type {HTMLInputElement} */ (document.getElementById('polyhedraColorGreyOthers'));
    const edges = document.getElementById('polyhedraColorEdges');
    const shown = (el) => !!el && el.closest('label, .control-row').style.display !== 'none';
    const out = {};
    set(sel, 'style');
    await settle(100);
    out.rowsAtStyle = { grey: shown(grey), edges: shown(edges) };
    const style = P.polyhedraInfo();
    out.cns = [...new Set(style.map((p) => p.cn))];
    set(sel, 'tiltC');
    await settle(100);
    out.rowsAtProperty = { grey: shown(grey), edges: shown(edges) };
    out.defaults = { grey: grey.checked, edges: edges.value };
    const vals = Array.from(F.polyhedraPropertyValues());
    const info = () => P.polyhedraInfo();
    const noValue = style.findIndex((p) => !Number.isFinite(vals[p.index]));
    const valued = style.findIndex((p) => Number.isFinite(vals[p.index]));
    out.noValueCn = style[noValue]?.cn;
    const table = P.polyhedraTable();
    const gpuEdge = (i) => {
      const arr = table.edgeGeometry.getAttribute('instanceColorStart').data.array;
      const o = 6 * table.edgeStart[i];
      return [arr[o], arr[o + 1], arr[o + 2]].map((x) => Number(x.toFixed(4)));
    };
    const tableEdge = (i) => [0, 1, 2].map((k) => Number(table.edgeColor[3 * i + k].toFixed(4)));
    // (c) on: grey; off: the style colour
    out.greyOn = { face: info()[noValue].color, edge: info()[noValue].edgeColor };
    grey.click();
    await settle(100);
    out.greyOff = { face: info()[noValue].color, edge: info()[noValue].edgeColor, saved: general.polyhedraColorGreyOthers };
    out.styleNoValue = { face: style[noValue].color, edge: style[noValue].edgeColor };
    grey.click();
    await settle(100);
    // (d) the three edge choices on a row with a value
    const vi = style[valued].index;
    const pick = async (mode) => {
      set(edges, mode);
      await settle(100);
      const p = info()[valued];
      return { face: p.color, edge: p.edgeColor, table: tableEdge(vi), gpu: gpuEdge(vi) };
    };
    out.edgeGrey = await pick('grey');
    out.edgeProperty = await pick('property');
    out.edgeStyle = await pick('style');
    out.styleValued = { face: style[valued].color, edge: style[valued].edgeColor };
    out.savedEdges = JSON.parse(localStorage.getItem('crysvizPolyhedraColor') || '{}').edges;
    set(edges, 'grey');
    await settle(100);
    return out;
  });
  console.log(`  CNs ${c.cns.join(',')}; no-value row CN ${c.noValueCn}: on ${c.greyOn.face}/${c.greyOn.edge}, off ${c.greyOff.face}/${c.greyOff.edge}; edges grey ${c.edgeGrey.edge}, property ${c.edgeProperty.edge} (face ${c.edgeProperty.face}), style ${c.edgeStyle.edge}`);
  H.check('(c)(d) Grey the rest and Edges show with a property only, defaults on and Grey',
    !c.rowsAtStyle.grey && !c.rowsAtStyle.edges && c.rowsAtProperty.grey && c.rowsAtProperty.edges
      && c.defaults.grey === true && c.defaults.edges === 'grey', JSON.stringify(c));
  H.check('(c) switch on: a polyhedron without a value is grey', c.noValueCn === 12 && c.greyOn.face === '#808080', JSON.stringify(c));
  H.check('(c) switch off: its style colours (face and edges)',
    c.greyOff.face === c.styleNoValue.face && c.greyOff.edge === c.styleNoValue.edge && c.greyOff.saved === false, JSON.stringify(c));
  const same = (x, y) => x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
  H.check('(d) Edges Grey: the edge grey, in the table and the GPU buffer',
    c.edgeGrey.edge === '#555555' && same(c.edgeGrey.table, c.edgeGrey.gpu), JSON.stringify(c.edgeGrey));
  H.check('(d) Edges Property: the face\'s colour', c.edgeProperty.edge === c.edgeProperty.face
    && c.edgeProperty.face !== c.styleValued.face && same(c.edgeProperty.table, c.edgeProperty.gpu), JSON.stringify(c.edgeProperty));
  H.check('(d) Edges Style: the style\'s edge colour', c.edgeStyle.edge === c.styleValued.edge
    && same(c.edgeStyle.table, c.edgeStyle.gpu) && c.savedEdges === 'style', JSON.stringify(c.edgeStyle));

  // ---------------------------------------------------------------- (e)
  const e = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const P = await import('./render/PolyhedraModule.js');
    const PM = await import('./ui/panels/PanelManager.js');
    const CC = await import('./ui/PolyhedraColorControls.js');
    const { refreshPolyhedraPanel } = await import('./ui/PolyhedraPanel.js');
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (value) => { const s = document.getElementById('polyhedraColorBy'); s.value = value; s.dispatchEvent(new Event('change')); };
    set('style');
    await settle(100);
    const style = P.polyhedraInfo().map((p) => p.color + p.edgeColor);
    set('bld');
    await settle(100);
    const out = {};
    out.coloured = P.polyhedraInfo().some((p, i) => p.color + p.edgeColor !== style[i]);
    // collapse and rebuild keep it
    const panel = PM.getPanel('polyhedra');
    panel.collapse();
    await settle(100);
    refreshPolyhedraPanel();
    await settle(100);
    out.afterCollapse = general.polyhedraColor;
    panel.expand?.();
    await settle(200);
    // remove from the sidebar
    PM.removeStoreFeature('polyhedra');
    await settle(200);
    out.afterRemove = general.polyhedraColor;
    out.inSidebar = PM.isPanelInSidebar('polyhedra');
    out.restored = P.polyhedraInfo().every((p, i) => p.color + p.edgeColor === style[i]);
    out.bar = !!CC.polyhedraColorBar();
    out.saved = JSON.parse(localStorage.getItem('crysvizPolyhedraColor') || '{}').color;
    PM.addStoreFeature('polyhedra');
    for (let i = 0; i < 25 && !document.getElementById('polyhedraColorBy')?.isConnected; i++) await settle(200);
    out.readded = document.getElementById('polyhedraColorBy')?.value;
    return out;
  });
  H.check('(e) collapse and rebuild of the window keep the colouring', e.coloured && e.afterCollapse === 'bld', JSON.stringify(e));
  H.check('(e) removing the window resets Colour by to Style, style colours, no bar',
    e.afterRemove === 'style' && !e.inSidebar && e.restored && !e.bar && e.saved === 'style', JSON.stringify(e));
  H.check('(e) re-added, it starts at Style', e.readded === 'style', JSON.stringify(e));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
