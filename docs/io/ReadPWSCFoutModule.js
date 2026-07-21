import { Structure } from "../model/index.js";
import { Atom } from "../model/index.js";
import { Force } from "../model/index.js";
import { Stress } from "../model/index.js";
import { StructureContainer } from "../model/index.js";
import { cartToFractional } from "../math/index.js";
import { generateID } from '../utils/index.js'

const BOHR_TO_ANG = 0.52917721092;
const RY_TO_EV = 13.605693;
// pw.x prints "Forces acting on atoms (cartesian axes, Ry/au)" — Rydberg per
// Bohr, not eV/Å (the unit every other reader/the Forces panel legend uses).
// Force is energy/length, so the conversion is eV-per-Ry divided by
// Å-per-Bohr, not just one factor or the other.
const FORCE_RY_BOHR_TO_EV_ANG = RY_TO_EV / BOHR_TO_ANG;

/**
 * Parse a pw.x output file into a trajectory.
 *
 * The layout pw.x writes is the reason this reads as a state machine rather
 * than a block splitter: within one ionic step it prints the energy, forces
 * and stress *of the current geometry*, and only then the CELL_PARAMETERS /
 * ATOMIC_POSITIONS of the **next** one. Pairing those naively (everything
 * between two "End of self-consistent calculation" markers) attaches each
 * frame's forces to the geometry that came after them. So: accumulate
 * energy/forces/stress, and emit a frame the moment a new geometry is
 * announced — the geometry in hand at that point is the one the data belongs
 * to. The first geometry comes from the header echo, which is also the only
 * geometry a plain scf run prints at all.
 */
export function parsePWSCFout(content, fileName) {
  const lines = content.split("\n");
  const n = lines.length;

  // alat (celldm(1)) is in Bohr and scales both the header cell and the
  // header tau positions.
  let alatBohr = 1;
  const celldmIdx = lines.findIndex(ln => ln.includes("celldm(1)="));
  if (celldmIdx !== -1) {
    const m = lines[celldmIdx].match(/celldm\(1\)=\s*(-?[\d.]+)/);
    if (m) alatBohr = parseFloat(m[1]);
  }
  const alatAng = alatBohr * BOHR_TO_ANG;

  /** @type {number[][] | null} */
  let lattice = readHeaderCell(lines, alatAng);
  /** @type {string[]} */
  let elements = [];
  /** @type {number[][]} */
  let positionsFrac = [];
  if (lattice) {
    const header = readHeaderPositions(lines, alatAng, lattice);
    elements = header.elements;
    positionsFrac = header.positionsFrac;
  }

  const steps = [];
  /** @type {{energy: number | null, forces: number[][], stress: number[][] | null}} */
  let pending = { energy: null, forces: [], stress: null };
  const hasPending = () => pending.energy !== null || pending.forces.length > 0 || pending.stress !== null;

  function emit() {
    // Clear pending even when there is no geometry to attach it to, so a
    // dropped frame can never mispair its data onto the next geometry.
    if (!lattice || positionsFrac.length === 0) {
      pending = { energy: null, forces: [], stress: null };
      return;
    }
    steps.push({
      lattice,
      elements,
      positionsFrac,
      forces: pending.forces,
      stressTensor: pending.stress,
      energy: pending.energy,
    });
    pending = { energy: null, forces: [], stress: null };
  }

  for (let i = 0; i < n; i++) {
    const line = lines[i];

    if (line.includes("total energy") && line.trimStart().startsWith("!")) {
      const m = line.match(/=\s*(-?[\d.]+)/);
      if (m) {
        if (pending.energy !== null) emit();
        pending.energy = parseFloat(m[1]) * RY_TO_EV;
      }

    } else if (line.includes("Forces acting on atoms")) {
      if (pending.forces.length > 0) emit();
      pending.forces = readForces(lines, i, n);

    } else if (line.includes("total") && line.includes("stress") && line.includes("Ry/bohr**3")) {
      if (pending.stress !== null) emit();
      pending.stress = readStress(lines, i, n);

    } else if (line.startsWith("CELL_PARAMETERS") || line.startsWith("ATOMIC_POSITIONS")) {
      // First geometry marker after a batch of scf data closes the frame.
      // CELL_PARAMETERS and ATOMIC_POSITIONS are printed back to back for the
      // same new geometry, so only the first of the pair emits. (A second scf
      // block with no geometry in between — the final scf at the relaxed
      // structure — is closed by the overwrite guards above instead.)
      if (hasPending()) emit();

      if (line.startsWith("CELL_PARAMETERS")) {
        const cell = readCellParameters(lines, i, alatAng);
        if (cell) lattice = cell;
      } else {
        const parsed = readAtomicPositions(lines, i, n, alatAng, lattice);
        if (parsed.positionsFrac.length > 0) {
          elements = parsed.elements;
          positionsFrac = parsed.positionsFrac;
        }
      }
    }
  }

  // Last ionic step (and, for a relaxation, the "Final scf calculation at the
  // relaxed structure" block) is never followed by a geometry marker.
  if (hasPending()) emit();

  const structures = steps.map((s) => {
    const atoms = s.positionsFrac.map((pos, i) => new Atom({
      position: pos,
      element: s.elements[i],
      uuid: generateID([s.elements[i]]),
    }));
    const forces = s.forces.map(vector => new Force({ vector, scaling: 1.0 }));

    return new Structure({
      elements: s.elements,
      uniqueElements: [...new Set(s.elements)],
      lattice: s.lattice,
      forces,
      polyhedra: [],
      energy: s.energy,
      stress: s.stressTensor ? new Stress({ tensor: s.stressTensor }) : null,
      atoms,
      spins: [],
    });
  });

  return new StructureContainer({ fileName, structures });
}

