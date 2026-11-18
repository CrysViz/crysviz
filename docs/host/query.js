// Query and action commands (registered in commands.js): find picks out atoms,
// bonds, polyhedra or voids and keeps them as a named selection; apply acts on
// a selection or on atom indices (highlight, select, colour, hide); get_bonding
// and export_structure give an outside script the structure file and the exact
// bond rule, so heavy analysis (rings, graphs) runs there and only atom
// indices come back. Every action reuses the UI's own path; the UI modules are
// imported on first use so this file stays importable in Node.

import { commandError } from './commands.js';
import { getActiveStructure } from '../state/structures.js';
import { general } from '../state/store.js';
import { cartToFractional } from '../math/index.js';

/** Below this squared distance two atoms are never bonded (BondsFracUpdateModule BOND_MIN_DIST_SQ). */
export const BOND_MIN_DISTANCE = 0.005;
/** A pair whose max cutoff is at or below this never bonds (buildBondObjects skips cutSq <= 1e-4). */
export const BOND_MAX_FLOOR = 0.01;

export const BOND_RULE = 'Atoms i and j of the pair\'s elements are bonded, across periodic images, when '
  + 'shown is true, max > 0.01 and max(min, 0.005) <= d <= max (d in Å). Hidden pairs never bond.';

const round = (value, digits = 4) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const elementOf = (structure, i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements?.[i] ?? '';

/**
 * get_bonding: the bond cutoffs of every element pair present (vacancies left out).
 * @param {string[]} elements the structure's elements
 * @param {Record<string, {min?: number, max?: number}>} lengths general.bondLengths
 * @param {Record<string, boolean>} visibility general.bondVisibility
 */
export function bondingTable(elements, lengths, visibility) {
  const unique = [...new Set(elements)].filter((e) => e && e !== 'Va').sort();
  const pairs = [];
  for (let a = 0; a < unique.length; a++) {
    for (let b = a; b < unique.length; b++) {
      const key = `${unique[a]}-${unique[b]}`;
      pairs.push({
        elements: [unique[a], unique[b]],
        min: round(lengths[key]?.min || 0),
        max: round(lengths[key]?.max || 0),
        shown: visibility[key] !== false,
      });
    }
  }
  return { rule: BOND_RULE, pairs };
}

/**
 * The drawn bonds of `structure` as [a, b, image, length]: atom b's image
 * [i, j, k] is the cell translation from b's stored fractional position to the
 * bonded copy, relative to a. A bond drawn more than once (at several periodic
 * copies) is listed once.
 */
export function bondItems(structure) {
  const wrapped = structure.periodic?.visibleWrapped;
  const cart = wrapped?.cart;
  const seen = new Set();
  const items = [];
  for (const bond of structure.bonds || []) {
    let a = bond.srcA, b = bond.srcB;
    const pa = cart?.[bond.indexA], pb = cart?.[bond.indexB];
    if (a < 0 || b < 0 || !pa || !pb) continue;
    const d = cartToFractional([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], structure.lattice);
    const fa = structure.atoms[a].position, fb = structure.atoms[b].position;
    let image = [0, 1, 2].map((k) => Math.round(d[k] - (fb[k] - fa[k])) || 0);
    if (b < a || (a === b && image.find((x) => x !== 0) < 0)) {
      [a, b] = [b, a];
      image = image.map((x) => -x || 0);
    }
    const key = `${a},${b},${image.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push([a, b, image, round(bond.dist)]);
  }
  return items;
}

const asList = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** Pure filters for find; each returns { items, atoms } (atoms: indices apply acts on). */
export const FINDERS = {
  atoms(structure, where) {
    const elements = asList(where.element ?? where.elements);
    const only = where.indices ? new Set(where.indices) : null;
    const items = [];
    structure.atoms.forEach((atom, i) => {
      if (only && !only.has(i)) return;
      const el = elementOf(structure, i);
      if (elements && !elements.includes(el)) return;
      items.push([i, el, atom.position.map((x) => round(x, 5))]);
    });
    return { items, atoms: items.map((it) => it[0]) };
  },
  bonds(structure, where) {
    const pair = where.elements ? [...where.elements].sort().join('-') : null;
    const items = bondItems(structure).filter(([a, b, , length]) => {
      if (pair && [elementOf(structure, a), elementOf(structure, b)].sort().join('-') !== pair) return false;
      if (where.minLength !== undefined && length < where.minLength) return false;
      if (where.maxLength !== undefined && length > where.maxLength) return false;
      return true;
    });
    return { items, atoms: [...new Set(items.flatMap(([a, b]) => [a, b]))] };
  },
};

const selections = new Map();
let nextSelection = 1;
const MAX_SELECTIONS = 20;

function remember(structure, what, atoms) {
  const id = `s${nextSelection++}`;
  selections.set(id, { structure, what, atoms });
  if (selections.size > MAX_SELECTIONS) selections.delete(selections.keys().next().value);
  return id;
}

/** find: run a finder on the active structure and keep its atoms as a selection. */
export async function find(args, { polyhedraSummary, voidSites }) {
  const { what, where = {}, limit = 100 } = args || {};
  if (!['atoms', 'bonds', 'polyhedra', 'voids'].includes(what)) {
    throw commandError('INVALID_ARGS', 'find.what must be atoms, bonds, polyhedra or voids');
  }
  if (!where || typeof where !== 'object' || Array.isArray(where)) throw commandError('INVALID_ARGS', 'find.where must be an object');
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw commandError('INVALID_ARGS', 'find.limit must be 1 to 5000');
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  let found;
  let note;
  if (what === 'polyhedra') {
    const rows = polyhedraSummary(structure, where.type).filter((p) =>
      (where.center === undefined || p.centerElement === where.center)
      && (where.cn === undefined || p.vertexCount === where.cn));
    found = { items: rows, atoms: [...new Set(rows.flatMap((p) => [...(p.centerAtom !== undefined ? [p.centerAtom] : []), ...p.cornerAtoms]))] };
    if (!(structure.polyhedra?.polyhedra?.length)) note = 'No polyhedra are built: switch on Show Polyhedra first.';
  } else if (what === 'voids') {
    const minRadius = where.minRadius ?? 0.7;
    found = { items: voidSites(structure, minRadius), atoms: [] };
  } else {
    found = FINDERS[what](structure, where);
    if (what === 'bonds') {
      note = structure.bonds?.length
        ? 'Drawn bonds only: bonds across the cell edge appear when their periodic copies are drawn. For the full periodic graph use export_structure and get_bonding.'
        : 'No bonds are drawn: switch on Show Bonds first, or use export_structure and get_bonding.';
    }
  }
  return {
    selection: remember(structure, what, found.atoms),
    count: found.items.length,
    atomCount: found.atoms.length,
    items: found.items.slice(0, limit),
    ...(found.items.length > limit ? { truncated: true } : {}),
    ...(note ? { note } : {}),
  };
}

/** The atom indices apply acts on: a selection's atoms, or a list given directly. */
export function applyTargets(structure, args) {
  let atoms = args.atoms;
  if (args.selection !== undefined) {
    const saved = selections.get(args.selection);
    if (!saved) throw commandError('SELECTION_NOT_FOUND', `No selection ${args.selection}`);
    if (saved.structure !== structure) throw commandError('SELECTION_STALE', `${args.selection} belongs to another structure; find again`);
    atoms = saved.atoms;
  }
  if (!Array.isArray(atoms)) throw commandError('INVALID_ARGS', 'apply needs selection or atoms');
  const n = structure.atoms.length;
  for (const i of atoms) {
    if (!Number.isInteger(i) || i < 0 || i >= n) throw commandError('INVALID_ARGS', `atom index ${i} is not 0 to ${n - 1}`);
  }
  return [...new Set(atoms)];
}

/** apply: act on atoms through the UI's own paths. */
export async function apply(args) {
  if (!args || typeof args !== 'object') throw commandError('INVALID_ARGS', 'apply requires an object');
  const { action } = args;
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  const highlight = () => import('../ui/SelectAndHighlightModule.js');
  if (action === 'clear') {
    const { clearHighlightAtom, selectAtomsByInstances } = await highlight();
    clearHighlightAtom();
    selectAtomsByInstances([]);
    return { action, atoms: 0 };
  }
  const atoms = applyTargets(structure, args);
  if (action === 'highlight') {
    (await highlight()).highlightAtomsIn3D(atoms);
  } else if (action === 'select') {
    const instances = atoms.flatMap((i) => structure.atomImages?.[i] ?? [i]);
    (await highlight()).selectAtomsByInstances(instances, { reason: 'host' });
  } else if (action === 'color') {
    if (typeof args.value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(args.value)) {
      throw commandError('INVALID_ARGS', 'apply color needs value "#rrggbb"');
    }
    (await import('../ui/StructureInfoPanel/SelectionActionBar.js')).colorSourceAtoms(atoms, args.value.toLowerCase());
  } else if (action === 'hide' || action === 'show') {
    const { commitHideRestore } = await import('../ui/SceneInteraction.js');
    if (action === 'hide') commitHideRestore(atoms, []);
    else commitHideRestore([], atoms);
  } else {
    throw commandError('INVALID_ARGS', 'apply.action must be highlight, select, clear, color, hide or show');
  }
  return { action, atoms: atoms.length };
}

/** get_bonding for the active structure. */
export function getBonding() {
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  return bondingTable(structure.elements || [], general.bondLengths || {}, general.bondVisibility || {});
}

/** export_structure's browser half: the Save window's writer text and its atom order. */
export async function exportStructure(args) {
  const format = args?.format;
  if (format !== 'cif' && format !== 'poscar') throw commandError('INVALID_ARGS', 'export_structure.format must be cif or poscar');
  if (!getActiveStructure()) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  const save = await import('../ui/SavePanel.js');
  const { text, order } = format === 'cif' ? save.cifExport() : save.poscarExport();
  const sameOrder = order.every((atom, row) => atom === row);
  return {
    format,
    text,
    rows: order.length,
    sameOrder,
    ...(sameOrder ? {} : { order }),
    // POSCAR writes a partly occupied site as a whole atom of its species.
    ...(format === 'poscar' && save.poscarLosesOccupancy() ? { warning: 'Partial occupancies are lost in POSCAR; use cif to keep them.' } : {}),
  };
}
