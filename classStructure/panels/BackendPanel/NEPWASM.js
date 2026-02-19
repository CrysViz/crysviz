import { fileBrowser, structureShip, general } from '../../store.js';
import {
  buildNEPStructure,
  relaxUntilConverged,
  applyStructureToViewer,
  maxForce,
  pressureGPaFromStress,
} from '../../atomistic/relaxer.js';
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
        <label style="display:flex; align-items:center; gap:6px;">
          save traj
          <input type="checkbox" id="nepSaveTrajInput" checked />
        </label>
      </div>
      <p id="nepStatus" style="margin-top:10px;"></p>
      <p id="nepResult" style="margin-top:10px;font-weight:bold;"></p>
    </div>
  `;

  const runBtn = document.getElementById('nepRunBtn');
  const relaxBtn = document.getElementById('nepRelaxBtn');
  const maxStepsInput = document.getElementById('nepMaxStepsInput');
  const targetPressureInput = document.getElementById('nepTargetPressureInput');
  const saveTrajInput = document.getElementById('nepSaveTrajInput');
  const status = document.getElementById('nepStatus');
  const result = document.getElementById('nepResult');

  try {
    await initNEP();
    status.textContent = `Model loaded: ${nepRunner.modelInfo.name}`;
    runBtn.textContent = 'Get Forces + Stress';
    runBtn.disabled = false;
    relaxBtn.disabled = false;
  } catch (err) {
    status.textContent = `NEP init failed: ${err.message || String(err)}`;
    runBtn.textContent = 'Initialization failed';
    relaxBtn.disabled = true;
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
      const saveTrajectory = !!saveTrajInput.checked;
      const stride = 1;
      const container = structureShip.container[fileBrowser.selectedRowIndex];
      const row = fileBrowser.selectedRow;

      runBtn.disabled = true;
      relaxBtn.disabled = true;
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
    }
    })();
  };
}
