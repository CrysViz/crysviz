import { io } from 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.esm.min.js';
import { fileBrowser, structureShip, general } from '../../store.js';
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
import { updateForces } from '../../modules/ForceModule.js';
import { updateRow, createRow, selectLastAddedRow } from '../FileBrowswerPanel.js';
import { StructureContainer } from '../../classes/StructureContainer.js';
import { Atom } from '../../classes/Atom.js';
import { Force } from '../../classes/Force.js';
import { Stress } from '../../classes/Stress.js';
import { Structure } from '../../classes/Structure.js';

const tableBody = document.querySelector('#objectTable tbody');

let nepRunner = null;
let nepInitPromise = null;
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
        positions: data.result.positions[i],
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
        positions: data.result.positions[i],
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
    const structure = new Structure({
      elements,
      uniqueElements: [...new Set(elements)],
      lattice: data.result.lattice,
      positions: data.result.positions,
      forces: new Force({ vectors: data.result.forces }),
      stress: new Stress({ tensor: convertStressEvA3ToGPa(data.result.stress) }),
    });
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
      <div class="atomistic-header-row">
        <h2>${title}</h2>
        <div class="backend-potential-toggle" data-role="potential-toggle">
          <button type="button" class="active" data-potential="nep">NEP</button>
          <button type="button" data-potential="ase">ASE</button>
        </div>
      </div>
      <div class="atomistic-source-panel">
        <div class="atomistic-source-copy">
          <div class="atomistic-source-label">Choose potential</div>
          <div class="atomistic-source-state" data-role="source-state"></div>
        </div>
        <div class="atomistic-backend-actions hidden" data-role="ase-connectors">
          <button type="button" class="calcButton" data-role="connect-ase">Connect</button>
          <button type="button" class="calcButton" data-role="disconnect-ase">Disconnect</button>
          <div class="atomistic-backend-state" data-role="backend-state">Backend: not connected</div>
        </div>
      </div>
      <div class="atomistic-body" data-role="body"></div>
      <p class="atomistic-status" data-role="status"></p>
      <p class="atomistic-result" data-role="result"></p>
    </div>
  `;
}

function getShellBindings(panel) {
  return {
    toggle: panel.querySelector('[data-role="potential-toggle"]'),
    sourceStateEl: panel.querySelector('[data-role="source-state"]'),
    aseConnectorsEl: panel.querySelector('[data-role="ase-connectors"]'),
    backendStateEl: panel.querySelector('[data-role="backend-state"]'),
    bodyEl: panel.querySelector('[data-role="body"]'),
    statusEl: panel.querySelector('[data-role="status"]'),
    resultEl: panel.querySelector('[data-role="result"]'),
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
    <div class="atomistic-card">
      <div class="atomistic-card-title-row">
        <span class="atomistic-card-title">EFS</span>
        <span class="atomistic-card-pill">${potential === 'nep' ? 'in-browser' : 'server'}</span>
      </div>
      <div class="atomistic-button-row">
        <button type="button" class="calcButton atomistic-primary-action" id="relaxEfsCard">Get EFS</button>
      </div>
      <div class="atomistic-card-metrics" id="relaxEfsMetrics">
        <div class="atomistic-empty-state"></div>
      </div>
    </div>
    <div class="atomistic-card">
      <div class="atomistic-card-title atomistic-card-title-accent">Geometry optimization</div>
      <div class="atomistic-grid atomistic-grid-2">
        <label>
          <span>max steps</span>
          <input type="number" id="relaxMaxStepsInput" value="200" step="10" min="1">
        </label>
        <label>
          <span>force tol</span>
          <input type="number" id="relaxForceTolInput" value="0.01" step="0.001" min="0">
        </label>
        <label>
          <span>target P</span>
          <input type="number" id="relaxTargetPressureInput" value="0" step="0.1">
        </label>
        <label>
          <span>stress tol</span>
          <input type="number" id="relaxStressTolInput" value="0.2" step="0.1" min="0">
        </label>
      </div>
      <div class="atomistic-button-row">
        <button type="button" class="calcButton" id="relaxAppendBtn">Append Relaxation</button>
        <button type="button" class="calcButton" id="relaxNewBtn">New Relaxation</button>
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
    <div class="atomistic-card">
      <div class="atomistic-grid atomistic-grid-2">
        <label>
          <span>Steps</span>
          <input type="number" id="mdStepsInput" value="500" step="50" min="1">
        </label>
        <label>
          <span>timestep (fs)</span>
          <input type="number" id="mdTimestepInput" value="1.0" step="0.1" min="0.1">
        </label>
        <label>
          <span>Temperature</span>
          <input type="number" id="mdTemperatureInput" value="300" step="10" min="1">
        </label>
        <label>
          <span class="atomistic-label-disabled">pressure</span>
          <input type="number" id="mdPressureInput" value="0" step="0.1" disabled>
        </label>
      </div>
      <div class="atomistic-button-row">
        <button type="button" class="calcButton" id="mdStartBtn"${potential === 'ase' ? ' disabled' : ''}>start</button>
        <button type="button" class="calcButton" id="mdStopBtn" disabled>stop</button>
      </div>
    </div>
    <div class="atomistic-card">
      <button type="button" class="atomistic-collapse-toggle" id="mdAnnealHeader">
        <span id="mdAnnealIcon">▸</span>
        <span class="atomistic-card-title atomistic-card-title-accent">Simulated Annealing</span>
      </button>
      <div class="hidden" id="mdAnnealControls">
        <div class="atomistic-grid atomistic-grid-3 atomistic-anneal-grid">
          <label>
            <span>Tmin (K)</span>
            <input type="number" id="mdAnnealMinInput" value="100" step="10" min="1">
          </label>
          <label>
            <span>Tmax (K)</span>
            <input type="number" id="mdAnnealMaxInput" value="1200" step="10" min="1">
          </label>
          <label>
            <span>Peak at %</span>
            <input type="number" id="mdAnnealPeakPctInput" value="30" step="1" min="1" max="99">
          </label>
        </div>
      </div>
    </div>
    ${potential === 'ase' ? '<div class="atomistic-hint">ASE-backed MD is not wired yet. Use NEP for in-browser MD.</div>' : ''}
  `;
}

