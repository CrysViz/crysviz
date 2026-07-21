import {structureShip,fileBrowser} from '../../state/store.js'
import { createRow,selectLastAddedRow } from '../FileBrowswerPanel.js';
import init, { analyze_cell } from '../../external/moyo-test/moyo_wasm.js';
import { Structure } from "../../model/index.js";
import { Atom } from "../../model/index.js";
import { StructureContainer } from "../../model/index.js";
import { generateID } from "../../utils/index.js";
import { activateWyckoffMode, deactivateWyckoffMode, isWyckoffModeActive, describeMoyoFailure } from '../SymmetryEditModule.js';
import { renderComposition } from '../StructureInfoPanel/General.js';
import { refreshBackendTheme } from './BackendTheme.js';
import { normalizeFractional } from "../../math/index.js";
import { runPeriodicWrapped } from "../../render/index.js";
import { hallEntry, symdataHallUrl } from './hallSymbols.js';



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


async function initMoyo() {
  const _wasmReady = await init(); // no-arg: moyo_wasm.js resolves the .wasm via import.meta.url
}

// Builds the Moyo symmetry tools into the given container (the unified
// "Symmetry" panel window's body).
export async function addMoyoPanel(target = "cvPanelBody-symmetry") {
    const panel = document.getElementById(target);
    if (!panel) return;

    await initMoyo(); // call once on page load

    // Clear panel
    panel.innerHTML = "";

    panel.innerHTML = `
    <div id="panel" class="sym-body">
      <p class="sym-caption">Analyse symmetry with Moyo</p>

      <div class="sym-card">
        <div class="sym-card-title">Symmetry information</div>
        <div class="sym-row">
          <label for="symTolInput">Tolerance (Å)
            <input type="number" id="symTolInput" value="0.01" min="0" step="0.001">
          </label>
        </div>
        <div class="sym-row">
          <button class="calcButton" id="getSymBtn">Get Symmetry Info</button>
        </div>
        <div class="sym-result" id="symResult" hidden></div>
      </div>

      <div class="sym-card">
        <div class="sym-card-title">Symmetrize cell</div>
        <div class="sym-row">
          <button class="calcButton" id="getPrimBtn">Prim. Cell</button>
          <button class="calcButton" id="getConvBtn">Conv. Cell</button>
        </div>
      </div>

      <div class="sym-card">
        <div class="sym-card-title">Wyckoff positions</div>
        <div class="sym-row">
          <button class="calcButton sym-wide" id="getWyckoffBtn">Enable Wyckoff Editor</button>
        </div>
      </div>

      <p class="sym-status" id="calcResult"></p>
    </div>
    `;

    const getTol = () => {
      const v = parseFloat(document.getElementById("symTolInput")?.value);
      return Number.isFinite(v) && v > 0 ? v : 0.01;
    };

    const setStatus = (text = '') => {
      const el = document.getElementById("calcResult");
      if (el) el.textContent = text;
    };

    // moyo throws for cells it cannot handle (atoms closer than the tolerance,
    // a heavily distorted MD frame, ...). Those are ordinary user situations,
    // not bugs: report them in the panel and leave the app untouched, rather
    // than letting an exception escape and kill the click handler.
    const failSoft = (action) => {
      try {
        action();
      } catch (error) {
        const box = document.getElementById('symResult');
        if (box) box.hidden = true;
        setStatus(describeMoyoFailure(error, getTol()));
      }
    };

    document.getElementById("getSymBtn").onclick = () => failSoft(() => {
      renderSymmetryResult(callMoyo("getSymmetryInfo", getTol()));
      setStatus();
    });

    document.getElementById("getConvBtn").onclick = () => failSoft(() => {
      const result = callMoyo("getConvUnit", getTol());
      renderSymmetryResult(result);
      setStatus();
      newContainerFromSymmetrisation("conv", result.positions, result.lattice, result.elements)
    });

    document.getElementById("getPrimBtn").onclick = () => failSoft(() => {
      const result = callMoyo("getPrimUnit", getTol());
      renderSymmetryResult(result);
      setStatus();
      newContainerFromSymmetrisation("prim", result.positions, result.lattice, result.elements)
    });

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

      let result;
      try {
        result = callMoyo("getSymmetryInfo", getTol());
        await activateWyckoffMode(fileBrowser.selectedStructure, getTol());
      } catch (error) {
        // Nothing was locked (activateWyckoffMode assigns only on success), so
        // the structure stays exactly as editable as it was.
        const box = document.getElementById('symResult');
        if (box) box.hidden = true;
        setStatus(describeMoyoFailure(error, getTol()));
        syncWyckoffButton();
        return;
      }
      renderComposition('open');
      renderSymmetryResult(result);
      setStatus('Wyckoff editor active');
      syncWyckoffButton();
      refreshBackendTheme();
    };

    syncWyckoffButton();
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// AFLOW anonymous formula from per-element atom counts of the conventional
// cell: stoichiometry reduced by its gcd, sorted ascending, labelled A, B, C...
// with a count of 1 written as nothing (Al2O3 -> "A2B3", TiO2 -> "AB2").
function anonymousFormula(counts) {
  if (!counts.length) return '';
  const g = counts.reduce((acc, c) => gcd(acc, c));
  return counts
    .map(c => c / g)
    .sort((a, b) => a - b)
    .map((c, i) => String.fromCharCode(65 + i) + (c > 1 ? c : ''))
    .join('');
}

