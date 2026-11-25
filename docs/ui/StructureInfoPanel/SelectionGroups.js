// Saved selections ("selection groups") of a structure: the atoms of the
// current selection, with the bonds and polyhedra its Bonds / Polyhedra view
// holds and the view that was active, under a name — to dress a picture by
// re-selecting the same atoms, bonds or polyhedra later with one click.
//
// Stored on the structure (structure.selectionGroups) so they are per
// structure, remembered in this browser with the structure's other
// preferences (state/structurePrefs.js), and carried by .crysviz sessions and
// share links (display.selectionGroups in captureState / the codec's `sg`
// store). An atom is kept as [source index, on-screen copy]; a bond by its
// wrapped-index key (render/BondsFracUpdateModule.js bondKey), a polyhedron
// by its stable key — all of which survive rebuilds of the same structure
// but not an edit of its atom list, which is why the codec drops the store
// when the referenced database entry changed underneath a link.
//
// The UI lives in the selection bar (SelectionActionBar.js).

import { fileBrowser } from '../../state/store.js';
import { registerStructurePrefField, scheduleStructurePrefSave } from '../../state/structurePrefs.js';
import { bondKey, polyhedraTable, polyhedronIndexOfKey } from '../../render/index.js';
import {
  getSelectedAtoms, getSelectionView, getSelectionViewSets, setSelectionView,
  selectAtomsByInstances, addAtomsToSelectionByInstances, getDirectSelection,
  selectBondsDirect, selectPolyhedraDirect,
} from '../SelectAndHighlightModule.js';

export const SELECTION_GROUPS_CHANGED = 'crysviz:selection-groups-changed';
const MAX_NAME = 60;

/** @typedef {{ name: string, tab: 'atoms'|'bonds'|'polyhedra', atoms: Array<[number, number]>, bonds: string[], polyhedra: string[] }} SelectionGroup */

function notify(structure) {
  scheduleStructurePrefSave(structure, 'selectionGroups', () => JSON.parse(JSON.stringify(structure.selectionGroups ?? [])));
  document.dispatchEvent(new CustomEvent(SELECTION_GROUPS_CHANGED));
}

/** The structure's saved selections (live array; do not mutate). */
export function listSelectionGroups(structure = fileBrowser.selectedStructure) {
  return Array.isArray(structure?.selectionGroups) ? structure.selectionGroups : [];
}

