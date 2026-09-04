// CifSymmetryExport.js
//
// The "CIF (symmetry)" exporter: the cell exactly as displayed — lattice,
// origin and setting untouched — with the symmetry moyo finds in THAT cell:
// the full `_space_group_symop` loop of this cell's operations and one
// `_atom_site` row per crystallographic orbit (the asymmetric unit), with
// multiplicity as counted in this cell and moyo's Wyckoff letter. The same
// picture the Wyckoff editor gives, on paper.
//
// Not the standardized conventional cell. A primitive fcc cell is written as
// its 1-atom rhombohedral cell with the 48 point operations and no centring
// translations; a 2x2x2 supercell keeps its 8 extra pure translations in the
// loop. Both are valid CIF — readers expand from the symop loop — and both
// describe what is on screen, which is the point. The H-M symbol and IT
// number name the space-group TYPE; the Hall symbol is setting-specific and is
// deliberately not written, since the setting is whatever the user has.
//
// Everything hinges on a tolerance: only representatives are written, so the
// file silently symmetrizes the structure to the symprec used. That is why the
// Download-menu button opens CifExportModal.js (tolerance box, live preview of
// what it yields, a ladder of tolerances) instead of downloading directly, and
// why the tolerance, and the largest deviation it absorbed, go into the file
// header. When the Wyckoff editor is active the export reads the lock instead
// of re-analysing, so the file matches the editor row for row.
//
// Disorder: atoms are labelled by composition (species + occupancies), not by
// majority element, so two mixed sites with different mixes are inequivalent —
// as they must be for the written occupancies to hold on every image.

import { fileBrowser } from '../state/store.js';
import { latticeParameters } from '../math/index.js';
import { analyzeCell, defaultSymprec } from './SymmetryEditModule.js';
import { selectedForExport, siteSpecies, cifSiteRows, cifBlockName } from './SavePanel.js';
import {
  buildCifText, symopsToXyz, parseSymopsXyz, symmetryDeviation,
} from '../io/cif/cif_writer.js';

/** Tolerances the export dialog previews side by side (Å). */
export const CIF_TOLERANCE_LADDER = [1e-4, 1e-3, 1e-2, 1e-1];

/** The active Wyckoff lock of the selected structure, or null. */
export function activeSymmetryLock(structure = fileBrowser.selectedStructure) {
  const lock = structure?.symmetry;
  return lock?.mode === 'wyckoff' && lock.operations?.length ? lock : null;
}

// moyo serializes matrices column-major (nalgebra); the writer reads row-major.
const transpose3 = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/**
 * Composition labels for the exportable atoms: one small integer per distinct
 * (species, occupancy) mix, positions in the structure's own cell.
 */
function labelledCell(structure, keep) {
  const compositions = [];
  const labelByKey = new Map();
  const atomIndices = [];
  const positions = [];
  const numbers = [];
  structure.atoms.forEach((atom, i) => {
    if (!keep[i]) return;
    const species = siteSpecies(structure, atom, i);
    if (!species.length) return;
    const key = species.map((s) => `${s.element}:${s.occupancy.toFixed(6)}`).sort().join('|');
    if (!labelByKey.has(key)) {
      labelByKey.set(key, compositions.length + 1);
      compositions.push(species);
    }
    atomIndices.push(i);
    positions.push([...atom.position]);
    numbers.push(labelByKey.get(key));
  });
  if (!positions.length) throw new Error('Structure has only vacancies — nothing to export.');
  return { compositions, atomIndices, positions, numbers, lattice: structure.lattice.map((r) => [...r]) };
}

/**
 * Orbits from the Wyckoff lock, remapped onto the exportable atoms. null when
 * the lock cannot be used as-is: an orbit mixing atoms of different
 * composition (the lock groups by element only) would make the written
 * occupancies wrong on some images, so such a structure is re-analysed.
 */
function orbitsFromLock(lock, cell) {
  const exportIndex = new Map(cell.atomIndices.map((atomIndex, k) => [atomIndex, k]));
  const orbits = [];
  for (const group of lock.orbitGroups ?? []) {
    const members = group.atomIndices.map((i) => exportIndex.get(i)).filter((k) => k !== undefined);
    if (!members.length) continue;
    const label = cell.numbers[members[0]];
    if (members.some((k) => cell.numbers[k] !== label)) return null;
    const representative = exportIndex.get(group.representativeIndex) ?? members[0];
    orbits.push({ representative, members, wyckoff: group.wyckoff ?? '?' });
  }
  if (!orbits.length) return null;
  const covered = orbits.reduce((n, o) => n + o.members.length, 0);
  return covered === cell.positions.length ? orbits : null;
}

