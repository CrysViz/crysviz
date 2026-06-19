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
import { updateForces } from '../../render/ForceModule.js';
import { updateRow, createRow } from '../FileBrowswerPanel.js';
import { StructureContainer } from '../../model/StructureContainer.js';
import { Atom } from '../../model/Atom.js';
import { Force } from '../../model/Force.js';
import { Stress } from '../../model/Stress.js';
import { Structure } from '../../model/Structure.js';

const tableBody = document.querySelector('#objectTable tbody');

let nepRunner = null;
let nepInitPromise = null;

function createStepPerfTracker(label) {
  const startedAt = performance.now();
  let lastAt = startedAt;
  let lastStep = 0;
  let fps = 0;

  return {
    tick(step) {
      const now = performance.now();
      const dt = Math.max(1e-9, now - lastAt);
      const stepDelta = Math.max(1, step - lastStep);
      fps = (stepDelta * 1000) / dt;
      lastAt = now;
      lastStep = step;
      return fps;
    },
    summary(step) {
      const totalMs = Math.max(1e-9, performance.now() - startedAt);
      return {
        label,
        steps: step,
        totalMs,
        totalSeconds: totalMs / 1000,
        avgFps: (step * 1000) / totalMs,
        lastFps: fps,
      };
    },
  };
}

function formatPerf(summary) {
  return `${summary.label}: ${summary.steps} steps in ${summary.totalSeconds.toFixed(2)} s | avg ${summary.avgFps.toFixed(1)} FPS | last ${summary.lastFps.toFixed(1)} FPS`;
}

