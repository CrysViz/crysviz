// cif_writer.js
//
// DOM-free building blocks for the CIF exporters (ui/SavePanel.js,
// ui/CifSymmetryExport.js): turning symmetry operations into
// `_space_group_symop_operation_xyz` strings, measuring how far a cell's atoms
// are from being exactly invariant under those operations, and laying out the
// CIF text itself. Nothing here knows about moyo, structures or the store.

import { parse_xyz_op } from './cif_parser.js';

/** Fixed-point (never exponential) formatting shared by every structure
 *  exporter: 12 decimals is far below any symmetry tolerance, so a symmetric
 *  cell written here stays symmetric even at tight symprec. */
export const hp = (x) => Number(x).toFixed(12);

function wrap01(x) {
  let v = x - Math.floor(x);
  // 0.999999999999 is the same site as 0 — write it as 0 rather than as a
  // coordinate that a reader wraps to 1e-12.
  if (v > 1 - 1e-9) v = 0;
  return v;
}

/** Fractional position wrapped into [0, 1). */
export function wrapFractional(position) {
  return [wrap01(position[0]), wrap01(position[1]), wrap01(position[2])];
}

function fracDelta(a, b) {
  return a.map((value, axis) => {
    let diff = value - b[axis];
    diff -= Math.round(diff);
    return diff;
  });
}

// Symmetry translations of a cell whose origin sits on a symmetry element are
// multiples of 1/12 at most (1/2, 1/3, 1/4, 1/6 and their multiples). When the
// structure is shifted off such a point — the export writes the cell as it is,
// never re-origined — an operation like an inversion picks up a translation of
// twice the shift, which is no fraction. Those are written as decimals.
const TRANSLATION_DENOMINATORS = [1, 2, 3, 4, 6, 8, 12];

function snapTranslation(value, tolerance = 1e-6) {
  const wrapped = wrap01(value);
  for (const den of TRANSLATION_DENOMINATORS) {
    const num = Math.round(wrapped * den);
    if (Math.abs(wrapped - num / den) < tolerance) return { num: num % den, den };
  }
  return null;
}

