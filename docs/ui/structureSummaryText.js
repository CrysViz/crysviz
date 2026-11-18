// Plain-text renderings of one structure for the Files window's "Structure
// info" section (ui/FileStructureSummary.js): the lattice, its parameters and
// volume, the atomic positions (fractional or Cartesian) and the Wyckoff
// positions — what the copy buttons put on the clipboard, and what the tests
// pin down. No DOM here.

import { latticeParameters, fracToCartPoint } from '../math/index.js';
import { pressureGPa, tensorGPa } from '../model/index.js';
import { formatWithSu } from '../model/cifErrors.js';

const num = (v, digits = 6, width = 0) => {
  const text = Number.isFinite(v) ? v.toFixed(digits) : 'nan';
  return width ? text.padStart(width) : text;
};

/** The three lattice vectors, one per line (Å, 6 decimals) — a component
 *  with an s.u. (`su`, 3×3 like the lattice: CIF errors, model/cifErrors.js
 *  latticeVectorSus) written with it, 4.91600(10). */
export function latticeText(lattice, su = null) {
  return lattice.map((row, i) => row.map((v, k) => withSu(v, su?.[i]?.[k], 6).padStart(12)).join(' ')).join('\n');
}

/** A value, with its s.u. in parentheses when it has one (CIF errors,
 *  model/cifErrors.js formatWithSu): 5.4307(2); else to `digits` decimals. */
const withSu = (v, su, digits) => (Number.isFinite(v) ? formatWithSu(v, su, digits) : 'nan');

/**
 * The lattice parameters and volume, one item each:
 * ["a = 5.4455 Å", …, "α = 90.000°", …, "V = 366.1234 Å³"]. With `su` (the
 * s.u.s of a, b, c, α, β, γ, V from a CIF, model/cifErrors.js
 * cellParameterSus) a value that has one is written with it, a = 5.4307(2) Å.
 * @param {number[][]} lattice
 * @param {number[]|null} [su]
 */
export function latticeParamItems(lattice, su = null) {
  const p = latticeParameters(lattice);
  const values = [p.a, p.b, p.c, p.alpha, p.beta, p.gamma, p.volume];
  const names = ['a', 'b', 'c', 'α', 'β', 'γ', 'V'];
  const units = [' Å', ' Å', ' Å', '°', '°', '°', ' Å³'];
  const digits = [4, 4, 4, 3, 3, 3, 4];
  return values.map((v, k) => `${names[k]} = ${withSu(v, su?.[k], digits[k])}${units[k]}`);
}

/** "a = 5.4455 Å  b = …  c = …  α = 90.000°  β = …  γ = …  V = 366.1234 Å³"
 *  (with s.u.s when `su` is given, see latticeParamItems). */
export function latticeParamsText(lattice, su = null) {
  return latticeParamItems(lattice, su).join('  ');
}

/** A site's label: its element, or "Fe/Ni" for a mixed site, with the
 *  occupancy in parentheses when the site is not fully occupied. */
export function siteLabel(atom, element) {
  const species = Array.isArray(atom?.species) && atom.species.length ? atom.species : null;
  if (!species) return element ?? '?';
  const label = species.map((s) => s.element).join('/');
  const occ = species.reduce((sum, s) => sum + (Number.isFinite(s.occupancy) ? s.occupancy : 1), 0);
  return occ < 0.9999 || species.length > 1
    ? `${label} (${species.map((s) => num(s.occupancy ?? 1, 2)).join('/')})`
    : label;
}

/** A coordinate as the tables write it: 6 decimals, or with its s.u. */
export const coordText = (v, su) => withSu(v, su, 6);

/**
 * The atomic positions, one row per atom: index, site label, x y z — in the
 * structure's own fractional coordinates, or Cartesian Å when `cartesian`.
 * `su(atomIndex)` gives an atom's fractional-coordinate s.u.s (CIF errors,
 * model/cifErrors.js fracCoordinateSus) or null; a fractional row carries them
 * (`su`, written into the text with the values), a Cartesian one never does.
 * @param {any} structure
 * @param {boolean} [cartesian]
 * @param {{su?: ((atomIndex: number) => number[]|null) | null}} [opts]
 * @returns {{header: string, rows: {index: number, label: string, xyz: number[], su: number[]|null}[], text: string}}
 */
