import {structureShip,fileBrowser} from '../../state/store.js'
import { createRow,selectLastAddedRow } from '../FileBrowswerPanel.js';
import {updateVisualization} from '../../core/crystal-viewer.js'
import init, { analyze_cell } from '../../external/moyo-test/moyo_wasm.js';
import { Structure } from "../../model/Structure.js";
import { Atom } from "../../model/Atom.js";
import { StructureContainer } from "../../model/StructureContainer.js";
import { generateID } from "../../utils/index.js";
import { activateWyckoffMode, deactivateWyckoffMode, isWyckoffModeActive } from '../SymmetryEditModule.js';
import { renderComposition } from '../StructureInfoPanel/General.js';
import { refreshBackendTheme } from './BackendTheme.js';



export const PT = {
  1: "H",   2: "He",
  3: "Li",  4: "Be",  5: "B",   6: "C",   7: "N",   8: "O",   9: "F",   10: "Ne",
  11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",  16: "S",  17: "Cl", 18: "Ar",
  19: "K",  20: "Ca", 21: "Sc", 22: "Ti", 23: "V",  24: "Cr", 25: "Mn", 26: "Fe",
  27: "Co", 28: "Ni", 29: "Cu", 30: "Zn", 31: "Ga", 32: "Ge", 33: "As", 34: "Se",
  35: "Br", 36: "Kr",
  37: "Rb", 38: "Sr", 39: "Y",  40: "Zr", 41: "Nb", 42: "Mo", 43: "Tc", 44: "Ru",
  45: "Rh", 46: "Pd", 47: "Ag", 48: "Cd", 49: "In", 50: "Sn", 51: "Sb", 52: "Te",
  53: "I",  54: "Xe",
  55: "Cs", 56: "Ba",
  // Lanthanides
  57: "La", 58: "Ce", 59: "Pr", 60: "Nd", 61: "Pm", 62: "Sm", 63: "Eu", 64: "Gd",
  65: "Tb", 66: "Dy", 67: "Ho", 68: "Er", 69: "Tm", 70: "Yb", 71: "Lu",
  // Transition continues
  72: "Hf", 73: "Ta", 74: "W",  75: "Re", 76: "Os", 77: "Ir", 78: "Pt", 79: "Au",
  80: "Hg", 81: "Tl", 82: "Pb", 83: "Bi", 84: "Po", 85: "At", 86: "Rn",
  87: "Fr", 88: "Ra",
  // Actinides
  89: "Ac", 90: "Th", 91: "Pa", 92: "U",  93: "Np", 94: "Pu", 95: "Am", 96: "Cm",
  97: "Bk", 98: "Cf", 99: "Es", 100: "Fm", 101: "Md", 102: "No", 103: "Lr",
  // Final row
  104: "Rf", 105: "Db", 106: "Sg", 107: "Bh", 108: "Hs", 109: "Mt", 110: "Ds",
  111: "Rg", 112: "Cn", 113: "Nh", 114: "Fl", 115: "Mc", 116: "Lv", 117: "Ts",
  118: "Og"
};

export const PT_INVERTED = {
  "H": 1,   "He": 2,
  "Li": 3,  "Be": 4,  "B": 5,   "C": 6,   "N": 7,   "O": 8,   "F": 9,   "Ne": 10,
  "Na": 11, "Mg": 12, "Al": 13, "Si": 14, "P": 15,  "S": 16,  "Cl": 17, "Ar": 18,
  "K": 19,  "Ca": 20, "Sc": 21, "Ti": 22, "V": 23,  "Cr": 24, "Mn": 25, "Fe": 26,
  "Co": 27, "Ni": 28, "Cu": 29, "Zn": 30, "Ga": 31, "Ge": 32, "As": 33, "Se": 34,
  "Br": 35, "Kr": 36,
  "Rb": 37, "Sr": 38, "Y": 39,  "Zr": 40, "Nb": 41, "Mo": 42, "Tc": 43, "Ru": 44,
  "Rh": 45, "Pd": 46, "Ag": 47, "Cd": 48, "In": 49, "Sn": 50, "Sb": 51, "Te": 52,
  "I": 53,  "Xe": 54,
  "Cs": 55, "Ba": 56,
  "La": 57, "Ce": 58, "Pr": 59, "Nd": 60, "Pm": 61, "Sm": 62, "Eu": 63, "Gd": 64,
  "Tb": 65, "Dy": 66, "Ho": 67, "Er": 68, "Tm": 69, "Yb": 70, "Lu": 71,
  "Hf": 72, "Ta": 73, "W": 74,  "Re": 75, "Os": 76, "Ir": 77, "Pt": 78, "Au": 79,
  "Hg": 80, "Tl": 81, "Pb": 82, "Bi": 83, "Po": 84, "At": 85, "Rn": 86,
  "Fr": 87, "Ra": 88,
  "Ac": 89, "Th": 90, "Pa": 91, "U": 92,  "Np": 93, "Pu": 94, "Am": 95, "Cm": 96,
  "Bk": 97, "Cf": 98, "Es": 99, "Fm": 100, "Md": 101, "No": 102, "Lr": 103,
  "Rf": 104, "Db": 105, "Sg": 106, "Bh": 107, "Hs": 108, "Mt": 109, "Ds": 110,
  "Rg": 111, "Cn": 112, "Nh": 113, "Fl": 114, "Mc": 115, "Lv": 116, "Ts": 117,
  "Og": 118
};