// "0.246800000000" -> "0.2468"; "0.500000000000" would never get here.
function decimalText(value) {
  return wrap01(value).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * One symmetry operation as CIF xyz notation ("-x+1/2, y, -z+1/2"). The
 * rotation is a flat ROW-major 3x3 of small integers (the fractional-basis
 * matrix W), the translation a length-3 vector in fractional coordinates.
 * `exact` is false when a translation had to be written as a decimal.
 * @param {number[]} rotation
 * @param {number[]} translation
 * @returns {{text: string, exact: boolean}}
 */
export function symopToXyz(rotation, translation) {
  const axes = ['x', 'y', 'z'];
  let exact = true;
  const text = [0, 1, 2].map((row) => {
    let part = '';
    axes.forEach((axis, column) => {
      const c = Math.round(rotation[3 * row + column]);
      if (c === 0) return;
      part += (c > 0 ? '+' : '-') + (Math.abs(c) === 1 ? '' : String(Math.abs(c))) + axis;
    });
    const frac = snapTranslation(translation[row]);
    if (frac) {
      if (frac.num !== 0) part += `+${frac.num}/${frac.den}`;
    } else {
      exact = false;
      part += `+${decimalText(translation[row])}`;
    }
    if (!part) part = '0';
    return part.replace(/^\+/, '');
  }).join(', ');
  return { text, exact };
}

/**
 * All operations as xyz strings, plus whether every translation was an exact
 * fraction.
 * @param {{rotation: number[], translation: number[]}[]} operations row-major rotations
 * @returns {{xyz: string[], exact: boolean}}
 */
export function symopsToXyz(operations) {
  const parts = operations.map((op) => symopToXyz(op.rotation, op.translation));
  return { xyz: parts.map((p) => p.text), exact: parts.every((p) => p.exact) };
}

/**
 * Parse xyz operations back into { rotation (row-major flat), translation }
 * pairs — the same reading a CIF consumer does, so anything verified with these
 * is verified as written.
 * @param {string[]} symopsXyz
 */
export function parseSymopsXyz(symopsXyz) {
  return symopsXyz.map((text) => {
    const [rows, translation] = parse_xyz_op(text, false);
    return { rotation: rows.flat().map(Number), translation: translation.map(Number) };
  });
}

function applyOperation(position, { rotation: r, translation: t }) {
  const [x, y, z] = position;
  return [
    r[0] * x + r[1] * y + r[2] * z + t[0],
    r[3] * x + r[4] * y + r[5] * z + t[1],
    r[6] * x + r[7] * y + r[8] * z + t[2],
  ];
}

/**
 * How far the cell is from being exactly invariant under the operations: for
 * every operation and every atom, the distance from the atom's image to the
 * nearest atom carrying the same label; the largest such distance, in Å. Zero
 * for an idealized cell; up to about the symprec for a cell moyo accepted at
 * that symprec. Infinity when a label has no atoms at all (cannot happen for a
 * label taken from `labels`).
 *
 * Positions are fractional, `labels` anything comparable with `===`, `lattice`
 * the three row vectors in Å.
 * @param {number[][]} positions
 * @param {any[]} labels
 * @param {{rotation: number[], translation: number[]}[]} operations
 * @param {number[][]} lattice
 * @returns {number}
 */
export function symmetryDeviation(positions, labels, operations, lattice) {
  const cartLength = (frac) => {
    const v = [0, 1, 2].map((k) => frac[0] * lattice[0][k] + frac[1] * lattice[1][k] + frac[2] * lattice[2][k]);
    return Math.hypot(v[0], v[1], v[2]);
  };
  let worst = 0;
  positions.forEach((position, i) => {
    for (const operation of operations) {
      const image = applyOperation(position, operation);
      let best = Infinity;
      positions.forEach((candidate, j) => {
        if (labels[j] !== labels[i]) return;
        const d = cartLength(fracDelta(image, candidate));
        if (d < best) best = d;
      });
      if (best > worst) worst = best;
    }
  });
  return worst;
}

/** A CIF string value: single-quoted unless it contains a single quote (then
 *  double-quoted). Hall symbols carry a `"` ("-R 3 2\""), so the choice is real. */
export function cifQuote(value) {
  const text = String(value);
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  throw new Error(`Cannot quote CIF value ${text}`);
}

/**
 * Lay out a CIF data block.
 *
 * @param {object} spec
 * @param {string} spec.name              data block name (whitespace already replaced)
 * @param {string} spec.created           ISO timestamp for the header comment
 * @param {{a:number,b:number,c:number,alpha:number,beta:number,gamma:number}} spec.cell
 * @param {{hm: string, number: number, hall?: string|null}} spec.spaceGroup
 * @param {string[]} spec.symopsXyz       full operation list, identity included
 * @param {Array<{label: string, symbol: string, position: number[], occupancy: number,
 *   multiplicity?: number, wyckoff?: string}>} spec.sites
 *   One row per species on a site; a mixed site is several rows sharing
 *   coordinates. `multiplicity`/`wyckoff` columns are written when every row
 *   carries them (the symmetric export), omitted otherwise (P1).
 * @param {string[]} [spec.comments]     extra `#` header lines
 * @returns {string}
 */
export function buildCifText({ name, created, cell, spaceGroup, symopsXyz, sites, comments = [] }) {
  const withSites = sites.every((s) => Number.isFinite(s.multiplicity) && s.wyckoff);
  const lines = [
    `# generated by CrysViz ${created}`,
    ...comments.map((c) => `# ${c}`),
    `data_${name}`,
    `_symmetry_space_group_name_H-M   ${cifQuote(spaceGroup.hm)}`,
    `_symmetry_Int_Tables_number      ${spaceGroup.number}`,
  ];
  if (spaceGroup.hall) lines.push(`_space_group_name_Hall           ${cifQuote(spaceGroup.hall)}`);
  lines.push(
    // Full precision on the metric too: rounding an angle to a few decimals
    // could snap a near-90°/120° cell to the wrong symmetry (or away from it).
    `_cell_length_a    ${hp(cell.a)}`,
    `_cell_length_b    ${hp(cell.b)}`,
    `_cell_length_c    ${hp(cell.c)}`,
    `_cell_angle_alpha ${hp(cell.alpha)}`,
    `_cell_angle_beta  ${hp(cell.beta)}`,
    `_cell_angle_gamma ${hp(cell.gamma)}`,
    'loop_',
    '_space_group_symop_id',
    '_space_group_symop_operation_xyz',
  );
  symopsXyz.forEach((op, i) => lines.push(`  ${String(i + 1).padStart(3)} ${cifQuote(op)}`));
  lines.push(
    'loop_',
    '_atom_site_label',
    '_atom_site_type_symbol',
  );
  if (withSites) lines.push('_atom_site_symmetry_multiplicity', '_atom_site_Wyckoff_symbol');
  lines.push(
    '_atom_site_fract_x',
    '_atom_site_fract_y',
    '_atom_site_fract_z',
    '_atom_site_occupancy',
  );
  for (const site of sites) {
    const [x, y, z] = site.position;
    let row = `  ${site.label.padEnd(6)} ${String(site.symbol).padEnd(4)} `;
    if (withSites) row += `${String(site.multiplicity).padStart(3)} ${String(site.wyckoff).padEnd(2)} `;
    row += `${hp(x)} ${hp(y)} ${hp(z)} ${hp(site.occupancy)}`;
    lines.push(row);
  }
  lines.push('');
  return lines.join('\n');
}
