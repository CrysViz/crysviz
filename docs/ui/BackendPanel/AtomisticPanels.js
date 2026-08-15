import { loadSocketIO } from '../../external/socket.io-loader.js';
import { fileBrowser, structureShip, general } from '../../state/store.js';
import { structureHasFractionalOccupancy } from '../DisorderWarningBanner.js';
import {
  buildNEPStructure,
  relaxUntilConverged,
  applyStructureToViewer,
  expandKeptVectorsToFull,
  maxForce,
  pressureGPaFromStress,
} from '../../atomistic/relaxer.js';
import {
  initializeMDState,
  runMDSimulation,
  applyMDStateToViewer,
  createNEPForceEvaluator,
  createVelocityVerletIntegrator,
  createCosineAnnealingSchedule,
  createBussiThermostat,
  createStochasticCellBarostat,
  createNoBarostat,
  recommendedTimestepFs,
  DEFAULT_THERMOSTAT_TAU_FS,
  DEFAULT_BAROSTAT_TAU_FS,
  MIN_BAROSTAT_TAU_RATIO,
  mdProfileMeasure,
} from '../../atomistic/MD.js';
import { ensureWorkerNEPReady, createWorkerNEPForceEvaluator } from '../../atomistic/nepWorkerClient.js';
import { ensureTrajectoryPanelForLive, feedLiveStep, resetLivePlot, endLiveFeed } from '../TrajectoryPanel.js';
import { MLIPRunner } from '../../external/mlip_wasm/mlip_runner.js';
import { updateForces } from '../../render/index.js';
import { updateRow, createRow, selectLastAddedRow, selectStructure } from '../FileBrowswerPanel.js';
import { refreshActivePanels } from '../panels/PanelManager.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { fracToCartPoint, cartToFractional, normalizeFractionalPoint } from '../../math/index.js';
import {
  isWyckoffModeActive,
  symmetrizeCartesianPositions,
  symmetrizeCartesianVectors,
  symmetrizeCartesianStrain,
} from '../SymmetryEditModule.js';
import { StructureContainer } from '../../model/index.js';
import { Atom } from '../../model/index.js';
import { Force } from '../../model/index.js';
import { Stress } from '../../model/index.js';
import { Structure } from '../../model/index.js';
import { refreshBackendTheme } from './BackendTheme.js';

const tableBody = document.querySelector('#objectTable tbody');

let nepRunner = null;
let nepInitPromise = null;

// PET-MAD (mlip.js) state. The runner is a singleton keyed by backend: changing
// the backend requires a fresh runner (a different wasm variant / module),
// while changing the model just reloads weights on the existing runner.
const MLIP_MODEL_BASE_URL = 'https://huggingface.co/peterspackman/mlip-gguf/resolve/main/';
// All PET-MAD singleton state lives in one object so a backend change (or a
// failed init) replaces/clears it atomically instead of resetting five vars
// in lockstep. Shape: { backend, initPromise, runner, loadedModelKey,
// modelPromise, modelPromiseKey }.
let mlipState = null;

let aseSocket = null;
let aseConnected = false;
let aseBoundElements = null;
let aseConnectPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initNEP() {
  if (nepInitPromise) return nepInitPromise;

  nepInitPromise = (async () => {
    await loadScript('./external/nep_wasm/nep_wasm.js');
    await loadScript('./external/nep_wasm/nep_simple.js');

    nepRunner = new window.NEPWasmRunner({
      defaultModelUrl: './external/nep_wasm/nep89_20250409.txt',
    });

    await nepRunner.init();
    await nepRunner.loadDefaultModel();
    return nepRunner;
  })();

  return nepInitPromise;
}

async function ensureNEPReady(statusEl, stateEl = null) {
  if (nepRunner) {
    if (stateEl) stateEl.textContent = `Built-in model ready: ${nepRunner.modelInfo.name}`;
    return nepRunner;
  }

  if (statusEl) statusEl.textContent = 'Loading built-in NEP model...';
  if (stateEl) stateEl.textContent = 'Built-in model loading...';

  const runner = await initNEP();

  if (statusEl) statusEl.textContent = 'Built-in NEP model loaded.';
  if (stateEl) stateEl.textContent = `Built-in model ready: ${runner.modelInfo.name}`;
  return runner;
}

function setMLIPStatus(shell, message) {
  if (shell?.mlipStatusEl) shell.mlipStatusEl.textContent = message;
}

// Initialize (or reuse) the PET-MAD runner for the backend/model currently
// selected in the shell controls, then return the ready runner. A backend
// change rebuilds the runner; a model change reloads weights on the existing
// runner. Concurrent loads are de-duplicated per model key via mlipState.
async function ensureMLIPReady(shell) {
  const backend = shell.mlipBackendSelect?.value || 'cpu';
  const modelFile = shell.mlipModelSelect?.value || 'pet-mad-xs.gguf';
  const localFile = shell.mlipFileInput?.files?.[0] || null;

  // Keyed by backend on the state object (not the runner) so a switch made
  // while the previous init is still in flight also takes effect: the old
  // runner is destroyed once its init settles.
  if (mlipState && mlipState.backend !== backend) {
    const old = mlipState;
    mlipState = null;
    old.initPromise.then((r) => r.destroy()).catch(() => { /* never initialized */ });
  }

  if (!mlipState) {
    setMLIPStatus(shell, `initializing PET-MAD (${backend}) …`);
    const state = {
      backend,
      initPromise: null,
      runner: null,
      loadedModelKey: null,
      modelPromise: null,
      modelPromiseKey: null,
    };
    state.initPromise = (async () => {
      const runner = new MLIPRunner({ backend });
      await runner.init();
      state.runner = runner;
      return runner;
    })();
    // A failed init must not poison the singleton: clear it so the next
    // attempt retries instead of re-awaiting the cached rejection.
    state.initPromise.catch(() => {
      if (mlipState === state) mlipState = null;
    });
    mlipState = state;
  }
  const state = mlipState;
  let runner;
  try {
    runner = await state.initPromise;
  } catch (error) {
    // WebGPU (or 'auto' resolving to it) can fail on adapter/device request;
    // fall back to the CPU build instead of leaving the panel dead. The
    // rejection handler above has already cleared mlipState, so the retry
    // builds a fresh cpu runner.
    if (backend !== 'cpu' && shell.mlipBackendSelect) {
      console.warn(`PET-MAD ${backend} backend failed; falling back to cpu:`, error);
      shell.mlipBackendSelect.value = 'cpu';
      setMLIPStatus(shell, `${backend} init failed (${error.message || error}) — falling back to cpu`);
      return ensureMLIPReady(shell);
    }
    throw error;
  }
  if (mlipState !== state) return ensureMLIPReady(shell);

  const modelKey = localFile
    ? `file:${localFile.name}:${localFile.size}`
    : `url:${modelFile}`;

  while (state.loadedModelKey !== modelKey) {
    if (state.modelPromise && state.modelPromiseKey !== modelKey) {
      // A different model is mid-load on this runner; let it settle, then
      // re-check (loads are serialized — never piggyback on the wrong key).
      try {
        await state.modelPromise;
      } catch (_e) { /* previous load failed; ours proceeds below */ }
      if (mlipState !== state) return ensureMLIPReady(shell);
      continue;
    }
    if (!state.modelPromise) {
      state.modelPromiseKey = modelKey;
      state.modelPromise = (async () => {
        if (localFile) {
          setMLIPStatus(shell, `loading ${localFile.name} …`);
          await runner.loadModelFromFile(localFile);
        } else {
          const url = MLIP_MODEL_BASE_URL + modelFile;
          await runner.loadModelFromUrl(url, ({ loadedBytes, totalBytes }) => {
            const pct = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;
            setMLIPStatus(shell, `fetching ${modelFile} … ${pct}%`);
          });
        }
        state.loadedModelKey = modelKey;
      })();
    }
    try {
      await state.modelPromise;
    } finally {
      if (state.modelPromiseKey === modelKey) {
        state.modelPromise = null;
        state.modelPromiseKey = null;
      }
    }
  }

  setMLIPStatus(shell, `PET-MAD ready: ${runner.modelInfo.name}`);
  if (shell.sourceStateEl) shell.sourceStateEl.textContent = `PET-MAD ready: ${runner.modelInfo.name}`;
  return runner;
}

// Return the ready runner for the active potential (nep -> NEP wasm singleton,
// mlip -> PET-MAD runner). Both expose the same { modelInfo, compute } surface
// buildNEPStructure / relaxUntilConverged / createNEPForceEvaluator consume.
async function ensureCalculatorReady(potential, shell) {
  if (potential === 'mlip') return ensureMLIPReady(shell);
  return ensureNEPReady(shell.statusEl, shell.sourceStateEl);
}

