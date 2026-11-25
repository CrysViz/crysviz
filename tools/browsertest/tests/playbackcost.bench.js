// Trajectory playback cost: ms per frame and NEW shader programs per frame,
// for the full-rebuild path (Render: Full, and every Auto frame that cannot go
// fast) and the in-place fast path (Render: Auto on a moving system).
//
// A rebuild that creates fresh materials makes three.js compile and link the
// atom/bond/lattice shaders again on every frame (Material.dispose releases
// the program); this prints that count so a regression is visible.
//
// Not pass/fail beyond "it ran" — prints a table:
//   tools/browsertest/run.sh tests/playbackcost.bench.js
// Env: PBENCH_CELLS=4 (Si conventional cell repeated n^3: 8 n^3 atoms),
//      PBENCH_FRAMES=40.
'use strict';
const H = require('../harness');

const CELLS = Number(process.env.PBENCH_CELLS || 4);
const FRAMES = Number(process.env.PBENCH_FRAMES || 40);

function makeTrajectory(n, frames) {
  const a = 5.43;
  const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
    [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
  const L = n * a;
  const sites = [];
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) for (let k = 0; k < n; k += 1) {
    for (const f of base) sites.push([(f[0] + i) * a, (f[1] + j) * a, (f[2] + k) * a]);
  }
  const lines = [];
  for (let t = 0; t < frames; t += 1) {
    lines.push(String(sites.length));
    lines.push(`Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
    sites.forEach((p, idx) => {
      // Smooth thermal-looking motion, ~0.1 Å.
      const d = [0, 1, 2].map((c) => 0.1 * Math.sin(0.4 * t + 1.3 * idx + 2.1 * c));
      lines.push(`Si ${(p[0] + d[0]).toFixed(5)} ${(p[1] + d[1]).toFixed(5)} ${(p[2] + d[2]).toFixed(5)}`);
    });
  }
  return lines.join('\n');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const traj = makeTrajectory(CELLS, FRAMES);

  const res = await page.evaluate(async ({ traj, frames }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { general, fileBrowser, structureShip, app } = await import('./state/store.js');
    const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
    const { renderFrameNow } = await import('./render/AnimateModule.js');
    await cv.loadStructure(traj, 'playbackcost.xyz');
    await new Promise((r) => setTimeout(r, 300));
    general.showBonds = true;
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const programs = () => app.renderer?.info?.programs?.length ?? NaN;
    const run = async (mode) => {
      container.playbackMode = mode;
      showTrajectoryFrame(0, container);
      renderFrameNow();
      await new Promise((r) => setTimeout(r, 100));
      const p0 = programs();
      const ids0 = new Set((app.renderer.info.programs || []).map((p) => p.id));
      const t0 = performance.now();
      let updMs = 0;
      let renMs = 0;
      const fast0 = window.__fastFrames ?? 0;
      for (let f = 1; f < frames; f += 1) {
        const a = performance.now();
        showTrajectoryFrame(f, container, { full: false, playback: { forceFull: false }, recenter: false });
        const b = performance.now();
        renderFrameNow();
        // Force a GPU sync so render time is not deferred into the next frame.
        app.renderer.getContext().finish();
        renMs += performance.now() - b;
        updMs += b - a;
      }
      const ms = (performance.now() - t0) / (frames - 1);
      const { lastFastFrameBail } = await import('./render/FastFrameModule.js');
      const after = (app.renderer.info.programs || []).map((p) => p.id);
      const created = after.filter((id) => !ids0.has(id)).length;
      return { mode, msPerFrame: +ms.toFixed(1), updateMs: +(updMs / (frames - 1)).toFixed(1),
        renderMs: +(renMs / (frames - 1)).toFixed(1), lastBail: lastFastFrameBail?.() ?? null,
        motion: container.motionProfile?.().kind,
        programsBefore: p0, programsAfter: programs(),
        newProgramsPerFrame: +(created / (frames - 1)).toFixed(2) };
    };
    const atoms = fileBrowser.selectedStructure.atoms.length;
    const bonds = fileBrowser.selectedStructure.bonds?.length ?? 0;
    const full = await run('full');
    const auto = await run('auto');
    return { atoms, bonds, full, auto };
  }, { traj, frames: FRAMES });

  console.log(`  ${res.atoms} atoms, ${res.bonds} bonds, ${FRAMES} frames`);
  console.table([res.full, res.auto]);
  H.check('playback ran on both paths', Number.isFinite(res.full.msPerFrame) && Number.isFinite(res.auto.msPerFrame),
    JSON.stringify(res));
  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
