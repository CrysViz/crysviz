// CommitAtoms.js
//
// The ways an edited atom list ends up in the app's state: applied to the
// currently-loaded Structure (Modify Structure), or used to build a brand-new
// Structure that gets registered as its own file-browser row (Add Structure).
// Both paths are pulled out here, decoupled from any particular panel's UI, so
// the two structure editors and (later) a symmetry/Wyckoff generator can all
// call the same commit logic after running AtomCollisionCheck.js.

import { Atom, Structure, StructureContainer } from '../../model/index.js';
import { fileBrowser, structureShip } from '../../state/store.js';
import { createRow, selectLastAddedRow } from '../FileBrowswerPanel.js';
import { generateID } from '../../utils/index.js';
import { recenterCamera } from '../WindowAndSceneControls.js';
import { mergeCoLocatedAtoms, sameSite, SITE_TOLERANCE } from '../../io/cif/site_grouping.js';
import { addVacancyMarker, VACANCY_SYMBOLS } from '../../render/VacancyMarkerModule.js';
import { getElementDefaultColor } from '../../defaults/color_texture_defaults.js';

// Parse a "#rrggbb" string to a numeric color, or undefined (=> element default).
export function parseColorHexToInt(hex) {
  if (typeof hex !== 'string') return undefined;
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
  return parseInt(h, 16);
}

// Push new atoms (fractional x/y/z inputs, used as-is) into an already-loaded
// Structure. Pushes onto the parallel atoms/elements arrays and recomputes
// uniqueElements. Also records each real atom's uuid onto
// structure._sessionAddedAtoms — the "Added this session" list in
// AddAtomModule.js reads that to offer a per-atom undo without the user
// having to hunt for it in the full atom list. Caller is responsible for
// refreshing bond controls and re-rendering (createBondLengthControls() +
// updateVisualization({ reRenderAtoms:true, reRenderBonds:true})).
export function addAtomsToExistingStructure(structure, atomsToAdd) {
  if (!structure._sessionAddedAtoms) structure._sessionAddedAtoms = [];
  for (const a of atomsToAdd) {
    // "Va" is not an element — it is an annotation. Routing it here keeps it
    // out of structure.atoms/elements entirely, which is what lets bonding,
    // polyhedra, symmetry and the formula stay unaware of it. It is also the
    // only way to express a fully vacant site, which occupancy cannot: a site
    // with no occupants simply is not in the file.
    if (VACANCY_SYMBOLS.has(String(a.element).trim())) {
      addVacancyMarker({
        position: [a.x, a.y, a.z],
        color: parseColorHexToInt(a.color),
        oxidationState: a.oxidationState ?? null,
      }, structure);
      continue;
    }
    const uuid = generateID([a.element]);
    structure.atoms.push(new Atom({
      position: [a.x, a.y, a.z],
      element: a.element,
      occupancy: a.occupancy ?? 1,
      color: parseColorHexToInt(a.color),
      uuid,
    }));
    structure.elements.push(a.element);
    structure._sessionAddedAtoms.push({ uuid, element: a.element });
  }
  structure.uniqueElements = [...new Set(structure.elements)];
  // Two rows typed at the same position with occupancies summing to at most 1
  // are one disordered site, exactly as they would be in a CIF — merge them so
  // they render as a single pie-wedge sphere rather than as coincident atoms.
  mergeCoLocatedAtoms(structure);
  structure._hasFractionalOccupancy = undefined;
}

// Undo one addAtomsToExistingStructure() addition, looked up by the uuid
// recorded in structure._sessionAddedAtoms. Returns false (no-op) if that
// uuid isn't a real atom right now — e.g. it was already removed, or merged
// into a sibling site by mergeCoLocatedAtoms and no longer has its own
// entry — so the caller can skip its re-render.
export function removeSessionAddedAtom(structure, uuid) {
  const index = structure.atoms.findIndex((a) => a.uuid === uuid);
  if (index === -1) return false;
  structure.atoms.splice(index, 1);
  structure.elements.splice(index, 1);
  structure.uniqueElements = [...new Set(structure.elements)];
  structure._hasFractionalOccupancy = undefined;
  if (structure._sessionAddedAtoms) {
    structure._sessionAddedAtoms = structure._sessionAddedAtoms.filter((e) => e.uuid !== uuid);
  }
  // Same reasoning as applyStructureEdits below: a Wyckoff lock's
  // orbitGroups store raw atom indices, meaningless once an atom is removed.
  if (structure.symmetry?.mode === 'wyckoff') structure.symmetry = null;
  return true;
}

