// CutSlab.js
//
// Cut a surface slab from a structure and register it as a new, selected
// file-browser row: the one path behind the Cell & Supercell window's
// "Cut Slab (h k l)" section and the host's build_slab command. Validation
// lives here too, so the window and the assistant refuse the same inputs with
// the same words; each refusal carries a `code` the host passes through.

import { buildSlab } from '../../model/slab.js';
import { getActiveStructure, getContainerForStructure } from '../../state/structures.js';
import { createNewStructureFromAtoms } from './CommitAtoms.js';

export const SLAB_DEFAULTS = Object.freeze({ layers: 4, vacuum: 15 });
const MAX_LAYERS = 50;
const MAX_VACUUM = 200;
const MAX_ATOMS = 20000;

/** @returns {never} */
function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

const elementOf = (structure, i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements[i];

/**
 * Cut `structure` along (h k l), `layers` stacking repeats thick with `vacuum`
 * Å along the surface normal, and add the slab as a new, selected row.
 * @param {any} structure
 * @param {{hkl: number[], layers?: number, vacuum?: number}} options
 * @returns {{container: any, slab: {lattice: number[][], positions: number[][], elements: string[], thickness: number}, layers: number, vacuum: number}}
 */
export function cutSlab(structure, { hkl, layers = SLAB_DEFAULTS.layers, vacuum = SLAB_DEFAULTS.vacuum }) {
  if (!structure) refuse('NO_ACTIVE_STRUCTURE', 'No active structure');
  if (!Array.isArray(structure.lattice) || structure.lattice.length !== 3 || structure.periodic === false) {
    refuse('NO_LATTICE', 'This needs a periodic structure');
  }
  if (!Array.isArray(hkl) || hkl.length !== 3 || !hkl.every(Number.isInteger) || hkl.every((x) => x === 0)) {
    refuse('INVALID_ARGS', 'hkl must be three integers, not all zero');
  }
  if (!Number.isInteger(layers) || layers < 1 || layers > MAX_LAYERS) refuse('INVALID_ARGS', `layers must be 1 to ${MAX_LAYERS}`);
  if (typeof vacuum !== 'number' || !Number.isFinite(vacuum) || vacuum < 0 || vacuum > MAX_VACUUM) {
    refuse('INVALID_ARGS', `vacuum must be 0 to ${MAX_VACUUM} Å`);
  }
  if (structure.atoms.some((atom) => atom.isDisordered?.())) {
    refuse('DISORDERED', 'Slabs need an ordered structure (Order Structure first, or run_ordering)');
  }
  let slab;
  try {
    slab = buildSlab({
      lattice: structure.lattice, positions: structure.atoms.map((a) => a.position),
      elements: structure.atoms.map((_, i) => elementOf(structure, i)),
    }, { hkl, layers, vacuum });
  } catch (error) {
    refuse('SLAB_FAILED', error.message);
  }
  if (slab.positions.length > MAX_ATOMS) refuse('TOO_LARGE', `The slab would have ${slab.positions.length} atoms`);
  const name = `slab_${hkl.join('')}_${String(getContainerForStructure(structure)?.fileName ?? 'structure')}`;
  createNewStructureFromAtoms(slab.positions.map((p, i) => ({ element: slab.elements[i], x: p[0], y: p[1], z: p[2] })),
    { lattice: slab.lattice, fileName: name });
  // createNewStructureFromAtoms selected the new row.
  return { container: getContainerForStructure(getActiveStructure()), slab, layers, vacuum };
}
