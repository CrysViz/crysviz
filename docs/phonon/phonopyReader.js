// Readers for phonopy's output files, producing the PhononDataset the phonon
// panel and the mode-mapping code work on. Everything phonopy writes about
// modes has the same shape (`phonon: [{q-position, band: [{frequency,
// eigenvector}]}]`), so band.yaml, mesh.yaml and qpoints.yaml share one
// reader; total_dos.dat / projected_dos.dat are plain columns; phonopy.yaml
// (or phonopy_disp.yaml / phonopy_params.yaml) only contributes the cells.
//
// Conventions (phonopy defaults): frequencies in THz with imaginary modes
// written as NEGATIVE numbers; q-positions in reduced coordinates of the
// primitive reciprocal lattice; eigenvectors are the columns of the unitary
// matrix that diagonalises the dynamical matrix, i.e. mass-weighted and
// normalised to one per mode, stored per atom as three [re, im] pairs.

import { parsePhonopyYaml } from './phonopyYaml.js';

/**
 * @typedef {Object} PhononCell
 * @property {number[][]} lattice  rows are a, b, c in Å
 * @property {string[]} species    element symbol per atom
 * @property {number[][]} frac     fractional coordinates per atom
 * @property {number[]} masses     amu per atom
 */

/**
 * @typedef {Object} PhononQPoint
 * @property {number[]} q            reduced coordinates (primitive reciprocal basis)
 * @property {number} distance       cumulative path distance (band) or distance from Γ (mesh)
 * @property {number} weight         mesh multiplicity (1 for band/qpoints)
 * @property {Float64Array} freqs    one frequency per band (THz, negative = imaginary)
 * @property {Float64Array|null} eigvecs  nb × natom × 3 × 2 (re, im) or null when the file has none
 */

/**
 * @typedef {Object} PhononDataset
 * @property {'band'|'mesh'|'qpoints'} kind
 * @property {PhononCell|null} cell   the primitive cell the modes refer to (null for very old files)
 * @property {number[][]|null} reciprocal
 * @property {number} natom
 * @property {number} nbands
 * @property {PhononQPoint[]} qpoints
 * @property {number[]} segments      band: q-points per path segment
 * @property {string[][]|null} labels band: [start, end] label per segment
 * @property {boolean} hasEigenvectors
 * @property {string} fileName
 * @property {number[]|null} meshDims  mesh: the sampling grid
 * @property {PhononCell|null} [cellRaw]  the cell as written (calculator units), before conversion to Å
 * @property {string} [lengthUnitApplied]  which unit cellRaw was read as
 */

function requireArray(v, what) {
  if (!Array.isArray(v)) throw new Error(`phonopy file: missing "${what}"`);
  return v;
}

/** Turn a phonopy `points:` list into a PhononCell (with `lattice`). */
export function cellFromPhonopyPoints(lattice, points) {
  const species = [];
  const frac = [];
  const masses = [];
  for (const p of requireArray(points, 'points')) {
    species.push(String(p.symbol));
    const c = p.coordinates;
    if (!Array.isArray(c) || c.length !== 3) throw new Error('phonopy file: bad "coordinates"');
    frac.push([Number(c[0]), Number(c[1]), Number(c[2])]);
    masses.push(Number(p.mass));
  }
  const lat = requireArray(lattice, 'lattice').map((row) => requireArray(row, 'lattice row').map(Number));
  if (lat.length !== 3) throw new Error('phonopy file: lattice must have three rows');
  return { lattice: lat, species, frac, masses };
}

/** Sniff: does this text look like a phonopy mode file (band/mesh/qpoints)? */
export function looksLikePhonopyModes(text) {
  const head = String(text).slice(0, 4000);
  return /^phonon:\s*$/m.test(head) || (/^nqpoint:/m.test(head) && /^(npath|mesh|reciprocal_lattice):/m.test(head));
}

/** Sniff: phonopy.yaml / phonopy_disp.yaml / phonopy_params.yaml. */
export function looksLikePhonopyCells(text) {
  const head = String(text).slice(0, 2000);
  return /^phonopy:\s*$/m.test(head) && /^\s+version:/m.test(head);
}

/** Sniff: total_dos.dat / projected_dos.dat (two or more numeric columns,
 *  optionally with phonopy's "# Tetrahedron method"/"# Sigma" header). */
