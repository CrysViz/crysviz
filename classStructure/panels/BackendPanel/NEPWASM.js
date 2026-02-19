import { fileBrowser } from '../../store.js';
import { updateVisualization } from '../../crystal-viewer.js';

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

function symbolCase(sym) {
  const s = String(sym ?? '').trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

// this might be implemented elsewhere -  perhaps we can reuse that. except that the wasm version expectes a flat array of positions.
function fracToCart(frac, lattice) {
  return frac.map((f) => [
    f[0] * lattice[0][0] + f[1] * lattice[1][0] + f[2] * lattice[2][0],
    f[0] * lattice[0][1] + f[1] * lattice[1][1] + f[2] * lattice[2][1],
    f[0] * lattice[0][2] + f[1] * lattice[1][2] + f[2] * lattice[2][2],
  ]);
}

function transpose3x3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function invert3x3(m) {
  const A = m[0][0], B = m[0][1], C = m[0][2];
  const D = m[1][0], E = m[1][1], F = m[1][2];
  const G = m[2][0], H = m[2][1], I = m[2][2];
  const det = A * (E * I - F * H) - B * (D * I - F * G) + C * (D * H - E * G);
  if (Math.abs(det) < 1e-14) throw new Error('Singular lattice during relaxation');
  const invDet = 1.0 / det;
  return [
    [(E * I - F * H) * invDet, (C * H - B * I) * invDet, (B * F - C * E) * invDet],
    [(F * G - D * I) * invDet, (A * I - C * G) * invDet, (C * D - A * F) * invDet],
    [(D * H - E * G) * invDet, (B * G - A * H) * invDet, (A * E - B * D) * invDet],
  ];
}

function multiplyMatVec(mat, vec) {
  return [
    mat[0][0] * vec[0] + mat[0][1] * vec[1] + mat[0][2] * vec[2],
    mat[1][0] * vec[0] + mat[1][1] * vec[1] + mat[1][2] * vec[2],
    mat[2][0] * vec[0] + mat[2][1] * vec[1] + mat[2][2] * vec[2],
  ];
}

function cartToFrac(cart, lattice) {
  const inv = invert3x3(transpose3x3(lattice));
  return cart.map((c) => multiplyMatVec(inv, c));
}

function wrapFrac01(frac) {
  return frac.map((v) => {
    let x = v - Math.floor(v);
    if (x < 0) x += 1;
    return x >= 1 ? 0 : x;
  });
}

function buildNEPStructure() {
  const s = fileBrowser.selectedStructure;
  const lattice = s.lattice.map((row) => [...row]);
  const frac = s.atoms.map((a) => a.position);
  const positions = fracToCart(frac, lattice);

  const modelElements = nepRunner.modelInfo.element_list.map(symbolCase);
  const symbols = s.elements.map(symbolCase);
  const types = symbols.map((sym) => {
    const i = modelElements.indexOf(sym);
    if (i < 0) throw new Error(`Model does not support element: ${sym}`);
    return i;
  });

  return { lattice, positions, types };
}

function maxForce(forces) {
  return Math.max(...forces.map((v) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)));
}

function applySimpleRelaxStep(structure, efs, atomStep = 0.02, cellStep = 0.002) {
  const cart = structure.positions;
  const forces = efs.forces;
  const stress = efs.stress.matrix3x3;

  const newCart = cart.map((r, i) => [
    r[0] + atomStep * forces[i][0],
    r[1] + atomStep * forces[i][1],
    r[2] + atomStep * forces[i][2],
  ]);

  const diagScale = [0, 1, 2].map((i) => {
    const s = 1.0 - cellStep * stress[i][i];
    return Math.min(1.02, Math.max(0.98, s));
  });

  const newLattice = structure.lattice.map((row) => [...row]);
  newLattice[0] = newLattice[0].map((x) => x * diagScale[0]);
  newLattice[1] = newLattice[1].map((x) => x * diagScale[1]);
  newLattice[2] = newLattice[2].map((x) => x * diagScale[2]);

  return { lattice: newLattice, positions: newCart, types: structure.types };
}

