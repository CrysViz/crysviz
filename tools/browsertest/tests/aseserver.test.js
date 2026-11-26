// The ASE backend (backend/server.py) as a calculator: the page connects, and
// EFS, relaxation and MD run through the same paths as NEP and PET-MAD. The
// server offers ASE's EMT (the default) and Lennard-Jones (no PyTorch
// needed); energies, forces and stress must equal ASE's own, with the stress
// in the app convention. The panel switches between the two models and
// remembers the choice. Needs a Python
// with ase, flask-socketio and simple-websocket (CRYSVIZ_ASE_PYTHON, default
// python3); without one only the "no server" message is checked.
//   CRYSVIZ_ASE_PYTHON=/path/to/python tools/browsertest/run.sh tests/aseserver.test.js
'use strict';
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('../harness');

const PYTHON = process.env.CRYSVIZ_ASE_PYTHON || 'python3';
const PORT = Number(process.env.ASE_TEST_PORT || 5097);
const SERVER = path.join(__dirname, '..', '..', '..', 'backend', 'server.py');

// Cu fcc, 2x2x2 conventional cells (32 atoms), atoms displaced so forces and
// stress are not zero by symmetry.
function cuPoscar() {
  const a = 3.65;
  const basis = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]];
  const lines = ['Cu fcc 2x2x2', '1.0', `${2 * a} 0 0`, `0 ${2 * a} 0`, `0 0 ${2 * a}`, 'Cu', '32', 'Direct'];
  let q = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    for (const [x, y, z] of basis) {
      const d = 0.004 * (((q * 7) % 5) - 2);
      lines.push(`${(x + i) / 2 + d} ${(y + j) / 2 - d / 2} ${(z + k) / 2 + d / 3}`);
      q += 1;
    }
  }
  return lines.join('\n');
}

const LJ_SPEC = 'lj,sigma=2.3,epsilon=0.4';
const REFERENCE = `
import json, sys, numpy as np
from ase import Atoms
from ase.calculators.emt import EMT
from ase.calculators.lj import LennardJones
d = json.load(sys.stdin)
a = Atoms(numbers=[t + 1 for t in d['types']], positions=d['positions'], cell=d['lattice'], pbc=True)
a.calc = EMT() if d.get('calc', 'emt') == 'emt' else LennardJones(sigma=2.3, epsilon=0.4, rc=6.9, smooth=True)
print(json.dumps({'energy': a.get_potential_energy(), 'forces': a.get_forces().tolist(),
                  'stress': a.get_stress(voigt=False).tolist()}))
`;