// Write-only stand-in for a panel status element: the ensure* helpers report
// progress by assigning .textContent, so a setter that forwards to a callback
// lets them run without any panel DOM.
function statusElAdapter(onStatus) {
  return { set textContent(text) { onStatus(String(text)); } };
}

// Interatomic potentials and ML force fields need one definite species per
// site — there is no defined force on an atom that is half Fe and half Ni —
// so refuse rather than return numbers for a structure the model cannot
// describe. Shared by every run entry point below (headless calculator
// access, and the Relax/EFS/MD panel's own buttons — local NEP/PET-MAD *and*
// the remote ASE dispatch, which otherwise has no calculator-readiness check
// at all to hang this on).
function assertOrderedStructure() {
  if (structureHasFractionalOccupancy()) {
    throw new Error(
      'This structure has fractionally occupied sites, which interatomic potentials cannot represent. '
      + 'Use "Order structure" to generate an ordered approximation first.'
    );
  }
}

// Shared by ensureActiveCalculator and ensureCalculatorRunner below: resolves
// general.atomisticPotential to a ready { runner, potential }. When the
// Relax/MD panel IS built, its PET-MAD backend/model controls are reused so a
// headless load matches (and shares the singleton with) whatever the user
// picked there. 'ase' throws — it computes on a remote server, not in the
// browser.
async function resolveCalculatorRunner(onStatus = () => {}) {
  const potential = general.atomisticPotential || 'nep';
  if (potential === 'ase') {
    throw new Error('ASE runs on a remote server backend — select the NEP or PET-MAD potential to compute in-browser.');
  }
  const statusEl = statusElAdapter(onStatus);
  const panel = document.getElementById('BackendCalcPanel');
  const shell = {
    statusEl,
    sourceStateEl: statusEl,
    mlipStatusEl: statusEl,
    mlipBackendSelect: panel?.querySelector('[data-role="mlip-backend"]') ?? null,
    mlipModelSelect: panel?.querySelector('[data-role="mlip-model"]') ?? null,
    mlipFileInput: panel?.querySelector('[data-role="mlip-file"]') ?? null,
  };
  const runner = await ensureCalculatorReady(potential, shell);
  return { runner, potential };
}

/**
 * Headless access to the active in-browser calculator (EOS scans, addons):
 * resolves general.atomisticPotential to a ready { runner, potential } without
 * needing the Relax/MD panel open.
 */
export async function ensureActiveCalculator(onStatus = () => {}) {
  assertOrderedStructure();
  return resolveCalculatorRunner(onStatus);
}

/**
 * Same headless calculator access as ensureActiveCalculator, but WITHOUT the
 * ordered-structure guard — for computing on structures that are already
 * known to be ordered (Order Structure's random-sample energy comparison
 * builds fully-ordered candidates from a disordered source; asserting against
 * fileBrowser.selectedStructure there would reject on the still-disordered
 * structure the candidates were built FROM, not the candidates themselves).
 */
export async function ensureCalculatorRunner(onStatus = () => {}) {
  return resolveCalculatorRunner(onStatus);
}

function convertStressEvA3ToGPa(stressTensor) {
  const factor = 160.21766208;
  return stressTensor.map((row) => row.map((value) => value * factor));
}

function setCurrentEFS(out, keptIndices = null) {
  if (Array.isArray(out?.forces)) {
    // The potential returns one force per NON-vacancy atom; expand back to the
    // full atom list (vacancies get a zero force) so structure.forces stays
    // index-aligned with structure.atoms for the Forces panel and arrows.
    const forces = expandKeptVectorsToFull(
      fileBrowser.selectedStructure.atoms.length, out.forces, keptIndices);
    fileBrowser.selectedStructure.forces = forces.map((v) => new Force({ vector: [...v] }));
  }
  // Stress is optional — some calculators don't provide it. Don't throw when
  // it's absent; just leave the structure without a stress tensor.
  if (Array.isArray(out?.stress?.matrix3x3)) {
    fileBrowser.selectedStructure.stress = new Stress({
      tensor: out.stress.matrix3x3.map((row) => [...row]),
    });
  }

  if (general.forcesActive) {
    updateForces();
  }
}

// Exported for the browser test: this is the working copy MD/relax actually
// animate, and what it silently drops (symmetry, velocities) is invisible from
// anywhere else in the UI.
export function snapshotCurrentStructure() {
  const src = fileBrowser.selectedStructure;
  const elements = [...src.elements];
  const atoms = src.atoms.map((atom, index) => new Atom({
    position: [...atom.position],
    element: elements[index],
    uuid: atom.uuid,
  }));
  const forces = (src.forces ?? []).map((force) => new Force({ vector: [...force.vector] }));
  const stress = src.stress ? new Stress({ tensor: src.stress.tensor.map((row) => [...row]) }) : null;
  // Carried like forces (not reset here) so an MD frame's velocities survive
  // into its saved trajectory frame — that's what "Continue MD" resumes from.
  const velocities = src.velocities ? src.velocities.map((v) => [...v]) : null;

  return new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice: src.lattice.map((row) => [...row]),
    atoms,
    forces,
    stress,
    velocities,
    // MD/relax animate a snapshot, not the source, and every symmetrize call
    // in MD.js keys off `structure.symmetry.mode === 'wyckoff'`. Dropping it
    // here left the working copy looking unconstrained, so Wyckoff-mode runs
    // silently integrated without symmetry and even zero-freedom sites moved.
    // Shared by reference: it is derived, read-only data (operations, orbits,
    // site-freedom bases) that no run mutates.
    symmetry: src.symmetry ?? null,
    periodic: { hash: 'None', wrapped: null },
  });
}

// Copy a snapshot's positions/lattice/forces back into a structure in place
// (preserving object identity + styles). Used to undo the in-place mutation MD
// makes to the source structure while it animates the viewer.
function restoreStructureInPlace(target, src) {
  if (!target || !src) return;
  if (Array.isArray(src.lattice)) target.lattice = src.lattice.map((row) => [...row]);
  if (Array.isArray(src.atoms)) {
    src.atoms.forEach((atom, index) => {
      if (target.atoms[index] && Array.isArray(atom.position)) {
        target.atoms[index].position = [...atom.position];
      }
    });
  }
  target.forces = (src.forces ?? []).map((force) => new Force({ vector: [...force.vector] }));
  // Drop the wrapped-position cache so the restored structure re-wraps from its
  // own positions instead of a leftover MD frame's.
  target.periodic = { hash: 'None', wrapped: null };
}

function setASEStatus(bound, message) {
  if (!bound?.statusEl) return;
  bound.statusEl.textContent = message;
}

function clearASEHandlers() {
  if (!aseSocket || !aseBoundElements) return;

  aseSocket.off('connect', aseBoundElements.onConnect);
  aseSocket.off('connect_error', aseBoundElements.onConnectError);
  aseSocket.off('status', aseBoundElements.onStatus);
  aseSocket.off('new', aseBoundElements.onNew);
  aseSocket.off('getEFS', aseBoundElements.onGetEFS);
  aseSocket.off('stressUpdate', aseBoundElements.onStressUpdate);
  aseBoundElements = null;
}