function applyStructureToViewer(nepStruct) {
  const frac = cartToFrac(nepStruct.positions, nepStruct.lattice).map(wrapFrac01);
  fileBrowser.selectedStructure.lattice = nepStruct.lattice.map((r) => [...r]);
  fileBrowser.selectedStructure.atoms.forEach((atom, i) => {
    atom.position = [...frac[i]];
  });
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderOther: true, reRenderComposition: false });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function relaxUntilConverged(initial, opts = {}) {
  const fmaxTol = Number(opts.fmaxTol ?? 0.01);
  const maxSteps = Number(opts.maxSteps ?? 200);
  const onStep = opts.onStep ?? (() => {});

  let current = {
    lattice: initial.lattice.map((r) => [...r]),
    positions: initial.positions.map((r) => [...r]),
    types: [...initial.types],
  };

  let out = null;
  let mF = Infinity;
  let step = 0;

  for (step = 1; step <= maxSteps; step += 1) {
    out = nepRunner.compute(current);
    mF = maxForce(out.forces);
    onStep(step, current, out, mF);

    if (mF <= fmaxTol) break;

    current = applySimpleRelaxStep(current, out);
    await nextFrame();
  }

  return {
    structure: current,
    result: out,
    steps: step,
    maxForce: mF,
    converged: mF <= fmaxTol,
  };
}

export async function addNEPPanel() {
  const panel = document.getElementById('BackendCalcPanel');

  panel.innerHTML = `
    <div id="nepPanel">
      <h2 style="margin:0 0 8px 0;">NEP (WASM)</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="calcButton" id="nepRunBtn" disabled>Initialize NEP...</button>
        <button class="calcButton" id="nepRelaxBtn" disabled>Relax to fmax</button>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px;">
          fmax (eV/A)
          <input type="number" id="nepFmaxInput" value="0.01" step="0.005" min="0.001" style="width:80px;" />
        </label>
        <label style="display:flex; align-items:center; gap:6px;">
          max steps
          <input type="number" id="nepMaxStepsInput" value="200" step="10" min="1" style="width:80px;" />
        </label>
      </div>
      <p id="nepStatus" style="margin-top:10px;"></p>
      <p id="nepResult" style="margin-top:10px;font-weight:bold;"></p>
    </div>
  `;

  const runBtn = document.getElementById('nepRunBtn');
  const relaxBtn = document.getElementById('nepRelaxBtn');
  const fmaxInput = document.getElementById('nepFmaxInput');
  const maxStepsInput = document.getElementById('nepMaxStepsInput');
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
      const nepStruct = buildNEPStructure();
      const out = nepRunner.compute(nepStruct);
      result.textContent = `E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${maxForce(out.forces).toFixed(5)} eV/A`;
    } catch (err) {
      result.textContent = `Failed: ${err.message || String(err)}`;
    }
  };

  relaxBtn.onclick = () => {
    (async () => {
      try {
      const fmaxTol = Number(fmaxInput.value || 0.01);
      const maxSteps = Number(maxStepsInput.value || 200);

      runBtn.disabled = true;
      relaxBtn.disabled = true;
      status.textContent = `Relaxing... target fmax=${fmaxTol.toFixed(3)} eV/A`;

      const nepStruct = buildNEPStructure();
      const relaxed = await relaxUntilConverged(nepStruct, {
        fmaxTol,
        maxSteps,
        onStep: (step, current, out, mF) => {
          applyStructureToViewer(current);
          status.textContent = `Relax step ${step}: E/atom=${Number(out.energy_per_atom).toFixed(6)} eV, max|F|=${mF.toFixed(5)} eV/A`;
        },
      });

      applyStructureToViewer(relaxed.structure);

      const tag = relaxed.converged ? 'Converged' : 'Stopped';
      result.textContent = `${tag} after ${relaxed.steps} steps: E/atom=${Number(relaxed.result.energy_per_atom).toFixed(6)} eV, max|F|=${relaxed.maxForce.toFixed(5)} eV/A`;
    } catch (err) {
      result.textContent = `Relax failed: ${err.message || String(err)}`;
    } finally {
      runBtn.disabled = false;
      relaxBtn.disabled = false;
    }
    })();
  };
}