export function looksLikePhonopyDos(text, fileName = '') {
  const name = String(fileName).toLowerCase();
  if (/(^|\/)(total|projected|partial)_dos\.dat$/.test(name)) return true;
  const lines = String(text).split(/\r?\n/, 12).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 3) return false;
  return /^#\s*(Tetrahedron|Sigma)/m.test(String(text).slice(0, 200))
    && lines.every((l) => l.trim().split(/\s+/).every((t) => Number.isFinite(Number(t))));
}

/**
 * Parse band.yaml / mesh.yaml / qpoints.yaml.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {PhononDataset}
 */
export function parsePhonopyModes(text, fileName = 'band.yaml') {
  const doc = parsePhonopyYaml(text);
  if (!doc || typeof doc !== 'object') throw new Error('phonopy file: empty document');
  const phonon = requireArray(doc.phonon, 'phonon');
  if (!phonon.length) throw new Error('phonopy file: no q-points');

  const kind = Array.isArray(doc.mesh) ? 'mesh' : (doc.npath !== undefined || doc.segment_nqpoint !== undefined ? 'band' : 'qpoints');
  const cell = Array.isArray(doc.lattice) && Array.isArray(doc.points) ? cellFromPhonopyPoints(doc.lattice, doc.points) : null;
  const natom = Number(doc.natom ?? (cell ? cell.species.length : 0));
  const firstBands = requireArray(phonon[0].band, 'band');
  const nbands = firstBands.length;
  const hasEigenvectors = firstBands[0] && Array.isArray(firstBands[0].eigenvector);
  const natomFromEig = hasEigenvectors ? firstBands[0].eigenvector.length : natom;
  const nat = natom || natomFromEig;
  if (hasEigenvectors && natom && natomFromEig !== natom) {
    throw new Error(`phonopy file: eigenvectors are for ${natomFromEig} atoms but natom is ${natom}`);
  }

  /** @type {PhononQPoint[]} */
  const qpoints = new Array(phonon.length);
  let running = 0;
  for (let iq = 0; iq < phonon.length; iq++) {
    const p = phonon[iq];
    const q = requireArray(p['q-position'], 'q-position').map(Number);
    const bands = requireArray(p.band, 'band');
    if (bands.length !== nbands) throw new Error('phonopy file: inconsistent number of bands');
    const freqs = new Float64Array(nbands);
    const eigvecs = hasEigenvectors ? new Float64Array(nbands * nat * 6) : null;
    for (let ib = 0; ib < nbands; ib++) {
      const b = bands[ib];
      freqs[ib] = Number(b.frequency);
      if (eigvecs) {
        const ev = requireArray(b.eigenvector, 'eigenvector');
        if (ev.length !== nat) throw new Error('phonopy file: eigenvector atom count mismatch');
        let o = ib * nat * 6;
        for (let ia = 0; ia < nat; ia++) {
          const comps = requireArray(ev[ia], 'eigenvector components');
          for (let k = 0; k < 3; k++) {
            const pair = comps[k];
            eigvecs[o++] = Number(pair[0]);
            eigvecs[o++] = Number(pair[1]);
          }
        }
      }
    }
    let distance;
    if (p.distance !== undefined) distance = Number(p.distance);
    else if (p.distance_from_gamma !== undefined) distance = Number(p.distance_from_gamma);
    else distance = running++;
    qpoints[iq] = {
      q,
      distance,
      weight: p.weight !== undefined ? Number(p.weight) : 1,
      freqs,
      eigvecs,
    };
  }

  let segments = Array.isArray(doc.segment_nqpoint) ? doc.segment_nqpoint.map(Number) : [qpoints.length];
  let labels = null;
  if (Array.isArray(doc.labels)) {
    labels = doc.labels.map((pair) => (Array.isArray(pair) ? pair.map((s) => String(s)) : [String(pair), '']));
  }

  return {
    kind,
    cell,
    reciprocal: Array.isArray(doc.reciprocal_lattice) ? doc.reciprocal_lattice.map((r) => r.map(Number)) : null,
    natom: nat,
    nbands,
    qpoints,
    segments,
    labels,
    hasEigenvectors: !!hasEigenvectors,
    fileName,
    meshDims: Array.isArray(doc.mesh) ? doc.mesh.map(Number) : null,
  };
}

export const BOHR_TO_ANGSTROM = 0.529177210903;

/**
 * The length unit phonopy keeps a calculator's cells in. phonopy converts
 * nothing when it writes band.yaml / mesh.yaml: the lattice and coordinates
 * are in the calculator's own unit (Bohr for QE, abinit, siesta, elk, ...),
 * and only phonopy.yaml says which. Frequencies are always THz.
 * @param {string|null|undefined} calculator
 * @returns {'angstrom'|'bohr'|null}
 */