function bindASEHandlers(bound) {
  if (!aseSocket) return;
  clearASEHandlers();

  const onConnect = () => {
    aseConnected = true;
    if (bound.backendStateEl) bound.backendStateEl.textContent = 'Backend: connected';
    setASEStatus(bound, 'ASE backend connected.');
  };

  const onConnectError = () => {
    aseConnected = false;
    if (bound.backendStateEl) bound.backendStateEl.textContent = 'Backend: not found';
    setASEStatus(bound, 'ASE backend not found. Start the server and reconnect.');
  };

  const onStatus = (data) => {
    setASEStatus(bound, data.message);
  };

  const onNew = (data) => {
    setASEStatus(bound, 'ASE relaxation finished.');
    if (bound.resultEl) bound.resultEl.textContent = data.log ?? '';
    const sourceFileName = structureShip.container[fileBrowser.selectedRowIndex].fileName;
    const container = new StructureContainer({ fileName: sourceFileName });

    for (let i = 0; i < data.result.positions.length; i += 1) {
      const atoms = [];
      data.result.positions[i].forEach((pos, index) => {
        atoms.push(new Atom({
          position: pos,
          element: [...fileBrowser.selectedStructure.elements][index],
        }));
      });

      const forces = [];
      data.result.forces[i].forEach((force) => {
        forces.push(new Force({ vector: force }));
      });

      const elements = [...fileBrowser.selectedStructure.elements];
      const structure = new Structure({
        elements,
        uniqueElements: [...new Set(elements)],
        lattice: data.result.lattices[i],
        atoms,
        forces,
        stress: new Stress({ tensor: convertStressEvA3ToGPa(data.result.stresses[i]) }),
      });
      container.structures.push(structure);
    }

    structureShip.container.push(container);
    const fileName = `relax_ase_${sourceFileName}`;
    container.fileName = fileName;
    const row = createRow({ name: fileName, traj: container.structures.length, step: container.structures.length });
    tableBody.appendChild(row);
    fileBrowser.fileData.push({ name: fileName, traj: container.structures.length, step: container.structures.length });
    selectLastAddedRow();
  };

  const onGetEFS = (data) => {
    setASEStatus(bound, data.log ?? 'ASE EFS finished.');
    const elements = [...fileBrowser.selectedStructure.elements];
    // FIXME (latent bug, pre-existing): unlike the relax/MD paths above, this
    // EFS path passes `positions` (ignored by Structure, which reads `atoms`)
    // and a single malformed Force instead of building `atoms` + a forces array.
    // Cast keeps existing runtime behavior; the structure ends up without atoms.
    const structure = new Structure(/** @type {any} */ ({
      elements,
      uniqueElements: [...new Set(elements)],
      lattice: data.result.lattice,
      positions: data.result.positions,
      forces: new Force({ vector: data.result.forces }),
      stress: new Stress({ tensor: convertStressEvA3ToGPa(data.result.stress) }),
    }));
    const pressure = structure.stress.pressure;
    if (bound.efsMetricsEl) {
      bound.efsMetricsEl.innerHTML = `
        <div>energy / atom: server</div>
        <div>max force: ${Number(data.result.maxf).toFixed(5)} eV/A</div>
        <div>pressure: ${pressure.toFixed(2)} GPa</div>
      `;
    }
    if (bound.resultEl) {
      bound.resultEl.textContent = `ASE EFS ready. max|F|=${Number(data.result.maxf).toFixed(5)} eV/A, P=${pressure.toFixed(2)} GPa`;
    }
  };

  const onStressUpdate = (data) => {
    const stress = new Stress({ tensor: convertStressEvA3ToGPa(data.stress) });
    if (bound.efsMetricsEl) {
      bound.efsMetricsEl.innerHTML = `
        <div>energy / atom: server</div>
        <div>max force: ${Number(data.maxf).toFixed(5)} eV/A</div>
        <div>pressure: ${stress.pressure.toFixed(2)} GPa</div>
      `;
    }
  };

  aseBoundElements = {
    ...bound,
    onConnect,
    onConnectError,
    onStatus,
    onNew,
    onGetEFS,
    onStressUpdate,
  };

  aseSocket.on('connect', onConnect);
  aseSocket.on('connect_error', onConnectError);
  aseSocket.on('status', onStatus);
  aseSocket.on('new', onNew);
  aseSocket.on('getEFS', onGetEFS);
  aseSocket.on('stressUpdate', onStressUpdate);
}

async function connectASEBackend(bound) {
  bindASEHandlers(bound);

  if (aseConnected) {
    if (bound.backendStateEl) bound.backendStateEl.textContent = 'Backend: connected';
    setASEStatus(bound, 'ASE backend connected.');
    return;
  }

  if (aseSocket) return;
  if (aseConnectPromise) return aseConnectPromise;
  aseConnectPromise = (async () => {
    try {
      const { io } = await loadSocketIO();
      aseSocket = io('http://localhost:5001', {
        timeout: 1000,
        reconnection: false,
      });
      bindASEHandlers(bound);
    } catch (error) {
      setASEStatus(bound, `ASE backend client unavailable: ${error.message || String(error)}`);
    } finally {
      aseConnectPromise = null;
    }
  })();
  return aseConnectPromise;
}

function disconnectASEBackend(bound) {
  if (!aseSocket) return;
  clearASEHandlers();
  aseSocket.disconnect();
  aseSocket = null;
  aseConnected = false;
  if (bound?.backendStateEl) bound.backendStateEl.textContent = 'Backend: disconnected';
  setASEStatus(bound, 'ASE backend disconnected.');
}

function emitASERelax(style, params) {
  if (!aseConnected || !aseSocket) throw new Error('ASE backend not connected');
  const positions = fileBrowser.selectedStructure.atoms.map((atom) => atom.position);
  const elements = [...fileBrowser.selectedStructure.elements];
  const lattice = fileBrowser.selectedStructure.lattice.map((row) => [...row]);
  aseSocket.emit('relaxStructure', {
    positions,
    lattice,
    elements,
    fmax: params.forceTol,
    pressure: params.targetPressure / 160.21766,
    style,
  });
}

function emitASEEFS() {
  if (!aseConnected || !aseSocket) throw new Error('ASE backend not connected');
  const positions = fileBrowser.selectedStructure.atoms.map((atom) => atom.position);
  const elements = [...fileBrowser.selectedStructure.elements];
  const lattice = fileBrowser.selectedStructure.lattice.map((row) => [...row]);
  aseSocket.emit('relaxStructure', {
    positions,
    lattice,
    elements,
    fmax: 0,
    pressure: 0,
    style: 'getEFS',
  });
}

// The potential picker lives in its OWN persistent element (#BackendPotentialSelector),
// rendered once and ABOVE the Relax/MD switch — the user picks the potential
// first, then an action, and the choice (general.atomisticPotential) survives
// switching Relax<->MD and is what Order Structure / EOS read too.
function buildSourcePanel() {
  return `
    <div class="atomistic-panel">
      <div class="atomistic-source-panel">
        <div class="atomistic-source-row">
          <div class="atomistic-source-label">Choose potential</div>
          <div class="backend-potential-toggle" data-role="potential-toggle">
            <button type="button" class="active" data-potential="nep">NEP</button>
            <button type="button" data-potential="mlip">PET-MAD</button>
            <button type="button" data-potential="ase">ASE</button>
          </div>
        </div>
        <div class="atomistic-source-copy">
          <div class="atomistic-source-state" data-role="source-state"></div>
        </div>
        <div class="atomistic-backend-actions hidden" data-role="mlip-source">
          <label class="atomistic-inline-toggle">
            <span>model</span>
            <select class="atomistic-input-sm" data-role="mlip-model">
              <option value="pet-mad-xs.gguf">PET-MAD xs (17 MB)</option>
              <option value="pet-mad-s.gguf">PET-MAD s (100 MB)</option>
            </select>
          </label>
          <label class="atomistic-inline-toggle">
            <span>backend</span>
            <select class="atomistic-input-sm" data-role="mlip-backend">
              <option value="cpu">cpu</option>
              <option value="auto">auto</option>
              <option value="webgpu">webgpu</option>
            </select>
          </label>
          <button type="button" class="calcButton" data-role="mlip-load">Load model</button>
          <label class="atomistic-inline-toggle">
            <span>local .gguf</span>
            <input type="file" accept=".gguf" class="atomistic-input-sm" data-role="mlip-file">
          </label>
          <div class="atomistic-backend-state" data-role="mlip-status">PET-MAD: not loaded</div>
        </div>
        <div class="atomistic-backend-actions hidden" data-role="ase-connectors">
          <button type="button" class="calcButton" data-role="connect-ase">Connect</button>
          <button type="button" class="calcButton" data-role="disconnect-ase">Disconnect</button>
          <div class="atomistic-backend-state" data-role="backend-state">Backend: not connected</div>
        </div>
      </div>
    </div>
  `;
}

function buildBodyShell() {
  return `
    <div class="atomistic-panel">
      <div class="atomistic-body" data-role="body"></div>
    </div>
  `;
}

// One shell object over the two persistent containers: the potential picker
// (#BackendPotentialSelector) and the action body (#BackendCalcPanel).
function getShellBindings() {
  const selector = document.getElementById('BackendPotentialSelector');
  const calc = document.getElementById('BackendCalcPanel');
  const sourceStateEl = selector?.querySelector('[data-role="source-state"]');
  return {
    toggle: selector?.querySelector('[data-role="potential-toggle"]'),
    sourceStateEl,
    aseConnectorsEl: selector?.querySelector('[data-role="ase-connectors"]'),
    backendStateEl: selector?.querySelector('[data-role="backend-state"]'),
    mlipSourceEl: selector?.querySelector('[data-role="mlip-source"]'),
    mlipModelSelect: selector?.querySelector('[data-role="mlip-model"]'),
    mlipBackendSelect: selector?.querySelector('[data-role="mlip-backend"]'),
    mlipLoadBtn: selector?.querySelector('[data-role="mlip-load"]'),
    mlipFileInput: selector?.querySelector('[data-role="mlip-file"]'),
    mlipStatusEl: selector?.querySelector('[data-role="mlip-status"]'),
    bodyEl: calc?.querySelector('[data-role="body"]'),
    statusEl: sourceStateEl,
    resultEl: sourceStateEl,
  };
}

