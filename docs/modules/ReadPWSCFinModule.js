import { Structure } from "../classes/Structure.js";
import { Atom } from "../classes/Atom.js";
import { StructureContainer } from "../classes/StructureContainer.js";
import { structureShip,fileBrowser } from '../store.js';
import { createRow,selectLastAddedRow } from '../panels/FileBrowswerPanel.js';
import {
  transpose3x3,
  invert3x3,
  cartToFractional,
} from "./math/index.js";
import {generateID} from './UUIDModule.js'



export function parsePWSCFin(content, fileName) {
  if (!fileName) return;
  const lines = content.split("\n");

  const BOHR_TO_ANG = 0.52917721092;
  const celldm = {};  // store celldm(n) values
  let natoms = 0;

  // ----------------------
  // Read nat = XX
  // ----------------------
  for (const line of lines) {
    const m = line.match(/nat\s*=\s*(\d+)/i);
    if (m) {
      natoms = parseInt(m[1]);
      break;
    }
  }

  if (!natoms) return { error: "nat (number of atoms) not found" };

  // ----------------------
  // Read celldm(n)
  // ----------------------
  for (const line of lines) {
    const m = line.match(/celldm\s*\(\s*(\d+)\s*\)\s*=\s*([\d.eE+-]+)/);
    if (m) celldm[Number(m[1])] = Number(m[2]);
  }

  // ----------------------
  // Find ATOMIC_POSITIONS
  // ----------------------
  let posIndex = lines.findIndex(l => /^ATOMIC_POSITIONS/i.test(l.trim()));
  if (posIndex === -1) return { error: "No ATOMIC_POSITIONS found" };

  const elements = [];
  const positions = [];

  for (let i = posIndex + 1; i <= posIndex + natoms; i++) {
    if (i >= lines.length) break;
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length >= 4) {
      elements.push(parts[0]);
      positions.push(parts.slice(1, 4).map(Number));
    }
  }

  // ----------------------
  // Find CELL_PARAMETERS
  // ----------------------
  let cellIndex = lines.findIndex(l => /^CELL_PARAMETERS/i.test(l.trim()));
  if (cellIndex === -1) return { error: "No CELL_PARAMETERS found" };

  let latticeUnit = "angstrom";
  const mUnit = lines[cellIndex].match(/CELL_PARAMETERS\s+(\S+)/);
  if (mUnit) latticeUnit = mUnit[1].toLowerCase();

  const lattice = [];
  for (let j = 1; j <= 3; j++) {
    let vec = lines[cellIndex + j].trim().split(/\s+/).map(Number);
    if (latticeUnit === "bohr") vec = vec.map(v => v * BOHR_TO_ANG);
    else if (latticeUnit === "alat") {
      const a = celldm[1] !== undefined ? celldm[1] : 1.0;
      vec = vec.map(v => v * a * BOHR_TO_ANG);
    }
    lattice.push(vec.slice(0, 3));
  }

  // ----------------------
  // Build structure
  // ----------------------
  //
  const atoms = [];
  positions.forEach((pos, i) => {
    atoms.push(new Atom({
      position: pos,
      element: elements[i],
      uuid: generateID([elements[i]])
    }));
  });

  let periodic = runPeriodicWrapped(
   { hash: "None",wrapped: {}},
   pos,
   elements,
   lattice
  )

  
  const structures = [new Structure({
    elements:elements,
    uniqueElements: [...new Set(elements)],
    lattice:lattice,
    atoms:atoms,
    periodic: periodic,
    volumetricFields:null,
    })
  ];

  // ----------------------
  // UI updates
  // ----------------------
  const row = createRow({ name: fileName, traj: structures.length, step: structures.length });
  document.querySelector("#objectTable tbody").appendChild(row);
  fileBrowser.fileData.push({ name: fileName, traj: structures.length, step: structures.length });

  const container = new StructureContainer({
  fileName: fileName,
  structures: structures,
  });
  structureShip.container.push(container)

  selectLastAddedRow();
}
