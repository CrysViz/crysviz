// The trajectory memory limit (Settings ▸ Memory ▸ "Trajectory memory";
// io/trajectoryLoadPlan.js, ui/TrajectoryMemoryLimit.js).
//  1. The .xyz estimate from the start of a file: frame count, atoms, bytes per
//     frame (8 bytes a coordinate; positions, plus forces when present).
//  2. A planned .xyz parse keeps exactly the planned frames — every n-th, the
//     first m, both — identical to those frames of a full parse, chunked or not.
//  3. Over the limit, the dialog offers every n-th frame / first frames /
//     everything and raise the limit / everything this time / cancel, and each
//     answer gives its plan; "raise" stores the new limit and moves the slider.
//  4. Under the limit nothing is asked. A cancelled load shows no error and
//     adds no row. An .xyz is asked once; other trajectories are trimmed after
//     parsing (keepFrames, plot values with them).
'use strict';
const H = require('../harness');

function trajectory(nAtoms, frames, forces = true) {
  const parts = [];
  for (let t = 0; t < frames; t++) {
    parts.push(String(nAtoms), `Lattice="20 0 0 0 20 0 0 0 20" Properties=species:S:1:pos:R:3${forces ? ':forces:R:3' : ''} t=${t}`);
    for (let i = 0; i < nAtoms; i++) {
      const p = [1 + (i % 10) * 1.9 + 0.01 * t, 1 + (Math.floor(i / 10) % 10) * 1.9, 1 + Math.floor(i / 100) * 1.9].map((x) => x.toFixed(5));
      parts.push(`Si ${p.join(' ')}${forces ? ` ${Math.sin(i + t).toFixed(5)} 0.5 -0.25` : ''}`);
    }
  }
  return parts.join('\n') + '\n';
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---- 1-2. Estimate and planned parses ----
  const parse = await page.evaluate(async ({ text, plain }) => {
    const { estimateXYZ, parseXYZBlob, parseXYZFile } = await import('./io/ReadeXYZModule.js');
    const { setTrajectoryLoadPlanner } = await import('./io/trajectoryLoadPlan.js');
    const { installTrajectoryMemoryLimit } = await import('./ui/TrajectoryMemoryLimit.js');
    const out = {
      est: estimateXYZ(text.slice(0, 4000), text.length),
      estPlain: estimateXYZ(plain.slice(0, 4000), plain.length),
    };
    const frames = (c) => {
      const s = c.store;
      return Array.from({ length: s.frameCount }, (_, f) => {
        const ph = s.getFramePhysics(f);
        return JSON.stringify([Array.from(ph.positions), ph.forces ? Array.from(ph.forces) : null]);
      });
    };
    const whole = frames(await parseXYZBlob(new Blob([text]), 'whole.xyz'));
    out.wholeFrames = whole.length;
    const pick = (steps) => steps.map((i) => whole[i]);
    out.plans = {};
    for (const [name, plan, steps] of [
      ['every 3rd', { stride: 3, maxFrames: Infinity }, [0, 3, 6, 9]],
      ['first 4', { stride: 1, maxFrames: 4 }, [0, 1, 2, 3]],
      ['every 2nd, at most 3', { stride: 2, maxFrames: 3 }, [0, 2, 4]],
    ]) {
      for (const chunkBytes of [700, 1 << 20]) {
        const got = frames(await parseXYZBlob(new Blob([text]), 'planned.xyz', { chunkBytes, plan }));
        out.plans[`${name} (${chunkBytes}-byte chunks)`] = JSON.stringify(got) === JSON.stringify(pick(steps));
      }
    }
    // The whole-text path, through a stand-in planner.
    let asked = null;
    setTrajectoryLoadPlanner(async (est) => { asked = est; return { stride: 4, maxFrames: Infinity }; });
    const viaText = frames(await parseXYZFile(text, 'text.xyz'));
    installTrajectoryMemoryLimit();
    out.textPath = JSON.stringify(viaText) === JSON.stringify(pick([0, 4, 8]));
    out.asked = asked && { frames: asked.frames, atoms: asked.atoms, estimated: asked.estimated };
    return out;
  }, { text: trajectory(120, 11), plain: trajectory(120, 11, false) });
  H.check('the .xyz estimate: 11 frames of 120 atoms, 48 B/atom/frame with forces, 24 without',
    parse.est.frames === 11 && parse.est.atoms === 120 && parse.est.bytesPerFrame === 120 * 48
      && parse.estPlain.frames === 11 && parse.estPlain.bytesPerFrame === 120 * 24, JSON.stringify([parse.est, parse.estPlain]));
  for (const [name, same] of Object.entries(parse.plans)) {
    H.check(`planned parse, ${name}: exactly those frames of the full parse`, same, '');
  }
  H.check('the whole-text path asks the planner with the estimate and keeps every 4th frame',
    parse.textPath && parse.asked?.frames === 11 && parse.asked.estimated, JSON.stringify(parse.asked));

  // ---- 3. The dialog ----
  const dialog = await page.evaluate(async () => {
    const { planTrajectoryLoad } = await import('./io/trajectoryLoadPlan.js');
    const { setPanelPref, getPanelPref, openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('settings');
    await new Promise((r) => setTimeout(r, 300));
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('trajectoryMemorySlider'));
    const out = { sliderDefault: slider?.value };
    setPanelPref('trajectoryMemoryGiB', 0.5);
    // 200 frames of 100,000 atoms with forces: 0.96 GB, above 0.5 GiB.
    const est = { fileName: 'big.xyz', frames: 200, atoms: 100000, bytesPerFrame: 4.8e6, bytes: 9.6e8, estimated: true };
    const answer = async (id) => {
      const pending = planTrajectoryLoad(est).then((p) => p, (e) => e.name);
      await new Promise((r) => setTimeout(r, 50));
      const labels = [...document.querySelectorAll('#confirmModalActions .confirm-choice-label')].map((x) => x.textContent);
      document.getElementById(id).click();
      return { labels, plan: await pending };
    };
    out.stride = await answer('trajMemStride');
    out.first = await answer('trajMemFirst');
    out.all = await answer('trajMemAll');
    out.limitAfterAll = getPanelPref('trajectoryMemoryGiB');
    out.cancel = await answer('trajMemCancel');
    out.raise = await answer('trajMemRaise');
    out.limitAfterRaise = getPanelPref('trajectoryMemoryGiB');
    out.sliderAfterRaise = slider?.value;
    // Under the limit now: no dialog.
    const t = performance.now();
    out.under = await planTrajectoryLoad({ ...est, bytes: 5e8, frames: 100 });
    out.underMs = performance.now() - t;
    out.modalHidden = document.getElementById('confirmModal').hidden;
    setPanelPref('trajectoryMemoryGiB', 2);
    return out;
  });
  H.check('the Settings slider shows the default limit of 2 GiB', dialog.sliderDefault === '2', JSON.stringify(dialog.sliderDefault));
  // 0.5 GiB holds 111 frames of 4.8 MB: every 2nd frame (100 frames) or the first 111.
  H.check('over the limit: "every 2nd frame" keeps 100 of 200', dialog.stride.plan.stride === 2 && dialog.stride.plan.maxFrames === Infinity
    && /Every 2nd frame/.test(dialog.stride.labels[0]), JSON.stringify(dialog.stride));
  H.check('"the first 111 frames"', dialog.first.plan.stride === 1 && dialog.first.plan.maxFrames === 111
    && /first 111 frames/.test(dialog.first.labels[1]), JSON.stringify(dialog.first));
  H.check('"everything, this time" loads all and leaves the limit', dialog.all.plan.stride === 1 && dialog.all.plan.maxFrames === Infinity
    && dialog.limitAfterAll === 0.5, JSON.stringify([dialog.all, dialog.limitAfterAll]));
  H.check('cancel cancels the load', dialog.cancel.plan === 'LoadCancelledError', JSON.stringify(dialog.cancel));
  H.check('"everything, and raise the limit to 1 GiB" loads all, stores the limit, moves the slider',
    dialog.raise.plan.maxFrames === Infinity && /raise the limit to 1 GiB/.test(dialog.raise.labels[2])
      && dialog.limitAfterRaise === 1 && dialog.sliderAfterRaise === '1', JSON.stringify([dialog.raise, dialog.limitAfterRaise, dialog.sliderAfterRaise]));
  H.check('under the limit nothing is asked', dialog.under.stride === 1 && dialog.under.maxFrames === Infinity && dialog.modalHidden,
    JSON.stringify(dialog.under));

  // ---- 4. Through the app's load path ----
  const flow = await page.evaluate(async ({ text }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { structureShip } = await import('./state/store.js');
    const { setTrajectoryLoadPlanner, planLoadedTrajectory } = await import('./io/trajectoryLoadPlan.js');
    const { installTrajectoryMemoryLimit } = await import('./ui/TrajectoryMemoryLimit.js');
    const { TrajectoryContainer } = await import('./model/index.js');
    const { TrajectoryFrameStore } = await import('./model/TrajectoryFrameStore.js');
    const out = {};
    // Cancel: no row, no error modal.
    let calls = 0;
    setTrajectoryLoadPlanner(async () => { calls++; return null; });
    const before = structureShip.container.length;
    const res = await cv.loadStructure(text, 'cancelled.xyz');
    await new Promise((r) => setTimeout(r, 300));
    const errModal = document.querySelector('.load-error-modal, #loadErrorModal');
    out.cancel = { cancelled: res?.cancelled === true, rows: structureShip.container.length - before, calls,
      errorShown: !!errModal && !errModal.hidden && getComputedStyle(errModal).display !== 'none' };
    // An .xyz is asked once (before parsing), not again after.
    calls = 0;
    setTrajectoryLoadPlanner(async () => { calls++; return { stride: 2, maxFrames: Infinity }; });
    await cv.loadStructure(text, 'halved.xyz');
    while (structureShip.container.length === before) await new Promise((r) => setTimeout(r, 100));
    out.xyz = { calls, frames: structureShip.container[structureShip.container.length - 1].frameCount };
    // Another reader's trajectory: trimmed after parsing.
    const physics = Array.from({ length: 6 }, (_, f) => ({
      elements: ['Si', 'Si'], spinFrame: { fileSaxis: [0, 0, 1] }, lattice: [[5, 0, 0], [0, 5, 0], [0, 0, 5]],
      positions: new Float64Array([0.1 * f, 0, 0, 0.5, 0.5, 0.5]), forces: null, spinVectors: null, spinRaw: null, energy: -f, stress: null,
    }));
    const c = new TrajectoryContainer({ fileName: 'other.traj', store: new TrajectoryFrameStore({ frames: physics }) });
    c.plotSeries = { step: [0, 1, 2, 3, 4, 5] };
    calls = 0;
    await planLoadedTrajectory(c);
    out.other = { calls, frames: c.frameCount, x: Array.from({ length: c.frameCount }, (_, i) => c.store.getFramePhysics(i).positions[0]),
      energies: c.store.energySeries(), plot: c.plotSeries.step, planned: c.loadPlanned, structures: c.structures.length };
    installTrajectoryMemoryLimit();
    return out;
  }, { text: trajectory(30, 6) });
  H.check('a cancelled load adds no row and shows no error', flow.cancel.cancelled && flow.cancel.rows === 0 && flow.cancel.calls === 1
    && !flow.cancel.errorShown, JSON.stringify(flow.cancel));
  H.check('an .xyz load is planned once, before parsing (every 2nd of 6 frames: 3)', flow.xyz.calls === 1 && flow.xyz.frames === 3,
    JSON.stringify(flow.xyz));
  H.check('another trajectory is trimmed after parsing: frames, energies and plot values together',
    flow.other.calls === 1 && flow.other.frames === 3 && JSON.stringify(flow.other.x) === JSON.stringify([0, 0.2, 0.4])
      && JSON.stringify(flow.other.energies) === JSON.stringify([-0, -2, -4]) && JSON.stringify(flow.other.plot) === JSON.stringify([0, 2, 4])
      && flow.other.planned && flow.other.structures === 3, JSON.stringify(flow.other));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