/** A name no other group of the structure has ("Selection 2", or "Cu-O 3"). */
export function nextSelectionGroupName(base = 'Selection', structure = fileBrowser.selectedStructure) {
  const names = new Set(listSelectionGroups(structure).map((g) => g.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

function cleanName(name, fallback) {
  const s = String(name ?? '').trim().slice(0, MAX_NAME);
  return s || fallback;
}

/**
 * Save the current selection (atoms, plus the Bonds / Polyhedra view's sets
 * and the active view) as a group of the selected structure.
 * @returns {SelectionGroup|null} null when nothing is selected
 */
export function saveSelectionGroup(name) {
  const structure = fileBrowser.selectedStructure;
  const selected = getSelectedAtoms();
  const direct = getDirectSelection();
  if (!structure || (!selected.length && !direct.kind)) return null;
  const sets = getSelectionViewSets();
  /** @type {SelectionGroup} */
  const group = {
    name: cleanName(name, nextSelectionGroupName('Selection', structure)),
    tab: /** @type {'atoms'|'bonds'|'polyhedra'} */ (getSelectionView()),
    // a picked bond/polyhedron set keeps no atoms: it is restored as that set
    atoms: direct.kind ? [] : selected.map((a) => [a.sourceIndex, a.instanceId]),
    bonds: sets.bonds.map((i) => structure.bonds?.[i]?.indices).filter(Boolean).map((idx) => bondKey(idx)),
    polyhedra: sets.polyhedra.map((i) => polyhedraTable()?.key?.[i]).filter(Boolean),
  };
  structure.selectionGroups = [...listSelectionGroups(structure), group];
  notify(structure);
  return group;
}

/** The atoms-mesh instance ids a group's atoms resolve to now: the same copy
 *  when it is still displayed, else the atom's first copy. */
function resolveInstances(group, structure) {
  const src = structure?.periodic?.visibleWrapped?.srcIndex;
  const out = [];
  for (const entry of group.atoms ?? []) {
    const [sourceIndex, instanceId] = entry;
    let id = null;
    if (src ? src[instanceId] === sourceIndex : instanceId === sourceIndex) id = instanceId;
    else id = structure?.atomImages?.[sourceIndex]?.[0];
    if (Number.isInteger(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The group's own bond / polyhedron sets as they exist now (null when it
 *  recorded none, so the view derives them from the atoms). */
function resolveExplicit(group, structure) {
  const bondsByKey = new Map();
  (structure?.bonds ?? []).forEach((b, i) => { if (b.indices) bondsByKey.set(bondKey(b.indices), i); });
  const bonds = (group.bonds ?? []).map((k) => bondsByKey.get(k)).filter((i) => i !== undefined);
  // polyhedra: rows of the polyhedra table (render/PolyhedraMesh.js)
  const polyhedra = (group.polyhedra ?? []).map((k) => polyhedronIndexOfKey(k)).filter((i) => i >= 0);
  if (!bonds.length && !polyhedra.length) return null;
  return { bonds, polyhedra };
}

/**
 * Select a saved group again: its atoms replace the selection (or join it,
 * `add`), then its view is shown with its own bond / polyhedron sets where
 * they still exist.
 * @param {number} index position in listSelectionGroups()
 */
export function restoreSelectionGroup(index, { add = false } = {}) {
  const structure = fileBrowser.selectedStructure;
  const group = listSelectionGroups(structure)[index];
  if (!group) return false;
  const ids = resolveInstances(group, structure);
  if (!ids.length) {
    // a saved bond / polyhedron set (no atoms): selected again as that set
    const explicit = resolveExplicit(group, structure);
    if (!explicit) return false;
    if (group.tab === 'polyhedra' && explicit.polyhedra.length) {
      selectPolyhedraDirect(explicit.polyhedra.map((i) => polyhedraTable()?.key?.[i]).filter(Boolean), { mode: add ? 'add' : 'replace' });
      return true;
    }
    if (explicit.bonds.length) { selectBondsDirect(explicit.bonds, { mode: add ? 'add' : 'replace' }); return true; }
    return false;
  }
  if (add) addAtomsToSelectionByInstances(ids, { reason: 'selection-group' });
  else selectAtomsByInstances(ids, { reason: 'selection-group' });
  const explicit = add ? null : resolveExplicit(group, structure);
  setSelectionView(group.tab ?? 'atoms', explicit ? { explicit } : {});
  return true;
}

/** Replace a group's content with the current selection (same name). */
export function updateSelectionGroup(index) {
  const structure = fileBrowser.selectedStructure;
  const old = listSelectionGroups(structure)[index];
  if (!old) return false;
  const fresh = saveSelectionGroup(old.name);
  if (!fresh) return false;
  const list = listSelectionGroups(structure).slice(0, -1); // saveSelectionGroup appended it
  list[index] = fresh;
  structure.selectionGroups = list;
  notify(structure);
  return true;
}

export function renameSelectionGroup(index, name) {
  const structure = fileBrowser.selectedStructure;
  const group = listSelectionGroups(structure)[index];
  if (!group) return false;
  group.name = cleanName(name, group.name);
  notify(structure);
  return true;
}

export function deleteSelectionGroup(index) {
  const structure = fileBrowser.selectedStructure;
  const list = listSelectionGroups(structure);
  if (!list[index]) return false;
  structure.selectionGroups = list.filter((_, i) => i !== index);
  notify(structure);
  return true;
}

/** Remembered with the structure's other per-structure preferences. */
function restoreGroups(container, value) {
  if (!Array.isArray(value) || typeof container?.forEachFrameMaterialized !== 'function') return;
  container.forEachFrameMaterialized((frame) => {
    frame.selectionGroups = JSON.parse(JSON.stringify(value));
  });
}
registerStructurePrefField('selectionGroups', restoreGroups, { phase: 'beforeSelect' });