// Build the protostructure (AFLOW prototype) label:
//   "{anonymous formula}_{Pearson}_{spg number}_{wyckoffs per element}:{elements}"
// e.g. "A2B3_hR10_167_1c_1e:Al-O".
//
// The number in front of a Wyckoff letter is NOT the site multiplicity — it is
// how many DISTINCT orbits of that element sit on that letter, and it is always
// written, including when it is 1. So `orbits` (moyo's crystallographic orbits,
// one representative atom index per orbit) is what gets counted here, never the
// raw per-atom Wyckoff list.
//
// `elements` is the per-atom element list of the input cell, parallel to
// `result.orbits` / `result.wyckoffs`. The anonymous formula is counted on the
// conventional standard cell (`result.std_cell.numbers`).
function buildProtostructureLabel(result, elements) {
  const reps = [...new Set(result.orbits)]; // one representative atom per orbit
  const lettersByElement = new Map();
  for (const i of reps) {
    const el = elements[i];
    if (!lettersByElement.has(el)) lettersByElement.set(el, []);
    lettersByElement.get(el).push(result.wyckoffs[i]);
  }

  const sortedElements = [...lettersByElement.keys()].sort();
  const wyckParts = sortedElements.map(el => {
    const perLetter = new Map();
    for (const letter of lettersByElement.get(el)) {
      perLetter.set(letter, (perLetter.get(letter) || 0) + 1);
    }
    return [...perLetter.keys()].sort()
      .map(letter => `${perLetter.get(letter)}${letter}`)
      .join('');
  });

  const convCounts = new Map();
  for (const z of (result.std_cell?.numbers || [])) {
    convCounts.set(z, (convCounts.get(z) || 0) + 1);
  }
  const anon = anonymousFormula([...convCounts.values()]);
  const pearson = result.pearson_symbol || '';

  return `${anon}_${pearson}_${result.number}_${wyckParts.join('_')}:${sortedElements.join('-')}`;
}

