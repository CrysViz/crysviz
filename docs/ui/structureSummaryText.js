// Plain-text renderings of one structure for the Files window's "Structure
// info" section (ui/FileStructureSummary.js): the lattice, its parameters and
// volume, the atomic positions (fractional or Cartesian) and the Wyckoff
// positions — what the copy buttons put on the clipboard, and what the tests
// pin down. No DOM here.

import { latticeParameters, fracToCartPoint } from '../math/index.js';
import { stressMean } from '../atomistic/relaxer.js';

const num = (v, digits = 6, width = 0) => {
  const text = Number.isFinite(v) ? v.toFixed(digits) : 'nan';
  return width ? text.padStart(width) : text;
};

/** The three lattice vectors, one per line (Å, 6 decimals). */
export function latticeText(lattice) {
  return lattice.map((row) => row.map((v) => num(v, 6, 12)).join(' ')).join('\n');
}

/** "a = 5.4455 Å  b = …  c = …  α = 90.000°  β = …  γ = …  V = 366.1234 Å³". */
export function latticeParamsText(lattice) {
  const p = latticeParameters(lattice);
  return [
    `a = ${num(p.a, 4)} Å`, `b = ${num(p.b, 4)} Å`, `c = ${num(p.c, 4)} Å`,
    `α = ${num(p.alpha, 3)}°`, `β = ${num(p.beta, 3)}°`, `γ = ${num(p.gamma, 3)}°`,
    `V = ${num(p.volume, 4)} Å³`,
  ].join('  ');
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

/**
 * The atomic positions, one row per atom: index, site label, x y z — in the
 * structure's own fractional coordinates, or Cartesian Å when `cartesian`.
 * @returns {{header: string, rows: {index: number, label: string, xyz: number[]}[], text: string}}
 */
export function positionsTable(structure, cartesian = false) {
  const rows = structure.atoms.map((atom, i) => {
    const frac = atom.position;
    const xyz = cartesian ? fracToCartPoint(frac, structure.lattice) : frac;
    return { index: i + 1, label: siteLabel(atom, structure.elements[i]), xyz: [...xyz] };
  });
  const header = `# ${cartesian ? 'Cartesian positions (Å)' : 'Fractional positions'}: index element x y z`;
  const text = [header, ...rows.map((r) => `${String(r.index).padStart(4)} ${r.label.padEnd(6)} ${r.xyz.map((v) => num(v, 6, 12)).join(' ')}`)].join('\n');
  return { header, rows, text };
}

/**
 * Wyckoff positions as rows, one per crystallographic orbit: element, the
 * Wyckoff symbol (multiplicity in the analysed cell + letter), the site
 * symmetry and the representative's fractional coordinates. Built from either
 * the structure's active Wyckoff lock (ui/SymmetryEditModule.js orbitGroups)
 * or a raw moyo dataset whose per-atom `orbits`/`wyckoffs` arrays are
 * index-aligned with `structure.atoms`.
 * @returns {{spaceGroup: string, number: number | null, hallNumber: number | null,
 *            rows: {element: string, wyckoff: string, siteSymmetry: string, multiplicity: number, xyz: number[], atomIndices: number[]}[]}}
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
      atomIndices,
    };
  });
  return { spaceGroup: compact(dataset.hm_symbol), number: dataset.number ?? null, hallNumber: dataset.hall_number ?? null, rows };
}

/** The Wyckoff rows as text: a space-group line, then one row per orbit. */
export function wyckoffText(info) {
  const head = `# Space group ${info.spaceGroup}${info.number ? ` (${info.number})` : ''}: element wyckoff site-symmetry x y z`;
  return [head, ...info.rows.map((r) =>
    `${r.element.padEnd(4)} ${r.wyckoff.padEnd(5)} ${(r.siteSymmetry || '-').padEnd(8)} ${r.xyz.map((v) => num(v, 6, 12)).join(' ')}`)].join('\n');
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
 * present: total and per-atom energy (eV), hydrostatic pressure (stress
 * trace / 3, GPa, the Trajectory plot's convention) and the largest per-atom
 * force (eV/Å). Empty when the structure has none.
 * @returns {{key: string, label: string, value: number, unit: string, digits: number}[]}
 */
export function scalarProperties(structure) {
  const rows = [];
  const n = structure?.atoms?.length ?? 0;
  if (Number.isFinite(structure?.energy)) {
    rows.push({ key: 'energy', label: 'Energy', value: structure.energy, unit: 'eV', digits: 6 });
    if (n > 0) rows.push({ key: 'energyPerAtom', label: 'Energy/atom', value: structure.energy / n, unit: 'eV', digits: 6 });
  }
  const pressure = stressMean(structure?.stress?.tensor);
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

/** Everything the section shows, as one text for "Copy all". */
export function structureSummaryText(structure, { name = '', cartesian = false, wyckoff = null } = {}) {
  const scalars = scalarPropertiesText(structure);
  const parts = [
    `# ${name || 'structure'}: ${structure.atoms.length} atoms`,
    ...(scalars ? [scalars, ''] : []),
    '# Lattice vectors (Å)', latticeText(structure.lattice), latticeParamsText(structure.lattice),
    '', positionsTable(structure, cartesian).text,
  ];
  if (wyckoff?.rows?.length) parts.push('', wyckoffText(wyckoff));
  return `${parts.join('\n')}\n`;
}
