/**
 * Parser for FHI-aims `geometry.in` files (and the shared structure builder the
 * aims.out reader reuses for its "Updated atomic structure" blocks, which use
 * the same syntax).
 *
 * Recognised lines (everything after `#` is a comment):
 *   lattice_vector  x y z              a lattice row, Å (0, or 3 for periodic)
 *   atom            x y z  Species     Cartesian position, Å
 *   atom_frac       x y z  Species     fractional position (needs a lattice)
 *   initial_moment  m                  collinear moment of the preceding atom
 *   initial_moment  mx my mz           non-collinear moment of the preceding atom
 *
 * Positions are stored fractional (Cartesian atoms are converted against the
 * lattice). A structure with atoms but no lattice_vector (a molecule) is placed
 * in a centered bounding box, exactly as the (ext)XYZ and CASTEP-seed readers
 * do. `initial_moment` becomes a Spin so the magnetic structure renders; a bare
 * collinear value m is taken along z ([0, 0, m]).
 */

import { Structure, StructureContainer, Atom, Spin } from '../model/index.js';
import { transpose3x3, invert3x3, cartToFractional, normalizeFractional } from '../math/index.js';
import { runPeriodicWrapped } from '../render/index.js';
import { generateID } from '../utils/index.js';

/** Element symbol from an aims species label (drop a trailing numeric/underscore
 *  tag: `Fe1` → `Fe`, `C_surf` → `C`). */
export function elementFromSpecies(label) {
  return String(label || '').replace(/[_0-9].*$/, '') || String(label || '');
}

/** A moment token list → a Cartesian spin vector. One value is collinear (z);
 *  three are taken as-is. Returns null for an all-zero / empty moment. */
function momentVector(tokens) {
  const nums = tokens.map(Number).filter(Number.isFinite);
  let v = null;
  if (nums.length === 1) v = [0, 0, nums[0]];
  else if (nums.length >= 3) v = nums.slice(0, 3);
  if (!v || v.every((c) => c === 0)) return null;
  return v;
}

/**
 * Parse geometry.in-syntax lines into { latticeRows, atoms }, where each atom is
 * { element, xyz, frac, moment }. Pure — no model construction — so the aims.out
 * reader can reuse it on its "Updated atomic structure" blocks.
 * @param {string[]} lines
 */
export function parseAimsAtomsBlock(lines) {
  const latticeRows = [];
  const atoms = [];

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toLowerCase();

    if (key === 'lattice_vector' && parts.length >= 4) {
      const v = parts.slice(1, 4).map(Number);
      if (v.every(Number.isFinite) && latticeRows.length < 3) latticeRows.push(v);
    } else if ((key === 'atom' || key === 'atom_frac') && parts.length >= 5) {
      const xyz = parts.slice(1, 4).map(Number);
      if (!xyz.every(Number.isFinite)) continue;
      atoms.push({ element: elementFromSpecies(parts[4]), xyz, frac: key === 'atom_frac', moment: null });
    } else if (key === 'initial_moment' && atoms.length) {
      atoms[atoms.length - 1].moment = momentVector(parts.slice(1));
    }
  }
  return { latticeRows, atoms };
}

/** Centered orthorhombic bounding box for a molecule (no lattice), matching the
 *  XYZ / CASTEP-seed fallback. @param {number[][]} cart */
function molecularBox(cart) {
  let maxMag = 0;
  const com = [0, 0, 0];
  for (const p of cart) {
    for (let k = 0; k < 3; k++) { maxMag = Math.max(maxMag, Math.abs(p[k])); com[k] += p[k]; }
  }
  const n = cart.length || 1;
  for (let k = 0; k < 3; k++) com[k] /= n;
  const size = 2 * (maxMag + 2);
  const half = size / 2;
  const lattice = [[size, 0, 0], [0, size, 0], [0, 0, size]];
  const centered = cart.map((p) => [p[0] - com[0] + half, p[1] - com[1] + half, p[2] - com[2] + half]);
  return { lattice, centered };
}

/**
 * Build a Structure from a parsed aims atom block, plus optional per-frame
 * forces/energy (used by the aims.out trajectory reader).
 * @param {{ latticeRows: number[][], atoms: Array<{element:string,xyz:number[],frac:boolean,moment:number[]|null}> }} block
 * @param {{ forces?: number[][]|null, energy?: number|null }} [extra]
 * @returns {Structure|null} null when the block has no atoms
 */
export function buildAimsStructure(block, { forces = null, energy = null } = {}) {
  const { latticeRows, atoms } = block;
  if (!atoms.length) return null;

  let lattice = latticeRows.length === 3 ? latticeRows : null;
  const elements = atoms.map((a) => a.element);

  // Resolve every atom to a Cartesian position first (fractional atoms need the
  // lattice, so those are only valid when one was given).
  let positions;
  if (lattice) {
    const inv = invert3x3(transpose3x3(lattice));
    positions = atoms.map((a) => {
      const frac = a.frac ? a.xyz : cartToFractional(a.xyz, lattice, inv);
      return frac.map(normalizeFractional);
    });
  } else {
    // No lattice: a molecule. atom_frac without a cell is meaningless, so treat
    // every atom as Cartesian and wrap it in a centered box.
    const cart = atoms.map((a) => a.xyz);
    const boxed = molecularBox(cart);
    lattice = boxed.lattice;
    const inv = invert3x3(transpose3x3(lattice));
    positions = boxed.centered.map((c) => cartToFractional(c, lattice, inv).map(normalizeFractional));
  }

  const atomObjs = positions.map((position, i) => new Atom({
    position, element: elements[i], uuid: generateID([elements[i], i]),
  }));

  // Spins only when at least one atom carries a moment.
  const spins = atoms.some((a) => a.moment)
    ? atoms.map((a, i) => new Spin({
      vector: a.moment ? [...a.moment] : [0, 0, 0],
      scaling: 1.0, color: '#008080', atomIndex: i, element: elements[i],
    }))
    : [];

  const forceObjs = (Array.isArray(forces) && forces.length === atoms.length)
    ? forces.map((vector) => ({ vector, scaling: 1.0 }))
    : [];

  const periodic = runPeriodicWrapped({ hash: 'None', wrapped: {} }, positions, elements, lattice);

  return new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice,
    atoms: atomObjs,
    spins,
    forces: forceObjs,
    energy: Number.isFinite(energy) ? energy : null,
    periodic,
  });
}

/**
 * Parse an FHI-aims geometry.in file into a single-structure StructureContainer.
 * @param {string} content
 * @param {string} fileName
 * @returns {Promise<StructureContainer>}
 */
export function parseAimsGeometry(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== 'string') {
      reject(new Error('Content must be a non-empty string'));
      return;
    }
    try {
      const block = parseAimsAtomsBlock(content.split(/\r?\n/));
      if (block.atoms.some((a) => a.frac) && block.latticeRows.length !== 3) {
        reject(new Error('FHI-aims geometry.in: atom_frac needs three lattice_vector lines'));
        return;
      }
      const structure = buildAimsStructure(block);
      if (!structure) {
        reject(new Error('FHI-aims geometry.in: no atoms found'));
        return;
      }
      resolve(new StructureContainer({ fileName, structures: [structure] }));
    } catch (error) {
      reject(error);
    }
  });
}
