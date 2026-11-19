// Query and action commands (registered in commands.js): find picks out atoms,
// bonds, polyhedra or voids and keeps them as a named selection; apply acts on
// a selection or on atom indices (highlight, select, colour, hide); get_bonding
// and export_structure give an outside script the structure file and the exact
// bond rule, so heavy analysis (rings, graphs) runs there and only atom
// indices come back. Every action reuses the UI's own path; the UI modules are
// imported on first use so this file stays importable in Node.

import { commandError, structureRevision } from './commands.js';
import { atomIdentity } from '../model/structureRevision.js';
import { fracToCartPoint } from '../math/index.js';
import { getActiveStructure, getContainerById, getContainerForStructure, getContainerId } from '../state/structures.js';
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
 * @returns {Array<[number, number, number[], number]>}
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
  /** @type {Array<[number, number, number[], number]>} */
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
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** Shortest periodic distance (Å) between fractional points p and q. */
export function periodicDistance(p, q, lattice) {
  const d = [0, 1, 2].map((k) => { const x = q[k] - p[k]; return x - Math.round(x); });
  let best = Infinity;
  // Neighbouring images too: in a skewed cell the rounded difference is not always the shortest.
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    best = Math.min(best, Math.hypot(...fracToCartPoint([d[0] + i, d[1] + j, d[2] + k], lattice)));
  }
  return best;
}

/** Is fractional x inside [lo, hi] along one axis, periodically (lo > hi wraps through 0)? */
const insideAxis = (x, lo, hi) => {
  const w = (v) => v - Math.floor(v);
  if (hi - lo >= 1) return true;
  const [a, b, v] = [w(lo), w(hi), w(x)];
  return a <= b ? v >= a - 1e-9 && v <= b + 1e-9 : v >= a - 1e-9 || v <= b + 1e-9;
};

/**
 * The atom-level part of where shared by every finder: element(s), indices,
 * a fractional box (frac: {min, max}, periodic) and a sphere (near: {point
 * (fractional) | atom, within Å}). Returns a predicate on atom index.
 */
export function atomFilter(structure, where) {
  const elements = asList(where.element ?? where.elements);
  const only = where.indices ? new Set(where.indices) : null;
  const box = where.frac;
  if (box !== undefined && !(isVec3(box?.min) && isVec3(box?.max))) {
    throw commandError('INVALID_ARGS', 'where.frac needs min and max, each [x, y, z] fractional');
  }
  const near = where.near;
  let centre = null;
  if (near !== undefined) {
    if (!near || typeof near !== 'object' || !(Number.isFinite(near.within) && near.within > 0)) {
      throw commandError('INVALID_ARGS', 'where.near needs within (Å) and point [x, y, z] (fractional) or atom (index)');
    }
    if (Number.isInteger(near.atom) && structure.atoms[near.atom]) centre = structure.atoms[near.atom].position;
    else if (isVec3(near.point)) centre = near.point;
    else throw commandError('INVALID_ARGS', 'where.near needs point [x, y, z] (fractional) or atom (an index)');
  }
  return (i) => {
    if (only && !only.has(i)) return false;
    if (elements && !elements.includes(elementOf(structure, i))) return false;
    const p = structure.atoms[i].position;
    if (box && ![0, 1, 2].every((k) => insideAxis(p[k], box.min[k], box.max[k]))) return false;
    if (centre && periodicDistance(centre, p, structure.lattice) > near.within) return false;
    return true;
  };
}