// Apply one round of edits from the Modify Structure panel's atom table.
//
// `atoms` is the FINAL atom list in table order: an entry with a uuid is the
// existing atom of that uuid (possibly moved/recoloured/re-elemented), an
// entry without one is new, and any atom of `structure` missing from the list
// is deleted. Rebuilding the arrays from the table beats replaying individual
// add/move/remove operations — every atom-indexed thing in the app
// (atomImages, bonds, selection) is derived from these arrays anyway, and a
// rebuild can't drift out of order the way an operation replay can.
//
// Caller re-renders (createBondLengthControls() + updateVisualization({
// reRenderAtoms:true, reRenderBonds:true, reRenderComposition:"open" })).
// Returns { added, removed } counts.
/**
 * @param {any} structure
 * @param {{atoms: Array<{uuid: string|null, element: string, x: number, y: number, z: number, occupancy?: number, color?: string}>, lattice?: number[][]}} edits
 */
export function applyStructureEdits(structure, { atoms, lattice }) {
  const byUuid = new Map(structure.atoms.map((atom) => [atom.uuid, atom]));

  // The table carries one row per SPECIES, so several rows can describe one
  // site (a half-Na/half-K site is two rows sharing a position). Rows of a site
  // share a base uuid, so regroup by that first — otherwise every commit would
  // split a mixed site into coincident single-species atoms and the disorder
  // would be lost on the first keystroke.
  const uuidGroups = [];
  const groupByBase = new Map();
  for (const entry of atoms) {
    const base = typeof entry.uuid === 'string' ? entry.uuid.split('#')[0] : null;
    const key = base ?? `__new_${uuidGroups.length}`;
    let group = groupByBase.get(key);
    if (!group) {
      group = { base, entries: [] };
      groupByBase.set(key, group);
      uuidGroups.push(group);
    }
    group.entries.push(entry);
  }

  // Second, cluster those uuid-groups by POSITION: a row added at the exact
  // spot of an existing (possibly just edited to partial occupancy) site is
  // the same disorder statement as typing it as a second species on that row
  // would have been, and must become one site rather than a coincident
  // atom-plus-implicit-vacancy pair. Mirrors mergeCoLocatedAtoms's rule for
  // the Add Atom panel: merge only while it would not over-fill the site.
  const clusters = [];
  for (const group of uuidGroups) {
    const first = group.entries[0];
    const pos = [first.x, first.y, first.z];
    const occ = group.entries.reduce((sum, e) => sum + (e.occupancy ?? 1), 0);
    const host = clusters.find((c) =>
      sameSite(c.position, pos, SITE_TOLERANCE) && (c.occupancy + occ) <= 1 + 1e-3);
    if (host) {
      host.occupancy += occ;
      host.groups.push(group);
    } else {
      clusters.push({ position: pos, occupancy: occ, groups: [group] });
    }
  }

  const nextAtoms = [];
  const nextElements = [];
  const keptUuids = new Set();

  for (const cluster of clusters) {
    // Prefer an EXISTING atom's identity so its styling (user colour, opacity,
    // radius, cut-plane immunity) survives — including when a site absorbs a
    // newly-added row and gains a second species.
    const existingGroup = cluster.groups.find((g) => g.base && byUuid.has(g.base));
    const existing = existingGroup ? byUuid.get(existingGroup.base) : null;
    const first = cluster.groups[0].entries[0];

    const species = cluster.groups.flatMap((group) => group.entries.map((e) => {
      // Each row of a multi-species site shows and edits that ONE species' own
      // colour (tableRowColor() in StructureEditorPanel.js) — the single-
      // species branch below that writes atom.userColor is deliberately gated
      // off for species.length > 1 (see its own comment), so resolving each
      // species' colour here is the only place a disordered site's per-
      // species colour can be picked up at all. Same "only write when it
      // actually differs from what's already there" rule as that branch,
      // just checked per species instead of once for the whole atom.
      const existingSp = existing?.species?.find((s) => s.element === e.element);
      const currentHex = colorToHex(existingSp?.color ?? getElementDefaultColor(e.element));
      const color = e.color && e.color.toLowerCase() !== currentHex.toLowerCase()
        ? parseColorHexToInt(e.color)
        : (existingSp?.color ?? null);
      return { element: e.element, occupancy: e.occupancy ?? 1, oxidationState: null, color };
    }));

    // Colour deliberately excluded here: a colour-only change must still
    // reuse the existing atom (below) rather than reconstruct a new one, so
    // opacity/radius/immunity survive it the same as any other edit.
    const sameSpeciesShape = existing
      && existing.species.length === species.length
      && existing.species.every((s, i) =>
        s.element === species[i].element
        && Math.abs(s.occupancy - species[i].occupancy) < 1e-6);

    let atom;
    if (existing && sameSpeciesShape) {
      atom = existing;
      // Species identity/occupancy are already right; sync just the colour,
      // since this branch never gets `species` (the freshly resolved copy)
      // applied any other way.
      species.forEach((sp, i) => { atom.species[i].color = sp.color; });
    } else if (existing) {
      atom = new Atom({
        position: existing.position,
        element: species[0].element,
        species,
        uuid: existing.uuid,
      });
    } else {
      atom = new Atom({
        position: [first.x, first.y, first.z],
        element: species[0].element,
        species,
        color: parseColorHexToInt(first.color),
        // Honour a uuid the table already assigned to a new row: the live
        // Modify editor re-runs this on every keystroke, so a stable uuid is
        // what keeps a just-added atom the SAME atom across edits (and lets
        // the New/Removed diff tell it from the originals).
        uuid: existingGroup?.base || generateID([species[0].element]),
      });
    }

    atom.position = [first.x, first.y, first.z];
    // Only write the colour when the user actually picked a different one,
    // and only for an ORDERED site (one species, no ambiguity about which
    // row "is" the atom's colour). A disordered site's rows each show their
    // OWN species' colour (tableRowColor() in StructureEditorPanel.js), which
    // will almost always differ from the atom's plain, non-species-aware
    // .color/.userColor — comparing them here would stomp atom.userColor
    // with whichever species happens to be first in the array on every
    // commit (this function reruns on every keystroke, for every row, not
    // just the one edited), short-circuiting getRepresentativeColor() back to
    // "always the first species' colour" regardless of which is actually
    // representative. Per-species colour edits already have their own direct
    // path (setSpeciesColorBulk), so this block has nothing to do for a
    // disordered atom.
    if (species.length === 1 && first.color && first.color.toLowerCase() !== colorToHex(atom.getColor()).toLowerCase()) {
      atom.userColor = first.color;
      atom.setColor(first.color);
    }

    // Every uuid this cluster consumed is accounted for, even one merged into
    // a sibling's atom rather than kept as its own — it was not deleted, its
    // data just now lives on a shared site.
    for (const g of cluster.groups) if (g.base) keptUuids.add(g.base);

    nextAtoms.push(atom);
    nextElements.push(atom.getRepresentativeElement());
  }

  const removed = structure.atoms.length - keptUuids.size;
  // A cluster counts as "added" only when none of its uuid-groups came from a
  // pre-existing atom — a cluster that absorbed a new row onto an existing
  // site is a modification, not an addition.
  const added = clusters.filter((c) => !c.groups.some((g) => g.base && byUuid.has(g.base))).length;

  structure.atoms = nextAtoms;
  structure.elements = nextElements;
  structure.uniqueElements = [...new Set(structure.elements)];
  // Occupancy may have changed, so the gating flag has to be recomputed.
  structure._hasFractionalOccupancy = undefined;
  if (lattice) structure.lattice = lattice.map((row) => [...row]);

  // A Wyckoff lock stores raw atom indices (orbitGroups.atomIndices), so it is
  // meaningless the moment atoms are added or removed — drop it instead of
  // letting the composition panel index past the end of structure.atoms.
  if ((added || removed) && structure.symmetry?.mode === 'wyckoff') structure.symmetry = null;

  return { added, removed };
}

