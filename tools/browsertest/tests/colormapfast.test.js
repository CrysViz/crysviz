// Frame-dependent colour maps on the render fast path (render/FrameColorsModule.js).
// Atoms coloured by force and bonds coloured by length (or following
// force-coloured atoms) change only colour from frame to frame, so playback
// moves and recolours instances in place instead of rebuilding every frame.
// For each mode the colours a fast frame paints — atom and bond instances,
// candidate bonds included, and the model's atom.color / bond.color — must be
// exactly those of a full rebuild of the same frame, with a user atom colour
// taking precedence as on the full path. Then a
// large trajectory plays a force map on the fast path only, and the bond
// builder honours the log scale of the bond map like the Colors panel.
'use strict';
const H = require('../harness');

// 2x2x2 Si (64 atoms) with forces that change every frame, small motion.
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
      const d = 0.12 * Math.sin(0.9 * t + 1.7 * s);
      const f = ((s * 7 + t * 3) % 11) * 0.9;
      parts.push(`Si ${(p[0] + d).toFixed(4)} ${(p[1] - d).toFixed(4)} ${p[2].toFixed(4)} ${f.toFixed(3)} ${(0.3 * t).toFixed(3)} 0`);
    });
  }
  return parts.join('\n');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, groups, fileBrowser, structureShip } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const trace = await import('./debug/debugTrace.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'colormap.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    general.showBonds = true;

    const key = (arr, i) => `${arr[i * 16 + 12].toFixed(3)},${arr[i * 16 + 13].toFixed(3)},${arr[i * 16 + 14].toFixed(3)}`;
    const rgb = (arr, i) => `${arr[i * 3].toFixed(6)},${arr[i * 3 + 1].toFixed(6)},${arr[i * 3 + 2].toFixed(6)}`;
    // What is drawn, keyed by position so the instance order does not matter.
    const drawn = () => {
      const atoms = {};
      const am = groups.atomsMesh;
      for (let i = 0; i < am.count; i++) atoms[key(am.instanceMatrix.array, i)] = rgb(am.instanceColor.array, i);
      const bonds = {};
      for (const mesh of [groups.bondsMesh, groups.bondsCandidateMesh]) {
        if (!mesh?.visible) continue;
        const m = mesh.instanceMatrix.array;
        for (let i = 0; i < mesh.count; i++) {
          if (Math.hypot(m[i * 16], m[i * 16 + 1], m[i * 16 + 2]) < 1e-9) continue;
          bonds[key(m, i)] = rgb(mesh.instanceColor.array, i);
        }
      }
      const s = fileBrowser.selectedStructure;
      return {
        atoms, bonds,
        atomModel: s.atoms.map((a) => String(a.color)),
        bondModel: Object.fromEntries(s.bonds.filter((b) => b.visibleLen > 1e-3)
          .map((b) => [`${b.indexA}-${b.indexB}`, b.color.map(String).join('|')])),
      };
    };
    const diff = (x, y) => {
      const out = { atoms: 0, bonds: 0, atomModel: 0, bondModel: 0, sizes: [Object.keys(x.atoms).length, Object.keys(x.bonds).length] };
      for (const k of new Set([...Object.keys(x.atoms), ...Object.keys(y.atoms)])) if (x.atoms[k] !== y.atoms[k]) out.atoms++;
      for (const k of new Set([...Object.keys(x.bonds), ...Object.keys(y.bonds)])) if (x.bonds[k] !== y.bonds[k]) out.bonds++;
      x.atomModel.forEach((v, i) => { if (v !== y.atomModel[i]) out.atomModel++; });
      for (const k of Object.keys(y.bondModel)) if (x.bondModel[k] !== undefined && x.bondModel[k] !== y.bondModel[k]) out.bondModel++;
      return out;
    };
    // Frames 1..3 on the fast path, each compared with a full rebuild of it.
    const compare = async () => {
      showTrajectoryFrame(0, c, { full: true, recenter: false });
      const rows = [];
      for (const f of [1, 2, 3]) {
        const c0 = trace.counters();
        showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
        const fast = drawn();
        const fastFrames = (trace.counters().playbackFast || 0) - (c0.playbackFast || 0);
        showTrajectoryFrame(f, c, { full: true, recenter: false });
        const full = drawn();
        rows.push({ f, fastFrames, changedFromPrev: rows.length ? JSON.stringify(full.atoms) !== rows[rows.length - 1].fullAtoms : true, ...diff(fast, full), fullAtoms: JSON.stringify(full.atoms) });
        showTrajectoryFrame(f, c, { full: true, recenter: false });
      }
      return rows.map(({ fullAtoms, ...r }) => r);
    };

    const out = {};
    // Bonds by length, linear and log. (Length first: leaving the force map
    // by assignment, as here, leaves force colours on the atoms, which then
    // count as per-frame styles — the Colors panel resets them.)
    general.bondsColor = 'length'; general.bondsColorMap = 'jet'; general.bondColorScale = 'linear';
    general.BondMin = 2.2; general.BondMax = 2.6;
    out.length = await compare();
    general.bondColorScale = 'log';
    out.lengthLog = await compare();
    const { bondLengthToColor } = await import('./ui/ColorPanel.js');
    showTrajectoryFrame(2, c, { full: true, recenter: false });
    const bs = fileBrowser.selectedStructure.bonds.filter((b) => b.visibleLen > 1e-3);
    out.logMatchesPanel = bs.every((b) => b.color[0] === bondLengthToColor(b.dist));
    general.bondColorScale = 'linear';
    // Atoms by force, bonds following them (element mode).
    general.bondsColor = 'elements';
    general.atomsColor = 'force'; general.atomColorMap = 'viridis'; general.atomColorScale = 'linear';
    general.ForceMin = 0; general.ForceMax = 9;
    out.force = await compare();
    // With a user colour on one atom. A frame left with
    // a user colour keeps it as a per-frame style, and frames with styles
    // take the full path; the frames still moved in place must agree.
    fileBrowser.selectedStructure.atoms[5].userColor = '#ff00ff';
    out.forceUser = await compare();
    general.atomsColor = 'elements';
    return out;
  }, trajectory(2, 4));

  const ok = (rows) => rows.every((r) => r.fastFrames === 1 && r.atoms === 0 && r.bonds === 0 && r.atomModel === 0 && r.bondModel === 0);
  H.check('atoms by force: a fast frame paints exactly a full rebuild (atoms, bonds following them, model colours)',
    ok(res.force) && res.force.some((r) => r.changedFromPrev), JSON.stringify(res.force));
  const fastRows = res.forceUser.filter((r) => r.fastFrames === 1);
  H.check('a user atom colour wins on the fast path as on the full path',
    fastRows.length > 0 && ok(fastRows), JSON.stringify(res.forceUser));
  H.check('bonds by length: a fast frame paints exactly a full rebuild', ok(res.length), JSON.stringify(res.length));
  H.check('bonds by length, log scale: the same', ok(res.lengthLog), JSON.stringify(res.lengthLog));
  H.check('the bond builder honours the log scale like the Colors panel', res.logMatchesPanel, JSON.stringify(res.logMatchesPanel));

  // A large trajectory plays a force map on the fast path.
  const big = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, structureShip, fileBrowser, groups } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const trace = await import('./debug/debugTrace.js');
    const before = structureShip.container.length;
    await cv.loadStructure(text, 'colormap-big.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 400));
    structureShip.container[structureShip.container.length - 1].playbackMode = 'auto';
    general.atomsColor = 'force'; general.ForceMin = 0; general.ForceMax = 9;
    const colorsBefore = Array.from(groups.atomsMesh.instanceColor.array.slice(0, 300));
    const c0 = trace.counters();
    document.getElementById('playPauseBtn').click();
    await new Promise((r) => setTimeout(r, 3000));
    document.getElementById('playPauseBtn').click();
    const c1 = trace.counters();
    const colorsAfter = Array.from(groups.atomsMesh.instanceColor.array.slice(0, 300));
    general.atomsColor = 'elements';
    return {
      atoms: fileBrowser.selectedStructure.atoms.length,
      fast: (c1.playbackFast || 0) - (c0.playbackFast || 0),
      full: (c1.playbackFull || 0) - (c0.playbackFull || 0),
      recoloured: JSON.stringify(colorsBefore) !== JSON.stringify(colorsAfter),
    };
  }, trajectory(14, 4));
  H.check(`${big.atoms} atoms coloured by force play on the fast path (no full rebuild per frame)`,
    big.fast > 0 && big.full === 0 && big.recoloured, JSON.stringify(big));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
