import { io } from 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.esm.min.js';
import { fileBrowser, structureShip, general } from '../../state/store.js';
import {
  buildNEPStructure,
  relaxUntilConverged,
  applyStructureToViewer,
  maxForce,
  pressureGPaFromStress,
} from '../../atomistic/relaxer.js';
import {
  initializeMDState,
  runMDSimulation,
  applyMDStateToViewer,
  createMDMonitorPanel,
  createNEPForceEvaluator,
  createVelocityVerletIntegrator,
  createCosineAnnealingSchedule,
  createVelocityRescaleThermostat,
} from '../../atomistic/MD.js';
import { MLIPRunner } from '../../external/mlip_wasm/mlip_runner.js';
import { updateForces } from '../../render/index.js';
import { updateRow, createRow, selectLastAddedRow } from '../FileBrowswerPanel.js';
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

function convertStressEvA3ToGPa(stressTensor) {
  const factor = 160.21766208;
  return stressTensor.map((row) => row.map((value) => value * factor));
}

function setCurrentEFS(out) {
  fileBrowser.selectedStructure.forces = out.forces.map((v) => new Force({ vector: [...v] }));
  fileBrowser.selectedStructure.stress = new Stress({
    tensor: out.stress.matrix3x3.map((row) => [...row]),
  });

  if (general.spinForceState === 'Forces') {
    updateForces();
  }
}

function snapshotCurrentStructure() {
  const src = fileBrowser.selectedStructure;
  const elements = [...src.elements];
  const atoms = src.atoms.map((atom, index) => new Atom({
    position: [...atom.position],
    element: elements[index],
    uuid: atom.uuid,
  }));
  const forces = (src.forces ?? []).map((force) => new Force({ vector: [...force.vector] }));
  const stress = src.stress ? new Stress({ tensor: src.stress.tensor.map((row) => [...row]) }) : null;

  return new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice: src.lattice.map((row) => [...row]),
    atoms,
    forces,
    stress,
    periodic: { hash: 'None', wrapped: null },
  });
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
  aseSocket.off('append', aseBoundElements.onAppend);
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

  const onAppend = (data) => {
    setASEStatus(bound, 'ASE relaxation appended.');
    if (bound.resultEl) bound.resultEl.textContent = data.log ?? '';
    const selected = structureShip.container[fileBrowser.selectedRowIndex];
    const trajLength = selected.structures.length + data.result.positions.length;

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
      selected.structures.push(structure);
    }

    updateRow(fileBrowser.selectedRow, {
      name: selected.fileName,
      traj: trajLength,
      step: trajLength,
    });
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
    const fileName = `rx_${sourceFileName}`;
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
    onAppend,
    onNew,
    onGetEFS,
    onStressUpdate,
  };

  aseSocket.on('connect', onConnect);
  aseSocket.on('connect_error', onConnectError);
  aseSocket.on('status', onStatus);
  aseSocket.on('append', onAppend);
  aseSocket.on('new', onNew);
  aseSocket.on('getEFS', onGetEFS);
  aseSocket.on('stressUpdate', onStressUpdate);
}

