import { Structure } from "../classes/Structure.js";
import { StructureContainer } from "../classes/StructureContainer.js";
const tableBody = document.querySelector("#objectTable tbody");
import {fileBrowser} from '../store.js';
import {createRow} from '../panels/FileBrowswerPanel.js'

import {
  transpose3x3,
  invert3x3,
  cartToFractional,
} from "./StructureInputModule.js";


const BOHR_TO_ANG = 0.52917721092;

export function parsePWSCFout(content,fileName) {
    const lines = content.split("\n");
  const steps = [];

  let i = 0;
  const n = lines.length;

  while (i < n) {
    // -------------------------------------------------
    // Detect CELL_PARAMETERS block
    // -------------------------------------------------
    if (lines[i].startsWith("CELL_PARAMETERS")) {
      const alatMatch = lines[i].match(/alat\s*=\s*([\d.]+)/);
      const alat = alatMatch ? parseFloat(alatMatch[1]) : 1.0;

      const lattice = [];
      for (let k = 1; k <= 3; k++) {
        const nums = lines[i + k].trim().split(/\s+/).map(Number);

        // QE gives these in units of 'alat'
        // so convert to Angstrom:
        lattice.push(nums.map(v => v * alat * BOHR_TO_ANG));
      }

      i += 4;

      // -------------------------------------------------
      // Look ahead for ATOMIC_POSITIONS
      // -------------------------------------------------
      let positions = [];
      let elements = [];

      while (i < n && !lines[i].startsWith("ATOMIC_POSITIONS")) i++;

      if (i < n && lines[i].startsWith("ATOMIC_POSITIONS")) {
        i++;
        while (i < n && lines[i].trim().length > 0) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length < 4) break;

          elements.push(parts[0]);
          positions.push(parts.slice(1, 4).map(Number));
          i++;
        }
      }

      // -------------------------------------------------
      // Check for Forces
      // -------------------------------------------------
      let forces = [];

      while (i < n && !lines[i].includes("Forces acting on atoms")) i++;

      if (i < n && lines[i].includes("Forces acting on atoms")) {
        i++; // skip header

        while (i < n && lines[i].includes("atom")) {
          const match = lines[i].match(/force\s*=\s*(.*)/);
          if (match) {
            const nums = match[1].trim().split(/\s+/).map(Number);
            forces.push(nums.slice(0, 3));
          }
          i++;
        }
      }

      // -------------------------------------------------
      // Save this relaxation step
      // -------------------------------------------------
      if (positions.length > 0) {
        steps.push({
          lattice,
          elements,
          positionsFrac: positions,  // already fractional
          forces
        });
      }
    }

    i++;
  }

  // -------------------------------------------------
  // Convert steps to Structure objects
  // -------------------------------------------------
  const structures = steps.map(s =>
    new Structure({
      elements: s.elements,
      uniqueElements: [...new Set(s.elements)],
      lattice: s.lattice,
      positions: s.positionsFrac,        // fractional as your viewer expects
      positions_cartesian: null          // optional to compute
    })
  );

  const forceObjects = steps.map(s => ({ forces: s.forces }));

   let traj = structures.length
   let step = traj
   const row = createRow({name: fileName, traj: traj, step: step });
   tableBody.appendChild(row);
   fileBrowser.fileData.push({idx: -1, name: fileName, traj: traj, step: step });
  console.log(structures)

  return new StructureContainer({
    fileName: fileName,
    structures,
    spins: [],
    symmetries: [],
    forces: forceObjects,
    polyhedra: []
  });
}

