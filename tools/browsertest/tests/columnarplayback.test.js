// Columnar trajectory playback (model/materializeFrame.js deferFramePhysics,
// render/FastFrameModule.js): a frame switch defers writing positions into the
// live Structure's Atom objects, and the Auto fast path moves the meshes from
// the frame's position column. Checks, on an 8,000-atom thermally moving Si
// trajectory (above PLAYBACK_TOPOLOGY_MIN_ATOMS):
//  - fast playback frames build no per-atom positions (deferred flushes stay
//    flat) and take the fast path between refreshes;
//  - every drawn atom sits where the frame puts it (modulo a lattice vector:
//    an atom that wrapped is drawn continuing its motion);
//  - the bonds drawn on a fast frame are the bonds a full rebuild of that
//    frame draws, at the same places;
//  - reading structure.atoms afterwards gives exactly the shown frame's
//    positions, and the next frame's park records no phantom position edit;
//  - topology refresh follows motion: steady drift of 0.2 Å per frame forces
//    a full rebuild within a few frames (displacement > 0.5 Å), thermal
//    jiggle alone does not for 30 frames.
'use strict';
const H = require('../harness');

async function loadTraj(page, { n, frames, drift, name, offset = 0 }) {
  return page.evaluate(async ({ n, frames, drift, name, offset }) => {
    const a = 5.43;
    const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
      [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
    const L = n * a;
    const sites = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      for (const f of base) sites.push([(f[0] + i) * a, (f[1] + j) * a, (f[2] + k) * a]);
    }
    const parts = [];
    for (let t = 0; t < frames; t++) {
      parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
      sites.forEach((p, s) => {
        const x = (p[0] + offset + 0.06 * Math.sin(0.7 * t + 1.3 * s) + drift * t) % L;
        parts.push(`Si ${x.toFixed(5)} ${(p[1] + offset + 0.06 * Math.sin(0.7 * t + 1.3 * s + 2.1)).toFixed(5)} ${(p[2] + offset + 0.06 * Math.sin(0.7 * t + 1.3 * s + 4.2)).toFixed(5)}`);
      });
    }
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(parts.join('\n'), name);
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    return sites.length;
  }, { n, frames, drift, name, offset });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const atoms = await loadTraj(page, { n: 10, frames: 12, drift: 0, name: 'columnar.xyz' });

  const r = await page.evaluate(async () => {
    const { structureShip, fileBrowser, groups, general } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const mf = await import('./model/materializeFrame.js');
    const trace = await import('./debug/debugTrace.js');
    general.showBonds = true;
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    const play = (f) => showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
    const lat = () => fileBrowser.selectedStructure.lattice;
    const out = { frames: [], bondSets: [] };

    // Settle on frame 0 (full), then play 1..11.
    showTrajectoryFrame(0, c, { full: true });
    const flush0 = mf.deferredFlushCount();
    const c0 = trace.counters();
    for (let f = 1; f < c.frameCount; f++) {
      play(f);
      const s = fileBrowser.selectedStructure;
      const ph = c.store.getFramePhysics(f);
      const wrapped = s.periodic.wrapped;
      const mesh = groups.atomsMesh;
      const m = mesh.instanceMatrix.array;
      const L = lat();
      // Each drawn instance i: frame frac of its source + an integer shift.
      let worst = 0;
      const inv = 1 / L[0][0];
      for (let i = 0; i < wrapped.srcIndex.length; i++) {
        const sIdx = wrapped.srcIndex[i];
        for (let k = 0; k < 3; k++) {
          const drawnFrac = m[i * 16 + 12 + k] * inv; // cubic cell
          let d = drawnFrac - ph.positions[sIdx * 3 + k];
          d -= Math.round(d);
          worst = Math.max(worst, Math.abs(d) * L[0][0]);
        }
      }
      out.frames.push({ f, worst, pending: mf.hasPendingFramePhysics(s) });
    }
    const c1 = trace.counters();
    out.flushesDuringPlayback = mf.deferredFlushCount() - flush0;
    out.fast = (c1.playbackFast || 0) - (c0.playbackFast || 0);
    out.full = (c1.playbackFull || 0) - (c0.playbackFull || 0);

    // Bonds on the last fast frame vs a full rebuild of the same frame.
    // Bond half centres, wrapped into the (cubic) cell: a bond of an atom
    // that wrapped is drawn continuing its motion, the rebuild draws the copy
    // one lattice vector away — the same bond.
    const bondCenters = () => {
      const bm = groups.bondsMesh;
      const arr = bm.instanceMatrix.array;
      const Lc = lat()[0][0];
      const pts = [];
      for (let i = 0; i < bm.count; i++) {
        const sx = Math.hypot(arr[i * 16], arr[i * 16 + 1], arr[i * 16 + 2]);
        if (sx < 1e-9) continue; // hidden half
        pts.push([arr[i * 16 + 12], arr[i * 16 + 13], arr[i * 16 + 14]].map((v) => ((v % Lc) + Lc) % Lc));
      }
      return pts;
    };
    // Points of `a` with no unused partner in `b` within tol (periodic, grid hashed).
    const unmatched = (a, b, tol) => {
      const Lc = lat()[0][0];
      const cell = 0.1;
      const n = Math.ceil(Lc / cell);
      const grid = new Map();
      const key = (x, y, z) => ((x + n) % n) * n * n + ((y + n) % n) * n + ((z + n) % n);
      b.forEach((p, i) => {
        const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      });
      const used = new Uint8Array(b.length);
      let miss = 0;
      for (const p of a) {
        const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
        let found = -1;
        for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
          for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) || []) {
            if (used[j]) continue;
            let d2 = 0;
            for (let k = 0; k < 3; k++) { let d = p[k] - b[j][k]; d -= Lc * Math.round(d / Lc); d2 += d * d; }
            if (d2 < tol * tol) { found = j; break; }
          }
        }
        if (found >= 0) used[found] = 1; else miss++;
      }
      return miss;
    };
    window.__bondCenters = bondCenters;
    window.__unmatched = unmatched;
    const last = c.frameCount - 1;

    // Reading atoms applies the deferred frame: exact positions of `last`.
    const s = fileBrowser.selectedStructure;
    const ph = c.store.getFramePhysics(last);
    let atomErr = 0;
    s.atoms.forEach((atom, i) => { for (let k = 0; k < 3; k++) atomErr = Math.max(atomErr, Math.abs(atom.position[k] - ph.positions[i * 3 + k])); });
    out.atomErr = atomErr;
    out.pendingAfterRead = mf.hasPendingFramePhysics(s);


    // Moving on from the read frame: no phantom position edit is recorded.
    play(0);
    out.recordsAfter = c._frameStyles.size;
    return out;
  });
  const worst = Math.max(...r.frames.map((x) => x.worst));
  H.check(`${atoms} atoms: every drawn atom is where the frame puts it (max ${worst.toExponential(1)} Å)`,
    worst < 1e-4, JSON.stringify(r.frames.slice(0, 3)));
  H.check('fast frames leave the per-atom physics deferred (no Atom positions built)',
    r.flushesDuringPlayback === 0 && r.frames.every((x) => x.pending), JSON.stringify({ flushes: r.flushesDuringPlayback, frames: r.frames.map((x) => x.pending) }));
  H.check('thermal playback takes the fast path for all 11 frames (no topology refresh)',
    r.fast === 11 && r.full === 0, JSON.stringify({ fast: r.fast, full: r.full }));
  H.check('reading structure.atoms yields exactly the shown frame', r.atomErr === 0 && !r.pendingAfterRead,
    JSON.stringify({ atomErr: r.atomErr, pending: r.pendingAfterRead }));
  H.check('switching on records no phantom per-frame edit', r.recordsAfter === 0, JSON.stringify({ records: r.recordsAfter }));

  // Bonds: with no atom at a cell face (all shifted 0.3 Å inwards, so none
  // crosses one and no periodic image comes or goes), a fast frame must draw
  // exactly the bonds a full rebuild of that frame draws. (An atom crossing a
  // face is drawn continuing its motion with its bonds whole, where a rebuild
  // draws them split at the faces — both right; the position check above
  // covers crossings.)
  await loadTraj(page, { n: 10, frames: 12, drift: 0, name: 'inside.xyz', offset: 0.3 });
  const b = await page.evaluate(async () => {
    const { structureShip, groups } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    showTrajectoryFrame(0, c, { full: true });
    for (let f = 1; f < c.frameCount; f++) showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
    const fast = window.__bondCenters();
    const fastAtoms = groups.atomsMesh.count;
    showTrajectoryFrame(c.frameCount - 1, c, { full: true });
    const full = window.__bondCenters();
    return { fast: fast.length, full: full.length, atoms: [fastAtoms, groups.atomsMesh.count], mismatch: window.__unmatched(fast, full, 1e-3) };
  });
  H.check('the bonds of a fast frame are exactly the bonds a full rebuild of it draws',
    b.fast > 0 && b.fast === b.full && b.mismatch === 0 && b.atoms[0] === b.atoms[1], JSON.stringify(b));

  // Drift of 0.2 Å per frame along x: the candidate bond list is refreshed as
  // the atoms move (every ~0.3 Å), so every fast frame still draws exactly the
  // bonds a full rebuild would; the full rebuild itself comes only once atoms
  // have moved PLAYBACK_TOPOLOGY_DISPLACEMENT (2 Å) — the periodic image set.
  await loadTraj(page, { n: 10, frames: 16, drift: 0.2, name: 'drift.xyz', offset: 0.3 });
  const d = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { playbackBondStats } = await import('./render/PlaybackBondsModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const trace = await import('./debug/debugTrace.js');
    const c = structureShip.container[structureShip.container.length - 1];
    c.playbackMode = 'auto';
    showTrajectoryFrame(0, c, { full: true });
    const seq = [];
    let refreshes = 0;
    let checked = null;
    for (let f = 1; f < c.frameCount; f++) {
      const before = trace.counters().playbackFull || 0;
      showTrajectoryFrame(f, c, { full: false, playback: { forceFull: false }, recenter: false });
      const full = (trace.counters().playbackFull || 0) > before;
      seq.push(full ? 'F' : '.');
      if (!full) refreshes = Math.max(refreshes, playbackBondStats(fileBrowser.selectedStructure)?.refreshes ?? 0);
      if (f === 3 && !full) {
        const fast = window.__bondCenters();
        showTrajectoryFrame(f, c, { full: true });
        const exact = window.__bondCenters();
        checked = { fast: fast.length, full: exact.length, mismatch: window.__unmatched(fast, exact, 1e-3) };
      }
    }
    return { seq: seq.join(''), refreshes, checked };
  });
  H.check('steady drift (0.2 Å/frame): candidate bonds refresh as atoms move, full rebuild only after 2 Å',
    /^\.{7,}F/.test(d.seq) && d.refreshes >= 3, JSON.stringify(d));
  H.check('under drift a fast frame still draws exactly the bonds of a full rebuild',
    d.checked && d.checked.fast === d.checked.full && d.checked.mismatch === 0, JSON.stringify(d.checked));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