// "crystal axes: (cart. coord. in units of alat)" followed by a(1)..a(3).
function readHeaderCell(lines, alatAng) {
  const idx = lines.findIndex(ln => ln.includes("crystal axes:"));
  if (idx === -1) return null;
  const cell = [];
  for (let k = 1; k <= 3; k++) {
    // "a(1) = ( x y z )" — anchor on the `=` so the index in `a(1)` isn't
    // what the paren group picks up.
    const m = lines[idx + k]?.match(/=\s*\(([^)]*)\)/);
    if (!m) return null;
    const nums = m[1].trim().split(/\s+/).map(Number);
    if (nums.length < 3 || nums.some(v => !Number.isFinite(v))) return null;
    cell.push(nums.slice(0, 3).map(v => v * alatAng));
  }
  return cell;
}

// "site n.  atom  positions (alat units)" followed by `tau( i ) = ( x y z )`.
function readHeaderPositions(lines, alatAng, lattice) {
  const idx = lines.findIndex(ln => ln.includes("site n.") && ln.includes("positions"));
  if (idx === -1) return { elements: [], positionsFrac: [] };
  const elements = [];
  const positionsFrac = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const m = lines[j].match(/^\s*\d+\s+(\S+)\s+tau\(\s*\d+\s*\)\s*=\s*\(([^)]*)\)/);
    if (!m) {
      if (lines[j].trim().length === 0) continue;
      break;
    }
    const nums = m[2].trim().split(/\s+/).map(Number);
    if (nums.length < 3) break;
    elements.push(m[1]);
    positionsFrac.push(cartToFractional(nums.slice(0, 3).map(v => v * alatAng), lattice));
  }
  return { elements, positionsFrac };
}

function readCellParameters(lines, idx, alatAng) {
  const header = lines[idx];
  const alatMatch = header.match(/alat\s*=\s*([\d.]+)/);
  // The alat printed on the CELL_PARAMETERS line is in Bohr and may differ
  // from celldm(1) after a vc-relax rescale, so prefer it when present.
  let scale = alatAng;
  if (alatMatch) scale = parseFloat(alatMatch[1]) * BOHR_TO_ANG;
  else if (header.includes("bohr")) scale = BOHR_TO_ANG;
  else if (header.includes("angstrom")) scale = 1;

  const cell = [];
  for (let k = 1; k <= 3; k++) {
    const nums = lines[idx + k]?.trim().split(/\s+/).map(Number);
    if (!nums || nums.length < 3 || nums.some(v => !Number.isFinite(v))) return null;
    cell.push(nums.slice(0, 3).map(v => v * scale));
  }
  return cell;
}

function readAtomicPositions(lines, idx, n, alatAng, lattice) {
  const header = lines[idx];
  const elements = [];
  const raw = [];
  for (let j = idx + 1; j < n; j++) {
    const parts = lines[j].trim().split(/\s+/);
    if (parts.length < 4 || !Number.isFinite(Number(parts[1]))) break;
    elements.push(parts[0]);
    raw.push(parts.slice(1, 4).map(Number));
  }

  if (header.includes("crystal")) return { elements, positionsFrac: raw };
  if (!lattice) return { elements: [], positionsFrac: [] };
  const scale = header.includes("bohr") ? BOHR_TO_ANG
    : header.includes("alat") ? alatAng
    : 1; // angstrom
  return {
    elements,
    positionsFrac: raw.map(p => cartToFractional(p.map(v => v * scale), lattice)),
  };
}

function readForces(lines, idx, n) {
  const forces = [];
  for (let j = idx + 1; j < n; j++) {
    const match = lines[j].match(/atom\s+\d+\s+type\s+\d+\s+force\s*=\s*(.*)/);
    if (!match) {
      // A blank line separates the header from the list; stop at the first
      // non-blank line that isn't an atom (e.g. "Total force = ...").
      if (lines[j].trim().length === 0 && forces.length === 0) continue;
      break;
    }
    const nums = match[1].trim().split(/\s+/).map(Number);
    forces.push(nums.slice(0, 3).map(v => v * FORCE_RY_BOHR_TO_EV_ANG));
  }
  return forces;
}

// The "total stress" header line is followed by three rows holding the tensor
// twice: Ry/bohr**3 in columns 1-3, kbar in columns 4-6.
function readStress(lines, idx, n) {
  const tensor = [];
  for (let r = 1; r <= 3; r++) {
    if (idx + r >= n) return null;
    const parts = lines[idx + r].trim().split(/\s+/).map(Number);
    if (parts.length < 6 || parts.some(v => !Number.isFinite(v))) return null;
    tensor.push(parts.slice(3, 6).map(v => v * 0.1)); // kbar -> GPa
  }
  return tensor;
}
