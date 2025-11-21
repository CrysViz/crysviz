import { Structure } from "../classes/Structure.js";
import { StructureContainer } from "../classes/StructureContainer.js";
const tableBody = document.querySelector("#objectTable tbody");
import { fileBrowser } from "../store.js";
import { createRow } from "../panels/FileBrowswerPanel.js";

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
    let stressMatrix = [];

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
          stressMatrix.push(pressures.map(v => v * 0.1)); // GPa
        }
      }

      // Only push step if all data exists
      if (
        lattice && lattice.length === 3 &&
        positions && positions.length > 0 &&
        forces && forces.length > 0 &&
        stressMatrix && stressMatrix.length === 3
      ) {
        steps.push({
          lattice,
          elements,
          positionsFrac: positions,
          forces,
          stressMatrix
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
            stressMatrix.push(pressures.map(v => v * 0.1));
          }
        }

        // Push final SCF step
        steps.push({
          lattice,
          elements,
          positionsFrac: positions,
          forces,
          stressMatrix
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

      const stressMatrix = [];
      const stressIdx = findIndexInRange(remainingForcesIdx, n, ln =>
        ln.includes("Computing stress")
      );
      if (stressIdx !== -1) {
        let k = stressIdx + 3;
        for (let r = 0; r < 3; r++) {
          const parts = lines[k + r].trim().split(/\s+/).map(Number);
          const pressures = parts.slice(3, 6);
          stressMatrix.push(pressures.map(v => v * 0.1));
        }
      }

      if (forces.length > 0 || stressMatrix.length > 0) {
        steps.push({
          lattice: lastStep.lattice,
          elements: lastStep.elements,
          positionsFrac: lastStep.positionsFrac,
          forces,
          stressMatrix
        });
        finalSCF = true;
      }
    }
  }

  // -----------------------------
  // Convert to Structure objects
  // -----------------------------
  const structures = steps.map(s =>
    new Structure({
      elements: s.elements,
      uniqueElements: [...new Set(s.elements)],
      lattice: s.lattice,
      positions: s.positionsFrac,
      positions_cartesian: null
    })
  );

  const forceObjects = steps.map(s => ({ forces: s.forces }));
  const stressObjects = steps.map(s => ({ stressMatrix: s.stressMatrix }));

  const traj = structures.length;
  const step = traj;

  const row = createRow({ name: fileName, traj, step });
  if (tableBody) tableBody.appendChild(row);

  if (fileBrowser && Array.isArray(fileBrowser.fileData)) {
    fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });
  }

  // -----------------------------
  // Return container with finalSCF flag
  // -----------------------------
  return new StructureContainer({
    fileName,
    structures,
    spins: [],
    symmetries: [],
    forces: forceObjects,
    polyhedra: [],
    stresses: stressObjects,
    finalSCF
  });
}

