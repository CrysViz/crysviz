// The "CIF errors": the standard uncertainties (s.u., "esd" — the digits in
// parentheses, 5.4307(2)) a CIF gives for its cell parameters and atomic
// coordinates, gathered from the parsed file into one record. Built for every
// plain CIF that has any; the load dialog (ui/CifSymmetryLoad.js) then asks
// whether to read them, and drops the record when the answer is no.
//
// The record keeps the uncertainties per crystallographic SITE, as the file
// gives them, and each expanded atom keeps which site it is a copy of and the
// rotation part of the operation that made it. That is what lets a distance
// between two symmetry copies of one site (an atom and its inversion image,
// say) get the right, correlated uncertainty rather than treating the two ends
// as independent: model/cifErrors.js propagates through the site parameters.
// Symmetry also ties parameters together — an atom at (x, 2x, z), a = b in a
// hexagonal cell — so each site and the cell get their free directions here,
// from the file's own operations (freeSiteDirections / freeCellDirections).

import { freeSiteDirections, freeCellDirections } from '../../model/cifErrors.js';

/** Plain numbers from the parser's exact fractions. */
function num(value) {
  return value && typeof value === 'object' && typeof value.toNumber === 'function'
    ? value.toNumber()
    : Number(value);
}

/**
 * @param {any} cif the result of cif_to_struct (io/cif/expand_asu.js)
 * @returns {null | {
 *   cell: { values: number[], su: number[], resolution: number[], dirs: Array<{d:number[], su:number}> },
 *   sites: Array<{ label: string, frac: number[], su: number[], resolution: number[], dirs: Array<{d:number[], su:number}> }>,
 *   atoms: Array<{ site: number, R: number[][], frac: number[] }>,
 * }} null when the file gives no uncertainty at all
 */
export function buildCifErrors(cif) {
  const cell = cif?.cell;
  const sites = cif?.sites;
  const rowEsd = cif?.position_esds;
  const rowRes = cif?.position_resolutions;
  const siteOf = cif?.site_index_full;
  const opOf = cif?.op_index_full;
  const full = cif?.positions_full;
  if (!cell || !sites?.positions || !Array.isArray(rowEsd) || !Array.isArray(siteOf)
    || !Array.isArray(opOf) || !Array.isArray(full) || full.length !== siteOf.length) return null;

  // A site's uncertainties are those of the first atom_site row that made it
  // (its position is that row's too: io/cif/site_grouping.js).
  const firstRow = new Array(sites.positions.length).fill(-1);
  (sites.rowToSite ?? []).forEach((site, row) => {
    if (site >= 0 && firstRow[site] < 0) firstRow[site] = row;
  });
  const clean = (list) => (list ?? [0, 0, 0]).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const ops = (cif.symops ?? []).map(([R, t]) => [R.map((row) => row.map(num)), t.map(num)]);
  const rotations = ops.map(([R]) => R);
  const siteRecords = sites.positions.map((frac, s) => {
    const row = firstRow[s] >= 0 ? firstRow[s] : s;
    const x = frac.map(Number);
    const su = clean(rowEsd[row]);
    return {
      label: sites.labels?.[s] ?? '',
      frac: x,
      su,
      resolution: clean(rowRes?.[row]),
      dirs: freeSiteDirections(x, su, ops, cif.site_symmetry_orders?.[row] ?? null),
    };
  });

  const cellSu = clean(cell.esd);
  const anySu = cellSu.some((v) => v > 0) || siteRecords.some((s) => s.su.some((v) => v > 0));
  if (!anySu) return null;

  const atoms = full.map((frac, i) => ({
    site: siteOf[i],
    R: rotations[opOf[i]] ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    frac: frac.map(Number),
  }));

  return {
    cell: {
      values: cell.values.map(Number), su: cellSu, resolution: clean(cell.resolution),
      dirs: freeCellDirections(cell.values.map(Number), cellSu, rotations),
    },
    sites: siteRecords,
    atoms,
  };
}
