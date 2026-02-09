import { fileBrowser } from '../../store.js';

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

export async function addNEPPanel() {
  const panel = document.getElementById('BackendCalcPanel');

  panel.innerHTML = `
    <div id="nepPanel">
      <h2 style="margin:0 0 8px 0;">NEP (WASM)</h2>
      <button class="calcButton" id="nepRunBtn" disabled>Initialize NEP...</button>
      <p id="nepStatus" style="margin-top:10px;"></p>
      <p id="nepResult" style="margin-top:10px;font-weight:bold;"></p>
    </div>
  `;

  const runBtn = document.getElementById('nepRunBtn');
  const status = document.getElementById('nepStatus');
  const result = document.getElementById('nepResult');

  try {
    await initNEP();
    status.textContent = `Model loaded: ${nepRunner.modelInfo.name}`;
    runBtn.textContent = 'Get Forces + Stress';
    runBtn.disabled = false;
  } catch (err) {
    status.textContent = `NEP init failed: ${err.message || String(err)}`;
    runBtn.textContent = 'Initialization failed';
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
}
