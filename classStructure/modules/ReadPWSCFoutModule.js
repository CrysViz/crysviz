import { Structure } from "../classes/Structure.js";
import { Atom } from "../classes/Atom.js";
import { Force } from "../classes/Force.js";
import { Spin } from "../classes/Spin.js";
import { Stress } from "../classes/Stress.js";
import { StructureContainer } from "../classes/StructureContainer.js";
const tableBody = document.querySelector("#objectTable tbody");
import { fileBrowser } from "../store.js";
import { createRow,selectLastAddedRow } from "../panels/FileBrowswerPanel.js";

const BOHR_TO_ANG = 0.52917721092;

export function parsePWSCFout(content, fileName) {
  const lines = content.split("\n");
  const n = lines.length;
  const steps = [];
  let finalSCF = false;

  function findIndexInRange(start, end, predicate) {
    for (let i = start; i < end; i++) {
      if (predicate(lines[i])) return i;
    }
    return -1;
  }

  let pos = 0;

  // -----------------------------
  // Parse all blocks normally
  // -----------------------------
  while (pos < n) {
    let blockStart = findIndexInRange(pos, n, ln =>
      ln.includes("End of self-consistent calculation")
    );
    if (blockStart === -1) blockStart = pos;

    const blockContentStart = blockStart + 1;

    let nextMarker = findIndexInRange(blockContentStart, n, ln =>
      ln.includes("End of self-consistent calculation")
    );
    const blockEnd = nextMarker === -1 ? n : nextMarker;

    // Check if this block contains final SCF line
    const finalScfIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
      ln.includes("Final scf calculation at the relaxed structure.")
    );

    let lattice = null;
    let positions = [];
    let elements = [];
    let forces = [];
    let stressTensor = [];

    // -----------------------------
    // Normal relaxation step
    // -----------------------------
    if (finalScfIdx === -1) {
      // CELL_PARAMETERS
      const cellIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
        ln.startsWith("CELL_PARAMETERS")
      );
      if (cellIdx !== -1) {
        const alatMatch = lines[cellIdx].match(/alat\s*=\s*([\d.]+)/);
        const alat = alatMatch ? parseFloat(alatMatch[1]) : 1.0;
        lattice = [];
        for (let k = 1; k <= 3; k++) {
          const nums = lines[cellIdx + k].trim().split(/\s+/).map(Number);
          lattice.push(nums.map(v => v * BOHR_TO_ANG * alat));
        }
      }

      // ATOMIC_POSITIONS
      const posIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
        ln.startsWith("ATOMIC_POSITIONS")
      );
      if (posIdx !== -1) {
        let j = posIdx + 1;
        while (j < blockEnd && lines[j].trim().length > 0) {
          const parts = lines[j].trim().split(/\s+/);
          if (parts.length < 4) break;
          elements.push(parts[0]);
          positions.push(parts.slice(1, 4).map(Number));
          j++;
        }
      }

      // FORCES
      const forceIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
        ln.includes("Forces acting on atoms")
      );
      if (forceIdx !== -1) {
        let j = forceIdx + 2;
        while (j < blockEnd && lines[j].includes("atom")) {
          const match = lines[j].match(/force\s*=\s*(.*)/);
          if (match) {
            const nums = match[1].trim().split(/\s+/).map(Number);
            forces.push(nums.slice(0, 3));
          }
          j++;
        }
      }

      // STRESS
      const stressIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
        ln.includes("Computing stress")
      );
      if (stressIdx !== -1) {
        let j = stressIdx + 3;
        for (let r = 0; r < 3; r++) {
          const parts = lines[j + r].trim().split(/\s+/).map(Number);
          const pressures = parts.slice(3, 6);
          stressTensor.push(pressures.map(v => v * 0.1)); // GPa
        }
      }

      // Only push step if all data exists
      if (
        lattice && lattice.length === 3 &&
        positions && positions.length > 0 &&
        forces && forces.length > 0 &&
        stressTensor && stressTensor.length === 3
      ) {
        steps.push({
          lattice,
          elements,
          positionsFrac: positions,
          forces,
          stressTensor
        });
      }

    } else {
      // -----------------------------
      // Final SCF step
      // -----------------------------
      if (steps.length === 0) {
        console.warn("Final SCF detected but no previous step to reuse lattice/positions.");
      } else {
        const lastStep = steps[steps.length - 1];
        lattice = lastStep.lattice;
        positions = lastStep.positionsFrac;
        elements = lastStep.elements;

        // FORCES
        const forceIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
          ln.includes("Forces acting on atoms")
        );
        if (forceIdx !== -1) {
          let j = forceIdx + 2;
          while (j < blockEnd && lines[j].includes("atom")) {
            const match = lines[j].match(/force\s*=\s*(.*)/);
            if (match) {
              const nums = match[1].trim().split(/\s+/).map(Number);
              forces.push(nums.slice(0, 3));
            }
            j++;
          }
        }

        // STRESS
        const stressIdx = findIndexInRange(blockContentStart, blockEnd, ln =>
          ln.includes("Computing stress")
        );
        if (stressIdx !== -1) {
          let j = stressIdx + 3;
          for (let r = 0; r < 3; r++) {
            const parts = lines[j + r].trim().split(/\s+/).map(Number);
            const pressures = parts.slice(3, 6);
            stressTensor.push(pressures.map(v => v * 0.1));
          }
        }

        // Push final SCF step
        steps.push({
          lattice,
          elements,
          positionsFrac: positions,
          forces,
          stressTensor
        });

        finalSCF = true;
      }
    }

    if (nextMarker === -1) break;
    pos = nextMarker;
  }

  // -----------------------------
  // Handle any remaining forces/stress after the last marker
  // -----------------------------
  const lastStep = steps[steps.length - 1];
  if (lastStep) {
    const remainingForcesIdx = findIndexInRange(pos, n, ln =>
      ln.includes("Forces acting on atoms")
    );
    if (remainingForcesIdx !== -1) {
      let forces = [];
      let j = remainingForcesIdx + 2;
      while (j < n && lines[j].includes("atom")) {
        const match = lines[j].match(/force\s*=\s*(.*)/);
        if (match) {
          const nums = match[1].trim().split(/\s+/).map(Number);
          forces.push(nums.slice(0, 3));
        }
        j++;
      }

      const stressTensor = [];
      const stressIdx = findIndexInRange(remainingForcesIdx, n, ln =>
        ln.includes("Computing stress")
      );
      if (stressIdx !== -1) {
        let k = stressIdx + 3;
        for (let r = 0; r < 3; r++) {
          const parts = lines[k + r].trim().split(/\s+/).map(Number);
          const pressures = parts.slice(3, 6);
          stressTensor.push(pressures.map(v => v * 0.1));
        }
      }

      if (forces.length > 0 || stressTensor.length > 0) {
        steps.push({
          lattice: lastStep.lattice,
          elements: lastStep.elements,
          positionsFrac: lastStep.positionsFrac,
          forces,
          stressTensor,
        });
        finalSCF = true;
      }
    }
  }

  // -----------------------------
  // Convert to Structure objects
  // -----------------------------
  //
  const structures = steps.map(s => {
  const atoms = [];


  s.positionsFrac.forEach((pos, i) => {
    atoms.push(
      new Atom({
        position: pos,
        element: s.elements[i]  // use s.elements here
      })
    );
  });
  const spins = [];   
  if (s.spins) {
    s.spins.forEach((vector,i) =>{
       spins.push(new Spin({
         vector: vector,
         scaling: 1.0
       })
       );
    });}
    else{
      const spins = null;
    }
    const forces = [];
    s.forces.forEach((vector,i) =>{
       forces.push(new Force({
         vector: vector,
         scaling: 1.0
       })
       );
    });  

  return new Structure({
    elements: s.elements,
    uniqueElements: [...new Set(s.elements)],
    lattice: s.lattice,
    forces: forces,
    polyhedra: [],
    stresses: new Stress( {tensor:s.stressTensor}),
    atoms: atoms,
    spins: spins ?? []
  });
});


  const traj = structures.length;
  const step = traj;

  const row = createRow({ name: fileName, traj, step });
  if (tableBody) tableBody.appendChild(row);

  if (fileBrowser && Array.isArray(fileBrowser.fileData)) {
    fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });
    selectLastAddedRow();
  }

  // -----------------------------
  // Return container with finalSCF flag
  // -----------------------------
  return new StructureContainer({
    fileName,
    structures,
    symmetries: [],
    finalSCF
  });
}