function connectASEBackend(bound) {
  bindASEHandlers(bound);

  if (aseConnected) {
    if (bound.backendStateEl) bound.backendStateEl.textContent = 'Backend: connected';
    setASEStatus(bound, 'ASE backend connected.');
    return;
  }

  if (!aseSocket) {
    aseSocket = io('http://localhost:5001', {
      timeout: 1000,
      reconnection: false,
    });
    bindASEHandlers(bound);
  }
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

function buildPanelShell(title) {
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
      <div class="atomistic-body" data-role="body"></div>
    </div>
  `;
}

function getShellBindings(panel) {
  const sourceStateEl = panel.querySelector('[data-role="source-state"]');
  return {
    toggle: panel.querySelector('[data-role="potential-toggle"]'),
    sourceStateEl,
    aseConnectorsEl: panel.querySelector('[data-role="ase-connectors"]'),
    backendStateEl: panel.querySelector('[data-role="backend-state"]'),
    mlipSourceEl: panel.querySelector('[data-role="mlip-source"]'),
    mlipModelSelect: panel.querySelector('[data-role="mlip-model"]'),
    mlipBackendSelect: panel.querySelector('[data-role="mlip-backend"]'),
    mlipLoadBtn: panel.querySelector('[data-role="mlip-load"]'),
    mlipFileInput: panel.querySelector('[data-role="mlip-file"]'),
    mlipStatusEl: panel.querySelector('[data-role="mlip-status"]'),
    bodyEl: panel.querySelector('[data-role="body"]'),
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
        <button type="button" class="calcButton" id="relaxAppendBtn">Append</button>
        <button type="button" class="calcButton" id="relaxNewBtn">New</button>
      </div>
    </div>
  `;
}

function renderMDAnnealSummary(bodyEl) {
  const enabled = bodyEl.querySelector('#mdAnnealControls') && !bodyEl.querySelector('#mdAnnealControls').classList.contains('hidden');
  const controls = bodyEl.querySelector('#mdAnnealControls');
  const icon = bodyEl.querySelector('#mdAnnealIcon');
  if (!controls || !icon) return;
  icon.textContent = enabled ? '▾' : '▸';
}

function renderMDBody(bodyEl, potential) {
  bodyEl.innerHTML = `
    <div class="atomistic-card atomistic-card-compact">
      <div class="atomistic-grid atomistic-grid-2 atomistic-grid-compact">
        <label>
          <span>Steps</span>
          <input type="number" class="atomistic-input-sm" id="mdStepsInput" value="500" step="50" min="1">
        </label>
        <label>
          <span>timestep (fs)</span>
          <input type="number" class="atomistic-input-sm" id="mdTimestepInput" value="1.0" step="0.1" min="0.1">
        </label>
        <label>
          <span>Temperature</span>
          <input type="number" class="atomistic-input-sm" id="mdTemperatureInput" value="300" step="10" min="1">
        </label>
        <label>
          <span class="atomistic-label-disabled">pressure</span>
          <input type="number" class="atomistic-input-sm" id="mdPressureInput" value="0" step="0.1" disabled>
        </label>
      </div>
      <div class="atomistic-button-row atomistic-button-row-compact">
        <button type="button" class="calcButton" id="mdStartBtn"${potential === 'ase' ? ' disabled' : ''}>start</button>
        <button type="button" class="calcButton" id="mdStopBtn" disabled>stop</button>
      </div>
      <div class="atomistic-anneal-section">
        <button type="button" class="atomistic-collapse-toggle" id="mdAnnealHeader">
          <span id="mdAnnealIcon">▸</span>
          <span class="atomistic-card-title-accent atomistic-anneal-title">Simulated Annealing</span>
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
        </div>
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
  const relaxLabel = `Relax_${srcContainer?.fileName ?? 'run'}`;
  const relaxContainer = new StructureContainer({ fileName: relaxLabel, structures: [snapshotCurrentStructure()] });
  structureShip.container.push(relaxContainer);
  const relaxRow = createRow({ name: relaxLabel, traj: 1, step: 1 });
  tableBody.appendChild(relaxRow);

  shell.statusEl.textContent = 'Relaxation running...';
  shell.resultEl.textContent = '';

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
        setCurrentEFS(out);
      }

      if (shouldSave) {
        relaxContainer.structures.push(snapshotCurrentStructure());
        lastSavedStep = step;
      }

      const pressureText = noStress
        ? 'n/a'
        : `${pressureGPaFromStress(out.stress.matrix3x3).toFixed(2)} GPa`;
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
  setCurrentEFS(relaxed.result);

  // Always keep the final state in the trajectory, even off-stride.
  if (relaxed.steps !== lastSavedStep) {
    relaxContainer.structures.push(snapshotCurrentStructure());
  }

  const stepsSaved = relaxContainer.structures.length;
  updateRow(relaxRow, { name: relaxLabel, traj: stepsSaved, step: stepsSaved });

  shell.statusEl.textContent = '';
  shell.resultEl.textContent = relaxed.converged
    ? `Converged after ${relaxed.steps} steps.`
    : `Stopped after ${relaxed.steps} steps.`;
}

async function runLocalEFS(shell, metricsEl, potential) {
  const runner = await ensureCalculatorReady(potential, shell);
  const nepStruct = buildNEPStructure(runner, fileBrowser.selectedStructure);
  const out = await runner.compute(nepStruct);
  setCurrentEFS(out);
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
  const appendBtn = shell.bodyEl.querySelector('#relaxAppendBtn');
  const newBtn = shell.bodyEl.querySelector('#relaxNewBtn');

  const aseBinding = {
    statusEl: shell.statusEl,
    resultEl: shell.resultEl,
    backendStateEl: shell.backendStateEl,
    efsMetricsEl: metricsEl,
  };

  efsCard.addEventListener('click', async () => {
    try {
      shell.resultEl.textContent = '';
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

  appendBtn.addEventListener('click', async () => {
    try {
      const params = readRelaxParams(shell.bodyEl);
      shell.resultEl.textContent = '';
      if (potential === 'ase') {
        emitASERelax('append', params);
        setASEStatus(aseBinding, 'Submitting ASE append relaxation...');
      } else {
        await runLocalRelax(shell, params, potential);
      }
    } catch (error) {
      shell.resultEl.textContent = `Relax failed: ${error.message || String(error)}`;
    }
  });

  newBtn.addEventListener('click', async () => {
    try {
      const params = readRelaxParams(shell.bodyEl);
      shell.resultEl.textContent = '';
      if (potential === 'ase') {
        emitASERelax('new', params);
        setASEStatus(aseBinding, 'Submitting ASE new relaxation...');
      } else {
        await runLocalRelax(shell, params, potential);
      }
    } catch (error) {
      shell.resultEl.textContent = `Relax failed: ${error.message || String(error)}`;
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

  startBtn?.addEventListener('click', async () => {
    if (mdRunning) return;

    let monitor = null;
    try {
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
      const minTemperatureK = Number(shell.bodyEl.querySelector('#mdAnnealMinInput')?.value || 100);
      const maxTemperatureK = Number(shell.bodyEl.querySelector('#mdAnnealMaxInput')?.value || 1200);
      const peakFraction = Math.max(0.01, Math.min(0.99, Number(shell.bodyEl.querySelector('#mdAnnealPeakPctInput')?.value || 30) / 100));
      const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
      const saveStride = Math.max(1, Number(general.backendTrajectorySaveStride || 1));
      let lastSavedStep = 0;
      const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
      const mdLabel = `MD_${srcContainer?.fileName ?? 'run'}`;
      const mdContainer = new StructureContainer({ fileName: mdLabel, structures: [snapshotCurrentStructure()] });
      structureShip.container.push(mdContainer);
      const mdRow = createRow({ name: mdLabel, traj: 1, step: 1 });
      tableBody.appendChild(mdRow);

      monitor = createMDMonitorPanel();
      const forceEvaluator = createNEPForceEvaluator(runner);
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
      const thermostat = createVelocityRescaleThermostat({
        targetTemperatureK: /** @type {any} */ (targetTemperatureSchedule),
        tauFs: 20,
      });

      const state = await initializeMDState({
        nepRunner: runner,
        structure: fileBrowser.selectedStructure,
        temperatureTargetK: startTemperatureK,
        forceEvaluator,
      });

      await runMDSimulation({
        state,
        steps,
        dtFs,
        forceEvaluator,
        integrator,
        thermostat,
        shouldStop: () => mdStopRequested,
        onStep: ({ step, timeFs, temperatureK, targetTemperatureK, epotEv, ekinEv, etotEv, state: mdState }) => {
          // snapshotCurrentStructure copies the viewer structure, so a save-step
          // must also apply the current state to the viewer first. Bond-topology
          // refresh is handled inside applyMDStateToViewer (BOND_TOPOLOGY_STRIDE);
          // the old forceRerender-every-5-steps full rebuild is gone.
          const shouldSave = step % saveStride === 0;
          const shouldUpdateViewer = step === 1 || shouldSave || step % viewerStride === 0;
          if (shouldUpdateViewer) {
            applyMDStateToViewer(mdState, fileBrowser.selectedStructure);
            setCurrentEFS({
              forces: mdState.forces,
              stress: { matrix3x3: mdState.stress },
            });
          }

          if (shouldSave) {
            mdContainer.structures.push(snapshotCurrentStructure());
            lastSavedStep = step;
          }
          const tLabel = Number.isFinite(targetTemperatureK)
            ? `T=${temperatureK.toFixed(0)} K → ${targetTemperatureK.toFixed(0)} K`
            : `T=${temperatureK.toFixed(0)} K`;
          shell.statusEl.textContent = `step ${step} / ${steps}  ·  t=${timeFs.toFixed(1)} fs  ·  ${tLabel}`;
          monitor.update({ step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv });
        },
      });

      // Run-end full apply: rebuild bond topology + refresh polyhedra one last time.
      applyMDStateToViewer(state, fileBrowser.selectedStructure, { full: true });
      setCurrentEFS({
        forces: state.forces,
        stress: { matrix3x3: state.stress },
      });

      // Always keep the final state in the trajectory, even off-stride.
      if (state.step !== lastSavedStep) {
        mdContainer.structures.push(snapshotCurrentStructure());
      }

      const count = mdContainer.structures.length;
      updateRow(mdRow, { name: mdLabel, traj: count, step: count });
      shell.statusEl.textContent = '';
      shell.resultEl.textContent = mdStopRequested ? `Stopped at step ${state.step}.` : `Finished at step ${state.step}.`;
    } catch (error) {
      shell.resultEl.textContent = `MD failed: ${error.message || String(error)}`;
    } finally {
      mdRunning = false;
      mdStopRequested = false;
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    }
  });
}

function bindPotentialToggle(panel, shell, mode) {
  let potential = 'nep';

  const render = async () => {
    shell.toggle.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('active', button.dataset.potential === potential);
    });
    general.atomisticPotential = potential;
    refreshBackendTheme();

    shell.aseConnectorsEl.classList.toggle('hidden', potential !== 'ase');
    shell.mlipSourceEl.classList.toggle('hidden', potential !== 'mlip');
    shell.resultEl.textContent = '';

    if (potential === 'ase') {
      window.alert('ASE requires a server backend. Please connect to the backend server before running this mode.');
      shell.sourceStateEl.textContent = 'ASE selected: server backend required.';
    } else if (potential === 'mlip') {
      shell.sourceStateEl.textContent = 'PET-MAD selected: load a model, then compute in-browser.';
    } else {
      shell.sourceStateEl.textContent = '';
    }

    if (mode === 'relax') {
      bindRelaxBody(panel, shell, potential);
    } else {
      bindMDBody(panel, shell, potential);
    }
  };

  shell.toggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-potential]');
    if (!button) return;
    potential = button.dataset.potential;
    render();
  });

  shell.aseConnectorsEl.querySelector('[data-role="connect-ase"]')?.addEventListener('click', () => {
    connectASEBackend({
      statusEl: shell.statusEl,
      backendStateEl: shell.backendStateEl,
      resultEl: shell.resultEl,
      efsMetricsEl: shell.bodyEl.querySelector('#relaxEfsMetrics'),
    });
  });

  shell.aseConnectorsEl.querySelector('[data-role="disconnect-ase"]')?.addEventListener('click', () => {
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

  render();
}

function addAtomisticPanel(mode) {
  const panel = document.getElementById('BackendCalcPanel');
  const title = mode === 'relax' ? 'Relax' : 'MD';
  panel.innerHTML = buildPanelShell(title);
  const shell = getShellBindings(panel);
  bindPotentialToggle(panel, shell, mode);
}

export function addRelaxPanel() {
  addAtomisticPanel('relax');
}

export function addMDPanel() {
  addAtomisticPanel('md');
}

export function removeAtomisticPanel() {
  const panel = document.getElementById('BackendCalcPanel');
  panel.innerHTML = '';
}
