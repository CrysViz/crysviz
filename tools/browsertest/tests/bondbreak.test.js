// The bond breaking tolerance during MD / trajectory playback
// (render/BondBreakTolerance.js, general.bondBreakTolerance): a bond — and
// the polyhedron corner with it — that exists keeps existing until its
// length exceeds cutoff × (1 + tol); one that does not exist forms within
// the plain cutoff. One O of SrTiO3 3×3×3 is driven away from its Ti along
// the Ti–O–Ti axis, frame by frame through applyFrameFast (the MD update:
// positions written to the atoms), with the Ti–O cutoff set to 2.10 Å.
//  (i)   tol 10 %: the bond and the corner (table cn, polyhedronInfo, the
//        model polyhedron's vertices) survive up to 1.1 × cutoff and go
//        beyond it;
//  (ii)  brought back, they return only within the cutoff;
//  (iii) tol 0: both switch at the cutoff, both ways;
//  (iv)  a full rebuild keeps a bond / corner held by the tolerance, and
//        drops one beyond it (or one not drawn before the rebuild);
//  (v)   a returning corner re-triangulates its polyhedron (2V − 4 faces);
//  (vi)  in every checked frame the drawn bonds and the polyhedra corners
//        agree (every centred polyhedron inside the cell, every corner);
//  (vii) no page errors.
'use strict';
const H = require('../harness');

const AP = 3.905;
const N = 3;
const CUT = 2.10;

/** SrTiO3 N×N×N as POSCAR; returns the text and the indices of the driven
 *  Ti (cell 1,1,1) and of its +x O. */
