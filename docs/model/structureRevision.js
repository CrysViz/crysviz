// Change tokens for a structure, shared by the host (docs/host) and the
// structure editor (ui/addToStructureModule/StructureEditorPanel.js).
//
//   structureRevision(s)  what atom indices mean: atom identity in order, each
//                         site's species, and the cell. An edit by index stays
//                         valid while it is unchanged. Positions are left out
//                         on purpose: moving atoms never renumbers them, and a
//                         phonon animation or a live MD/relax moves the active
//                         structure every frame.
//   structureContent(s)   the revision plus every position: has anything that
//                         a table of coordinates shows changed?
//   atomIdentity(s)       atom identity in order only: a selection of atom
//                         indices stays meaningful while it is unchanged, even
//                         when an element or a position changes.

/** @type {WeakMap<object, string>} */
const fallbackIds = new WeakMap();
let nextFallback = 1;

/** An atom's identity: its uuid, or a stable per-object id when it has none. */
function atomId(atom) {
  if (atom.uuid) return String(atom.uuid);
  let id = fallbackIds.get(atom);
  if (!id) { id = `~${nextFallback++}`; fallbackIds.set(atom, id); }
  return id;
}

function hasher() {
  let h = 0x811c9dc5;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619); };
  return {
    num: (x) => mix(Math.round(x * 1e6)),
    text: (t) => { for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i)); mix(0); },
    int: mix,
    done: (prefix) => `${prefix}${(h >>> 0).toString(16).padStart(8, '0')}`,
  };
}

function identityInto(h, structure) {
  h.int(structure.atoms.length);
  for (const atom of structure.atoms) h.text(atomId(atom));
}

function shapeInto(h, structure) {
  identityInto(h, structure);
  for (const row of structure.lattice || []) row.forEach(h.num);
  for (const atom of structure.atoms) {
    for (const s of atom.species || []) { h.text(String(s.element)); h.num(s.occupancy ?? 1); }
  }
}

/** Each atom's identity, in order: what an atom index points at. @param {any} structure */
export function atomIds(structure) {
  return structure.atoms.map(atomId);
}

/** @param {any} structure */
export function atomIdentity(structure) {
  const h = hasher();
  identityInto(h, structure);
  return h.done('i');
}

/** @param {any} structure */
export function structureRevision(structure) {
  const h = hasher();
  shapeInto(h, structure);
  return h.done('r');
}

/** @param {any} structure */
export function structureContent(structure) {
  const h = hasher();
  shapeInto(h, structure);
  for (const atom of structure.atoms) atom.position.forEach(h.num);
  return h.done('c');
}
