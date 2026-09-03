/**
 * Parser for CASTEP trajectory output files:
 *   .geom  geometry optimization
 *   .md    molecular dynamics
 *   .ts    transition-state search
 *
 * All three share one format: a `BEGIN header … END header` preamble followed
 * by frame blocks separated by blank lines. Every data line ends with a tag
 * that classifies it, independent of order within the block:
 *
 *   <-- h   lattice vector row      (Bohr)
 *   <-- R   "El idx x y z" position (Bohr, Cartesian)
 *   <-- F   "El idx fx fy fz" force (Hartree/Bohr)
 *   <-- E   energies; first value is the total energy (Hartree)
 *   <-- S   stress tensor row (Hartree/Bohr^3 -> GPa)
 *           <-- V velocity / <-- T,P … (ignored here)
 *
 * Values are in atomic units and converted to the app's Å / eV / (eV/Å). Each
 * block with positions becomes one Structure; the file loads as a stepped
 * trajectory carrying per-frame energy and forces (the Trajectory panel plots
 * them). A .ts file's reactant/product/TST configurations are each read as a
 * frame in file order.
 */

import { Structure, StructureContainer, Atom, Force, Stress } from '../model/index.js';
import { transpose3x3, invert3x3, cartToFractional, normalizeFractional } from '../math/index.js';
import { generateID } from '../utils/index.js';

const BOHR_TO_ANG = 0.52917721067;
const HARTREE_TO_EV = 27.211386245988;
const HARTREE_PER_BOHR_TO_EV_PER_ANG = HARTREE_TO_EV / BOHR_TO_ANG;
// Atomic unit of pressure (Hartree/Bohr^3) -> GPa. The app stores stress in GPa
// (the QE reader converts kbar->GPa the same way), so pressure = -tr/3 is GPa.
const HARTREE_PER_BOHR3_TO_GPA = 29421.02648438959;

/** The trailing `<-- X` tag of a line, or null. Matches the exact tag token so
 *  `hv` (lattice velocity) is not mistaken for the lattice tag `h`. */
function lineTag(line) {
  const m = line.match(/<--\s*([A-Za-z]+)\s*$/);
  return m ? m[1] : null;
}

/** Drop the trailing `<-- X` tag and return the whitespace-split tokens. */
function dataTokens(line) {
  return line.replace(/<--.*$/, '').trim().split(/\s+/);
}

/**
 * Turn one frame block into a plain record { lattice, elements, positionsCart,
 * forces, energy }, or null when it carries no atomic positions.
 * @param {string[]} block
 */
function parseBlock(block) {
  const latticeRows = [];
  const elements = [];
  const positionsCart = [];
  const forces = [];
  const stressRows = []; // 3 rows of the stress tensor, converted to GPa
  let energy = null;

  for (const line of block) {
    const tag = lineTag(line);
    if (!tag) continue;

    if (tag === 'h' && latticeRows.length < 3) {
      const v = dataTokens(line).map(Number);
      if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
        latticeRows.push(v.slice(0, 3).map((x) => x * BOHR_TO_ANG));
      }
    } else if (tag === 'S' && stressRows.length < 3) {
      // Stress tensor rows, Hartree/Bohr^3 -> GPa. `S` is exact (not `Sxx`), so
      // it is not confused with any other tag.
      const v = dataTokens(line).map(Number);
      if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
        stressRows.push(v.slice(0, 3).map((x) => x * HARTREE_PER_BOHR3_TO_GPA));
      }
    } else if (tag === 'R') {
      const t = dataTokens(line);
      const c = t.slice(2, 5).map(Number);
      if (t.length >= 5 && c.every(Number.isFinite)) {
        elements.push(t[0].split(':')[0]);
        positionsCart.push(c.map((x) => x * BOHR_TO_ANG));
      }
    } else if (tag === 'F') {
      const t = dataTokens(line);
      const f = t.slice(2, 5).map(Number);
      if (t.length >= 5 && f.every(Number.isFinite)) {
        forces.push(f.map((x) => x * HARTREE_PER_BOHR_TO_EV_PER_ANG));
      }
    } else if (tag === 'E' && energy === null) {
      const first = dataTokens(line).map(Number).find(Number.isFinite);
      if (first !== undefined) energy = first * HARTREE_TO_EV;
    }
  }

  if (positionsCart.length === 0 || latticeRows.length !== 3) return null;
  const stress = stressRows.length === 3 ? stressRows : null;
  return { lattice: latticeRows, elements, positionsCart, forces, energy, stress };
}

/**
 * Parse a CASTEP .geom/.md/.ts file into a StructureContainer trajectory.
 * @param {string} content
 * @param {string} fileName
 * @returns {Promise<StructureContainer>}
 */
export function parseCastepGeom(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== 'string') {
      reject(new Error('Content must be a non-empty string'));
      return;
    }

    try {
      const allLines = content.split(/\r?\n/);
      // Everything up to and including "END header" is the preamble.
      const endHeader = allLines.findIndex((l) => /END\s+header/i.test(l));
      const body = endHeader >= 0 ? allLines.slice(endHeader + 1) : allLines;

      // Group consecutive non-blank lines into frame blocks.
      const blocks = [];
      let block = [];
      for (const line of body) {
        if (line.trim() === '') {
          if (block.length) { blocks.push(block); block = []; }
        } else {
          block.push(line);
        }
      }
      if (block.length) blocks.push(block);

      const structures = [];
      for (const b of blocks) {
        const rec = parseBlock(b);
        if (!rec) continue;

        const { lattice, elements, positionsCart, forces, energy, stress } = rec;
        const latticeInverse = invert3x3(transpose3x3(lattice));
        const positions = positionsCart.map(
          (c) => cartToFractional(c, lattice, latticeInverse).map(normalizeFractional),
        );

        const atoms = positions.map((position, i) => new Atom({
          position,
          element: elements[i],
          uuid: generateID([elements[i], i]),
        }));

        structures.push(new Structure({
          elements,
          uniqueElements: [...new Set(elements)],
          lattice,
          atoms,
          // One Force per atom only when the block actually carried F lines.
          forces: forces.length === elements.length
            ? forces.map((vector) => new Force({ vector, scaling: 1.0 }))
            : [],
          energy,
          stress: stress ? new Stress({ tensor: stress }) : null,
        }));
      }

      if (structures.length === 0) {
        reject(new Error('CASTEP trajectory: no frames with atomic positions found'));
        return;
      }

      resolve(new StructureContainer({ fileName, structures }));
    } catch (error) {
      reject(error);
    }
  });
}