async function runNEPRelax(shell, params) {
  const runner = await ensureNEPReady(shell.statusEl, shell.sourceStateEl);
  const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
  const saveStride = 1;
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
      const shouldUpdateViewer = step === 1 || step % viewerStride === 0;
      if (shouldUpdateViewer) {
        applyStructureToViewer(current, fileBrowser.selectedStructure);
        setCurrentEFS(out);
      }

      if (step % saveStride === 0) {
        relaxContainer.structures.push(snapshotCurrentStructure());
      }

      const pressure = pressureGPaFromStress(out.stress.matrix3x3);
      shell.statusEl.textContent = `Relax step ${step}: E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A, P=${pressure.toFixed(2)} GPa`;
    },
  });

  applyStructureToViewer(relaxed.structure, fileBrowser.selectedStructure);
  setCurrentEFS(relaxed.result);

  const stepsSaved = relaxContainer.structures.length;
  updateRow(relaxRow, { name: relaxLabel, traj: stepsSaved, step: stepsSaved });

  const pressure = pressureGPaFromStress(relaxed.result.stress.matrix3x3);
  shell.resultEl.textContent = relaxed.converged
    ? `Relax converged after ${relaxed.steps} steps. E/atom=${Number(relaxed.result.energy_per_atom).toFixed(6)} eV, max|F|=${relaxed.maxForce.toFixed(5)} eV/A, P=${pressure.toFixed(2)} GPa`
    : `Relax stopped after ${relaxed.steps} steps. E/atom=${Number(relaxed.result.energy_per_atom).toFixed(6)} eV, max|F|=${relaxed.maxForce.toFixed(5)} eV/A, P=${pressure.toFixed(2)} GPa`;
}