export function positionsTable(structure, cartesian = false, { su = null } = {}) {
  const rows = structure.atoms.map((atom, i) => {
    const frac = atom.position;
    const xyz = cartesian ? fracToCartPoint(frac, structure.lattice) : frac;
    return {
      index: i + 1, label: siteLabel(atom, structure.elements[i]), xyz: [...xyz],
      su: !cartesian && su ? su(i) : null,
    };
  });
  const header = `# ${cartesian ? 'Cartesian positions (Å)' : 'Fractional positions'}: index element x y z`;
  const text = [header, ...rows.map((r) => `${String(r.index).padStart(4)} ${r.label.padEnd(6)} ${r.xyz.map((v, k) => coordText(v, r.su?.[k]).padStart(12)).join(' ')}`)].join('\n');
  return { header, rows, text };
}

/**
 * Wyckoff positions as rows, one per crystallographic orbit: element, the
 * Wyckoff symbol (multiplicity in the analysed cell + letter), the site
 * symmetry and the representative's fractional coordinates. Built from either
 * the structure's active Wyckoff lock (ui/SymmetryEditModule.js orbitGroups)
 * or a raw moyo dataset whose per-atom `orbits`/`wyckoffs` arrays are
 * index-aligned with `structure.atoms`.
 * `repIndex` is the atom whose coordinates the row shows.
 * @returns {{spaceGroup: string, number: number | null, hallNumber: number | null,
 *            rows: {element: string, wyckoff: string, siteSymmetry: string, multiplicity: number, xyz: number[], repIndex: number, atomIndices: number[]}[]}}
 */
export function wyckoffRows(structure, { lock = null, dataset = null } = {}) {
  // moyo writes the HM symbol with spaces ("P m m m"); the Symmetry window
  // shows the usual unspaced form, so this does too.
  const compact = (symbol) => String(symbol ?? '?').replace(/\s+/g, '') || '?';
  if (lock?.mode === 'wyckoff' && Array.isArray(lock.orbitGroups)) {
    return {
      spaceGroup: compact(lock.spaceGroup),
      number: lock.number ?? null,
      hallNumber: lock.hallNumber ?? null,
      rows: lock.orbitGroups.map((g) => ({
        element: g.element,
        wyckoff: `${g.multiplicity}${g.wyckoff ?? '?'}`,
        siteSymmetry: g.siteSymmetry ?? '',
        multiplicity: g.multiplicity,
        xyz: [...structure.atoms[g.representativeIndex].position],
        repIndex: g.representativeIndex,
        atomIndices: [...g.atomIndices],
      })),
    };
  }
  if (!dataset) return { spaceGroup: '?', number: null, hallNumber: null, rows: [] };
  const orbitIds = dataset.orbits ?? structure.atoms.map((_, i) => i);
  const wyckoffs = dataset.wyckoffs ?? [];
  const symbols = dataset.site_symmetry_symbols ?? [];
  /** @type {Map<number, number[]>} */
  const grouped = new Map();
  orbitIds.forEach((orbitId, atomIndex) => {
    if (!grouped.has(orbitId)) grouped.set(orbitId, []);
    grouped.get(orbitId).push(atomIndex);
  });
  const rows = [...grouped.values()].map((atomIndices) => {
    const rep = atomIndices[0];
    return {
      element: structure.elements[rep],
      wyckoff: `${atomIndices.length}${wyckoffs[rep] ?? '?'}`,
      siteSymmetry: symbols[rep] ?? '',
      multiplicity: atomIndices.length,
      xyz: [...structure.atoms[rep].position],
      repIndex: rep,
      atomIndices,
    };
  });
  return { spaceGroup: compact(dataset.hm_symbol), number: dataset.number ?? null, hallNumber: dataset.hall_number ?? null, rows };
}

/** The Wyckoff rows as text: a space-group line, then one row per orbit —
 *  with the representative's coordinate s.u.s when `su` gives them (see
 *  positionsTable). */