function readRelaxParams(bodyEl) {
  return {
    maxSteps: Number(bodyEl.querySelector('#relaxMaxStepsInput')?.value || 200),
    forceTol: Number(bodyEl.querySelector('#relaxForceTolInput')?.value || 0.01),
    targetPressure: Number(bodyEl.querySelector('#relaxTargetPressureInput')?.value || 0),
    stressTol: Number(bodyEl.querySelector('#relaxStressTolInput')?.value || 0.2),
  };
}

// Default cell-strain magnitude for the Rattle "cell" option (±2%); editable
// in the UI.
const RATTLE_LATTICE_PCT = 0.02;

// Standard normal sample (Box–Muller) for the atom-displacement rattle.
function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Apply a random perturbation to the selected structure: a Gaussian displacement
// (std = amp Å) to every atom and, when doLattice is set, a small symmetric
// random strain (±RATTLE_LATTICE_PCT) to the cell. Mutates the structure in
// place (the user's explicit intent — rattle then relax) and re-renders.
//
// In Wyckoff mode both the displacement field and the strain are projected onto
// what the space group allows, so rattling stays inside the symmetry the user
// locked — same contract as constrained MD/relax. Note the projection shrinks
// the perturbation (a site with no freedom does not move at all, and a hexagonal
// cell only breathes along its allowed strains), so the effective amplitude is
// below `amp` by design rather than being renormalised back up.
function rattleSelectedStructure(amp, doLattice, latticePct = RATTLE_LATTICE_PCT) {
  const s = fileBrowser.selectedStructure;
  if (!s || !Array.isArray(s.atoms) || !s.atoms.length) return;
  const lattice = s.lattice.map((r) => [...r]);
  const constrained = isWyckoffModeActive(s);

  const cartPositions = s.atoms.map((atom) => fracToCartPoint(atom.position, lattice));
  let displacements = s.atoms.map(() => [
    gaussianRandom() * amp,
    gaussianRandom() * amp,
    gaussianRandom() * amp,
  ]);
  if (constrained) displacements = symmetrizeCartesianVectors(displacements, lattice, s);

  let moved = cartPositions.map((cart, i) => [
    cart[0] + displacements[i][0],
    cart[1] + displacements[i][1],
    cart[2] + displacements[i][2],
  ]);
  // Re-project the positions themselves: the displacement field alone leaves
  // each orbit consistent only to float precision, and the symmetry analysis
  // downstream runs at a tolerance that deserves better than that.
  if (constrained) moved = symmetrizeCartesianPositions(moved, lattice, s);

  s.atoms.forEach((atom, i) => {
    // Wrap back into [0,1). An atom sitting near a face is as likely to be
    // kicked out of the cell as into it, and nothing downstream folds it back:
    // periodicWrapped() only mirrors atoms that lie ON a face/edge/corner, it
    // does not normalize out-of-cell coordinates, so the atom would simply
    // render outside the box. Under PBC the wrapped position is the same
    // physical site.
    atom.position = normalizeFractionalPoint(cartToFractional(moved[i], lattice));
  });

  if (doLattice) {
    // Symmetric random strain E (independent components in [-pct, pct]);
    // new lattice = old · (I + E).
    const pct = latticePct;
    let E = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const e = (Math.random() * 2 - 1) * pct;
        E[i][j] = e;
        E[j][i] = e;
      }
    }
    if (constrained) E = symmetrizeCartesianStrain(E, lattice, s);
    s.lattice = lattice.map((row) => [0, 1, 2].map(
      (j) => row[j] + row[0] * E[0][j] + row[1] * E[1][j] + row[2] * E[2][j],
    ));
  }

  // Forces/stress/velocities are stale after moving atoms; drop them (velocities
  // also so a rattled MD tip doesn't look like a "Continue MD"-able last frame)
  // and re-render geometry.
  s.forces = [];
  s.stress = null;
  s.velocities = null;
  s.periodic = { hash: 'None', wrapped: null };
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true });
}

function renderRelaxBody(bodyEl, potential) {
  bodyEl.innerHTML = `
    <button type="button" class="atomistic-card atomistic-efs-card" id="relaxEfsCard">
      <div class="atomistic-card-title-row">
        <span class="atomistic-card-title">EFS</span>
        <div class="atomistic-efs-title-right">
          <span class="atomistic-card-pill">${potential === 'ase' ? 'server' : 'in-browser'}</span>
          <span class="atomistic-efs-refresh-hint">↻ click to compute</span>
        </div>
      </div>
      <div class="atomistic-card-metrics" id="relaxEfsMetrics">
        <div>energy / atom: —</div>
        <div>max force: —</div>
        <div>pressure: —</div>
      </div>
    </button>
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-card-title atomistic-card-title-accent">Geometry optimization</div>
      <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
        <label>
          <span>max steps</span>
          <input type="number" class="atomistic-input-sm" id="relaxMaxStepsInput" value="200" step="10" min="1">
        </label>
        <label>
          <span>force tol</span>
          <input type="number" class="atomistic-input-sm" id="relaxForceTolInput" value="0.01" step="0.001" min="0">
        </label>
        <label>
          <span>target P</span>
          <input type="number" class="atomistic-input-sm" id="relaxTargetPressureInput" value="0" step="0.1">
        </label>
        <label>
          <span>stress tol</span>
          <input type="number" class="atomistic-input-sm" id="relaxStressTolInput" value="0.2" step="0.1" min="0">
        </label>
      </div>
      <div class="atomistic-button-row atomistic-button-row-compact">
        <button type="button" class="calcButton" id="relaxBtn">Relax</button>
      </div>
    </div>
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-card-title atomistic-card-title-accent">Rattle</div>
      <div class="atomistic-grid atomistic-grid-3 atomistic-grid-compact atomistic-rattle-grid">
        <label title="Gaussian displacement applied to every atom; the value is the standard deviation in Å.">
          <span>coordinate (Å)</span>
          <input type="number" class="atomistic-input-sm" id="relaxRattleAmpInput" value="0.1" step="0.01" min="0">
        </label>
        <label title="Random symmetric strain on the cell: each independent strain component is drawn uniformly from ±this percent, so both lattice lengths and angles change.">
          <span class="atomistic-rattle-toggle-label">
            lattice (±%)
            <input type="checkbox" id="relaxRattleLatticeChk">
          </span>
          <input type="number" class="atomistic-input-sm" id="relaxRattleLatticePctInput" value="2" step="0.5" min="0">
        </label>
        <div class="atomistic-rattle-action">
          <button type="button" class="calcButton" id="relaxRattleBtn">Rattle</button>
        </div>
      </div>
    </div>
  `;
}

// Expanding the Simulated Annealing section is what ENABLES annealing — the
// run reads `!annealControls.classList.contains('hidden')`. That is a lot of
// meaning to hang on a disclosure triangle, so the header carries an explicit
// "on" badge and turns green while it applies, and the section spells out the
// schedule that replaces the fixed temperature above it.
function renderMDAnnealSummary(bodyEl) {
  const controls = bodyEl.querySelector('#mdAnnealControls');
  const icon = bodyEl.querySelector('#mdAnnealIcon');
  const header = bodyEl.querySelector('#mdAnnealHeader');
  if (!controls || !icon) return;
  const enabled = !controls.classList.contains('hidden');
  icon.textContent = enabled ? '▾' : '▸';
  header?.classList.toggle('active', enabled);

  const hint = bodyEl.querySelector('#mdAnnealHint');
  if (hint) {
    const tMin = Number(bodyEl.querySelector('#mdAnnealMinInput')?.value) || 0;
    const tMax = Number(bodyEl.querySelector('#mdAnnealMaxInput')?.value) || 0;
    const peak = Number(bodyEl.querySelector('#mdAnnealPeakPctInput')?.value) || 0;
    const start = Number(bodyEl.querySelector('#mdTemperatureInput')?.value) || 0;
    hint.textContent = enabled
      ? `while this section is open the temperature above is only the start: ${start} K → ${tMax} K at ${peak}% of the run → ${tMin} K`
      : '';
  }
}

