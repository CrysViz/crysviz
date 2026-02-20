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
  createVelocityRescaleThermostat,
} from '../../atomistic/MD.js';
import { updateForces } from '../../modules/ForceModule.js';
import { updateRow } from '../FileBrowswerPanel.js';
import { Atom } from '../../classes/Atom.js';
import { Force } from '../../classes/Force.js';
import { Stress } from '../../classes/Stress.js';
import { Structure } from '../../classes/Structure.js';

let nepRunner = null;
let nepInitPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function initNEP() {
  if (nepInitPromise) return nepInitPromise;

  nepInitPromise = (async () => {
    await loadScript('./backend/nep_wasm/nep_wasm.js');
    await loadScript('./backend/nep_wasm/nep_simple.js');

    nepRunner = new window.NEPWasmRunner({
      defaultModelUrl: './backend/nep_wasm/nep89_20250409.txt',
    });

    await nepRunner.init();
    await nepRunner.loadDefaultModel();
    return nepRunner;
  })();

  return nepInitPromise;
}

function setCurrentEFS(out) {
  fileBrowser.selectedStructure.forces = out.forces.map((v) => new Force({ vector: [...v] }));
  fileBrowser.selectedStructure.stress = new Stress({
    tensor: out.stress.matrix3x3.map((r) => [...r]),
  });

  if (general.spinForceState === 'Forces') {
    updateForces();
  }
}

function snapshotCurrentStructure() {
  const src = fileBrowser.selectedStructure;
  const elements = [...src.elements];
  const atoms = src.atoms.map((a, i) => new Atom({
    position: [...a.position],
    element: elements[i],
    uuid: a.uuid,
  }));
  const forces = (src.forces ?? []).map((f) => new Force({ vector: [...f.vector] }));
  const stress = src.stress ? new Stress({ tensor: src.stress.tensor.map((r) => [...r]) }) : null;

  return new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice: src.lattice.map((r) => [...r]),
    atoms,
    forces,
    stress,
    periodic: { hash: 'None', wrapped: null },
  });
}