let wasmReady;
async function initMoyo() {
  wasmReady = await init(); // no-arg: moyo_wasm.js resolves the .wasm via import.meta.url
}

export async function addMoyoPanel() {
    const panel = document.getElementById("BackendCalcPanel");

    await initMoyo(); // call once on page load

    // Clear panel
    panel.innerHTML = "";

    panel.innerHTML = `
    <div id="panel">
<div style="margin-bottom: 1em; text-align: center;">
  <h2 style="margin: 0;">Analyse Symmetry with Moyo</h2>
  <p style="margin: 0;">(Data stays on your device!)</p>
</div>
  <div style="margin-bottom: 1em;">
    <p>Get symmetry information:</p>
    <button class="calcButton" id="getSymBtn">Get Symmetry Info</button>
  </div>

  <div style="margin-bottom: 1em;">
    <p>Symmetrize cell:</p>
    <div style="display: flex; gap: 0.5em;">
      <button class="calcButton" id="getPrimBtn">Prim. Cell</button>
      <button class="calcButton" id="getConvBtn">Conv. Cell</button>
    </div>
  </div>

  <div style="margin-bottom: 1em;">
    <p>Operate on Wyckoff positions:</p>
    <button class="calcButton" id="getWyckoffBtn">Enable Wyckoff Editor</button>
  </div>

  <p id="calcResult" style="margin-top: 1em; font-weight: bold;"></p>
</div>
    `;

    document.getElementById("getSymBtn").onclick = () => {
      const result = callMoyo("getSymmetryInfo", 1e-5);
      document.getElementById("calcResult").textContent =
        `${result.spg_symbol} (${result.spg_number})  ${result.aflowLabel}`;
    }

    document.getElementById("getConvBtn").onclick = () => {
      const result = callMoyo("getConvUnit", 1e-5);
      document.getElementById("calcResult").textContent =
        `${result.spg_symbol} (${result.spg_number})  ${result.aflowLabel}`;
      newContainerFromSymmetrisation("conv", result.positions, result.lattice, result.elements)
    }

    document.getElementById("getPrimBtn").onclick = () => {
      const result = callMoyo("getPrimUnit", 1e-5);
      document.getElementById("calcResult").textContent =
        `${result.spg_symbol} (${result.spg_number})  ${result.aflowLabel}`;
      newContainerFromSymmetrisation("prim", result.positions, result.lattice, result.elements)
    }

    const wyckoffBtn = document.getElementById("getWyckoffBtn");
    const syncWyckoffButton = () => {
      const active = isWyckoffModeActive(fileBrowser.selectedStructure);
      wyckoffBtn.textContent = active
        ? 'Disable Wyckoff Editor'
        : 'Enable Wyckoff Editor';
      wyckoffBtn.style.background = active
        ? 'linear-gradient(135deg, #1c5fb8, #2493ff)'
        : '';
      wyckoffBtn.style.color = active ? '#f5fbff' : '';
      wyckoffBtn.style.boxShadow = active ? '0 0 0 1px rgba(91,168,255,0.45)' : '';
    };

    wyckoffBtn.onclick = async () => {
      if (isWyckoffModeActive(fileBrowser.selectedStructure)) {
        deactivateWyckoffMode(fileBrowser.selectedStructure);
        renderComposition('open');
        document.getElementById("calcResult").textContent = 'Wyckoff editor disabled';
        syncWyckoffButton();
        refreshBackendTheme();
        return;
      }

      const result = callMoyo("getSymmetryInfo", 1e-5);
      await activateWyckoffMode(fileBrowser.selectedStructure, 1e-5);
      renderComposition('open');
      document.getElementById("calcResult").textContent =
        `Wyckoff editor active: ${result.spg_symbol} (${result.spg_number})  ${result.aflowLabel}`;
      syncWyckoffButton();
      refreshBackendTheme();
    };

    syncWyckoffButton();
}

