// Pipelined MD (atomistic/MD.js, general.mdPipelineViewer): with an
// off-thread potential the viewer update / frame save of step i runs while
// the worker computes step i+1, on a snapshot of step i's state. The danger is
// pairing step i's energy with step i+1's positions in the saved trajectory.
// Check: re-evaluate every saved frame with NEP and compare with the energy
// stored on it; and the sequential path (pipelining off) gives the same kind
// of trajectory.
'use strict';
const H = require('../harness');

async function runAndVerify(page, pipeline) {
  return page.evaluate(async ({ pipeline }) => {
    const { general, fileBrowser, structureShip } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.mdPipelineViewer = pipeline;
    general.mdWorker = true;
    general.atomisticPotential = 'nep';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 300));
    // Rebuild the MD body from scratch (the previous run left the panel in MD).
    document.querySelector('#BackendModeSwitch button[data-mode="relax"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('mdStepsInput').value = '16';
    const stride = document.getElementById('mdSaveStrideInput');
    if (stride) stride.value = '4';
    const before = structureShip.container.length;
    const startBtn = document.getElementById('mdStartBtn');
    startBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    while (startBtn.disabled) await new Promise((r) => setTimeout(r, 100));
    const container = structureShip.container[structureShip.container.length - 1];
    const added = structureShip.container.length - before;
    // Re-evaluate each saved frame with the main-thread NEP runner.
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { runner } = await ensureCalculatorRunner(() => {});
    const n = container.structures.length;
    const diffs = [];
    for (let i = 1; i < n; i += 1) {
      const frame = await container.frameAt(i);
      const s = buildNEPStructure(runner, frame);
      const out = await runner.compute(s);
      diffs.push(Math.abs(out.total_energy - frame.energy));
    }
    // Velocities carried for "Continue MD" must have one entry per atom.
    const last = await container.frameAt(n - 1);
    return {
      added, frames: n, maxDiff: Math.max(...diffs), diffs,
      velocities: Array.isArray(last.velocities) ? last.velocities.length : null,
      atoms: last.atoms.length,
    };
  }, { pipeline });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  const piped = await runAndVerify(page, true);
  H.check('pipelined run made a trajectory with the saved frames', piped.added === 1 && piped.frames >= 5,
    JSON.stringify(piped));
  H.check('pipelined: every saved frame\'s energy belongs to its own positions (|ΔE| < 1e-6 eV)',
    piped.maxDiff < 1e-6, JSON.stringify(piped.diffs));
  H.check('pipelined: the last frame carries one velocity per atom', piped.velocities === piped.atoms,
    JSON.stringify(piped));

  await H.loadDefaultStructure(page);
  const seq = await runAndVerify(page, false);
  H.check('sequential run (pipelining off) is exact as well', seq.maxDiff < 1e-6 && seq.frames === piped.frames,
    JSON.stringify(seq));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