function orbitsFromDataset(dataset, cell) {
  const orbitIds = dataset.orbits ?? cell.positions.map((_, i) => i);
  const wyckoffs = dataset.wyckoffs ?? [];
  const grouped = new Map();
  orbitIds.forEach((orbitId, k) => {
    if (!grouped.has(orbitId)) grouped.set(orbitId, []);
    grouped.get(orbitId).push(k);
  });
  return [...grouped.values()].map((members) => ({
    representative: members[0],
    members,
    wyckoff: wyckoffs[members[0]] ?? '?',
  }));
}

/**
 * Build the symmetric CIF of the selected structure and describe what went
 * into it. Rejects with a user-readable message (no structure, moyo failure).
 *
 * @param {number} [tolerance] symprec in Å. Ignored when the Wyckoff editor is
 *   active: the lock's own tolerance is used so the file matches the editor.
 * @returns {Promise<{text: string, tolerance: number, fromLock: boolean, hm: string,
 *   number: number, operationCount: number, siteCount: number, atomCount: number,
 *   maxDeviation: number, exactTranslations: boolean}>}
 */
export async function prepareSymmetricCif(tolerance = defaultSymprec()) {
  const { structure, keep } = selectedForExport();
  const cell = labelledCell(structure, keep);

  let operations;
  let orbits = null;
  let hm;
  let number;
  let fromLock = false;
  const lock = activeSymmetryLock(structure);
  if (lock) {
    orbits = orbitsFromLock(lock, cell);
    if (orbits) {
      fromLock = true;
      tolerance = lock.tolerance ?? tolerance;
      operations = lock.operations.map((op) => ({ rotation: [...op.rotation], translation: [...op.translation] }));
      hm = lock.spaceGroup;
      number = lock.number;
    }
  }
  if (!orbits) {
    if (lock) tolerance = lock.tolerance ?? tolerance;
    const dataset = await analyzeCell(cell, tolerance);
    operations = (dataset.operations ?? []).map((op) => ({
      rotation: transpose3(op.rotation),
      translation: [...op.translation],
    }));
    if (!operations.length) throw new Error('Symmetry analysis returned no operations.');
    orbits = orbitsFromDataset(dataset, cell);
    hm = dataset.hm_symbol;
    number = dataset.number;
  }

  const { xyz, exact } = symopsToXyz(operations);
  // Measured with the operations as WRITTEN (parsed back from their strings),
  // so the number in the header is what a reader of the file experiences.
  const maxDeviation = symmetryDeviation(cell.positions, cell.numbers, parseSymopsXyz(xyz), cell.lattice);
  if (!(maxDeviation <= Math.max(10 * tolerance, 1e-6))) {
    throw new Error('The symmetry operations found do not map the atoms onto each other '
      + `(largest miss ${maxDeviation.toExponential(2)} Å at tolerance ${tolerance} Å) — cannot write a symmetric CIF.`);
  }

  const counters = {};
  const sites = [];
  for (const orbit of orbits) {
    const r = orbit.representative;
    sites.push(...cifSiteRows(cell.compositions[cell.numbers[r] - 1], cell.positions[r], counters, {
      multiplicity: orbit.members.length,
      wyckoff: orbit.wyckoff || '?',
    }));
  }

  const comments = [
    `symmetry of the cell as displayed (not standardized), found at tolerance ${tolerance} Å`
      + (fromLock ? ' by the active Wyckoff lock' : ''),
    `largest deviation of an atom from its symmetry image: ${maxDeviation.toExponential(2)} Å`,
    'multiplicities count atoms in THIS cell; the Hall symbol is omitted because the setting is not standardized',
  ];
  if (!exact) {
    comments.push('some translations are not simple fractions (origin off a symmetry element) and are written as decimals');
  }

  const text = buildCifText({
    name: cifBlockName(),
    created: new Date().toISOString(),
    comments,
    cell: latticeParameters(cell.lattice),
    spaceGroup: { hm, number },
    symopsXyz: xyz,
    sites,
  });

  return {
    text, tolerance, fromLock, hm, number,
    operationCount: xyz.length,
    siteCount: orbits.length,
    atomCount: cell.positions.length,
    maxDeviation,
    exactTranslations: exact,
  };
}

/**
 * What each tolerance of the ladder yields, for the dialog's side-by-side
 * view. Failures are reported per rung, never thrown.
 * @param {number[]} [tolerances]
 * @returns {Promise<Array<{tolerance: number, hm?: string, number?: number, siteCount?: number, error?: string}>>}
 */
export async function symmetryLadder(tolerances = CIF_TOLERANCE_LADDER) {
  const rungs = [];
  for (const tolerance of tolerances) {
    try {
      const { hm, number, siteCount } = await prepareSymmetricCif(tolerance);
      rungs.push({ tolerance, hm, number, siteCount });
    } catch (error) {
      rungs.push({ tolerance, error: String(error?.message ?? error) });
    }
  }
  return rungs;
}
