/**
 * Parser for FHI-aims output (`aims.out`).
 *
 * Handles a single-point run or a relaxation/MD trajectory: the initial
 * "Input geometry" echo plus every "Updated atomic structure" block become
 * frames, each carrying the total energy (eV) and the per-atom forces
 * (eV/Å) printed for that geometry, and — when present — per-atom spin moments
 * from the Mulliken analysis (rendered as collinear spins along z).
 *
 * aims prints the energy and forces of the CURRENT geometry and only then the
 * "Updated atomic structure" of the NEXT one, so a forward pass accumulates the
 * pending energy/forces/spins and flushes them onto the current geometry when
 * the next update (or end of file) arrives — the same pairing the QE/OUTCAR
 * readers use. The "Updated atomic structure" blocks are geometry.in syntax and
 * are parsed by the shared ReadAimsGeometryModule helpers.
 */

import { StructureContainer } from '../model/index.js';
import {
  parseAimsAtomsBlock, buildAimsStructure, elementFromSpecies,
} from './ReadAimsGeometryModule.js';

const FLOAT = '-?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?';
const ENERGY_RE = new RegExp(`\\|\\s*Total energy(?:\\s+corrected|\\s+uncorrected)?\\s*:\\s*(${FLOAT})\\s*eV`, 'i');
const FORCE_RE = new RegExp(`^\\s*\\|\\s*\\d+\\s+(${FLOAT})\\s+(${FLOAT})\\s+(${FLOAT})`);
// Echo geometry: "|    1: Species C   x y z"
const ECHO_ATOM_RE = new RegExp(`^\\s*\\|\\s*\\d+:\\s*Species\\s+(\\S+)\\s+(${FLOAT})\\s+(${FLOAT})\\s+(${FLOAT})`, 'i');
// Echo lattice: a "|"-prefixed triple of floats inside the "Unit cell:" block.
const ECHO_LATTICE_RE = new RegExp(`^\\s*\\|\\s*(${FLOAT})\\s+(${FLOAT})\\s+(${FLOAT})\\s*$`);

/** Read the "Input geometry" echo into a { latticeRows, atoms } block (atoms in
 *  the same shape parseAimsAtomsBlock produces). Returns { block, end }. */
function readEcho(lines, start) {
  const latticeRows = [];
  const atoms = [];
  let inUnitCell = false;
  let sawAtoms = false;
  let j = start + 1;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (/Unit cell:/i.test(line)) { inUnitCell = true; continue; }
    if (/Atomic structure:/i.test(line)) { inUnitCell = false; continue; }

    const atomM = line.match(ECHO_ATOM_RE);
    if (atomM) {
      atoms.push({
        element: elementFromSpecies(atomM[1]),
        xyz: [Number(atomM[2]), Number(atomM[3]), Number(atomM[4])],
        frac: false,
        moment: null,
      });
      sawAtoms = true;
      continue;
    }
    if (inUnitCell && latticeRows.length < 3) {
      const latM = line.match(ECHO_LATTICE_RE);
      if (latM) { latticeRows.push([Number(latM[1]), Number(latM[2]), Number(latM[3])]); continue; }
    }
    // Stop once the atom list has ended (a non-atom, non-blank line past it).
    if (sawAtoms && line.trim() && !line.trim().startsWith('|')) break;
  }
  return { block: { latticeRows, atoms }, end: j - 1 };
}

/** Read an "Updated atomic structure" block (geometry.in syntax). */
function readUpdated(lines, start) {
  const collected = [];
  let sawAtom = false;
  let j = start + 1;
  for (; j < lines.length; j++) {
    const t = lines[j].trim();
    const key = t.split(/\s+/)[0]?.toLowerCase();
    if (key === 'lattice_vector' || key === 'atom' || key === 'atom_frac') {
      collected.push(lines[j]);
      if (key !== 'lattice_vector') sawAtom = true;
    } else if (!t) {
      if (sawAtom) break; // blank line after the atoms ends the block
    } else if (sawAtom) {
      break; // any other content after atoms ends the block
    }
  }
  return { block: parseAimsAtomsBlock(collected), end: j - 1 };
}

/** Read the per-atom force block after a "Total atomic forces … [eV/Ang]:"
 *  header. Returns { forces, end }. */