// Restore a structure to its as-loaded state (Structure.original, the frozen
// snapshot taken in the constructor). This is the Modify panel's "Revert
// Changes": the panel edits the structure live, so undoing everything means
// rebuilding the atom/element/lattice arrays from that snapshot. Fresh uuids
// are minted (the snapshot predates uuid assignment) - the caller drops any
// _modify diff state so the baseline is recaptured on the next open.
export function revertStructureToOriginal(structure) {
  const orig = structure.original;
  if (!orig) return;
  structure.atoms = orig.atoms.map((a, i) => {
    const atom = new Atom({
      position: [...a.position],
      element: orig.elements[i],
      uuid: generateID([orig.elements[i]]),
    });
    if (a.userColor) { atom.userColor = a.userColor; atom.setColor(a.userColor); }
    return atom;
  });
  structure.elements = [...orig.elements];
  structure.uniqueElements = [...new Set(orig.elements)];
  structure.lattice = orig.lattice.map((row) => [...row]);
  // Atom-index-based locks are meaningless against the rebuilt array.
  if (structure.symmetry) structure.symmetry = null;
}

// Restore only the cell to its as-loaded value - the lattice section's own
// "Reset Lattice", independent of the atom edits.
export function resetLatticeToOriginal(structure) {
  if (structure.original) structure.lattice = structure.original.lattice.map((row) => [...row]);
}