function poscar() {
  const by = { Sr: [], Ti: [], O: [] };
  let ti = -1, o = -1;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
    by.Sr.push([i / N, j / N, k / N]);
    if (i === 1 && j === 1 && k === 1) { ti = by.Ti.length; o = by.O.length; }
    by.Ti.push([(i + 0.5) / N, (j + 0.5) / N, (k + 0.5) / N]);
    // O on the +x face of the Ti first (the driven one for cell 1,1,1)
    by.O.push([(i + 1) / N, (j + 0.5) / N, (k + 0.5) / N]);
    by.O.push([(i + 0.5) / N, (j + 1) / N, (k + 0.5) / N]);
    by.O.push([(i + 0.5) / N, (j + 0.5) / N, (k + 1) / N]);
  }
  const wrap = (p) => p.map((x) => ((x % 1) + 1) % 1);
  const L = N * AP;
  const text = [`SrTiO3 ${N}x${N}x${N}`, '1.0', `${L} 0 0`, `0 ${L} 0`, `0 0 ${L}`, 'Sr Ti O',
    `${by.Sr.length} ${by.Ti.length} ${by.O.length}`, 'Direct',
    ...['Sr', 'Ti', 'O'].flatMap((el) => by[el].map((p) => wrap(p).map((x) => x.toFixed(8)).join(' ')))].join('\n');
  const nSr = by.Sr.length, nTi = by.Ti.length;
  return { text, ti: nSr + ti, o: nSr + nTi + o };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const { text, ti, o } = poscar();
  await page.evaluate(async ({ text }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'sto_bondbreak.vasp');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
  }, { text });

  // Set up: Ti–O cutoff 2.10 Å, fast polyhedra search (corners = bonded
  // ligands), bonds and polyhedra on, a full rebuild.
  const setup = await page.evaluate(async ({ CUT }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, fileBrowser } = await import('./state/store.js');
    const P = await import('./render/PolyhedraModule.js');
    const { getBondLengthCutoff } = await import('./render/BondsFracUpdateModule.js');
    general.showBonds = true;
    general.showPolyhedra = true;
    general.polyhedraMode = 'fast';
    general.bondBreakTolerance = 0.1;
    const prev = general.bondLengths['O-Ti'];
    general.bondLengths['O-Ti'] = { ...(typeof prev === 'object' ? prev : {}), min: 0, max: CUT };
    window.__bb = { pos0: fileBrowser.selectedStructure.atoms.map((a) => [...a.position]) };
    await cv.updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPolyhedra: true });
    await P.updatePolyhedra();
    return { cut: getBondLengthCutoff('Ti', 'O'), polys: P.polyhedraDrawnCount() };
  }, { CUT });
  H.check('setup: Ti–O cutoff set and polyhedra drawn', Math.abs(setup.cut - CUT) < 1e-9 && setup.polys > 0, JSON.stringify(setup));

  // Helpers installed on the page: place the driven O at distance r·CUT
  // from its Ti, run one fast frame (or a full rebuild), report the state.
  await page.evaluate(async ({ ti, o, AP, CUT }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, fileBrowser } = await import('./state/store.js');
    const P = await import('./render/PolyhedraModule.js');
    const { applyFrameFast, lastFastFrameBail } = await import('./render/FastFrameModule.js');
    const s = () => fileBrowser.selectedStructure;
    const L = () => s().lattice[0][0];
    const place = (r) => {
      const st = s();
      const pos0 = window.__bb.pos0;
      st.atoms.forEach((a, i) => { a.position = [...pos0[i]]; });
      const tiX = pos0[ti][0];
      st.atoms[o].position = [tiX + (r * CUT) / L(), pos0[o][1], pos0[o][2]];
    };
    const cornerRow = () => {
      const table = P.polyhedraTable();
      if (!table) return -1;
      for (let i = 0; i < table.n; i++) if (table.centerIndex[i] === ti && table.key[i].endsWith(':0,0,0')) return i;
      return -1;
    };
    // Every drawn bond as srcA-srcB → lengths (playback state, after the frame).
    const drawnBonds = () => {
      const { groups } = window.__store;
      const st = s();
      const wrapped = st.periodic.wrapped;
      const pb = wrapped.playbackBonds;
      const map = new Map();
      const list = [];
      if (!pb) return { map, list };
      const meshes = [groups.bondsMesh, groups.bondsCandidateMesh];
      [pb.real, pb.cand].forEach((set, si) => {
        if (!set) return;
        const m = meshes[si]?.instanceMatrix?.array;
        for (let k = 0; k < set.n; k++) {
          const a = wrapped.cart[set.i[k]], b = wrapped.cart[set.j[k]];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          let visible = false;
          if (m) { const off = set.slot[k] * 2 * 16; for (let q = 0; q < 12; q++) if (m[off + q] !== 0) visible = true; }
          const sa = Math.min(set.srcI[k], set.srcJ[k]), sb = Math.max(set.srcI[k], set.srcJ[k]);
          list.push({ sa, sb, d, drawn: !!set.drawn[k], visible });
          if (!set.drawn[k]) continue;
          const key = `${sa}-${sb}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(d);
        }
      });
      return { map, list };
    };
    const report = (r) => {
      const st = s();
      const table = P.polyhedraTable();
      const row = cornerRow();
      const { map, list } = drawnBonds();
      const want = r * CUT;
      const pair = list.filter((b) => b.sa === Math.min(ti, o) && b.sb === Math.max(ti, o) && Math.abs(b.d - want) < 1e-4);
      const bond = pair.length ? pair.some((b) => b.drawn) : false;
      const bondVisible = pair.some((b) => b.drawn && b.visible);
      const info = row >= 0 ? P.polyhedronInfo(row) : null;
      const poly = row >= 0 ? (table.topo?.model ?? st.polyhedra)?.polyhedra?.[row] : null;
      const cn = row >= 0 ? table.cn[row] : -1;
      const corner = row >= 0 ? Array.from(table.topo.vertSrc.subarray(table.vertStart[row], table.vertStart[row] + cn)).includes(o) : false;
      // (vi) every centred polyhedron with its centre well inside the cell:
      // each corner active exactly when its bond is drawn
      let disagree = 0, checked = 0;
      const Lc = L();
      for (let i = 0; table && i < table.n; i++) {
        const c = table.centerIndex[i];
        if (c < 0 || table.topo.skip[i]) continue;
        const cx = table.topo.centerXYZ[3 * i], cy = table.topo.centerXYZ[3 * i + 1], cz = table.topo.centerXYZ[3 * i + 2];
        if (![cx, cy, cz].every((x) => x / Lc > 0.25 && x / Lc < 0.75)) continue;
        const vs = table.vertStart[i];
        for (let k = 0; k < table.cnFull[i]; k++) {
          const v = vs + k;
          const sv = table.topo.vertSrc[v];
          const d = Math.hypot(table.vertXYZ[3 * v] - cx, table.vertXYZ[3 * v + 1] - cy, table.vertXYZ[3 * v + 2] - cz);
          const lens = map.get(`${Math.min(c, sv)}-${Math.max(c, sv)}`) ?? [];
          const drawn = lens.some((x) => Math.abs(x - d) < 1e-6);
          checked++;
          if (drawn !== (k < table.cn[i])) disagree++;
        }
      }
      return {
        r, bondFound: pair.length, bond, bondVisible, row, cn, cnFull: row >= 0 ? table.cnFull[row] : -1,
        infoCn: info?.cn ?? -1, drawnPoly: !!info?.drawn, faceCount: info?.faceCount ?? -1,
        modelVerts: poly?.vertices?.length ?? -1, modelSrcs: poly?.vertexSrcList?.length ?? -1, corner,
        disagree, checked,
      };
    };
    window.__bb.frame = (r) => {
      place(r);
      const ok = applyFrameFast(s());
      return { ...report(r), fast: ok === true, bail: ok === true ? null : lastFastFrameBail() };
    };
    window.__bb.rebuild = async (r) => {
      place(r);
      await cv.updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPolyhedra: true });
      await P.updatePolyhedra();
      const st = s();
      const bonds = st.bonds ?? [];
      const want = r * CUT;
      const modelBond = bonds.some((b) => ((b.srcA === ti && b.srcB === o) || (b.srcA === o && b.srcB === ti))
        && Math.abs(b.dist - want) < 1e-3);
      const table = P.polyhedraTable();
      const row = cornerRow();
      const poly = row >= 0 ? st.polyhedra?.polyhedra?.[row] : null;
      return {
        r, modelBond, row, cn: row >= 0 ? table.cn[row] : -1, modelVerts: poly?.vertices?.length ?? -1,
        hasO: !!poly?.vertexSrcList?.includes(o), catKey: poly?.catKey ?? null, key: poly?.key ?? null,
      };
    };
    window.__bb.tol = (t) => { general.bondBreakTolerance = t; };
    window.__store = await import('./state/store.js');
  }, { ti, o, AP, CUT });

  const run = async (rs) => {
    const out = [];
    for (const r of rs) out.push(await page.evaluate((r) => window.__bb.frame(r), r));
    return out;
  };
  const allAgree = [];
  const fmt = (fr) => fr.map((x) => `${x.r}:${x.bond ? 'B' : '-'}${x.corner ? 'C' : '-'}${x.cn}`).join(' ');

  // ---------------------------------------------------------------- (i), (ii), (v)
  await page.evaluate(() => window.__bb.tol(0.1));
  const out1 = await run([1.0, 0.97, 1.02, 1.05, 1.08, 1.095]);
  const gone1 = await run([1.105, 1.12, 1.15]);
  const back1 = await run([1.12, 1.08, 1.03, 1.01]);
  const ret1 = await run([0.995, 0.97, 0.93]);
  allAgree.push(...out1, ...gone1, ...back1, ...ret1);
  console.log(`  tol 10 %: ${fmt([...out1, ...gone1, ...back1, ...ret1])}`);
  const held = (x) => x.bond && x.bondVisible && x.corner && x.cn === 6 && x.infoCn === 6 && x.modelVerts === 6 && x.modelSrcs === 6;
  const broken = (x) => !x.bond && !x.corner && x.cn === 5 && x.infoCn === 5 && x.modelVerts === 5 && x.cnFull === 6;
  const fastAll = [...out1, ...gone1, ...back1, ...ret1].every((x) => x.fast);
  H.check('all frames took the fast path', fastAll, JSON.stringify([...out1, ...gone1, ...back1, ...ret1].filter((x) => !x.fast)));
  H.check('(i) tol 10 %: the bond and the corner survive up to 1.1 × cutoff', out1.every(held), JSON.stringify(out1));
  H.check('(i) tol 10 %: beyond 1.1 × cutoff both are gone', gone1.every(broken), JSON.stringify(gone1));
  H.check('(ii) brought back, they stay gone while beyond the cutoff', back1.every(broken), JSON.stringify(back1));
  H.check('(ii) they return within the cutoff', ret1.every(held), JSON.stringify(ret1));
  H.check('(v) a broken-off corner leaves a 5-corner polyhedron (2V − 4 faces)', gone1.every((x) => x.drawnPoly && x.faceCount === 6), JSON.stringify(gone1));
  H.check('(v) the returning corner re-triangulates it (2V − 4 = 8 faces)', ret1.every((x) => x.drawnPoly && x.faceCount === 8), JSON.stringify(ret1));

  // ---------------------------------------------------------------- (iii)
  await page.evaluate(() => window.__bb.tol(0));
  const out0 = await run([0.97, 0.995]);
  const gone0 = await run([1.005, 1.05, 1.12]);
  const back0 = await run([1.05, 1.005]);
  const ret0 = await run([0.995, 0.97]);
  allAgree.push(...out0, ...gone0, ...back0, ...ret0);
  console.log(`  tol 0:    ${fmt([...out0, ...gone0, ...back0, ...ret0])}`);
  H.check('(iii) tol 0: both exist within the cutoff', out0.every(held) && ret0.every(held), JSON.stringify([...out0, ...ret0]));
  H.check('(iii) tol 0: both break just beyond the cutoff, and stay broken there', gone0.every(broken) && back0.every(broken),
    JSON.stringify([...gone0, ...back0]));

  // ---------------------------------------------------------------- (iv)
  await page.evaluate(() => window.__bb.tol(0.1));
  const iv = {};
  iv.pre = await run([1.0, 1.05, 1.07]); // drawn all along, held at 1.07
  iv.held = await page.evaluate(() => window.__bb.rebuild(1.07));
  iv.after = await run([1.07, 1.09]); // still held after the rebuild, per frame
  iv.cross = await run([1.12, 1.07]); // broken, then back to 1.07: not drawn
  iv.notDrawn = await page.evaluate(() => window.__bb.rebuild(1.07));
  iv.afterNotDrawn = await run([1.07]);
  iv.reform = await run([1.0, 1.07]); // forms within the cutoff, held again
  iv.beyondBefore = await run([1.09]);
  iv.beyond = await page.evaluate(() => window.__bb.rebuild(1.12)); // beyond the tolerance at the rebuild
  iv.afterBeyond = await run([1.12, 1.07]);
  // the stride path: 25 fast frames + full rebuilds alternate as the MD loop does
  iv.stride = [];
  await run([1.0]);
  for (let f = 0; f < 3; f++) {
    iv.stride.push(...await run([1.03, 1.06, 1.08]));
    iv.stride.push({ rebuilt: await page.evaluate(() => window.__bb.rebuild(1.08)) });
  }
  allAgree.push(...iv.pre, ...iv.after, ...iv.cross, ...iv.afterNotDrawn, ...iv.reform, ...iv.beyondBefore, ...iv.afterBeyond,
    ...iv.stride.filter((x) => !x.rebuilt));
  console.log(`  rebuild held: ${JSON.stringify(iv.held)}`);
  console.log(`  rebuild not drawn: ${JSON.stringify(iv.notDrawn)}; beyond: ${JSON.stringify(iv.beyond)}`);
  H.check('(iv) a full rebuild keeps a bond / corner held by the tolerance (model too)',
    iv.pre.every(held) && iv.held.modelBond && iv.held.cn === 6 && iv.held.modelVerts === 6 && iv.held.hasO
      && iv.held.catKey === 'c:Ti:O6' && iv.after.every(held), JSON.stringify(iv));
  H.check('(iv) a bond not drawn before the rebuild is not made by it (strict there)',
    broken(iv.cross[1]) && !iv.notDrawn.modelBond && iv.notDrawn.cn === 5 && !iv.notDrawn.hasO && broken(iv.afterNotDrawn[0]),
    JSON.stringify(iv));
  H.check('(iv) a bond beyond the tolerance at the rebuild is dropped, and forms again only within the cutoff',
    iv.reform.every(held) && iv.beyondBefore.every(held) && !iv.beyond.modelBond && iv.beyond.cn === 5
      && iv.afterBeyond.every(broken), JSON.stringify(iv));
  H.check('(iv) held through several full rebuilds in a row (the topology stride)',
    iv.stride.every((x) => (x.rebuilt ? x.rebuilt.modelBond && x.rebuilt.cn === 6 : held(x))), JSON.stringify(iv.stride));

  // ---------------------------------------------------------------- (vi)
  const bad = allAgree.filter((x) => x.disagree > 0 || x.bond !== x.corner);
  const checked = allAgree.reduce((s, x) => s + x.checked, 0);
  console.log(`  agreement: ${allAgree.length} frames, ${checked} corner checks`);
  H.check('(vi) the drawn bonds and the polyhedra corners agree in every frame', bad.length === 0 && checked > 0,
    JSON.stringify(bad.slice(0, 4)));

  H.check('(vii) no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