/** Pure filters for find; each returns { items, atoms } (atoms: indices apply acts on). */
export const FINDERS = {
  atoms(structure, where) {
    const keep = atomFilter(structure, where);
    const items = [];
    structure.atoms.forEach((atom, i) => {
      if (keep(i)) items.push([i, elementOf(structure, i), atom.position.map((x) => round(x, 5))]);
    });
    return { items, atoms: items.map((it) => it[0]) };
  },
  /**
   * Bonds of the full periodic graph. where.atoms (centre indices) gives each
   * centre's neighbours: items [centre, neighbour, image, length], the image
   * being the neighbour's cell offset as seen from the centre.
   */
  bonds(structure, where, lengths = general.bondLengths || {}, visibility = general.bondVisibility || {}) {
    const pair = where.elements ? [...where.elements].sort().join('-') : null;
    const keep = (a, b, length) => {
      if (pair && [elementOf(structure, a), elementOf(structure, b)].sort().join('-') !== pair) return false;
      if (where.minLength !== undefined && length < where.minLength) return false;
      if (where.maxLength !== undefined && length > where.maxLength) return false;
      return true;
    };
    const all = periodicBonds(structure, lengths, visibility);
    if (where.atoms !== undefined) {
      const centres = new Set(asList(where.atoms));
      /** @type {Array<[number, number, number[], number]>} */
      const items = [];
      for (const [a, b, image, length] of all) {
        if (!keep(a, b, length)) continue;
        if (centres.has(a)) items.push([a, b, image, length]);
        if (centres.has(b) && a !== b) items.push([b, a, image.map((t) => -t), length]);
        if (a === b && centres.has(a)) items.push([a, a, image.map((t) => -t), length]);
      }
      items.sort((p, q) => p[0] - q[0] || p[3] - q[3]);
      return { items, atoms: [...new Set(items.flatMap(([c, n]) => [c, n]))] };
    }
    const items = all.filter(([a, b, , length]) => keep(a, b, length));
    return { items, atoms: [...new Set(items.flatMap(([a, b]) => [a, b]))] };
  },
};

/** where.in / where.notIn: keep atoms that are in every named selection and in none of the others. */
function setFilter(structure, where) {
  const named = (ids) => (asList(ids) || []).map((id) => new Set(savedAtoms(structure, id)));
  const inside = named(where.in);
  const outside = named(where.notIn);
  return (i) => inside.every((s) => s.has(i)) && !outside.some((s) => s.has(i));
}

const selections = new Map();
let nextSelection = 1;
const MAX_SELECTIONS = 20;

function remember(structure, what, atoms, polyhedra = null) {
  const id = `s${nextSelection++}`;
  // Keyed on atom identity, not the revision: a selection of indices stays valid while the
  // same atoms sit at the same indices, whatever their elements or positions do.
  selections.set(id, { structure, identity: atomIdentity(structure), what, atoms, polyhedra });
  if (selections.size > MAX_SELECTIONS) selections.delete(selections.keys().next().value);
  return id;
}

/** A saved selection, refused when its structure is gone or has changed since find. */
function savedSelection(structure, id) {
  const saved = selections.get(id);
  if (!saved) throw commandError('SELECTION_NOT_FOUND', `No selection ${id}`);
  if (saved.structure !== structure) throw commandError('SELECTION_STALE', `${id} belongs to another structure; find again`);
  if (saved.identity !== atomIdentity(structure)) {
    throw commandError('SELECTION_STALE', `Atoms were added, removed or reordered since ${id} was found (${structure.atoms.length} atoms now); find again`);
  }
  return saved;
}

const savedAtoms = (structure, id) => savedSelection(structure, id).atoms;

/** fields: "indices" keeps a big answer small; groupBy: "element" counts and lists per element. */
function shapeOutput(structure, what, found, { fields, groupBy, limit }) {
  if (groupBy === 'element') {
    /** @type {Record<string, number[]>} */
    const groups = {};
    for (const i of found.atoms) (groups[elementOf(structure, i)] ??= []).push(i);
    return { groups: Object.fromEntries(Object.entries(groups).map(([el, atoms]) => [el, {
      count: atoms.length, atoms: atoms.slice(0, limit), ...(atoms.length > limit ? { truncated: true } : {}),
    }])) };
  }
  if (fields === 'indices') {
    return { atoms: found.atoms.slice(0, limit), ...(found.atoms.length > limit ? { truncated: true } : {}) };
  }
  return { items: found.items.slice(0, limit), ...(found.items.length > limit ? { truncated: true } : {}) };
}