// Build an AFLOW-style label: "{spg}_{wyck_elem1}_{wyck_elem2}...:{elem1}-{elem2}-..."
// wyckoffs and elements are parallel arrays, one entry per atom in the input cell.
// For a primitive-cell input each entry is one inequivalent orbit, giving exact counts.
function buildAflowLabel(spgNumber, wyckoffs, elements) {
  const elemOrder = [];
  const elemLetters = {};
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!elemLetters[el]) {
      elemLetters[el] = [];
      elemOrder.push(el);
    }
    elemLetters[el].push(wyckoffs[i]);
  }

  const orbitParts = elemOrder.map(el => {
    const count = {};
    for (const l of elemLetters[el]) count[l] = (count[l] || 0) + 1;
    return Object.keys(count).sort()
      .map(l => (count[l] > 1 ? count[l] : '') + l)
      .join('');
  });

  return `${spgNumber}_${orbitParts.join('_')}:${elemOrder.join('-')}`;
}

function callMoyo(calcType="getSymmetryInfo", tolerance="1e-2") {
  let elements = [...fileBrowser.selectedStructure.elements];
  const numbers = elements.map(el => PT_INVERTED[el]);
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position)
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  const struct = { positions: positions, lattice:{basis:lattice.flat()}, numbers: numbers }

  const result = analyze_cell(JSON.stringify(struct), tolerance, 'Standard');
  const aflowLabel = buildAflowLabel(result.number, result.wyckoffs, elements);

  if (calcType === "getSymmetryInfo"){
      return {spg_symbol:result.hm_symbol, spg_number:result.number, aflowLabel};
  }
  else if (calcType === "getPrimUnit"){
      const flat = result.prim_std_cell.lattice.basis;
      const lattice3x3 = [flat.slice(0,3), flat.slice(3,6), flat.slice(6,9)];
      const primElements = result.prim_std_cell.numbers.map(el => PT[el]);
      return {lattice:lattice3x3, positions:result.prim_std_cell.positions, elements:primElements, spg_symbol:result.hm_symbol, spg_number:result.number, aflowLabel};
  }
  else if (calcType === "getConvUnit"){
      const flat = result.std_cell.lattice.basis;
      const lattice3x3 = [flat.slice(0,3), flat.slice(3,6), flat.slice(6,9)];
      const convElements = result.std_cell.numbers.map(el => PT[el]);
      return {lattice:lattice3x3, positions:result.std_cell.positions, elements:convElements, spg_symbol:result.hm_symbol, spg_number:result.number, aflowLabel};
  }
  else {
      console.warn("Unknown calculation type!");
  }
}



function newContainerFromSymmetrisation(primConv,positions,lattice,elements){
  let newTraj =  1
  let fileName = structureShip.container[fileBrowser.selectedRowIndex].fileName
  let atoms = [];
  const container = new StructureContainer({fileName:fileName})
  positions.forEach((pos, i) => {
    atoms.push(new Atom({
      position: pos,
      element: elements[i],
      uuid: generateID([elements[i]])
    }));
  });
  let structure = new Structure({
         elements:elements,
         uniqueElements: [...new Set(elements)],
         lattice:lattice,
         atoms:atoms,
     });
  container.structures.push(structure);
  structureShip.container.push(container)
  fileName=primConv+"_sym_"+fileName;
  const row = createRow({ name: fileName, traj: container.structures.length, step: container.structures.length });
  document.querySelector("#objectTable tbody").appendChild(row);
  fileBrowser.fileData.push({ name: fileName, traj: container.structures.length, step: container.structures.length });
  selectLastAddedRow();

  }