async function runNEPEFS(shell, metricsEl) {
  const runner = await ensureNEPReady(shell.statusEl, shell.sourceStateEl);
  const nepStruct = buildNEPStructure(runner, fileBrowser.selectedStructure);
  const out = runner.compute(nepStruct);
  setCurrentEFS(out);
  const pressure = pressureGPaFromStress(out.stress.matrix3x3);
  metricsEl.innerHTML = `
    <div>energy / atom: ${Number(out.energy_per_atom).toFixed(6)} eV</div>
    <div>max force: ${maxForce(out.forces).toFixed(5)} eV/A</div>
    <div>pressure: ${pressure.toFixed(2)} GPa</div>
  `;
  shell.resultEl.textContent = `EFS ready. E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${maxForce(out.forces).toFixed(5)} eV/A, P=${pressure.toFixed(2)} GPa`;
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
      if (potential === 'nep') {
        await runNEPEFS(shell, metricsEl);
      } else {
        emitASEEFS();
        setASEStatus(aseBinding, 'Requesting EFS from ASE backend...');
      }
    } catch (error) {
      shell.resultEl.textContent = `EFS failed: ${error.message || String(error)}`;
    }
  });

  appendBtn.addEventListener('click', async () => {
    try {
      const params = readRelaxParams(shell.bodyEl);
      shell.resultEl.textContent = '';
      if (potential === 'nep') {
        await runNEPRelax(shell, params);
      } else {
        emitASERelax('append', params);
        setASEStatus(aseBinding, 'Submitting ASE append relaxation...');
      }
    } catch (error) {
      shell.resultEl.textContent = `Relax failed: ${error.message || String(error)}`;
    }
  });

  newBtn.addEventListener('click', async () => {
    try {
      const params = readRelaxParams(shell.bodyEl);
      shell.resultEl.textContent = '';
      if (potential === 'nep') {
        await runNEPRelax(shell, params);
      } else {
        emitASERelax('new', params);
        setASEStatus(aseBinding, 'Submitting ASE new relaxation...');
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

      const runner = await ensureNEPReady(shell.statusEl, shell.sourceStateEl);
      const steps = Number(shell.bodyEl.querySelector('#mdStepsInput')?.value || 500);
      const dtFs = Number(shell.bodyEl.querySelector('#mdTimestepInput')?.value || 1);
      const startTemperatureK = Number(shell.bodyEl.querySelector('#mdTemperatureInput')?.value || 300);
      const useAnneal = !annealControls.classList.contains('hidden');
      const minTemperatureK = Number(shell.bodyEl.querySelector('#mdAnnealMinInput')?.value || 100);
      const maxTemperatureK = Number(shell.bodyEl.querySelector('#mdAnnealMaxInput')?.value || 1200);
      const peakFraction = Math.max(0.01, Math.min(0.99, Number(shell.bodyEl.querySelector('#mdAnnealPeakPctInput')?.value || 30) / 100));
      const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
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
        targetTemperatureK: targetTemperatureSchedule,
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
          const shouldUpdateViewer = step === 1 || step % viewerStride === 0;
          if (shouldUpdateViewer) {
            const forceRerender = step % Math.max(5, viewerStride) === 0;
            applyMDStateToViewer(mdState, fileBrowser.selectedStructure, { forceRerender });
            setCurrentEFS({
              forces: mdState.forces,
              stress: { matrix3x3: mdState.stress },
            });
          }

          mdContainer.structures.push(snapshotCurrentStructure());
          const ePerAtom = epotEv / Math.max(1, mdState.positions.length);
          const mF = maxForce(mdState.forces);
          shell.resultEl.textContent = `MD step ${step}: E/atom=${ePerAtom.toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A`;
          shell.statusEl.textContent = Number.isFinite(targetTemperatureK)
            ? `MD t=${timeFs.toFixed(1)} fs | T=${temperatureK.toFixed(1)} K | Ttarget=${targetTemperatureK.toFixed(1)} K`
            : `MD t=${timeFs.toFixed(1)} fs | T=${temperatureK.toFixed(1)} K`;
          monitor.update({ step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv });
        },
      });

      const count = mdContainer.structures.length;
      updateRow(mdRow, { name: mdLabel, traj: count, step: count });
      shell.statusEl.textContent = mdStopRequested ? `MD stopped at step ${state.step}` : `MD finished at step ${state.step}`;
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

    shell.aseConnectorsEl.classList.toggle('hidden', potential !== 'ase');
    shell.resultEl.textContent = '';

    if (potential === 'ase') {
      window.alert('ASE requires a server backend. Please connect to the backend server before running this mode.');
      shell.sourceStateEl.textContent = 'ASE selected: server backend required.';
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
  panel.innerHTML = '<h1>Choose Symmetry, Relax, or MD mode for more advanced functionalities</h1>';
}
