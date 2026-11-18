// Settling on a frame of a large trajectory (ui/TrajectoryPanel.js
// settleFrame, round 3): on 2·10^4+ atoms, pause, a step button and releasing
// the scrubber take the render fast path plus the panel refreshes instead of a
// full rebuild (seconds at 10^5 atoms), and dragging the scrubber never
// rebuilds mid-drag. What is on screen must still be exactly the frame: the
// atoms and bonds after a light settle are compared with a full rebuild of the
// same frame. A small trajectory keeps the full rebuild on pause.
'use strict';
const H = require('../harness');

async function load(page, n, frames, name) {
  return page.evaluate(async ({ n, frames, name }) => {
    const a = 5.43;
    const base = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
      [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25]];
    const L = n * a;
    const sites = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      // Off the cell faces, so the periodic image set does not change with the motion.
      for (const f of base) sites.push([(f[0] + i) * a + 0.3, (f[1] + j) * a + 0.3, (f[2] + k) * a + 0.3]);
    }
    const parts = [];
    for (let t = 0; t < frames; t++) {
      parts.push(String(sites.length), `Lattice="${L} 0 0 0 ${L} 0 0 0 ${L}" Properties=species:S:1:pos:R:3`);
      sites.forEach((p, s) => parts.push(`Si ${(p[0] + 0.06 * Math.sin(0.7 * t + 1.3 * s)).toFixed(4)} ${(p[1] + 0.06 * Math.sin(0.7 * t + 1.3 * s + 2.1)).toFixed(4)} ${(p[2] + 0.06 * Math.sin(0.7 * t + 1.3 * s + 4.2)).toFixed(4)}`));
    }
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const before = structureShip.container.length;
    await cv.loadStructure(parts.join('\n'), name);
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 400));
    return sites.length;
  }, { n, frames, name });
}

// What is drawn: atom centres and bond half centres (sorted, 1e-3 Å), and the
// frame the player shows.
const SNAPSHOT = `async () => {
  const { groups, fileBrowser } = await import('./state/store.js');
  const centres = (mesh) => {
    if (!mesh) return [];
    const arr = mesh.instanceMatrix.array, out = [];
    for (let i = 0; i < mesh.count; i++) {
      if (Math.hypot(arr[i * 16], arr[i * 16 + 1], arr[i * 16 + 2]) < 1e-9) continue;
      out.push(arr[i * 16 + 12].toFixed(3) + ',' + arr[i * 16 + 13].toFixed(3) + ',' + arr[i * 16 + 14].toFixed(3));
    }
    return out.sort();
  };
  return {
    step: fileBrowser.stepInput,
    atoms: centres(groups.atomsMesh),
    bonds: [...centres(groups.bondsMesh), ...centres(groups.bondsCandidateMesh)].sort(),
  };
}`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const snapshot = () => page.evaluate(`(${SNAPSHOT})()`);
  const counters = () => page.evaluate(async () => (await import('./debug/debugTrace.js')).counters());
  const delta = (a, b, k) => (b[k] || 0) - (a[k] || 0);
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const exactAgainstFull = async () => {
    const light = await snapshot();
    await page.evaluate(async (step) => {
      const { structureShip } = await import('./state/store.js');
      const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
      const c = structureShip.container[structureShip.container.length - 1];
      showTrajectoryFrame(step, c, { full: true, recenter: false });
    }, light.step);
    const full = await snapshot();
    return { step: light.step, atoms: light.atoms.length, bonds: light.bonds.length,
      atomsSame: same(light.atoms, full.atoms), bondsSame: same(light.bonds, full.bonds), fullBonds: full.bonds.length };
  };
  const click = (id) => page.evaluate((id) => document.getElementById(id).click(), id);

  const atoms = await load(page, 14, 6, 'settle.xyz');
  await page.evaluate(async () => {
    const { general, structureShip } = await import('./state/store.js');
    general.showBonds = true;
    structureShip.container[structureShip.container.length - 1].playbackMode = 'auto';
  });

  // Play, then pause: a light settle on the frame playback reached.
  await click('playPauseBtn');
  await page.waitForTimeout(2500);
  let c0 = await counters();
  await click('playPauseBtn');
  let c1 = await counters();
  const played = delta({}, c0, 'playbackFast');
  const pause = await exactAgainstFull();
  H.check(`${atoms} atoms: playback ran on the fast path (${played} frames)`, played > 0, JSON.stringify(c0));
  H.check('pause settles lightly (no full rebuild)', delta(c0, c1, 'lightSettle') === 1 && delta(c0, c1, 'playbackFull') === 0,
    JSON.stringify({ lightSettle: delta(c0, c1, 'lightSettle'), full: delta(c0, c1, 'playbackFull') }));
  H.check('after pause the atoms and bonds are exactly those of a full rebuild of that frame',
    pause.atomsSame && pause.bondsSame && pause.bonds > 0, JSON.stringify(pause));

  // Step forward: the same.
  c0 = await counters();
  await click('stepFwdBtn');
  c1 = await counters();
  const step = await exactAgainstFull();
  H.check('a step button settles lightly, exactly',
    delta(c0, c1, 'lightSettle') === 1 && step.atomsSame && step.bondsSame, JSON.stringify({ ...step, lightSettle: delta(c0, c1, 'lightSettle') }));

  // Drag the scrubber: fast frames only; release: a light settle, exactly.
  c0 = await counters();
  await page.evaluate(() => {
    const slider = document.getElementById('frameSlider');
    for (const v of [4, 2, 5, 3]) {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input'));
    }
  });
  c1 = await counters();
  await page.evaluate(() => document.getElementById('frameSlider').dispatchEvent(new Event('change')));
  const c2 = await counters();
  const drag = await exactAgainstFull();
  H.check('dragging the scrubber moves on the fast path, never a full rebuild',
    delta(c0, c1, 'playbackFast') === 4 && delta(c0, c1, 'playbackFull') === 0,
    JSON.stringify({ fast: delta(c0, c1, 'playbackFast'), full: delta(c0, c1, 'playbackFull') }));
  H.check('releasing it settles lightly on that frame, exactly',
    drag.step === 3 && delta(c1, c2, 'lightSettle') === 1 && drag.atomsSame && drag.bondsSame,
    JSON.stringify({ ...drag, lightSettle: delta(c1, c2, 'lightSettle') }));

  // Small structure: pause is the full rebuild, as before.
  await load(page, 3, 4, 'small-settle.xyz');
  await click('playPauseBtn');
  await page.waitForTimeout(800);
  c0 = await counters();
  await click('playPauseBtn');
  c1 = await counters();
  H.check('small structure: pause keeps the full rebuild (no light settle)', delta(c0, c1, 'lightSettle') === 0,
    JSON.stringify({ lightSettle: delta(c0, c1, 'lightSettle') }));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
