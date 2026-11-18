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

/** Below this squared distance two atoms are never bonded (BondsFracUpdateModule BOND_MIN_DIST_SQ). */
export const BOND_MIN_DISTANCE = 0.005;
/** A pair whose max cutoff is at or below this never bonds (buildBondObjects skips cutSq <= 1e-4). */
export const BOND_MAX_FLOOR = 0.01;

export const BOND_RULE = 'Atoms i and j of the pair\'s elements are bonded, across periodic images, when '
  + 'shown is true, max > 0.01 and max(min, 0.005) <= d <= max (d in Å). Hidden pairs never bond.';

const round = (value, digits = 4) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const elementOf = (structure, i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements?.[i] ?? '';

/** One element pair's cutoffs (general.bondLengths / bondVisibility keys are "A-B", sorted). */
export function pairCutoffs(lengths, visibility, e1, e2) {
  const key = e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`;
  return { min: lengths[key]?.min || 0, max: lengths[key]?.max || 0, shown: visibility[key] !== false };
}

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
      const { min, max, shown } = pairCutoffs(lengths, visibility, unique[a], unique[b]);
      pairs.push({ elements: [unique[a], unique[b]], min: round(min), max: round(max), shown });
    }
  }
  return { rule: BOND_RULE, pairs };
}

/** find bonds works on cells up to this many atoms (all pairs x images); bigger: export_structure. */
export const MAX_BOND_SEARCH_ATOMS = 3000;

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const norm = (u) => Math.hypot(u[0], u[1], u[2]);

/**
 * Every bond of the periodic structure under BOND_RULE (the get_bonding rule),
 * drawn or not, as [a, b, image, length] with a <= b: atom b's copy at its
 * stored fractional position + image (cell translation [i, j, k]) is bonded
 * to atom a. Each bond once.
 */
export function periodicBonds(structure, lengths, visibility) {
  const n = structure.atoms.length;
  if (n > MAX_BOND_SEARCH_ATOMS) {
    throw commandError('TOO_LARGE', `find bonds handles up to ${MAX_BOND_SEARCH_ATOMS} atoms; use export_structure and get_bonding`);
  }
  const L = structure.lattice;
  const elements = structure.atoms.map((_, i) => elementOf(structure, i));
  let maxCut = 0;
  for (const p of bondingTable(elements, lengths, visibility).pairs) {
    if (p.shown && p.max > BOND_MAX_FLOOR) maxCut = Math.max(maxCut, p.max);
  }
  if (!maxCut) return [];
  // Images within reach of the largest cutoff along each axis (perpendicular cell widths).
  const volume = Math.abs(L[0][0] * cross(L[1], L[2])[0] + L[0][1] * cross(L[1], L[2])[1] + L[0][2] * cross(L[1], L[2])[2]);
  const reach = [cross(L[1], L[2]), cross(L[2], L[0]), cross(L[0], L[1])]
    .map((c) => Math.ceil(maxCut / Math.max(volume / Math.max(norm(c), 1e-9), 1e-6)));
  const items = [];
  for (let a = 0; a < n; a++) {
    if (elements[a] === 'Va') continue;
    const fa = structure.atoms[a].position;
    for (let b = a; b < n; b++) {
      if (elements[b] === 'Va') continue;
      const rule = pairCutoffs(lengths, visibility, elements[a], elements[b]);
      if (!rule.shown || rule.max <= BOND_MAX_FLOOR) continue;
      const lo = Math.max(rule.min, BOND_MIN_DISTANCE);
      const fb = structure.atoms[b].position;
      for (let i = -reach[0]; i <= reach[0]; i++) for (let j = -reach[1]; j <= reach[1]; j++) for (let k = -reach[2]; k <= reach[2]; k++) {
        // An atom and its own copy: count +t, not also -t.
        if (a === b && (i < 0 || (i === 0 && (j < 0 || (j === 0 && k <= 0))))) continue;
        const f = [fb[0] - fa[0] + i, fb[1] - fa[1] + j, fb[2] - fa[2] + k];
        const d = Math.hypot(
          f[0] * L[0][0] + f[1] * L[1][0] + f[2] * L[2][0],
          f[0] * L[0][1] + f[1] * L[1][1] + f[2] * L[2][1],
          f[0] * L[0][2] + f[1] * L[1][2] + f[2] * L[2][2]);
        if (d >= lo && d <= rule.max) items.push([a, b, [i, j, k], round(d)]);
      }
    }
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
  bonds(structure, where, lengths = general.bondLengths || {}, visibility = general.bondVisibility || {}) {
    const pair = where.elements ? [...where.elements].sort().join('-') : null;
    const items = periodicBonds(structure, lengths, visibility).filter(([a, b, , length]) => {
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

function remember(structure, what, atoms, polyhedra = null) {
  const id = `s${nextSelection++}`;
  selections.set(id, { structure, what, atoms, polyhedra });
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
  /** @type {{items: any[], atoms: number[], polyhedra?: string[]}} */
  let found;
  let note;
  if (what === 'polyhedra') {
    const rows = polyhedraSummary(structure, where.type).filter((p) =>
      (where.center === undefined || p.centerElement === where.center)
      && (where.cn === undefined || p.vertexCount === where.cn));
    found = { items: rows, atoms: [...new Set(rows.flatMap((p) => [...(p.centerAtom !== undefined ? [p.centerAtom] : []), ...p.cornerAtoms]))] };
    // The drawn polyhedra (every periodic copy) behind these rows, so apply can colour them.
    found.polyhedra = (structure.polyhedra?.polyhedra || []).filter((p) =>
      (where.type === undefined || p.type === where.type)
      && (where.center === undefined || p.centerElement === where.center)
      && (where.cn === undefined || p.vertices.length === where.cn)).map((p) => p.key).filter(Boolean);
    if (!(structure.polyhedra?.polyhedra?.length)) note = 'No polyhedra are built: switch on Show Polyhedra first.';
  } else if (what === 'voids') {
    const minRadius = where.minRadius ?? 0.7;
    found = { items: voidSites(structure, minRadius), atoms: [] };
  } else {
    found = FINDERS[what](structure, where);
  }
  return {
    selection: remember(structure, what, found.atoms, found.polyhedra ?? null),
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

/** The atoms the user has selected in the window (source indices, sorted). */
export async function userSelection() {
  const { getSelectedAtoms } = await import('../ui/SelectAndHighlightModule.js');
  return [...new Set(getSelectedAtoms().map((atom) => atom.sourceIndex))]
    .filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
}

/** apply: act on atoms through the UI's own paths. */
export async function apply(args) {
  if (!args || typeof args !== 'object') throw commandError('INVALID_ARGS', 'apply requires an object');
  const { action } = args;
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  const highlight = () => import('../ui/SelectAndHighlightModule.js');
  // selection: "user" is whatever the user has selected in the window right now.
  if (args.selection === 'user') args = { ...args, selection: undefined, atoms: await userSelection() };
  if (action === 'color') {
    if (typeof args.value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(args.value)) {
      throw commandError('INVALID_ARGS', 'apply color needs value "#rrggbb"');
    }
    const hex = args.value.toLowerCase();
    // Every bond of one element pair, as the Bonds window's pair colour does.
    if (args.bondPair !== undefined) {
      if (!Array.isArray(args.bondPair) || args.bondPair.length !== 2 || !args.bondPair.every((e) => typeof e === 'string')) {
        throw commandError('INVALID_ARGS', 'apply.bondPair must be two element symbols, e.g. ["Ti", "O"]');
      }
      const pair = [...args.bondPair].sort().join('-');
      (await import('../ui/BondLengthPanel.js')).setBondPairColor(structure, pair, hex);
      return { action, bondPair: pair };
    }
    // A polyhedra selection colours the polyhedra themselves (target: "atoms" colours their atoms).
    const saved = args.selection !== undefined ? selections.get(args.selection) : null;
    if (saved?.polyhedra && args.target !== 'atoms') {
      if (saved.structure !== structure) throw commandError('SELECTION_STALE', `${args.selection} belongs to another structure; find again`);
      (await import('../render/PolyhedraModule.js')).setPolyhedronStyles(structure, saved.polyhedra, { color: hex });
      return { action, polyhedra: saved.polyhedra.length };
    }
  }
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
