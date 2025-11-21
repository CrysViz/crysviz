import { Structure } from "../classes/Structure.js";
import { StructureContainer } from "../classes/StructureContainer.js";
const tableBody = document.querySelector("#objectTable tbody");
import { fileBrowser } from '../store.js';
import { createRow } from '../panels/FileBrowswerPanel.js';
import {
  transpose3x3,
  invert3x3,
  cartToFractional,
} from "./StructureInputModule.js";

export function parsePWSCFin(content, fileName) {
  const lines = content.split("\n");

  const BOHR_TO_ANG = 0.52917721092;
  const celldm = {};  // store celldm(n) values
  let natoms = 0;

  // ----------------------
  // 1. Read celldm(n)
  // ----------------------
  for (const line of lines) {
    const m = line.match(/celldm\s*\(\s*(\d+)\s*\)\s*=\s*([\d.eE+-]+)/);
    if (m) celldm[Number(m[1])] = Number(m[2]);
  }

  // ----------------------
  // 2. Find ATOMIC_POSITIONS
  // ----------------------
  let posIndex = lines.findIndex(l => /^ATOMIC_POSITIONS/i.test(l.trim()));
  if (posIndex === -1) return { error: "No ATOMIC_POSITIONS found" };

  const elements = [];
  const positions = [];

  // optional: try to detect number of atoms from following non-empty lines
  let i = posIndex + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const startAtoms = i;

  while (i < lines.length && lines[i].trim() !== "" && !/^CELL_PARAMETERS/i.test(lines[i].trim())) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length >= 4) {
      elements.push(parts[0]);
      positions.push(parts.slice(1, 4).map(Number));
    }
    i++;
  }
  natoms = elements.length;

  // ----------------------
  // 3. Find CELL_PARAMETERS
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
  // 4. Done — create Structure
  // ----------------------
  const structures = [
    new Structure({
      elements,
      uniqueElements: [...new Set(elements)],
      lattice,
      positions,
      positions_cartesian: null
    })
  ];

  const forceObjects = [{ forces: [] }];

  // UI updates
  const row = createRow({ name: fileName, traj: structures.length, step: structures.length });
  document.querySelector("#objectTable tbody").appendChild(row);
  fileBrowser.fileData.push({ idx: -1, name: fileName, traj: structures.length, step: structures.length });

  return new StructureContainer({
    fileName,
    structures,
    spins: [],
    symmetries: [],
    forces: forceObjects,
    polyhedra: []
  });
}