(async () => {
  const deps = spawnSync(PYTHON, ['-c', 'import ase, flask_socketio, simple_websocket'], { encoding: 'utf8' });
  const havePython = deps.status === 0;
  let server = null;
  if (havePython) {
    server = spawn(PYTHON, [SERVER, '--model', 'emt', '--model', LJ_SPEC, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30000);
      const onData = (chunk) => {
        log += chunk;
        if (/Running on/.test(log)) { clearTimeout(timer); resolve(); }
      };
      server.stdout.on('data', onData);
      server.stderr.on('data', onData);
      server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
    });
  } else {
    console.log(`  (${PYTHON} lacks ase / flask-socketio / simple-websocket — server checks skipped)`);
  }

  const { browser, page, errors } = await H.launchApp();
  try {
    await page.evaluate(async (poscar) => {
      const cv = await import('./core/crystal-viewer.js');
      await cv.loadStructure(poscar, 'Cu32');
    }, cuPoscar());
    await page.waitForTimeout(1500);

    // Pick ASE in the panel; first against a port nothing listens on.
    const dead = await page.evaluate(async () => {
      const { openPanel } = await import('./ui/panels/PanelManager.js');
      openPanel('backend');
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('#BackendPotentialSelector button[data-potential="ase"]')?.click();
      await new Promise((r) => setTimeout(r, 200));
      const url = /** @type {HTMLInputElement} */ (document.querySelector('#BackendPotentialSelector [data-role="ase-url"]'));
      url.value = 'http://127.0.0.1:1';
      /** @type {HTMLElement} */ (document.querySelector('#BackendPotentialSelector [data-role="connect-ase"]')).click();
      const state = document.querySelector('#BackendPotentialSelector [data-role="source-state"]');
      // The line already holds the ASE hint ("ASE: start python …") from
      // picking ASE: wait for Connect's own answer.
      for (let i = 0; i < 60 && !/ASE: (?!start python)/.test(state?.textContent || ''); i++) await new Promise((r) => setTimeout(r, 100));
      return { urlShown: !!url, message: state?.textContent || '' };
    });
    H.check('no server: the panel says where it looked and how to start one',
      dead.urlShown && /no ASE server at http:\/\/127\.0\.0\.1:1/.test(dead.message) && /backend\/server\.py/.test(dead.message),
      JSON.stringify(dead));

    if (havePython) {
      const efs = await page.evaluate(async (port) => {
        const url = /** @type {HTMLInputElement} */ (document.querySelector('#BackendPotentialSelector [data-role="ase-url"]'));
        url.value = `http://127.0.0.1:${port}`;
        /** @type {HTMLElement} */ (document.querySelector('#BackendPotentialSelector [data-role="connect-ase"]')).click();
        const stateEl = document.querySelector('#BackendPotentialSelector [data-role="backend-state"]');
        for (let i = 0; i < 100 && !/EMT/.test(stateEl?.textContent || ''); i++) await new Promise((r) => setTimeout(r, 100));
        const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
        const { buildNEPStructure } = await import('./atomistic/relaxer.js');
        const { fileBrowser } = await import('./state/store.js');
        const { runner } = await ensureCalculatorRunner(() => {});
        const s = buildNEPStructure(runner, fileBrowser.selectedStructure);
        const out = await runner.compute(s);
        // The EFS card, as a user would press it.
        /** @type {HTMLElement} */ (document.querySelector('#relaxEfsCard')).click();
        const metrics = document.querySelector('#relaxEfsMetrics');
        for (let i = 0; i < 50 && !/eV/.test(metrics?.textContent || ''); i++) await new Promise((r) => setTimeout(r, 100));
        return { state: stateEl?.textContent, lattice: s.lattice, positions: s.positions, types: s.types,
          energy: out.total_energy, forces: out.forces, stress: out.stress.matrix3x3,
          offThread: runner.offThread, card: metrics?.textContent || '', timings: runner.lastTimings };
      }, PORT);
      H.check('connects and names the server model', /Backend: EMT \(cpu, float64\) at http:\/\/127\.0\.0\.1/.test(efs.state), efs.state);

      const ref = JSON.parse(spawnSync(PYTHON, ['-c', REFERENCE], {
        input: JSON.stringify({ lattice: efs.lattice, positions: efs.positions, types: efs.types }), encoding: 'utf8',
      }).stdout);
      let dF = 0;
      ref.forces.forEach((f, i) => f.forEach((x, k) => { dF = Math.max(dF, Math.abs(x - efs.forces[i][k])); }));
      let dS = 0; // app convention is compression-positive: minus ASE's
      ref.stress.forEach((row, i) => row.forEach((x, k) => { dS = Math.max(dS, Math.abs(-x - efs.stress[i][k])); }));
      H.check('energy, forces and stress equal ASE\'s own (stress sign-flipped into the app convention)',
        Math.abs(ref.energy - efs.energy) < 1e-9 && dF < 1e-9 && dS < 1e-9 && Math.abs(ref.stress[0][0]) > 1e-6,
        JSON.stringify({ dE: ref.energy - efs.energy, dF, dS, refSxx: ref.stress[0][0] }));
      H.check('the EFS card fills from the server', /energy \/ atom: -?\d/.test(efs.card) && /GPa/.test(efs.card), efs.card);
      H.check('the runner counts as off-thread and reports server and round-trip times',
        efs.offThread === true && efs.timings && efs.timings.roundTripMs >= efs.timings.serverMs, JSON.stringify(efs.timings));

      const relax = await page.evaluate(async () => {
        /** @type {HTMLInputElement} */ (document.querySelector('#relaxMaxStepsInput')).value = '15';
        /** @type {HTMLElement} */ (document.querySelector('#relaxBtn')).click();
        const state = document.querySelector('#BackendPotentialSelector [data-role="source-state"]');
        for (let i = 0; i < 300 && !/(Converged|Stopped) after \d+ steps/.test(state?.textContent || ''); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const { structureShip, fileBrowser } = await import('./state/store.js');
        const c = structureShip.container[fileBrowser.selectedRowIndex];
        const energies = c?.energySeries?.() ?? [];
        return { message: state?.textContent || '', name: c?.fileName, frames: c?.structures?.length ?? 0,
          first: energies[0], last: energies[energies.length - 1] };
      });
      H.check('relaxation runs on the server and records a trajectory with falling energy',
        /^relax_ase_/.test(relax.name || '') && relax.frames > 2 && relax.last < relax.first, JSON.stringify(relax));

      const md = await page.evaluate(async () => {
        /** @type {HTMLElement} */ (document.querySelector('#BackendModeSwitch button[data-mode="md"]')).click();
        await new Promise((r) => setTimeout(r, 300));
        const start = /** @type {HTMLButtonElement} */ (document.querySelector('#mdStartBtn'));
        /** @type {HTMLInputElement} */ (document.querySelector('#mdStepsInput')).value = '20';
        const enabled = !start.disabled;
        start.click();
        await new Promise((r) => setTimeout(r, 300));
        for (let i = 0; i < 600 && start.disabled; i++) await new Promise((r) => setTimeout(r, 100));
        const state = document.querySelector('#BackendPotentialSelector [data-role="source-state"]');
        const { structureShip, fileBrowser } = await import('./state/store.js');
        const c = structureShip.container[fileBrowser.selectedRowIndex];
        return { enabled, message: state?.textContent || '', name: c?.fileName, frames: c?.structures?.length ?? 0 };
      });
      H.check('MD runs on the server: 20 steps finish and are recorded',
        md.enabled && /Finished at step 20/.test(md.message) && md.frames > 2, JSON.stringify(md));

      // Two models on the server: listed, the default (EMT) selected.
      const q = (role) => `#BackendPotentialSelector [data-role="${role}"]`;
      const models = await page.evaluate((sel) => {
        const select = /** @type {HTMLSelectElement} */ (document.querySelector(sel.model));
        return { shown: !document.querySelector(sel.row).classList.contains('hidden'),
          options: [...select.options].map((o) => [o.value, o.textContent]), value: select.value };
      }, { model: q('ase-model'), row: q('ase-model-row') });
      H.check('a server with two models lists them in the panel, the default selected',
        models.shown && models.options.length === 2 && models.value === 'emt'
          && models.options[1][0] === LJ_SPEC && /loads on first use/.test(models.options[1][1]), JSON.stringify(models));

      // An element the model has no parameters for (EMT: no Fe) is refused by name.
      const missing = await page.evaluate(async () => {
        const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
        const { runner } = await ensureCalculatorRunner(() => {});
        try {
          await runner.compute({ lattice: [[3, 0, 0], [0, 3, 0], [0, 0, 3]], positions: [[0, 0, 0]], types: [25] });
          return 'computed';
        } catch (error) { return error.message; }
      });
      H.check('a structure with an element the model lacks is refused, naming it', /EMT.*has no parameters for Fe/.test(missing), missing);

      // Switch to Lennard-Jones in the panel: the next evaluation uses it.
      const lj = await page.evaluate(async ({ sel, spec }) => {
        const select = /** @type {HTMLSelectElement} */ (document.querySelector(sel.model));
        select.value = spec;
        select.dispatchEvent(new Event('change'));
        const stateEl = document.querySelector(sel.state);
        for (let i = 0; i < 100 && !/Lennard-Jones/.test(stateEl?.textContent || ''); i++) await new Promise((r) => setTimeout(r, 100));
        const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
        const { buildNEPStructure } = await import('./atomistic/relaxer.js');
        const { fileBrowser } = await import('./state/store.js');
        const { runner } = await ensureCalculatorRunner(() => {});
        const s = buildNEPStructure(runner, fileBrowser.selectedStructure);
        const out = await runner.compute(s);
        return { state: stateEl?.textContent, option: select.selectedOptions[0]?.textContent, lattice: s.lattice,
          positions: s.positions, types: s.types, energy: out.total_energy, forces: out.forces };
      }, { sel: { model: q('ase-model'), state: q('backend-state') }, spec: LJ_SPEC });
      const ljRef = JSON.parse(spawnSync(PYTHON, ['-c', REFERENCE], {
        input: JSON.stringify({ lattice: lj.lattice, positions: lj.positions, types: lj.types, calc: 'lj' }), encoding: 'utf8',
      }).stdout);
      let ljdF = 0;
      ljRef.forces.forEach((f, i) => f.forEach((x, k) => { ljdF = Math.max(ljdF, Math.abs(x - lj.forces[i][k])); }));
      H.check('switching to Lennard-Jones in the panel computes with it (equal to ASE\'s own)',
        /Backend: Lennard-Jones/.test(lj.state) && /Lennard-Jones/.test(lj.option) && Math.abs(ljRef.energy - lj.energy) < 1e-9 && ljdF < 1e-9,
        JSON.stringify({ state: lj.state, dE: ljRef.energy - lj.energy, ljdF }));

      // The address and the model are remembered across a reload.
      await page.reload({ waitUntil: 'load' });
      await H.waitForAppStart(page, { atLeast: 1500 }); // the Backend window exists once start-up is done
      const remembered = await page.evaluate(async (sel) => {
        const { openPanel } = await import('./ui/panels/PanelManager.js');
        openPanel('backend');
        await new Promise((r) => setTimeout(r, 300));
        document.querySelector('#BackendPotentialSelector button[data-potential="ase"]')?.click();
        await new Promise((r) => setTimeout(r, 200));
        const url = /** @type {HTMLInputElement|null} */ (document.querySelector(sel.url))?.value;
        /** @type {HTMLElement} */ (document.querySelector('#BackendPotentialSelector [data-role="connect-ase"]')).click();
        const stateEl = document.querySelector(sel.state);
        for (let i = 0; i < 100 && !/Backend: (Lennard-Jones|EMT)/.test(stateEl?.textContent || ''); i++) await new Promise((r) => setTimeout(r, 100));
        return { url, state: stateEl?.textContent, model: /** @type {HTMLSelectElement} */ (document.querySelector(sel.model)).value };
      }, { url: q('ase-url'), state: q('backend-state'), model: q('ase-model') });
      H.check('the server address and the chosen model are remembered after a reload',
        remembered.url === `http://127.0.0.1:${PORT}` && /Backend: Lennard-Jones/.test(remembered.state || '') && remembered.model === LJ_SPEC,
        JSON.stringify(remembered));
    }
  } finally {
    if (server) server.kill();
  }
  // Connection refused is the "no server" check; ERR_TUNNEL is a sandbox without
  // network access failing to fetch Plotly.
  const relevant = errors.filter((e) => !/ERR_CONNECTION_REFUSED|127\.0\.0\.1:1\b|websocket|ERR_TUNNEL/i.test(e));
  H.check('no unexpected console/page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