function renderMDBody(bodyEl, potential) {
  bodyEl.innerHTML = `
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-source-row">
        <div class="atomistic-source-label">Ensemble</div>
        <div class="backend-potential-toggle" id="mdEnsembleSwitch">
          <button type="button" class="active" data-ensemble="nvt">NVT</button>
          <button type="button" data-ensemble="npt">NPT</button>
        </div>
      </div>
      <div class="atomistic-ensemble-hint" id="mdEnsembleHint"></div>
      <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
        <label>
          <span>Steps</span>
          <input type="number" class="atomistic-input-sm" id="mdStepsInput" value="500" step="50" min="1">
        </label>
        <label>
          <span>timestep (fs)</span>
          <input type="number" class="atomistic-input-sm" id="mdTimestepInput" value="${recommendedTimestepFs(fileBrowser.selectedStructure?.elements)}" step="0.1" min="0.05">
        </label>
        <label>
          <span>temperature (K)</span>
          <input type="number" class="atomistic-input-sm" id="mdTemperatureInput" value="300" step="10" min="1">
        </label>
        <label id="mdPressureField">
          <span>pressure (GPa)</span>
          <input type="number" class="atomistic-input-sm" id="mdPressureInput" value="0" step="0.1" disabled>
        </label>
        <label>
          <span>Save every (steps)</span>
          <input type="number" class="atomistic-input-sm" id="mdSaveStrideInput" value="${Math.max(1, Number(general.backendTrajectorySaveStride || 4))}" step="1" min="1">
        </label>
      </div>
      <div class="atomistic-anneal-section">
        <button type="button" class="atomistic-collapse-toggle" id="mdCouplingHeader">
          <span id="mdCouplingIcon">▸</span>
          <span class="atomistic-card-title-accent atomistic-anneal-title">Coupling times</span>
        </button>
        <div class="hidden" id="mdCouplingControls">
          <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
            <label>
              <span>thermostat τ (fs)</span>
              <input type="number" class="atomistic-input-sm" id="mdTauTInput" value="${DEFAULT_THERMOSTAT_TAU_FS}" step="10" min="1">
            </label>
            <label id="mdTauPField">
              <span>barostat τ (fs)</span>
              <input type="number" class="atomistic-input-sm" id="mdTauPInput" value="${DEFAULT_BAROSTAT_TAU_FS}" step="100" min="10" disabled>
            </label>
          </div>
          <div class="atomistic-ensemble-hint" id="mdCouplingHint"></div>
        </div>
      </div>
      <div class="atomistic-anneal-section">
        <button type="button" class="atomistic-collapse-toggle" id="mdAnnealHeader">
          <span id="mdAnnealIcon">▸</span>
          <span class="atomistic-card-title-accent atomistic-anneal-title">Simulated Annealing</span>
          <span class="atomistic-anneal-badge" id="mdAnnealBadge">on</span>
        </button>
        <div class="hidden" id="mdAnnealControls">
          <div class="atomistic-grid atomistic-grid-3 atomistic-grid-compact atomistic-anneal-grid">
            <label>
              <span>Tmin (K)</span>
              <input type="number" class="atomistic-input-sm" id="mdAnnealMinInput" value="100" step="10" min="1">
            </label>
            <label>
              <span>Tmax (K)</span>
              <input type="number" class="atomistic-input-sm" id="mdAnnealMaxInput" value="1200" step="10" min="1">
            </label>
            <label>
              <span>Peak at %</span>
              <input type="number" class="atomistic-input-sm" id="mdAnnealPeakPctInput" value="30" step="1" min="1" max="99">
            </label>
          </div>
          <div class="atomistic-ensemble-hint" id="mdAnnealHint"></div>
        </div>
      </div>
      <div class="atomistic-button-row atomistic-button-row-compact">
        <button type="button" class="calcButton" id="mdStartBtn"${potential === 'ase' ? ' disabled' : ''}>start</button>
        <button type="button" class="calcButton" id="mdStopBtn" disabled>stop</button>
      </div>
    </div>
    ${potential === 'ase' ? '<div class="atomistic-hint">ASE-backed MD is not wired yet. Use NEP for in-browser MD.</div>' : ''}
  `;
}

async function runLocalRelax(shell, params, potential) {
  const metricsEl = shell.bodyEl.querySelector('#relaxEfsMetrics');
  const runner = await ensureCalculatorReady(potential, shell);
  const noStress = runner.supportsStress === false;
  const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
  const saveStride = Math.max(1, Number(general.backendTrajectorySaveStride || 1));
  let lastSavedStep = 0;
  const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
  // Relax animates this structure in place; keep the reference to restore it.
  const originalStructure = fileBrowser.selectedStructure;
  const relaxLabel = `relax_${potential}_${srcContainer?.fileName ?? 'run'}`;
  const relaxContainer = new StructureContainer({ fileName: relaxLabel, structures: [snapshotCurrentStructure()] });
  // Persisted plot series (energy / mean force / pressure), 1:1 with frames.
  // `step` records the real relax step per saved frame so the plot's x-axis
  // reads steps (a multiple of the save stride); seed frame = step 0.
  relaxContainer.plotSeries = { step: [0], etotEv: [NaN], meanForce: [NaN], pressure: [NaN] };
  structureShip.container.push(relaxContainer);
  const relaxRow = createRow({ name: relaxLabel, traj: 1, step: 1 });
  tableBody.appendChild(relaxRow);

  shell.statusEl.textContent = 'Relaxation running...';
  shell.resultEl.textContent = '';

  resetLivePlot();
  ensureTrajectoryPanelForLive();
  let lastMetrics = /** @type {any} */ (null);
  const meanForceOf = (forces) => (Array.isArray(forces) && forces.length
    ? forces.reduce((a, v) => a + Math.hypot(v[0], v[1], v[2]), 0) / forces.length
    : NaN);
  const pushRelaxSeries = (m) => {
    relaxContainer.plotSeries.step.push(Number.isFinite(m.step) ? m.step : NaN);
    relaxContainer.plotSeries.etotEv.push(Number.isFinite(m.etotEv) ? m.etotEv : NaN);
    relaxContainer.plotSeries.meanForce.push(Number.isFinite(m.meanForce) ? m.meanForce : NaN);
    relaxContainer.plotSeries.pressure.push(Number.isFinite(m.pressure) ? m.pressure : NaN);
  };

  try {
    // Animate a throwaway working copy, not the source structure: the relax
    // loop mutates fileBrowser.selectedStructure in place for live feedback, and
    // we do not want that to alter the user's starting structure. Only relax_…
    // holds the trajectory. (restoreStructureInPlace remains a safety net.)
    const workingStructure = snapshotCurrentStructure();
    // Relax has no dynamics — never let a stale velocity value (e.g. carried
    // over from an MD frame relaxed in place) survive onto relax's own frames,
    // or a later "Continue MD" could mistake this trajectory's tip for a
    // resumable one.
    workingStructure.velocities = null;
    fileBrowser.selectedStructure = workingStructure;

    const initial = buildNEPStructure(runner, fileBrowser.selectedStructure);
    const relaxed = await relaxUntilConverged(runner, initial, {
      fmaxTol: params.forceTol,
      maxSteps: params.maxSteps,
      atomStep: 0.02,
      cellStep: 0.002,
      targetPressureGPa: params.targetPressure,
      pressureTolGPa: params.stressTol,
      onStep: (step, current, out, mF) => {
        // snapshotCurrentStructure copies the viewer structure, so a save-step must
        // also apply the current state to the viewer first.
        const shouldSave = step % saveStride === 0;
        const shouldUpdateViewer = step === 1 || shouldSave || step % viewerStride === 0;
        if (shouldUpdateViewer) {
          applyStructureToViewer(current, fileBrowser.selectedStructure);
          setCurrentEFS(out, current.keptIndices);
        }

        lastMetrics = {
          step,
          etotEv: Number(out.total_energy),
          meanForce: meanForceOf(out.forces),
          pressure: pressureGPaFromStress(out.stress?.matrix3x3),
        };
        if (shouldSave) {
          relaxContainer.structures.push(snapshotCurrentStructure());
          lastSavedStep = step;
          feedLiveStep(lastMetrics);
          pushRelaxSeries(lastMetrics);
        }

        const pressureText = (!noStress && out.stress?.matrix3x3)
          ? `${pressureGPaFromStress(out.stress.matrix3x3).toFixed(2)} GPa`
          : 'n/a';
        shell.statusEl.textContent = `step ${step} / ${params.maxSteps}`;
        if (metricsEl) {
          metricsEl.innerHTML = `
            <div>energy / atom: ${Number(out.energy_per_atom).toFixed(6)} eV</div>
            <div>max force: ${mF.toFixed(5)} eV/Å</div>
            <div>pressure: ${pressureText}</div>
          `;
        }
      },
    });

    applyStructureToViewer(relaxed.structure, fileBrowser.selectedStructure, { full: true });
    setCurrentEFS(relaxed.result, relaxed.structure.keptIndices);

    // Always keep the final state in the trajectory, even off-stride.
    if (relaxed.steps !== lastSavedStep) {
      relaxContainer.structures.push(snapshotCurrentStructure());
      if (lastMetrics) {
        feedLiveStep({ ...lastMetrics, step: relaxed.steps });
        pushRelaxSeries(lastMetrics);
      }
    }

    const stepsSaved = relaxContainer.structures.length;
    updateRow(relaxRow, { name: relaxLabel, traj: stepsSaved, step: stepsSaved });

    shell.statusEl.textContent = '';
    shell.resultEl.textContent = relaxed.converged
      ? `Converged after ${relaxed.steps} steps.`
      : `Stopped after ${relaxed.steps} steps.`;
  } finally {
    // Live run over: release the plot, restore the source structure (relax
    // mutated it in place), and switch to the recorded relaxation trajectory.
    endLiveFeed();
    // Separate try/catch so a restore hiccup can't block switching to the
    // recorded relaxation trajectory (see the MD path for the rationale).
    try {
      restoreStructureInPlace(originalStructure, relaxContainer.structures[0]);
    } catch { /* safety net only */ }
    try {
      selectLastAddedRow();
      refreshActivePanels(); // rebuild the Trajectory panel for the new container
    } catch { /* non-fatal: leave selection as-is */ }
  }
}