export async function addNEPPanel() {
  const panel = document.getElementById('BackendCalcPanel');

  panel.innerHTML = `
    <div id="nepPanel">
      <h2 style="margin:0 0 8px 0;">NEP (WASM)</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="calcButton" id="nepRunBtn" disabled>Initialize NEP...</button>
        <button class="calcButton" id="nepRelaxBtn" disabled>Relax</button>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px;">
          max steps
          <input type="number" id="nepMaxStepsInput" value="200" step="10" min="1" style="width:80px;" />
        </label>
        <label style="display:flex; align-items:center; gap:6px;">
          target P (GPa)
          <input type="number" id="nepTargetPressureInput" value="0.0" step="0.1" style="width:90px;" />
        </label>
      </div>
      <hr style="margin:12px 0; border-color:#444;" />
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="calcButton" id="nepMDStartBtn" disabled>Run MD</button>
        <button class="calcButton" id="nepMDStopBtn" disabled>Stop MD</button>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px;">
          MD steps
          <input type="number" id="nepMDStepsInput" value="500" step="50" min="1" style="width:80px;" />
        </label>
        <label style="display:flex; align-items:center; gap:6px;">
          target T (K)
          <input type="number" id="nepMDTempInput" value="300" step="10" min="1" style="width:90px;" />
        </label>
      </div>
      <p id="nepStatus" style="margin-top:10px;"></p>
      <p id="nepResult" style="margin-top:10px;font-weight:bold;"></p>
    </div>
  `;

  const runBtn = document.getElementById('nepRunBtn');
  const relaxBtn = document.getElementById('nepRelaxBtn');
  const mdStartBtn = document.getElementById('nepMDStartBtn');
  const mdStopBtn = document.getElementById('nepMDStopBtn');
  const maxStepsInput = document.getElementById('nepMaxStepsInput');
  const targetPressureInput = document.getElementById('nepTargetPressureInput');
  const mdStepsInput = document.getElementById('nepMDStepsInput');
  const mdTempInput = document.getElementById('nepMDTempInput');
  const status = document.getElementById('nepStatus');
  const result = document.getElementById('nepResult');
  let mdStopRequested = false;
  let mdRunning = false;

  try {
    await initNEP();
    status.textContent = `Model loaded: ${nepRunner.modelInfo.name}`;
    runBtn.textContent = 'Get Forces + Stress';
    runBtn.disabled = false;
    relaxBtn.disabled = false;
    mdStartBtn.disabled = false;
  } catch (err) {
    status.textContent = `NEP init failed: ${err.message || String(err)}`;
    runBtn.textContent = 'Initialization failed';
    relaxBtn.disabled = true;
    mdStartBtn.disabled = true;
    return;
  }

  runBtn.onclick = () => {
    try {
      const nepStruct = buildNEPStructure(nepRunner, fileBrowser.selectedStructure);
      const out = nepRunner.compute(nepStruct);
      setCurrentEFS(out);
      const pGPa = pressureGPaFromStress(out.stress.matrix3x3);
      result.textContent = `E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${maxForce(out.forces).toFixed(5)} eV/A, P=${pGPa.toFixed(2)} GPa`;
    } catch (err) {
      result.textContent = `Failed: ${err.message || String(err)}`;
    }
  };

  relaxBtn.onclick = () => {
    (async () => {
      try {
      const fmaxTol = 0.01;
      const atomStep = 0.02;
      const cellStep = 0.002;
      const maxSteps = Number(maxStepsInput.value || 200);
      const targetPressureGPa = Number(targetPressureInput.value || 0.0);
      const saveTrajectory = true;
      const stride = 1;
      const container = structureShip.container[fileBrowser.selectedRowIndex];
      const row = fileBrowser.selectedRow;

      runBtn.disabled = true;
      relaxBtn.disabled = true;
      mdStartBtn.disabled = true;
      status.textContent = `Relaxing... target fmax=${fmaxTol.toFixed(3)} eV/A, target P=${targetPressureGPa.toFixed(2)} GPa`;

      const nepStruct = buildNEPStructure(nepRunner, fileBrowser.selectedStructure);
      const relaxed = await relaxUntilConverged(nepRunner, nepStruct, {
        fmaxTol,
        maxSteps,
        atomStep,
        cellStep,
        targetPressureGPa,
        onStep: (step, current, out, mF) => {
          applyStructureToViewer(current, fileBrowser.selectedStructure);
          setCurrentEFS(out);

          if (saveTrajectory && container && step % stride === 0) {
            container.structures.push(snapshotCurrentStructure());
          }

          const pGPa = pressureGPaFromStress(out.stress.matrix3x3);
          status.textContent = `Relax step ${step}: E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A, P=${pGPa.toFixed(2)} GPa`;
        },
      });

      applyStructureToViewer(relaxed.structure, fileBrowser.selectedStructure);
      setCurrentEFS(relaxed.result);

      if (saveTrajectory && container && row) {
        const n = container.structures.length;
        updateRow(row, {
          name: container.fileName,
          traj: n,
          step: n,
        });
      }

      const pGPa = pressureGPaFromStress(relaxed.result.stress.matrix3x3);
      if (relaxed.converged) {
        result.textContent = `Converged after ${relaxed.steps} steps: E/atom=${Number(relaxed.result.energy_per_atom).toFixed(6)} eV, max|F|=${relaxed.maxForce.toFixed(5)} eV/A, P=${pGPa.toFixed(2)} GPa`;
      } else {
        const misses = [];
        if (!relaxed.convergedForce) misses.push('force');
        if (!relaxed.convergedPressure) misses.push('pressure');
        result.textContent = `Stopped after ${relaxed.steps} steps (not converged: ${misses.join('+')}): E/atom=${Number(relaxed.result.energy_per_atom).toFixed(6)} eV, max|F|=${relaxed.maxForce.toFixed(5)} eV/A, P=${pGPa.toFixed(2)} GPa`;
      }
    } catch (err) {
      result.textContent = `Relax failed: ${err.message || String(err)}`;
    } finally {
      runBtn.disabled = false;
      relaxBtn.disabled = false;
      mdStartBtn.disabled = false;
    }
    })();
  };

  mdStopBtn.onclick = () => {
    mdStopRequested = true;
    status.textContent = 'Stopping MD after current step...';
  };

  mdStartBtn.onclick = () => {
    (async () => {
      if (mdRunning) return;
      let monitor = null;
      try {
        mdRunning = true;
        mdStopRequested = false;

        const mdSteps = Number(mdStepsInput.value || 500);
        const targetTemperatureK = Number(mdTempInput.value || 300);
        const dtFs = 1.0;
        const container = structureShip.container[fileBrowser.selectedRowIndex];
        const row = fileBrowser.selectedRow;

        runBtn.disabled = true;
        relaxBtn.disabled = true;
        mdStartBtn.disabled = true;
        mdStopBtn.disabled = false;
        status.textContent = `MD running... dt=${dtFs.toFixed(2)} fs, Ttarget=${targetTemperatureK.toFixed(1)} K`;

        monitor = createMDMonitorPanel();
        const forceEvaluator = createNEPForceEvaluator(nepRunner);
        const integrator = createVelocityVerletIntegrator();
        const thermostat = createVelocityRescaleThermostat({ targetTemperatureK, tauFs: 20 });
        const state = await initializeMDState({
          nepRunner,
          structure: fileBrowser.selectedStructure,
          temperatureTargetK: targetTemperatureK,
          forceEvaluator,
        });

        const mdRun = await runMDSimulation({
          state,
          steps: mdSteps,
          dtFs,
          forceEvaluator,
          integrator,
          thermostat,
          shouldStop: () => mdStopRequested,
          onStep: ({ step, timeFs, temperatureK, epotEv, ekinEv, etotEv, state: mdState }) => {
            const forceRerender = step % 5 === 0;
            applyMDStateToViewer(mdState, fileBrowser.selectedStructure, { forceRerender });
            setCurrentEFS({
              forces: mdState.forces,
              stress: { matrix3x3: mdState.stress },
            });

            if (container) {
              container.structures.push(snapshotCurrentStructure());
            }

            const nAtoms = Math.max(1, mdState.positions.length);
            const ePerAtom = epotEv / nAtoms;
            const mF = maxForce(mdState.forces);
            result.textContent = `MD step ${step}: E/atom=${ePerAtom.toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A`;
            status.textContent = `MD t=${timeFs.toFixed(1)} fs | T=${temperatureK.toFixed(1)} K`;
            monitor.update({ step, temperatureK, etotEv, epotEv, ekinEv });
          },
        });

        if (container && row) {
          const n = container.structures.length;
          updateRow(row, {
            name: container.fileName,
            traj: n,
            step: n,
          });
        }

        if (mdRun.stopped) {
          status.textContent = `MD stopped at step ${state.step}`;
        } else {
          status.textContent = `MD finished at step ${state.step}`;
        }
      } catch (err) {
        result.textContent = `MD failed: ${err.message || String(err)}`;
      } finally {
        mdRunning = false;
        mdStopRequested = false;
        runBtn.disabled = false;
        relaxBtn.disabled = false;
        mdStartBtn.disabled = false;
        mdStopBtn.disabled = true;
      }
    })();
  };
}