export function calculatorLengthUnit(calculator) {
  const c = String(calculator || '').toLowerCase();
  if (!c) return null;
  if (['qe', 'pwscf', 'abinit', 'siesta', 'elk', 'wien2k', 'turbomole', 'fleur', 'qlm'].includes(c)) return 'bohr';
  if (['vasp', 'castep', 'cp2k', 'crystal', 'aims', 'lammps', 'dftb+', 'dftbp'].includes(c)) return 'angstrom';
  return null;
}

/** A copy of `cell` with its lattice scaled by `factor` (fractional
 *  coordinates are unit-free). */
export function scaleCell(cell, factor) {
  if (!cell || factor === 1) return cell;
  return { ...cell, lattice: cell.lattice.map((row) => row.map((v) => v * factor)) };
}

/**
 * Parse phonopy.yaml-like files for their cells, matrices and units.
 * @param {string} text
 * @returns {{ primitive: PhononCell|null, unit: PhononCell|null, supercell: PhononCell|null,
 *            primitiveMatrix: number[][]|null, supercellMatrix: number[][]|null, version: string|null,
 *            calculator: string|null, lengthUnit: 'angstrom'|'bohr'|null }}
 */
export function parsePhonopyCells(text) {
  const doc = parsePhonopyYaml(text);
  if (!doc || typeof doc !== 'object') throw new Error('phonopy.yaml: empty document');
  const cellOf = (node) => (node && Array.isArray(node.lattice) && Array.isArray(node.points) ? cellFromPhonopyPoints(node.lattice, node.points) : null);
  const mat = (m) => (Array.isArray(m) && m.length === 3 ? m.map((r) => r.map(Number)) : null);
  const calculator = doc.phonopy && doc.phonopy.calculator !== undefined && doc.phonopy.calculator !== null
    ? String(doc.phonopy.calculator).toLowerCase() : null;
  const written = doc.physical_unit && doc.physical_unit.length !== undefined && doc.physical_unit.length !== null
    ? String(doc.physical_unit.length).toLowerCase() : '';
  /** @type {'angstrom'|'bohr'|null} */
  let lengthUnit = null;
  if (/^(au|a\.u\.|bohr)/.test(written)) lengthUnit = 'bohr';
  else if (/angstrom|^a$|^ang/.test(written)) lengthUnit = 'angstrom';
  else lengthUnit = calculatorLengthUnit(calculator);
  return {
    primitive: cellOf(doc.primitive_cell),
    unit: cellOf(doc.unit_cell),
    supercell: cellOf(doc.supercell),
    primitiveMatrix: mat(doc.primitive_matrix),
    supercellMatrix: mat(doc.supercell_matrix),
    version: doc.phonopy && doc.phonopy.version !== undefined ? String(doc.phonopy.version) : null,
    calculator,
    lengthUnit,
  };
}

/**
 * Parse total_dos.dat / projected_dos.dat: frequency column then one or more
 * density columns.
 * @param {string} text
 * @returns {{ frequencies: number[], columns: number[][], total: number[] }}
 */
export function parsePhonopyDos(text) {
  const frequencies = [];
  /** @type {number[][]} */
  const columns = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 2 || parts.some((v) => !Number.isFinite(v))) continue;
    frequencies.push(parts[0]);
    for (let k = 1; k < parts.length; k++) {
      if (!columns[k - 1]) columns[k - 1] = [];
      columns[k - 1].push(parts[k]);
    }
  }
  if (!frequencies.length) throw new Error('DOS file: no numeric rows');
  const total = frequencies.map((_, i) => columns.reduce((s, c) => s + (c[i] ?? 0), 0));
  return { frequencies, columns, total };
}

/**
 * Attach a cell from phonopy.yaml to a dataset that lacks one (old band.yaml
 * without `lattice`/`points`), or verify a present one matches.
 */
export function withCell(dataset, cells) {
  const cell = cells.primitive || cells.unit;
  if (!cell) return dataset;
  if (!dataset.cell) return { ...dataset, cell, natom: cell.species.length };
  return dataset;
}

/** A compact list of the imaginary (negative-frequency) modes in a dataset. */
export function listImaginaryModes(dataset, tolTHz = 0.05) {
  const out = [];
  dataset.qpoints.forEach((qp, iq) => {
    for (let ib = 0; ib < qp.freqs.length; ib++) {
      if (qp.freqs[ib] < -Math.abs(tolTHz)) out.push({ iq, ib, q: qp.q, freq: qp.freqs[ib] });
    }
  });
  out.sort((a, b) => a.freq - b.freq);
  return out;
}