/** The where keys each kind of find takes. An unknown key is an error, never ignored: a
 *  filter silently dropped answers a different question than the one asked. */
export const WHERE_KEYS = Object.freeze({
  atoms: ['element', 'elements', 'indices', 'frac', 'near', 'in', 'notIn'],
  bonds: ['elements', 'atoms', 'minLength', 'maxLength', 'in', 'notIn'],
  polyhedra: ['type', 'center', 'cn', 'in', 'notIn'],
  voids: ['minRadius'],
});

/** Refuse where keys that this kind of find does not take, naming the ones it does. */
export function checkWhere(what, where) {
  const unknown = Object.keys(where).filter((key) => !WHERE_KEYS[what].includes(key));
  if (!unknown.length) return;
  const hint = what === 'bonds' && unknown.some((key) => key === 'element')
    ? ' (for bonds of a pair give elements: ["A", "B"]; for one element use find atoms)' : '';
  throw commandError('INVALID_ARGS', `find ${what} where takes ${WHERE_KEYS[what].join(', ')}; not ${unknown.join(', ')}${hint}`);
}

/** find: run a finder on the active structure and keep its atoms as a selection. */
export async function find(args, { polyhedraSummary, voidSites }) {
  const { what, where = {}, limit = 100, fields, groupBy } = args || {};
  if (!['atoms', 'bonds', 'polyhedra', 'voids'].includes(what)) {
    throw commandError('INVALID_ARGS', 'find.what must be atoms, bonds, polyhedra or voids');
  }
  if (!where || typeof where !== 'object' || Array.isArray(where)) throw commandError('INVALID_ARGS', 'find.where must be an object');
  checkWhere(what, where);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw commandError('INVALID_ARGS', 'find.limit must be 1 to 5000');
  if (fields !== undefined && fields !== 'indices' && fields !== 'items') throw commandError('INVALID_ARGS', 'find.fields must be indices or items');
  if (groupBy !== undefined && groupBy !== 'element') throw commandError('INVALID_ARGS', 'find.groupBy must be element');
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  /** @type {{items: any[], atoms: number[], polyhedra?: string[], total?: number}} */
  let found;
  let note;
  if (what === 'polyhedra') {
    let source = structure;
    if (!(structure.polyhedra?.polyhedra?.length)) {
      // Not drawn: compute them as Show Polyhedra would, without drawing.
      const model = await (await import('../render/PolyhedraModule.js')).computePolyhedra(structure);
      source = { atoms: structure.atoms, elements: structure.elements, lattice: structure.lattice, polyhedra: model };
      note = 'Computed on demand: polyhedra are not shown, so apply can colour their atoms, not the polyhedra.';
    }
    const rows = polyhedraSummary(source, where.type).filter((p) =>
      (where.center === undefined || p.centerElement === where.center)
      && (where.cn === undefined || p.vertexCount === where.cn));
    found = { items: rows, atoms: [...new Set(rows.flatMap((p) => [...(p.centerAtom !== undefined ? [p.centerAtom] : []), ...p.cornerAtoms]))] };
    // The drawn polyhedra (every periodic copy) behind these rows, so apply can colour them.
    found.polyhedra = (structure.polyhedra?.polyhedra || []).filter((p) =>
      (where.type === undefined || p.type === where.type)
      && (where.center === undefined || p.centerElement === where.center)
      && (where.cn === undefined || p.vertices.length === where.cn)).map((p) => p.key).filter(Boolean);
  } else if (what === 'voids') {
    const minRadius = where.minRadius ?? 0.7;
    // Only the returned sites get their neighbours counted; count stays the full number.
    const { total, sites } = voidSites(structure, minRadius, limit);
    found = { items: sites, atoms: [], total };
  } else {
    found = FINDERS[what](structure, where);
  }
  if (where.in !== undefined || where.notIn !== undefined) {
    const keep = setFilter(structure, where);
    found = what === 'atoms'
      ? { items: found.items.filter((it) => keep(it[0])), atoms: found.atoms.filter(keep) }
      : what === 'bonds'
        ? (() => { const items = found.items.filter(([a, b]) => keep(a) && keep(b)); return { items, atoms: [...new Set(items.flatMap(([a, b]) => [a, b]))] }; })()
        : { ...found, atoms: found.atoms.filter(keep) };
  }
  return {
    // Voids are places, not atoms: nothing for apply to act on, so no selection.
    ...(what === 'voids' ? {} : { selection: remember(structure, what, found.atoms, found.polyhedra ?? null) }),
    revision: structureRevision(structure),
    count: found.total ?? found.items.length,
    atomCount: found.atoms.length,
    ...shapeOutput(structure, what, found, { fields, groupBy, limit }),
    ...(found.total > found.items.length ? { truncated: true } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * The atoms an atom-addressed command acts on (apply, remove_atoms,
 * set_element, move_atoms), one rule for all: exactly one of atoms (0-based
 * indices, in the order given) or selection (a find id, "user" for what the
 * user has selected in the window, or "all"). Indices without repeats.
 * @param {any} structure
 * @param {{atoms?: unknown, selection?: unknown}} args
 * @param {string} name the command, for the error text
 * @returns {Promise<number[]>}
 */
export async function resolveTargets(structure, args, name) {
  const hasAtoms = args.atoms !== undefined;
  const hasSelection = args.selection !== undefined;
  if (hasAtoms === hasSelection) {
    throw commandError('INVALID_ARGS', `${name} needs atoms (atom indices) or selection (a find id, "user" or "all"), `
      + `not ${hasAtoms ? 'both' : 'neither'}`);
  }
  let atoms = args.atoms;
  if (hasSelection) {
    if (typeof args.selection !== 'string') throw commandError('INVALID_ARGS', `${name}.selection must be a find id, "user" or "all"`);
    if (args.selection === 'user') atoms = await userSelection();
    else if (args.selection === 'all') atoms = structure.atoms.map((_, i) => i);
    else atoms = savedAtoms(structure, args.selection);
  }
  if (!Array.isArray(atoms)) throw commandError('INVALID_ARGS', `${name}.atoms must be a list of atom indices`);
  const n = structure.atoms.length;
  for (const i of atoms) {
    if (!Number.isInteger(i) || i < 0 || i >= n) throw commandError('INVALID_ARGS', `${name}.atoms: index ${i} is not 0 to ${n - 1}`);
  }
  return [...new Set(atoms)];
}

// How the user's selection last changed, from the app's own selection events:
// reason "pick" is a click on one atom (atom is that atom), others (marquee,
// focus-region, row-click, host, ...) select a group at once (atom null).
let lastPick = null;
let watchingSelection = null;

/** Start listening to selection changes (once); BrowserHost starts it in host windows. */
export function watchSelection() {
  watchingSelection ??= import('../ui/SelectAndHighlightModule.js').then(({ subscribeToAtomSelection }) => {
    subscribeToAtomSelection(({ event }) => {
      const atom = event?.atom?.sourceIndex;
      lastPick = { by: event?.reason ?? null, atom: Number.isInteger(atom) ? atom : null };
    });
  }).catch(() => { watchingSelection = null; });
  return watchingSelection;
}

/** {by, atom} for the selection as it is now, or null when nothing is known. */
export async function selectionOrigin() {
  await watchSelection();
  return lastPick;
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
  const hex = typeof args.color === 'string' ? args.color.toLowerCase() : null;
  if (action === 'color' && (!hex || !/^#[0-9a-f]{6}$/.test(hex))) {
    throw commandError('INVALID_ARGS', 'apply color needs color "#rrggbb"');
  }
  if (action !== 'color' && args.color !== undefined) throw commandError('INVALID_ARGS', 'apply.color goes with action color');
  // Every bond of one element pair, as the Bonds window's pair colour does.
  if (args.bondPair !== undefined) {
    if (action !== 'color') throw commandError('INVALID_ARGS', 'apply.bondPair goes with action color');
    if (!Array.isArray(args.bondPair) || args.bondPair.length !== 2 || !args.bondPair.every((e) => typeof e === 'string')) {
      throw commandError('INVALID_ARGS', 'apply.bondPair must be two element symbols, e.g. ["Ti", "O"]');
    }
    const pair = [...args.bondPair].sort().join('-');
    (await import('../ui/BondLengthPanel.js')).setBondPairColor(structure, pair, hex);
    return { action, kind: 'bonds', bondPair: pair };
  }
  if (action === 'clear') {
    // The selection is the user's as much as ours: clear it only when asked.
    const what = args.what ?? 'highlight';
    if (what !== 'highlight' && what !== 'selection') throw commandError('INVALID_ARGS', 'apply clear what must be highlight or selection');
    const { clearHighlightAtom, selectAtomsByInstances } = await highlight();
    if (what === 'highlight') {
      clearHighlightAtom();
      return { action, what };
    }
    const had = (await userSelection()).length;
    selectAtomsByInstances([]);
    return { action, what, clearedUserSelection: had };
  }
  if (args.what !== undefined) throw commandError('INVALID_ARGS', 'apply.what goes with action clear');
  // A drawn polyhedra selection's color colours the polyhedra themselves; for
  // their atoms, find atoms where {in: <that selection>} and colour those.
  const saved = action === 'color' && typeof args.selection === 'string' && !['user', 'all'].includes(args.selection)
    ? savedSelection(structure, args.selection) : null;
  if (saved?.polyhedra?.length) {
    (await import('../render/PolyhedraModule.js')).setPolyhedronStyles(structure, saved.polyhedra, { color: hex });
    return { action, kind: 'polyhedra', count: saved.polyhedra.length };
  }
  // reset_color on selection "all" is the Atoms tab's Reset Colors (atoms, bonds, polyhedra, arrows).
  if (action === 'reset_color' && args.selection === 'all') {
    (await import('../ui/StructureInfoPanel/General.js')).resetColors(structure);
    return { action, kind: 'structure', count: structure.atoms.length };
  }
  const atoms = await resolveTargets(structure, args, 'apply');
  if (action === 'highlight') {
    (await highlight()).highlightAtomsIn3D(atoms);
  } else if (action === 'select') {
    // Selecting replaces what the user had selected: say so, with what it was.
    const before = await userSelection();
    const instances = atoms.flatMap((i) => structure.atomImages?.[i] ?? [i]);
    (await highlight()).selectAtomsByInstances(instances, { reason: 'host' });
    const lost = before.filter((i) => !atoms.includes(i));
    if (lost.length) return { action, kind: 'atoms', count: atoms.length, replacedUserSelection: before.slice(0, 500) };
  } else if (action === 'color') {
    (await import('../ui/StructureInfoPanel/SelectionActionBar.js')).colorSourceAtoms(atoms, hex);
  } else if (action === 'reset_color') {
    (await import('../ui/StructureInfoPanel/SelectionActionBar.js')).resetSourceAtomColors(atoms);
  } else if (action === 'hide' || action === 'show') {
    const { commitHideRestore } = await import('../ui/SceneInteraction.js');
    if (action === 'hide') commitHideRestore(atoms, []);
    else commitHideRestore([], atoms);
  } else {
    throw commandError('INVALID_ARGS', 'apply.action must be highlight, select, clear, color, reset_color, hide or show');
  }
  return { action, kind: 'atoms', count: atoms.length };
}

/** get_bonding for the active structure. */
export function getBonding() {
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  return bondingTable(structure.elements || [], general.bondLengths || {}, general.bondVisibility || {});
}

/** The frames of a row to export: "all" or a list of frame indices. */
export function frameIndices(count, frames) {
  if (frames === undefined || frames === 'all') return [...Array(count).keys()];
  if (!Array.isArray(frames) || !frames.length) throw commandError('INVALID_ARGS', 'export_structure.frames must be "all" or a list of frame indices');
  for (const i of frames) {
    if (!Number.isInteger(i) || i < 0 || i >= count) throw commandError('INVALID_ARGS', `export_structure.frames: ${i} is not 0 to ${count - 1}`);
  }
  return frames;
}

/**
 * export_structure's browser half: the file's text and how its atoms map back.
 * cif and poscar write one frame through the Save window's writers (cif keeps
 * partial occupancy; poscar groups atoms by element, hence order); extxyz
 * writes frames (all of the row by default) for scripts. structure and frame
 * pick a row and frame other than the one on show, without selecting it.
 */
export async function exportStructure(args) {
  const format = args?.format;
  if (!['cif', 'poscar', 'extxyz'].includes(format)) throw commandError('INVALID_ARGS', 'export_structure.format must be cif, poscar or extxyz');
  const active = getActiveStructure();
  let container = active ? getContainerForStructure(active) : null;
  if (args.structure !== undefined) {
    container = getContainerById(args.structure);
    if (!container) throw commandError('STRUCTURE_NOT_FOUND', `No structure ${args.structure}; get_state include structures lists them`);
  }
  if (!container && !active) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  const count = container ? (container.frameCount ?? container.structures.length) : 1;
  const shownFrame = container && active ? container.structures.indexOf(active) : -1;
  // The frame on show is the live structure; any other is read detached, never selected.
  const frameAt = async (i) => (i === shownFrame ? active : container ? await (container.frameAtDetached?.(i) ?? container.structures[i]) : active);
  const base = { format, structure: container ? getContainerId(container) : null, name: container ? String(container.fileName) : null };
  if (format === 'extxyz') {
    if (args.frames !== undefined && args.frame !== undefined) throw commandError('INVALID_ARGS', 'export_structure takes frames or frame, not both');
    const indices = frameIndices(count, args.frame !== undefined ? [args.frame] : args.frames);
    const steps = container?.plotSeries?.step;
    const frames = [];
    for (const i of indices) {
      const frame = await frameAt(i);
      if (!frame) continue;
      frames.push({
        lattice: frame.periodic === false ? null : frame.lattice,
        positions: frame.atoms.map((a) => a.position),
        elements: frame.atoms.map((a, k) => a.getRepresentativeElement?.() ?? frame.elements[k]),
        energy: frame.energy,
        step: Number.isInteger(steps?.[i]) ? steps[i] : undefined,
      });
    }
    const { writeExtXYZ } = await import('../io/WriteExtXYZ.js');
    // extxyz keeps the atom order (one line per atom): no order map needed.
    return { ...base, text: writeExtXYZ(frames), frames: frames.length, atomCount: frames[0]?.positions.length ?? 0, sameOrder: true };
  }
  if (args.frames !== undefined) throw commandError('INVALID_ARGS', 'export_structure.frames is for extxyz; cif and poscar write one frame (frame)');
  const frameIndex = args.frame ?? (shownFrame >= 0 ? shownFrame : 0);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= count) {
    throw commandError('INVALID_ARGS', `export_structure.frame must be 0 to ${count - 1}`);
  }
  const structure = await frameAt(frameIndex);
  const save = await import('../ui/SavePanel.js');
  const name = container ? String(container.fileName).replace(/\.[^.]+$/, '') : undefined;
  const { text, order } = format === 'cif' ? save.cifExport(structure, name) : save.poscarExport(structure);
  const sameOrder = order.every((atom, row) => atom === row);
  return {
    ...base,
    text,
    frames: 1,
    // Atoms written: one per line, so a mixed CIF site counts once per species (order says which).
    atomCount: order.length,
    sameOrder,
    ...(sameOrder ? {} : { order }),
    // POSCAR writes a partly occupied site as a whole atom of its species.
    ...(format === 'poscar' && save.poscarLosesOccupancy(structure) ? { warning: 'Partial occupancies are lost in POSCAR; use cif to keep them.' } : {}),
  };
}