function logTimingBreakdown(timing) {
  if (!timing || !timing.totalMs) return;
  const pct = (value) => ((100 * value) / timing.totalMs).toFixed(1);

  if (timing.label === 'Relax') {
    console.info(
      `[timing] Relax total=${timing.totalMs.toFixed(1)}ms | compute=${timing.computeMs.toFixed(1)}ms (${pct(timing.computeMs)}%) | onStep=${timing.onStepMs.toFixed(1)}ms (${pct(timing.onStepMs)}%) | update=${timing.updateMs.toFixed(1)}ms (${pct(timing.updateMs)}%) | wait=${timing.waitMs.toFixed(1)}ms (${pct(timing.waitMs)}%)`
    );
    return;
  }

  if (timing.label === 'MD') {
    console.info(
      `[timing] MD total=${timing.totalMs.toFixed(1)}ms | integrate=${timing.integrateMs.toFixed(1)}ms (${pct(timing.integrateMs)}%) | thermostat=${timing.thermostatMs.toFixed(1)}ms (${pct(timing.thermostatMs)}%) | onStep=${timing.onStepMs.toFixed(1)}ms (${pct(timing.onStepMs)}%) | wait=${timing.waitMs.toFixed(1)}ms (${pct(timing.waitMs)}%)`
    );
  }
}

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
      <div style="margin-top:8px; padding:8px 0 0 0; border-top:1px solid rgba(255,255,255,0.08);">
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; color:rgba(255,255,255,0.9);">
          <input type="checkbox" id="nepMDAnnealToggle" />
          Simulated annealing
        </label>
        <div id="nepMDAnnealControls" style="display:none; gap:8px; align-items:center; flex-wrap:wrap; padding-left:22px;">
          <label style="display:flex; align-items:center; gap:6px; opacity:0.92;">
            Tmin (K)
            <input type="number" id="nepMDAnnealMinInput" value="100" step="10" min="1" style="width:90px;" />
          </label>
          <label style="display:flex; align-items:center; gap:6px; opacity:0.92;">
            Tmax (K)
            <input type="number" id="nepMDAnnealMaxInput" value="1200" step="10" min="1" style="width:90px;" />
          </label>
          <label style="display:flex; align-items:center; gap:6px; opacity:0.92;">
            Peak at (%)
            <input type="number" id="nepMDAnnealPeakPctInput" value="30" step="1" min="1" max="99" style="width:80px;" />
          </label>
        </div>
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
  const mdAnnealToggle = document.getElementById('nepMDAnnealToggle');
  const mdAnnealControls = document.getElementById('nepMDAnnealControls');
  const mdAnnealMinInput = document.getElementById('nepMDAnnealMinInput');
  const mdAnnealMaxInput = document.getElementById('nepMDAnnealMaxInput');
  const mdAnnealPeakPctInput = document.getElementById('nepMDAnnealPeakPctInput');
  const status = document.getElementById('nepStatus');
  const result = document.getElementById('nepResult');
  let mdStopRequested = false;
  let mdRunning = false;

  function syncAnnealControls() {
    mdAnnealControls.style.display = mdAnnealToggle.checked ? 'flex' : 'none';
  }

  mdAnnealToggle.addEventListener('change', syncAnnealControls);
  syncAnnealControls();

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
      const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
      const saveTrajectory = true;
      const stride = 1;
      const perfTracker = createStepPerfTracker('Relax');
      const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
      const relaxLabel = `Relax_${srcContainer?.fileName ?? 'run'}`;
      const relaxContainer = new StructureContainer({ fileName: relaxLabel, structures: [snapshotCurrentStructure()] });
      structureShip.container.push(relaxContainer);
      const relaxRow = createRow({ name: relaxLabel, traj: 1, step: 1 });
      tableBody.appendChild(relaxRow);

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
          perfTracker.tick(step);
          const shouldUpdateViewer = step === 1 || step % viewerStride === 0;
          if (shouldUpdateViewer) {
            applyStructureToViewer(current, fileBrowser.selectedStructure);
            setCurrentEFS(out);
          }

          if (saveTrajectory && step % stride === 0) {
            relaxContainer.structures.push(snapshotCurrentStructure());
          }

          const pGPa = pressureGPaFromStress(out.stress.matrix3x3);
          status.textContent = `Relax step ${step}: E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A, P=${pGPa.toFixed(2)} GPa`;
        },
      });

      applyStructureToViewer(relaxed.structure, fileBrowser.selectedStructure);
      setCurrentEFS(relaxed.result);

      if (saveTrajectory) {
        const n = relaxContainer.structures.length;
        updateRow(relaxRow, { name: relaxLabel, traj: n, step: n });
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
      {
        const summary = perfTracker.summary(relaxed.steps);
        console.info(formatPerf(summary));
        logTimingBreakdown(relaxed.timing);
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
        const startTemperatureK = Number(mdTempInput.value || 300);
        const useAnnealing = mdAnnealToggle.checked;
        const minTemperatureK = Number(mdAnnealMinInput.value || 100);
        const maxTemperatureK = Number(mdAnnealMaxInput.value || startTemperatureK);
        const peakFraction = Math.max(0.01, Math.min(0.99, Number(mdAnnealPeakPctInput.value || 30) / 100));
        const dtFs = 1.0;
        const viewerStride = Math.max(1, Number(general.backendViewerUpdateStride || 1));
        const perfTracker = createStepPerfTracker('MD');
        const srcContainer = structureShip.container[fileBrowser.selectedRowIndex];
        const mdLabel = `MD_${srcContainer?.fileName ?? 'run'}`;
        const mdContainer = new StructureContainer({ fileName: mdLabel, structures: [snapshotCurrentStructure()] });
        structureShip.container.push(mdContainer);
        const mdRow = createRow({ name: mdLabel, traj: 1, step: 1 });
        tableBody.appendChild(mdRow);

        runBtn.disabled = true;
        relaxBtn.disabled = true;
        mdStartBtn.disabled = true;
        mdStopBtn.disabled = false;
        status.textContent = useAnnealing
          ? `MD annealing... dt=${dtFs.toFixed(2)} fs, T=${startTemperatureK.toFixed(1)} -> ${maxTemperatureK.toFixed(1)} -> ${minTemperatureK.toFixed(1)} K`
          : `MD running... dt=${dtFs.toFixed(2)} fs, Ttarget=${startTemperatureK.toFixed(1)} K`;

        monitor = createMDMonitorPanel();
        const forceEvaluator = createNEPForceEvaluator(nepRunner);
        const integrator = createVelocityVerletIntegrator();
        const targetTemperatureSchedule = useAnnealing
          ? createCosineAnnealingSchedule({
              startTemperatureK,
              peakTemperatureK: maxTemperatureK,
              minTemperatureK,
              peakFraction,
              totalSteps: mdSteps,
            })
          : startTemperatureK;
        const thermostat = createVelocityRescaleThermostat({ targetTemperatureK: targetTemperatureSchedule, tauFs: 20 });
        const state = await initializeMDState({
          nepRunner,
          structure: fileBrowser.selectedStructure,
          temperatureTargetK: startTemperatureK,
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
          onStep: ({ step, timeFs, temperatureK, targetTemperatureK, epotEv, ekinEv, etotEv, state: mdState }) => {
            perfTracker.tick(step);
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

            const nAtoms = Math.max(1, mdState.positions.length);
            const ePerAtom = epotEv / nAtoms;
            const mF = maxForce(mdState.forces);
            result.textContent = `MD step ${step}: E/atom=${ePerAtom.toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A`;
            const targetText = Number.isFinite(targetTemperatureK) ? ` | Ttarget=${targetTemperatureK.toFixed(1)} K` : '';
            status.textContent = `MD t=${timeFs.toFixed(1)} fs | T=${temperatureK.toFixed(1)} K${targetText}`;
            monitor.update({ step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv });
          },
        });

        const n = mdContainer.structures.length;
        updateRow(mdRow, { name: mdLabel, traj: n, step: n });

        if (mdRun.stopped) {
          status.textContent = `MD stopped at step ${state.step}`;
        } else {
          status.textContent = `MD finished at step ${state.step}`;
        }
        {
          const summary = perfTracker.summary(mdRun.stepsRun);
          console.info(formatPerf(summary));
          logTimingBreakdown(mdRun.timing);
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