function readForces(lines, start) {
  const forces = [];
  let j = start + 1;
  for (; j < lines.length; j++) {
    const m = lines[j].match(FORCE_RE);
    if (!m) { if (forces.length) break; else continue; }
    forces.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return { forces, end: j - 1 };
}

/** Best-effort per-atom spin from a Mulliken analysis table: a header line
 *  mentioning both "atom" and "spin", then "| <idx> <El> … <spin>" rows whose
 *  last number is the moment. Returns collinear [0,0,m] vectors (null-safe). */
function readMullikenSpins(lines, start) {
  const spins = [];
  let j = start + 1;
  for (; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!t.startsWith('|')) { if (spins.length) break; else continue; }
    const m = t.match(new RegExp(`^\\|\\s*(\\d+)\\s+([A-Za-z]{1,3})\\b.*?(${FLOAT})\\s*$`));
    if (!m) { if (spins.length) break; else continue; }
    spins.push([0, 0, Number(m[3])]);
  }
  return { spins, end: j - 1 };
}

/**
 * Parse an FHI-aims output file into a StructureContainer trajectory.
 * @param {string} content
 * @param {string} fileName
 * @returns {Promise<StructureContainer>}
 */
export function parseAimsOut(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== 'string') {
      reject(new Error('Content must be a non-empty string'));
      return;
    }
    try {
      const lines = content.split(/\r?\n/);
      const frames = [];
      let current = null;
      let pendingForces = null;
      let pendingEnergy = null;
      let pendingSpins = null;
      // Magnetism sanity check: did the run report spin, and did we manage to
      // read per-atom moments? If the former without the latter, we warn.
      let spinSectionSeen = false; // a per-atom spin table header appeared
      let netMoment = 0;           // |N_up - N_down| of the cell

      const flush = () => {
        if (!current) return;
        if (pendingSpins && pendingSpins.length === current.atoms.length) {
          current.atoms.forEach((a, i) => { a.moment = pendingSpins[i]; });
        }
        frames.push({ block: current, forces: pendingForces, energy: pendingEnergy });
        pendingForces = null; pendingEnergy = null; pendingSpins = null;
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!current && /Input geometry:/i.test(line)) {
          const r = readEcho(lines, i); current = r.block; i = r.end; continue;
        }
        if (/Updated atomic structure/i.test(line)) {
          flush();
          const r = readUpdated(lines, i); current = r.block; i = r.end; continue;
        }
        if (/Total atomic forces.*\[eV\/Ang\]/i.test(line)) {
          const r = readForces(lines, i); pendingForces = r.forces; i = r.end; continue;
        }
        // The per-atom spin table's section header, e.g.
        // "Full analysis of Mulliken charges and spin moments:" (Mulliken or
        // Hirshfeld). Seeing it is our signal that per-atom moments were printed.
        if (/(mulliken|hirshfeld)/i.test(line) && /(spin|moment)/i.test(line)) {
          spinSectionSeen = true;
          const r = readMullikenSpins(lines, i);
          if (r.spins.length) { pendingSpins = r.spins; i = r.end; }
          continue;
        }
        // Net cell moment: evidence the run is magnetic even without a per-atom table.
        const nM = line.match(/N_up\s*-\s*N_down.*?:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/i);
        if (nM) netMoment = Math.max(netMoment, Math.abs(Number(nM[1])));
        const eM = line.match(ENERGY_RE);
        if (eM) pendingEnergy = Number(eM[1]);
      }
      flush();

      const structures = frames
        .map((f) => buildAimsStructure(f.block, { forces: f.forces, energy: f.energy }))
        .filter(Boolean);

      if (structures.length === 0) {
        reject(new Error('FHI-aims output: no atomic structure found'));
        return;
      }

      const container = new StructureContainer({ fileName, structures });

      // Sanity check: the run looks spin-polarised (a per-atom spin table was
      // printed, or the cell carries a net moment) but no spins were attached to
      // any frame — the moment format wasn't one we could read. Flag it so the
      // loader can tell the user rather than silently dropping magnetism.
      const hasSpins = structures.some((s) => s.spins && s.spins.length);
      if (!hasSpins && (spinSectionSeen || netMoment > 0.05)) {
        container.loadWarnings = [
          'This FHI-aims run appears to be spin-polarised, but per-atom spin '
          + 'moments could not be read from the output. The structure was loaded '
          + 'without spins.',
        ];
      }

      resolve(container);
    } catch (error) {
      reject(error);
    }
  });
}