export function wyckoffText(info, { su = null } = {}) {
  const head = `# Space group ${info.spaceGroup}${info.number ? ` (${info.number})` : ''}: element wyckoff site-symmetry x y z`;
  return [head, ...info.rows.map((r) => {
    const sus = su && Number.isInteger(r.repIndex) ? su(r.repIndex) : null;
    return `${r.element.padEnd(4)} ${r.wyckoff.padEnd(5)} ${(r.siteSymmetry || '-').padEnd(8)} ${r.xyz.map((v, k) => coordText(v, sus?.[k]).padStart(12)).join(' ')}`;
  })].join('\n');
}

/** Largest per-atom force magnitude (eV/Å) over a structure's forces, or NaN
 *  when there are none. */
function maxForceOf(structure) {
  const forces = structure?.forces;
  if (!Array.isArray(forces) || !forces.length) return NaN;
  let max = -Infinity;
  for (const f of forces) {
    const v = f?.vector ?? f;
    if (Array.isArray(v) && v.length >= 3) max = Math.max(max, Math.hypot(v[0], v[1], v[2]));
  }
  return max === -Infinity ? NaN : max;
}

/**
 * The scalar properties a structure carries, as display rows — only the ones
 * present: total and per-atom energy (eV), pressure (GPa, compression
 * positive: the plain trace/3 of the stored stress, see model/Stress.js — the
 * same number the Trajectory plot and the EFS readout show) and the largest
 * per-atom force (eV/Å). Empty when the structure has none.
 * @returns {{key: string, label: string, value: number, unit: string, digits: number}[]}
 */
export function scalarProperties(structure) {
  const rows = [];
  const n = structure?.atoms?.length ?? 0;
  if (Number.isFinite(structure?.energy)) {
    rows.push({ key: 'energy', label: 'Energy', value: structure.energy, unit: 'eV', digits: 6 });
    if (n > 0) rows.push({ key: 'energyPerAtom', label: 'Energy/atom', value: structure.energy / n, unit: 'eV', digits: 6 });
  }
  const pressure = pressureGPa(structure?.stress?.tensor);
  if (Number.isFinite(pressure)) rows.push({ key: 'pressure', label: 'Pressure', value: pressure, unit: 'GPa', digits: 4 });
  const maxForce = maxForceOf(structure);
  if (Number.isFinite(maxForce)) rows.push({ key: 'maxForce', label: 'Max force', value: maxForce, unit: 'eV/Å', digits: 4 });
  return rows;
}

/** The scalar properties as "Energy = -12.345678 eV" lines, one per row. */
export function scalarPropertiesText(structure) {
  return scalarProperties(structure)
    .map((r) => `${r.label} = ${num(r.value, r.digits)} ${r.unit}`).join('\n');
}

/**
 * The stored stress tensor in GPa (compression positive), three rows of three,
 * 4 decimals — '' when the structure carries no stress.
 */
export function stressTensorText(structure) {
  const t = tensorGPa(structure?.stress?.tensor);
  return t ? t.map((row) => row.map((v) => num(v, 4, 12)).join(' ')).join('\n') : '';
}

/** Everything the section shows, as one text for "Copy all" — with the CIF
 *  errors when given (`latticeSu`, `cellSu`, `su`: see latticeText,
 *  latticeParamItems, positionsTable) and the data's `source` ("VASP"). */
export function structureSummaryText(structure, {
  name = '', cartesian = false, wyckoff = null, latticeSu = null, cellSu = null, su = null, source = null,
} = {}) {
  // Where the energy, forces and stress came from (model/dataSource.js), first.
  const scalars = [source ? `Source: ${source}` : '', scalarPropertiesText(structure)].filter(Boolean).join('\n');
  const stress = stressTensorText(structure);
  const parts = [
    `# ${name || 'structure'}: ${structure.atoms.length} atoms`,
    ...(scalars ? [scalars, ''] : []),
    ...(stress ? ['# Stress tensor (GPa, compression positive)', stress, ''] : []),
    '# Lattice vectors (Å)', latticeText(structure.lattice, latticeSu), latticeParamsText(structure.lattice, cellSu),
    '', positionsTable(structure, cartesian, { su }).text,
  ];
  if (wyckoff?.rows?.length) parts.push('', wyckoffText(wyckoff, { su }));
  return `${parts.join('\n')}\n`;
}