// Fill the panel's result block: space group (linked to symdata), Hall symbol,
// Pearson symbol and protostructure label. No-op when the panel is not built.
function renderSymmetryResult(result) {
  const box = document.getElementById('symResult');
  if (!box) return;

  const hall = hallEntry(result.hall_number);
  const url = hall ? symdataHallUrl(hall.symbol) : null;
  const link = (text) => (url
    ? `<a class="sym-link" href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : text);

  // moyo writes the HM symbol with spaces ("P m m m"); the usual display form
  // is unspaced.
  const hm = String(result.spg_symbol).replace(/\s+/g, '');

  box.innerHTML = `
    <div class="sym-spg">
      <span class="sym-spg-symbol">${link(hm)}</span>
    </div>
    <dl class="sym-kv">
      <dt>Hall</dt><dd class="sym-mono">${hall ? link(hall.symbol) : '—'}</dd>
      <dt>Number</dt><dd class="sym-mono">${result.spg_number}</dd>
    </dl>
    <div class="sym-proto">
      <span class="sym-proto-label">Protostructure</span>
      <span class="sym-mono sym-proto-value">${result.protostructure}</span>
    </div>`;
  box.hidden = false;
}

function callMoyo(calcType="getSymmetryInfo", tolerance=0.01) {
  const structure = fileBrowser.selectedStructure;
  // Hidden atoms are excluded from symmetry detection entirely — filtered
  // together (elements/positions in lockstep) before anything is indexed, so
  // result.wyckoffs/result.orbits (one entry per surviving atom, in this same
  // order) stay aligned with `elements` below for the protostructure label.
  // Safe here specifically
  // because this function's outputs are either display-only strings or a
  // freshly-computed primitive/conventional cell with no back-reference to
  // original atom indices — unlike SymmetryEditModule.js's Wyckoff editing,
  // which mutates structure.atoms by raw index and is NOT filtered this way.
  const visibleIndices = structure.atoms
    .map((atom, i) => (atom.hidden ? -1 : i))
    .filter((i) => i !== -1);
  let elements = visibleIndices.map(i => structure.elements[i]);
  const numbers = elements.map(el => {
    const n = PT_INVERTED[el];
    if (n === undefined) {
      throw new Error(`Moyo: unknown element symbol "${el}" (not found in periodic table map). ` +
        `Check that the structure's species were parsed as clean chemical symbols.`);
    }
    return n;
  });
  let positions = visibleIndices.map(i => structure.atoms[i].position)
  let lattice = structure.lattice.map(r => [...r]);
  const struct = { positions: positions, lattice:{basis:lattice.flat()}, numbers: numbers }

  const result = analyze_cell(JSON.stringify(struct), tolerance, 'Standard');
  const protostructure = buildProtostructureLabel(result, elements);
  const info = {
    spg_symbol: result.hm_symbol,
    spg_number: result.number,
    hall_number: result.hall_number,
    pearson: result.pearson_symbol,
    protostructure,
  };

  if (calcType === "getSymmetryInfo"){
      return info;
  }
  else if (calcType === "getPrimUnit"){
      const flat = result.prim_std_cell.lattice.basis;
      const lattice3x3 = [flat.slice(0,3), flat.slice(3,6), flat.slice(6,9)];
      const primElements = result.prim_std_cell.numbers.map(el => PT[el]);
      return {...info, lattice:lattice3x3, positions:result.prim_std_cell.positions, elements:primElements};
  }
  else if (calcType === "getConvUnit"){
      const flat = result.std_cell.lattice.basis;
      const lattice3x3 = [flat.slice(0,3), flat.slice(3,6), flat.slice(6,9)];
      const convElements = result.std_cell.numbers.map(el => PT[el]);
      return {...info, lattice:lattice3x3, positions:result.std_cell.positions, elements:convElements};
  }
  else {
      console.warn("Unknown calculation type!");
  }
}



function newContainerFromSymmetrisation(primConv,positions,lattice,elements){
  let fileName = structureShip.container[fileBrowser.selectedRowIndex].fileName
  let atoms = [];
  const container = new StructureContainer({fileName:fileName})
  const normPositions = positions.map(p => p.map(normalizeFractional));
  normPositions.forEach((pos, i) => {
    atoms.push(new Atom({
      position: pos,
      element: elements[i],
      uuid: generateID([elements[i]])
    }));
  });
  let periodic = runPeriodicWrapped({ hash: "None", wrapped: {} }, normPositions, elements, lattice);
  let structure = new Structure({
         elements:elements,
         uniqueElements: [...new Set(elements)],
         lattice:lattice,
         atoms:atoms,
         periodic: periodic,
     });
  container.structures.push(structure);
  structureShip.container.push(container)
  fileName=primConv+"_sym_"+fileName;
  const row = createRow({ name: fileName, traj: container.structures.length, step: container.structures.length });
  document.querySelector("#objectTable tbody").appendChild(row);
  fileBrowser.fileData.push({ name: fileName, traj: container.structures.length, step: container.structures.length });
  selectLastAddedRow();

  }
