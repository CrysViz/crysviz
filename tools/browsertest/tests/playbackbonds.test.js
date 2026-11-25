// Bonds stay in step with the atoms during fast playback
// (render/PlaybackBondsModule.js): every pair of the last rebuild plus every
// candidate within cutoff + the candidate margin (BOND_SKIN) is drawn exactly
// while it exists — formed
// within its cutoff, kept up to cutoff × (1 + the bond breaking tolerance) —
// so a bond forms and breaks in the frame the atoms move, not at the next
// topology rebuild, as before.
//  1. Two C atoms approach (3.0 -> 1.0 Å) and separate again over 19 fast
//     frames: the bond must be drawn in exactly the frames where it exists by
//     that rule and is longer than the two atom radii — it is not in the
//     topology of frame 0, so it can only come from the candidate list.
//  2. A 39k-atom Si trajectory (above the inline-search size) refreshes its
//     candidate list in a worker as the atoms drift; a fast frame still draws
//     exactly the bonds of a full rebuild of that frame.
'use strict';
const H = require('../harness');

async function load(page, text, name) {
  await page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, name);
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
  }, { text, name });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---- 1. A bond forming and breaking ----
  const ds = [];
  for (let d = 3.0; d > 0.99; d -= 0.2) ds.push(+d.toFixed(2));
  for (let d = 1.2; d < 2.61; d += 0.2) ds.push(+d.toFixed(2));
  const pairText = ds.map((d) => ['2', 'Lattice="20 0 0 0 20 0 0 0 20" Properties=species:S:1:pos:R:3',
    'C 5.0 10.0 10.0', `C ${(5 + d).toFixed(4)} 10.0 10.0`].join('\n')).join('\n');
  await load(page, pairText, 'cc.xyz');
  const pair = await page.evaluate(async ({ ds }) => {
    const { structureShip, groups, general, fileBrowser } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { getBondCutoff, getBondMinCutoff } = await import('./render/BondsFracUpdateModule.js');
    const { playbackBondStats } = await import('./render/PlaybackBondsModule.js');
    const { bondBreakTolerance } = await import('./render/BondBreakTolerance.js');
    const { Bond } = await import('./model/index.js');
    const trace = await import('./debug/debugTrace.js');
    general.showBonds = true;
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    const cut = getBondCutoff('C', 'C');
    const minCut = getBondMinCutoff('C', 'C');
    const drawn = (mesh) => {
      if (!mesh) return 0;
      const a = mesh.instanceMatrix.array;
      let n = 0;
      for (let i = 0; i < mesh.count; i++) if (Math.hypot(a[i * 16], a[i * 16 + 1], a[i * 16 + 2]) > 1e-9) n++;
      return n;
    };
    showTrajectoryFrame(0, c, { full: true });
    const initialBonds = fileBrowser.selectedStructure.bonds.length;
    const c0 = trace.counters();
    const rows = [];
    const tol = bondBreakTolerance();
    let exists = false;
    for (let f = 1; f < Math.min(c.frameCount, 20); f++) {
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      const d = ds[f];
      const probe = new Bond({ elements: ['C', 'C'], positions: [[0, 0, 0], [d, 0, 0]] });
      exists = d >= minCut && d <= (exists ? cut * (1 + tol) : cut);
      const expected = exists && probe.visibleLen > 1e-3;
      const halves = drawn(groups.bondsMesh) + drawn(groups.bondsCandidateMesh);
      rows.push({ f, d, expected, halves, stats: playbackBondStats(fileBrowser.selectedStructure) });
    }
    const c1 = trace.counters();
    return { cut, minCut, tol, initialBonds, rows, fast: (c1.playbackFast || 0) - (c0.playbackFast || 0) };
  }, { ds });
  const wrong = pair.rows.filter((r) => (r.halves === 2) !== r.expected || (r.halves !== 0 && r.halves !== 2));
  const formed = pair.rows.filter((r) => r.expected).map((r) => r.f);
  H.check(`C-C bond (cutoff ${pair.cut.toFixed(2)} Å, tolerance ${(pair.tol * 100).toFixed(0)} %) is drawn in exactly the frames it exists: ${formed.join(',')}`,
    wrong.length === 0 && formed.length > 0 && pair.initialBonds === 0 && pair.fast === pair.rows.length,
    JSON.stringify({ wrong, fast: pair.fast, initialBonds: pair.initialBonds, rows: pair.rows.map((r) => [r.f, r.d, r.expected, r.halves]) }));
  H.check('the forming bond came from the candidate list (not in frame 0\'s topology)',
    pair.rows.some((r) => r.expected && r.stats?.candidates >= 1), JSON.stringify(pair.rows.map((r) => r.stats)));

  // ---- 2. Background refresh on a large structure ----
  const n = 17;
  const big = await page.evaluate(async ({ n }) => {
    const a = 5.43;
    const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
      [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
    const L = n * a;
    const sites = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      for (const f of base) sites.push([(f[0] + i) * a + 0.3, (f[1] + j) * a + 0.3, (f[2] + k) * a + 0.3]);
    }
    const parts = [];
    for (let t = 0; t < 8; t++) {
      parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
      sites.forEach((p, s) => parts.push(`Si ${(p[0] + 0.15 * t + 0.04 * Math.sin(t + s)).toFixed(4)} ${(p[1] + 0.04 * Math.sin(t + 2 * s)).toFixed(4)} ${p[2].toFixed(4)}`));
    }
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip, groups, fileBrowser } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(parts.join('\n'), 'big.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { playbackBondStats } = await import('./render/PlaybackBondsModule.js');
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    showTrajectoryFrame(0, c, { full: true });
    const centres = () => {
      const pts = [];
      for (const mesh of [groups.bondsMesh, groups.bondsCandidateMesh]) {
        if (!mesh) continue;
        const arr = mesh.instanceMatrix.array;
        for (let i = 0; i < mesh.count; i++) {
          if (Math.hypot(arr[i * 16], arr[i * 16 + 1], arr[i * 16 + 2]) < 1e-9) continue;
          pts.push(`${arr[i * 16 + 12].toFixed(2)},${arr[i * 16 + 13].toFixed(2)},${arr[i * 16 + 14].toFixed(2)}`);
        }
      }
      return pts.sort();
    };
    let sawPending = false;
    const stats = [];
    let fastCentres = null;
    for (let f = 1; f < c.frameCount; f++) {
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      const s = playbackBondStats(fileBrowser.selectedStructure);
      if (s?.pending) sawPending = true;
      stats.push(s);
      if (f === 5) fastCentres = centres();
      // Give the worker a moment, as real playback frames do.
      await new Promise((r) => setTimeout(r, 150));
    }
    showTrajectoryFrame(5, c, { full: true });
    const full = centres();
    const set = new Map();
    for (const k of full) set.set(k, (set.get(k) || 0) + 1);
    let mismatch = 0;
    for (const k of fastCentres) { const v = set.get(k); if (v) set.set(k, v - 1); else mismatch++; }
    return { atoms: sites.length, sawPending, stats, fast: fastCentres.length, full: full.length, mismatch };
  }, { n });
  const refreshes = Math.max(...big.stats.map((s) => s?.refreshes ?? 0));
  H.check(`${big.atoms} atoms: the candidate list is refreshed in a worker as atoms drift (${refreshes} refreshes)`,
    big.sawPending && refreshes >= 2, JSON.stringify(big.stats));
  H.check(`${big.atoms} atoms: a fast frame draws exactly the bonds of a full rebuild of that frame`,
    big.fast > 0 && big.fast === big.full && big.mismatch === 0, JSON.stringify({ fast: big.fast, full: big.full, mismatch: big.mismatch }));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