async function runLocalEFS(shell, metricsEl, potential) {
  const runner = await ensureCalculatorReady(potential, shell);
  const nepStruct = buildNEPStructure(runner, fileBrowser.selectedStructure);
  const out = await runner.compute(nepStruct);
  setCurrentEFS(out, nepStruct.keptIndices);
  const pressureText = runner.supportsStress === false
    ? 'n/a'
    : `${pressureGPaFromStress(out.stress.matrix3x3).toFixed(2)} GPa`;
  metricsEl.innerHTML = `
    <div>energy / atom: ${Number(out.energy_per_atom).toFixed(6)} eV</div>
    <div>max force: ${maxForce(out.forces).toFixed(5)} eV/A</div>
    <div>pressure: ${pressureText}</div>
  `;
  shell.resultEl.textContent = '';
}

function bindRelaxBody(panel, shell, potential) {
  renderRelaxBody(shell.bodyEl, potential);
  const metricsEl = shell.bodyEl.querySelector('#relaxEfsMetrics');
  const efsCard = shell.bodyEl.querySelector('#relaxEfsCard');
  const relaxBtn = shell.bodyEl.querySelector('#relaxBtn');

  const aseBinding = {
    statusEl: shell.statusEl,
    resultEl: shell.resultEl,
    backendStateEl: shell.backendStateEl,
    efsMetricsEl: metricsEl,
  };

  efsCard.addEventListener('click', async () => {
    try {
      shell.resultEl.textContent = '';
      assertOrderedStructure();
      if (potential === 'ase') {
        emitASEEFS();
        setASEStatus(aseBinding, 'Requesting EFS from ASE backend...');
      } else {
        await runLocalEFS(shell, metricsEl, potential);
      }
    } catch (error) {
      shell.resultEl.textContent = `EFS failed: ${error.message || String(error)}`;
    }
  });

  relaxBtn.addEventListener('click', async () => {
    try {
      const params = readRelaxParams(shell.bodyEl);
      shell.resultEl.textContent = '';
      assertOrderedStructure();
      if (potential === 'ase') {
        emitASERelax('new', params);
        setASEStatus(aseBinding, 'Submitting ASE relaxation...');
      } else {
        await runLocalRelax(shell, params, potential);
      }
    } catch (error) {
      shell.resultEl.textContent = `Relax failed: ${error.message || String(error)}`;
    }
  });

  const rattleBtn = shell.bodyEl.querySelector('#relaxRattleBtn');
  rattleBtn?.addEventListener('click', () => {
    try {
      const amp = Number(shell.bodyEl.querySelector('#relaxRattleAmpInput')?.value || 0.1);
      const doLattice = !!shell.bodyEl.querySelector('#relaxRattleLatticeChk')?.checked;
      const pctVal = Number(shell.bodyEl.querySelector('#relaxRattleLatticePctInput')?.value);
      const latticePct = (Number.isFinite(pctVal) ? pctVal : RATTLE_LATTICE_PCT * 100) / 100;
      rattleSelectedStructure(amp, doLattice, latticePct);
      shell.resultEl.textContent = `Rattled atoms ±${amp} Å${doLattice ? `, cell ±${(latticePct * 100).toFixed(1)}%` : ''}.`;
    } catch (error) {
      shell.resultEl.textContent = `Rattle failed: ${error.message || String(error)}`;
    }
  });
}