// Numeric colour (Atom.color) or css string (Atom.userColor) -> "#rrggbb".
export function colorToHex(color) {
  if (typeof color === 'string') return color.startsWith('#') ? color : `#${color}`;
  if (!Number.isFinite(color)) return '#808080';
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

// Register a Structure as a new file-browser row, select it, and recenter
// the camera on it - selectLastAddedRow() re-renders but (unlike a normal
// row click, see FileBrowswerPanel.js's click handler) does not itself move
// the camera, so newly created structures would otherwise stay framed on
// whatever was in view before.
function registerNewStructure(structure, fileName = 'new_structure') {
  const container = new StructureContainer({ fileName, structures: [structure] });
  structureShip.container.push(container);

  const row = createRow({ name: fileName, traj: 1, step: 1 });
  document.querySelector('#objectTable tbody').appendChild(row);
  fileBrowser.fileData.push({ name: fileName, traj: 1, step: 1 });
  selectLastAddedRow(); // selects the row and triggers a render
  recenterCamera();
}

// Register several already-built Structures as ONE new multi-frame
// file-browser row (a trajectory), selected on frame 1. Used by the Order
// Structure random-sample comparison's "Keep All" action
// (LatticeSupercellPanel.js) to keep every generated decoration browsable via
// the normal Trajectory panel/scrubber, not just whichever one gets picked.
// A frame with `.energy` already set (a decoration whose energy was computed
// before Keep All was clicked) is picked up automatically by the Trajectory
// panel's own "Compute step stats" action — nothing extra to wire here.
export function createTrajectoryFromFrames(frames, fileName = 'ordered_structures') {
  if (!frames.length) return null;
  const container = new StructureContainer({ fileName, structures: frames });
  structureShip.container.push(container);

  const row = createRow({ name: fileName, traj: frames.length, step: 1 });
  document.querySelector('#objectTable tbody').appendChild(row);
  fileBrowser.fileData.push({ name: fileName, traj: frames.length, step: 1 });
  selectLastAddedRow();
  recenterCamera();
  return container;
}

// Build a brand-new Structure from atoms entered in an atom-table editor
// (fractional x/y/z, used as-is) plus a lattice (3x3 Cartesian row-vector
// matrix, from LatticeInputPanel.js), and register it as a new file-browser row.
/**
 * @param {Array<{element: string, x: number, y: number, z: number, color?: string}>} atomsToAdd
 * @param {{lattice: number[][], fileName?: string}} options
 */
export function createNewStructureFromAtoms(atomsToAdd, { lattice, fileName = 'new_structure' }) {
  if (!atomsToAdd.length) {
    console.warn('Create structure: no atoms entered.');
    return;
  }

  const elements = atomsToAdd.map(a => a.element);
  const atoms = atomsToAdd.map(a => new Atom({
    position: [a.x, a.y, a.z],
    element: a.element,
    color: parseColorHexToInt(a.color),
    uuid: generateID([a.element]),
  }));

  const structure = new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice,
    atoms,
  });

  registerNewStructure(structure, fileName);
}