function bindMDBody(panel, shell, potential) {
  renderMDBody(shell.bodyEl, potential);
  renderMDAnnealSummary(shell.bodyEl);

  const annealHeader = shell.bodyEl.querySelector('#mdAnnealHeader');
  const annealControls = shell.bodyEl.querySelector('#mdAnnealControls');
  const startBtn = shell.bodyEl.querySelector('#mdStartBtn');
  const stopBtn = shell.bodyEl.querySelector('#mdStopBtn');
  let mdRunning = false;
  let mdStopRequested = false;

  annealHeader?.addEventListener('click', () => {
    annealControls.classList.toggle('hidden');
    renderMDAnnealSummary(shell.bodyEl);
  });
  ['#mdAnnealMinInput', '#mdAnnealMaxInput', '#mdAnnealPeakPctInput', '#mdTemperatureInput']
    .forEach((sel) => shell.bodyEl.querySelector(sel)
      ?.addEventListener('input', () => renderMDAnnealSummary(shell.bodyEl)));

  if (potential === 'ase') {
    startBtn?.addEventListener('click', () => {
      window.alert('ASE requires a server backend, but MD over ASE is not wired yet in this UI.');
    });
    return;
  }

  stopBtn?.addEventListener('click', () => {
    mdStopRequested = true;
    shell.statusEl.textContent = 'Stopping MD after current step...';
  });

  // Ensemble: NVT (thermostat, fixed cell) or NPT (thermostat + barostat, cell
  // free to change volume). A segmented control rather than a checkbox — it
  // matches the Relax/MD and potential switches above it, and "NPT" needs the
  // one-line explanation underneath more than it needs a tick box. The word
  // "relax" is deliberately avoided here: this panel's other mode is called
  // Relax and means something completely different.
  const ensembleSwitch = shell.bodyEl.querySelector('#mdEnsembleSwitch');
  const ensembleHint = shell.bodyEl.querySelector('#mdEnsembleHint');
  const pressureInput = shell.bodyEl.querySelector('#mdPressureInput');
  const tauTInput = shell.bodyEl.querySelector('#mdTauTInput');
  const tauPInput = shell.bodyEl.querySelector('#mdTauPInput');
  const couplingHint = shell.bodyEl.querySelector('#mdCouplingHint');
  const isNpt = () => ensembleSwitch?.querySelector('button.active')?.dataset.ensemble === 'npt';

  const syncEnsembleControls = () => {
    const npt = isNpt();
    if (pressureInput) pressureInput.disabled = !npt;
    if (tauPInput) tauPInput.disabled = !npt;
    if (ensembleHint) {
      ensembleHint.textContent = npt
        ? 'constant temperature and pressure — cell volume follows the target pressure (shape fixed)'
        : 'constant temperature — cell held fixed';
    }
    if (couplingHint) {
      const tauT = Number(tauTInput?.value) || DEFAULT_THERMOSTAT_TAU_FS;
      const tauP = Number(tauPInput?.value) || DEFAULT_BAROSTAT_TAU_FS;
      // A barostat comparable in speed to the thermostat fights it: the cell
      // does work on the atoms faster than the bath can absorb it.
      couplingHint.textContent = npt && tauP < tauT * MIN_BAROSTAT_TAU_RATIO
        ? `barostat τ should be at least ${MIN_BAROSTAT_TAU_RATIO}× the thermostat τ (≥ ${tauT * MIN_BAROSTAT_TAU_RATIO} fs) — the two will fight otherwise`
        : 'τ is how fast T and P are corrected, not how accurate the run is — that is the timestep. Loosen the thermostat for undistorted sampling, tighten it to tame a hot start.';
    }
  };

  ensembleSwitch?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-ensemble]') : null;
    if (!button) return;
    ensembleSwitch.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
    syncEnsembleControls();
  });
  tauTInput?.addEventListener('input', syncEnsembleControls);
  tauPInput?.addEventListener('input', syncEnsembleControls);
  syncEnsembleControls();

  const couplingHeader = shell.bodyEl.querySelector('#mdCouplingHeader');
  const couplingControls = shell.bodyEl.querySelector('#mdCouplingControls');
  const couplingIcon = shell.bodyEl.querySelector('#mdCouplingIcon');
  couplingHeader?.addEventListener('click', () => {
    const hidden = couplingControls?.classList.toggle('hidden');
    if (couplingIcon) couplingIcon.textContent = hidden ? '▸' : '▾';
  });

  startBtn?.addEventListener('click', async () => {
    if (mdRunning) return;

    // Declared out here (not inside the try) so the finally block can see them
    // for the restore/switch even if the run throws before/after assigning.
    let originalStructure = /** @type {any} */ (null);
    let mdContainer = /** @type {any} */ (null);
    let seedFrame = /** @type {any} */ (null);
    let isContinuation = false;
    try {
      assertOrderedStructure();
      mdRunning = true;
      mdStopRequested = false;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      shell.resultEl.textContent = '';

      const runner = await ensureCalculatorReady(potential, shell);
      const steps = Number(shell.bodyEl.querySelector('#mdStepsInput')?.value || 500);
      const dtFs = Number(shell.bodyEl.querySelector('#mdTimestepInput')?.value || 1);
      const startTemperatureK = Number(shell.bodyEl.querySelector('#mdTemperatureInput')?.value || 300);
      const useAnneal = !annealControls.classList.contains('hidden');
      const useNpt = shell.bodyEl.querySelector('#mdEnsembleSwitch button.active')?.dataset.ensemble === 'npt';
      const targetPressureGPa = Number(shell.bodyEl.querySelector('#mdPressureInput')?.value || 0);
      const thermostatTauFs = Math.max(1,
        Number(shell.bodyEl.querySelector('#mdTauTInput')?.value) || DEFAULT_THERMOSTAT_TAU_FS);
      // Clamped rather than merely warned about: a barostat running as fast as
      // the thermostat is unstable, and silently producing a bad trajectory is
      // worse than quietly slowing the cell down.
      const barostatTauFs = Math.max(
        thermostatTauFs * MIN_BAROSTAT_TAU_RATIO,
        Number(shell.bodyEl.querySelector('#mdTauPInput')?.value) || DEFAULT_BAROSTAT_TAU_FS);
      const minTemperatureK = Number(shell.bodyEl.querySelector('#mdAnnealMinInput')?.value || 100);
      const maxTemperatureK = Number(shell.bodyEl.querySelector('#mdAnnealMaxInput')?.value || 1200);
      const peakFraction = Math.max(0.01, Math.min(0.99, Number(shell.bodyEl.querySelector('#mdAnnealPeakPctInput')?.value || 30) / 100));
      const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
      const saveStride = Math.max(1, Number(shell.bodyEl.querySelector('#mdSaveStrideInput')?.value || general.backendTrajectorySaveStride || 4));
      general.backendTrajectorySaveStride = saveStride;
      let lastSavedStep = 0;
      let lastStepMetrics = /** @type {any} */ (null);
      const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
      // MD animates this structure in place for live viewer feedback; keep the
      // reference so it can be restored (from the seed frame) once the run ends.
      originalStructure = fileBrowser.selectedStructure;

      // "Continue MD": resume with the selected frame's own velocities and grow
      // its container in place, instead of a fresh start — but only when that
      // frame is genuinely the trajectory's tip (compared by reference, the
      // same way this file already tracks "the" selected structure) and it was
      // actually produced by MD (relax/rattle null out .velocities, so a relaxed
      // or rattled tip always falls through to the fresh-start branch below).
      const isLastFrame = !!srcContainer
        && srcContainer.structures[srcContainer.structures.length - 1] === originalStructure;
      const resumeVelocities = (isLastFrame && originalStructure.velocities) || null;
      isContinuation = !!resumeVelocities;

      const mdLabel = `md_${potential}_${srcContainer?.fileName ?? 'run'}`;
      let mdRow;
      if (isContinuation) {
        mdContainer = srcContainer;
        seedFrame = originalStructure;
        mdRow = fileBrowser.selectedRow;
      } else {
        seedFrame = snapshotCurrentStructure();
        mdContainer = new StructureContainer({ fileName: mdLabel, structures: [seedFrame] });
        // Persist the plotted series on the container so the trajectory plot can be
        // rebuilt (e.g. after a panel rebuild from a structure-table interaction)
        // long after the live run's in-memory plot was torn down. Seed one NaN gap
        // for the initial (pre-run) frame so the series stays index-aligned with
        // mdContainer.structures.
        // No pressure series: NEP/PET-MAD/ASE MD here runs at fixed cell, so the
        // stress trace is not a meaningful pressure to plot. `step` records the
        // real MD step per saved frame so the plot's x-axis reads steps (a
        // multiple of the save stride), not the frame index; seed frame = step 0.
        mdContainer.plotSeries = {
          step: [0], temperatureK: [NaN], targetTemperatureK: [NaN], etotEv: [NaN], pressure: [NaN],
        };
        structureShip.container.push(mdContainer);
        mdRow = createRow({ name: mdLabel, traj: 1, step: 1 });
        tableBody.appendChild(mdRow);
      }
      // Continuing picks the step/time clock up from the trajectory's own
      // record, so the plot's x-axis and the on-screen step counter don't snap
      // back to 0 partway through an otherwise-continuous run.
      const resumeStep = isContinuation
        ? (mdContainer.plotSeries?.step?.[mdContainer.plotSeries.step.length - 1] ?? 0)
        : 0;
      lastSavedStep = resumeStep;

      resetLivePlot();
      ensureTrajectoryPanelForLive();
      // Evaluate the potential off-thread when we can: it is by far the longest
      // part of a step, and on the main thread it blocks paint, so the render of
      // one frame and the compute of the next serialise instead of overlapping.
      // Falls back to the in-thread runner if the worker cannot start (and for
      // MLIP/ASE, which have their own transports).
      let forceEvaluator = createNEPForceEvaluator(runner);
      let offThreadForces = false;
      if (potential === 'nep' && general.mdWorker !== false && typeof Worker !== 'undefined') {
        try {
          await ensureWorkerNEPReady();
          forceEvaluator = createWorkerNEPForceEvaluator();
          offThreadForces = true;
        } catch (workerError) {
          console.warn('NEP worker unavailable, running the potential on the main thread:', workerError);
        }
      }
      const integrator = createVelocityVerletIntegrator();
      const targetTemperatureSchedule = useAnneal
        ? createCosineAnnealingSchedule({
            startTemperatureK,
            peakTemperatureK: maxTemperatureK,
            minTemperatureK,
            peakFraction,
            totalSteps: steps,
          })
        : startTemperatureK;
      // CSVR rather than the old Berendsen rescale: same cost, but it samples
      // the canonical ensemble instead of merely holding the mean temperature.
      const thermostat = createBussiThermostat({
        targetTemperatureK: /** @type {any} */ (targetTemperatureSchedule),
        tauFs: thermostatTauFs,
      });
      const barostat = useNpt
        ? createStochasticCellBarostat({ targetPressureGPa, tauFs: barostatTauFs })
        : createNoBarostat();

      // Animate a throwaway working copy of the source structure, not the
      // source itself: the MD loop mutates fileBrowser.selectedStructure in
      // place every step for live viewer feedback, and we do NOT want that to
      // alter the user's starting structure. With a working copy the source row
      // stays exactly as provided and only MD_… holds the trajectory. (The
      // end-of-run restoreStructureInPlace remains as a belt-and-suspenders.)
      const workingStructure = snapshotCurrentStructure();
      fileBrowser.selectedStructure = workingStructure;

      const state = await initializeMDState({
        nepRunner: runner,
        structure: fileBrowser.selectedStructure,
        temperatureTargetK: startTemperatureK,
        forceEvaluator,
        initialVelocities: resumeVelocities,
      });
      if (isContinuation) {
        state.step = resumeStep;
        state.timeFs = resumeStep * dtFs;
      }

      await runMDSimulation({
        state,
        steps,
        dtFs,
        forceEvaluator,
        integrator,
        thermostat,
        barostat,
        offThreadForces,
        shouldStop: () => mdStopRequested,
        onStep: ({ step, timeFs, temperatureK, targetTemperatureK, epotEv, ekinEv, etotEv,
                   pressureGPa, volumeA3, state: mdState }) => {
          // snapshotCurrentStructure copies the viewer structure, so a save-step
          // must also apply the current state to the viewer first. Bond-topology
          // refresh is handled inside applyMDStateToViewer (BOND_TOPOLOGY_STRIDE);
          // the old forceRerender-every-5-steps full rebuild is gone.
          const shouldSave = step % saveStride === 0;
          const shouldUpdateViewer = step === 1 || shouldSave || step % viewerStride === 0;
          if (shouldUpdateViewer) {
            mdProfileMeasure('viewerMs', () => {
              applyMDStateToViewer(mdState, fileBrowser.selectedStructure);
              setCurrentEFS({
                forces: mdState.forces,
                stress: { matrix3x3: mdState.stress },
              });
            });
          }

          // Fixed-cell MD: no pressure series (see plotSeries seed above).
          lastStepMetrics = {
            step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv, pressure: pressureGPa,
          };
          if (shouldSave) {
            mdProfileMeasure('saveMs', () => {
              const frame = snapshotCurrentStructure();
              frame.energy = epotEv;
              mdContainer.structures.push(frame);
              lastSavedStep = step;
            });
            // Feed the plot exactly once per SAVED trajectory frame so the plot's
            // sample count stays 1:1 with the scrubber's frames — this is what
            // keeps the frame cursor aligned with the slider (feeding every step
            // would desync the cursor from the 1..N frame index).
            mdProfileMeasure('plotMs', () => {
              feedLiveStep(lastStepMetrics);
              mdContainer.plotSeries.step.push(step);
              mdContainer.plotSeries.temperatureK.push(temperatureK);
              mdContainer.plotSeries.targetTemperatureK.push(Number.isFinite(targetTemperatureK) ? targetTemperatureK : NaN);
              mdContainer.plotSeries.etotEv.push(etotEv);
              mdContainer.plotSeries.pressure.push(Number.isFinite(pressureGPa) ? pressureGPa : NaN);
            });
          }
          const tLabel = Number.isFinite(targetTemperatureK)
            ? `T=${temperatureK.toFixed(0)} K → ${targetTemperatureK.toFixed(0)} K`
            : `T=${temperatureK.toFixed(0)} K`;
          const pvLabel = useNpt && Number.isFinite(pressureGPa)
            ? `  ·  P=${pressureGPa.toFixed(2)} GPa  ·  V=${volumeA3.toFixed(1)} A^3`
            : '';
          shell.statusEl.textContent = `step ${step} / ${steps}  ·  t=${timeFs.toFixed(1)} fs  ·  ${tLabel}${pvLabel}`;
        },
      });

      // Run-end full apply: rebuild bond topology + refresh polyhedra one last time.
      applyMDStateToViewer(state, fileBrowser.selectedStructure, { full: true });
      setCurrentEFS({
        forces: state.forces,
        stress: { matrix3x3: state.stress },
      }, state.keptIndices);

      // Always keep the final state in the trajectory, even off-stride.
      if (state.step !== lastSavedStep) {
        const frame = snapshotCurrentStructure();
        frame.energy = state.potentialEnergyEv;
        mdContainer.structures.push(frame);
        // Keep the plot 1:1 with frames: feed this final frame too, reusing the
        // last step's computed metrics (state carries no temperature/KE fields).
        if (lastStepMetrics) {
          feedLiveStep({ ...lastStepMetrics, step: state.step });
          mdContainer.plotSeries.step.push(state.step);
          mdContainer.plotSeries.temperatureK.push(lastStepMetrics.temperatureK);
          mdContainer.plotSeries.targetTemperatureK.push(Number.isFinite(lastStepMetrics.targetTemperatureK) ? lastStepMetrics.targetTemperatureK : NaN);
          mdContainer.plotSeries.etotEv.push(lastStepMetrics.etotEv);
          mdContainer.plotSeries.pressure.push(
            Number.isFinite(lastStepMetrics.pressure) ? lastStepMetrics.pressure : NaN);
        }
      }

      const count = mdContainer.structures.length;
      // Continuation keeps the row's existing name — it's the same container,
      // not a freshly labeled one.
      updateRow(mdRow, { name: isContinuation ? srcContainer.fileName : mdLabel, traj: count, step: count });
      shell.statusEl.textContent = '';
      shell.resultEl.textContent = mdStopRequested ? `Stopped at step ${state.step}.` : `Finished at step ${state.step}.`;
    } catch (error) {
      shell.resultEl.textContent = `MD failed: ${error.message || String(error)}`;
    } finally {
      mdRunning = false;
      mdStopRequested = false;
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      // Live run is over: hand ownership of the plot back to the container's
      // persisted series so scrubbing/replay survives later panel rebuilds.
      endLiveFeed();
      // Safety-net restore of the source structure (it's normally untouched now
      // that MD animates a working copy). SEPARATE try/catch from the row switch
      // below: a restore hiccup must not prevent switching to MD_…. seedFrame is
      // the frame the run actually started from — mdContainer.structures[0] for
      // a fresh run, but the (unmoved) resumed frame itself when continuing.
      try {
        restoreStructureInPlace(originalStructure, seedFrame);
      } catch { /* safety net only */ }
      // Auto-select the recorded trajectory so the viewer refreshes to the new
      // frame(s). refreshActivePanels() rebuilds the Trajectory panel (selection
      // alone doesn't, so the scrubber otherwise stayed put until a manual row
      // click).
      try {
        if (isContinuation) {
          // Same row as before the run — jump it to the newly appended tip.
          // selectLastAddedRow() would pick whatever row is last in the table,
          // which isn't necessarily this one.
          selectStructure(fileBrowser.selectedRowIndex, mdContainer.structures.length - 1);
        } else {
          selectLastAddedRow();
        }
        refreshActivePanels();
      } catch { /* non-fatal: leave selection as-is */ }
    }
  });
}

// Reflect the current general.atomisticPotential in the selector's own widgets
// (button highlight, ASE/MLIP sub-controls, one-line hint). Pure UI — no body.
function updatePotentialUI(shell, { announce = false } = {}) {
  const potential = general.atomisticPotential || 'nep';
  shell.toggle?.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.potential === potential);
  });
  refreshBackendTheme();
  shell.aseConnectorsEl?.classList.toggle('hidden', potential !== 'ase');
  shell.mlipSourceEl?.classList.toggle('hidden', potential !== 'mlip');
  if (announce && potential === 'ase') {
    window.alert('ASE requires a server backend. Please connect to the backend server before running this mode.');
    if (shell.sourceStateEl) shell.sourceStateEl.textContent = 'ASE selected: server backend required.';
  } else if (potential === 'ase') {
    if (shell.sourceStateEl) shell.sourceStateEl.textContent = 'ASE selected: server backend required.';
  } else if (potential === 'mlip') {
    if (shell.sourceStateEl) shell.sourceStateEl.textContent = 'PET-MAD selected: load a model, then compute in-browser.';
  } else if (shell.sourceStateEl) {
    shell.sourceStateEl.textContent = '';
  }
}

// Render the body for whichever action is active (general.backendState), using
// the currently chosen potential. Called both when the action changes (Relax/MD
// switch) and when the potential changes under a fixed action.
function renderActiveBody() {
  const shell = getShellBindings();
  if (!shell.bodyEl) return;
  const potential = general.atomisticPotential || 'nep';
  if (general.backendState === 'md') {
    bindMDBody(null, shell, potential);
  } else {
    bindRelaxBody(null, shell, potential);
  }
}

// Wire the persistent potential picker ONCE. Selecting a potential updates the
// shared state and re-renders the active action's body in place — it never
// rebuilds (or resets) the selector itself.
function bindPotentialToggle() {
  const shell = getShellBindings();

  shell.toggle?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-potential]');
    if (!button) return;
    general.atomisticPotential = button.dataset.potential;
    updatePotentialUI(shell, { announce: true });
    if (shell.resultEl) shell.resultEl.textContent = '';
    renderActiveBody();
  });

  shell.aseConnectorsEl?.querySelector('[data-role="connect-ase"]')?.addEventListener('click', () => {
    void connectASEBackend({
      statusEl: shell.statusEl,
      backendStateEl: shell.backendStateEl,
      resultEl: shell.resultEl,
      efsMetricsEl: shell.bodyEl?.querySelector('#relaxEfsMetrics'),
    });
  });

  shell.aseConnectorsEl?.querySelector('[data-role="disconnect-ase"]')?.addEventListener('click', () => {
    disconnectASEBackend({
      statusEl: shell.statusEl,
      backendStateEl: shell.backendStateEl,
    });
  });

  // Eager model load: the same ensureMLIPReady path the EFS/Relax/MD entry
  // points use, so whatever is loaded here is reused by later runs.
  shell.mlipLoadBtn?.addEventListener('click', async () => {
    const btn = shell.mlipLoadBtn;
    try {
      btn.disabled = true;
      await ensureMLIPReady(shell);
    } catch (error) {
      setMLIPStatus(shell, `Load failed: ${error.message || String(error)}`);
    } finally {
      btn.disabled = false;
    }
  });

  updatePotentialUI(shell);
}

// Build the persistent potential selector once, above the Relax/MD switch.
// Idempotent: safe to call on every panel entry.
export function initAtomisticSelector() {
  const selector = document.getElementById('BackendPotentialSelector');
  if (!selector || selector.dataset.ready === '1') return;
  general.atomisticPotential = general.atomisticPotential || 'nep';
  selector.innerHTML = buildSourcePanel();
  selector.dataset.ready = '1';
  bindPotentialToggle();
}

function addAtomisticPanel(mode) {
  initAtomisticSelector();
  document.getElementById('BackendPotentialSelector')?.classList.remove('hidden');
  general.backendState = mode;
  const panel = document.getElementById('BackendCalcPanel');
  panel.innerHTML = buildBodyShell();
  renderActiveBody();
}

export function addRelaxPanel() {
  addAtomisticPanel('relax');
}

export function addMDPanel() {
  addAtomisticPanel('md');
}

export function removeAtomisticPanel() {
  const panel = document.getElementById('BackendCalcPanel');
  if (panel) panel.innerHTML = '';
  // Hide the (persistent) selector while no action is open — it has nothing to
  // drive until a mode is picked again.
  const selector = document.getElementById('BackendPotentialSelector');
  if (selector) selector.classList.add('hidden');
}
