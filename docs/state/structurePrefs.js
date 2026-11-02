import { fileBrowser } from './store.js';
import { getContainerForStructure } from './structures.js';

// ---------------------------------------------------------------------------
// Per-structure user preferences that survive a browser reload: the per-atom
// colour overrides (utils/ColorModule.js), the focus regions
// (render/FocusRegionModule.js) and every other field a feature module
// registers through registerStructurePrefField below (field isosurface
// settings, crystal planes, arrow styles, cell boundary, ...).
//
// Loaded structures themselves are NOT kept across a reload (see
// data/uploadInfo.md), so nothing here can bring a structure back. Instead a
// record is stored under a CONTENT fingerprint of the file, and when the same
// structure is loaded again (the app default at boot, a file dropped in again)
// the record is recognised and its preferences re-applied. The fingerprint is
// a one-way 64-bit hash of the first frame's elements + lattice + positions
// (rounded) plus the frame count: enough to recognise the structure, not to
// rebuild it. It is computed once per container and cached, so in-app edits
// to positions don't move the entry; a differently-positioned file simply
// doesn't match.
//
// Storage shape: { [key]: { name, t, colors?, focusRegions?, <field>... } }. A
// field is dropped when its value is empty, the whole entry when no field is
// left, and only the MAX_STORED_STRUCTURES most recently touched files are
// kept. Same convention as the other small persisted blobs
// (ImageExportPanel.js, CustomUserSettingsPanel.js): own versioned key,
// try/catch around storage, corrupted/missing -> nothing restored.
//
// RULES FOR A FEATURE THAT PERSISTS SOMETHING HERE (issue #18)
//
//  1. Save only from USER-EDIT handlers (the slider/picker/button/table
//     callback), never from an apply/render/restore/frame-playback path.
//     A programmatic apply must not write: otherwise "Clear local data"
//     is silently undone by the next frame step, and a share-URL load
//     (restoreStoredPrefs: false) would leak its snapshot into storage.
//     Sliders that fire per pointer move use scheduleStructurePrefSave.
//  2. Store plain JSON of what the user set, nothing derived and no live
//     object references (a Field is matched by its label, an atom by its
//     index). Save the field as empty/null once the user resets it to the
//     default so the entry disappears from storage.
//  3. Register a restorer with registerStructurePrefField so the single load
//     funnel (ui/StructureInputModule.js initializeUIOnLoad) re-applies the
//     value; 'beforeSelect' for values the first rebuild must already see,
//     'afterSelect' (default) for anything that needs the displayed frame or
//     the scene. Values that can only be applied later (a volumetric field
//     dropped in after the structure) read the record themselves through
//     readStructurePrefs at that moment, gated on general.restoreStoredPrefs.
//  4. A field registered for browser memory is, in the same change, also
//     registered for data clearing. Concretely: (a) the Settings window's
//     "Clear local data" button calls clearLocalData below, which cancels
//     every pending debounced save, runs the onClearLocalData hooks and wipes
//     localStorage — a module with its own timer or in-memory cache that
//     could write back MUST register an onClearLocalData hook; (b) rule 1 is
//     what keeps the data from coming back afterwards; (c) the browser test
//     tools/browsertest/tests/clearlocaldata.test.js holds the exact list of
//     registered fields, sets every one of them, presses the real button and
//     asserts nothing is written back — add the new field to that list and
//     to the test's edit/assert steps, or the test fails on purpose.
// ---------------------------------------------------------------------------

export const STRUCTURE_PREFS_KEY = 'crysviz.structurePrefs.v1';
// A fully recoloured 100k-atom structure is ~1.5 MB on its own.
const MAX_STORED_STRUCTURES = 40;
const SAVE_DEBOUNCE_MS = 250;

/** @type {WeakMap<object, string>} container -> storage key, fixed on first use. */
const containerKeys = new WeakMap();

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const r4 = (v) => (+v).toFixed(4);

/**
 * The first frame's content in one canonical form, whichever way the
 * container stores it: a store-backed trajectory (model/TrajectoryContainer.js
 * keeps `structures` sparse and the physics in flat typed arrays) or an eager
 * container of Structures. Null when there is nothing to fingerprint yet (a
 * frame source that reads from disk answers with a Promise).
 * @returns {{ n: number, text: string } | null}
 */
function firstFrameContent(container) {
  const store = container?.store;
  if (store && typeof store.getFramePhysics === 'function' && store.frameCount > 0) {
    const ph = store.getFramePhysics(0);
    if (!ph || typeof ph.then === 'function' || !ph.elements) return null;
    const parts = [ph.elements.join(',')];
    for (const row of ph.lattice ?? []) parts.push(Array.from(row, r4).join(','));
    const p = ph.positions ?? [];
    for (let a = 0; a < ph.elements.length; a++) parts.push(`${r4(p[a * 3])},${r4(p[a * 3 + 1])},${r4(p[a * 3 + 2])}`);
    return { n: ph.elements.length, text: parts.join(';') };
  }
  const first = container?.structures?.[0];
  if (!first?.atoms || !first.elements) return null;
  const parts = [first.elements.join(',')];
  for (const row of first.lattice ?? []) parts.push(Array.from(row, r4).join(','));
  for (const atom of first.atoms) parts.push(Array.from(atom.position ?? [], r4).join(','));
  return { n: first.atoms.length, text: parts.join(';') };
}

/**
 * The storage key for a container (cached after the first call), or null when
 * the container can't be fingerprinted.
 * @param {any} container a StructureContainer
 * @returns {string | null}
 */
export function structurePrefsKey(container) {
  if (!container) return null;
  let key = containerKeys.get(container) ?? null;
  if (!key) {
    const content = firstFrameContent(container);
    if (!content) return null;
    const frames = container.frameCount ?? container.structures?.length ?? 1;
    key = `v1:${content.n}x${frames}:${fnv1a(content.text, 0x811c9dc5)}${fnv1a(content.text, 0x9747b28c)}`;
    containerKeys.set(container, key);
  }
  return key;
}

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STRUCTURE_PREFS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeStore(store) {
  try { localStorage.setItem(STRUCTURE_PREFS_KEY, JSON.stringify(store)); }
  catch { /* storage unavailable or quota exceeded */ }
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** A container, or the container that owns a structure. */
function containerOf(structureOrContainer) {
  if (!structureOrContainer) return null;
  if (Array.isArray(structureOrContainer.structures)) return structureOrContainer;
  return getContainerForStructure(structureOrContainer);
}

/**
 * The stored record for this container, or null.
 * @param {any} container
 * @returns {{ name?: string, t?: number, colors?: Record<string, string>,
 *   focusRegions?: object[], [field: string]: any } | null}
 */
export function readStructurePrefs(container) {
  const key = structurePrefsKey(container);
  if (!key) return null;
  const rec = readStore()[key];
  return rec && typeof rec === 'object' ? rec : null;
}

/**
 * Write one field of a structure's record (or drop it when `value` is
 * empty/null). Removes the entry when no field is left, so a full reset
 * leaves nothing behind.
 * @param {any} structureOrContainer
 * @param {string} field a registered field name ('colors', 'focusRegions', ...)
 * @param {any} value JSON-serialisable
 * @returns {boolean} whether storage changed
 */
export function saveStructurePref(structureOrContainer, field, value) {
  const container = containerOf(structureOrContainer);
  const key = structurePrefsKey(container);
  if (!key) return false;

  const store = readStore();
  const rec = store[key] && typeof store[key] === 'object' ? store[key] : null;
  if (isEmptyValue(value)) {
    if (!rec || !(field in rec)) return false;
    delete rec[field];
    const remaining = Object.keys(rec).filter((k) => k !== 'name' && k !== 't');
    if (remaining.length === 0) delete store[key];
    else rec.t = Date.now();
  } else {
    const next = rec ?? {};
    next.name = container.fileName ?? '';
    next.t = Date.now();
    next[field] = value;
    store[key] = next;
    const keys = Object.keys(store);
    if (keys.length > MAX_STORED_STRUCTURES) {
      keys.sort((a, b) => (store[a]?.t ?? 0) - (store[b]?.t ?? 0))
        .slice(0, keys.length - MAX_STORED_STRUCTURES)
        .forEach((k) => { delete store[k]; });
    }
  }
  writeStore(store);
  return true;
}

/** @type {Map<string, { timer: any, structure: any, getValue: () => any }>} */
const pending = new Map();

function flushField(field) {
  const p = pending.get(field);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(field);
  saveStructurePref(p.structure, field, p.getValue());
}

/** Flush every debounced save now (a reload inside the debounce window would
 *  otherwise drop the last edit). */
export function flushPendingStructurePrefSaves() {
  for (const field of [...pending.keys()]) flushField(field);
}

/**
 * Debounced saveStructurePref for editors that fire on every pointer move
 * (colour pickers, sliders): one write per burst. `getValue` is evaluated at
 * flush time. A pending save of the same field for a DIFFERENT structure is
 * flushed first so nothing is lost when the user switches rows mid-burst.
 * @param {any} structure
 * @param {string} field a registered field name
 * @param {() => any} getValue
 */
export function scheduleStructurePrefSave(structure = fileBrowser.selectedStructure, field, getValue) {
  if (!structure || typeof getValue !== 'function') return;
  const p = pending.get(field);
  if (p && p.structure !== structure) flushField(field);
  else if (p) clearTimeout(p.timer);
  pending.set(field, { structure, getValue, timer: setTimeout(() => flushField(field), SAVE_DEBOUNCE_MS) });
}

/** Drop every debounced save without writing it (used by clearLocalData). */
export function cancelPendingStructurePrefSaves() {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushPendingStructurePrefSaves);
}

// ---------------------------------------------------------------------------
// Restorer registry — each feature module registers the field it owns once
// at module evaluation; initializeUIOnLoad runs the two phases.
// ---------------------------------------------------------------------------

/**
 * @typedef {'beforeSelect' | 'afterSelect'} StructurePrefPhase
 *   beforeSelect: the container is registered but not yet selected/rendered
 *   (colours: the first rebuild already paints them). afterSelect: the row is
 *   selected and the displayed frame exists (`structure`), so scene state can
 *   be touched.
 */

/** @type {Map<string, { phase: StructurePrefPhase, order: number, seq: number, restore: (container: any, value: any, structure: any) => void }>} */
const restorers = new Map();
let registrationSeq = 0;

/**
 * Register the restorer for one stored field. Idempotent per field name (a
 * re-registration replaces the previous one).
 * @param {string} field the record key this feature saves under
 * @param {(container: any, value: any, structure: any) => void} restore
 *   re-applies a stored value; `structure` is the displayed frame in the
 *   afterSelect phase and null before selection. Exceptions are caught and
 *   logged so one bad record never blocks a load.
 * @param {{ phase?: StructurePrefPhase, order?: number }} [options] order:
 *   restorers of one phase run in ascending order (default 0), ties in
 *   registration order. A field that changes the atom count (the supercell,
 *   state/cellPrefs.js) runs at a negative order so every per-atom-index
 *   field is applied to the same cell it was saved on.
 */
export function registerStructurePrefField(field, restore, { phase = 'afterSelect', order = 0 } = {}) {
  if (typeof field !== 'string' || !field || typeof restore !== 'function') return;
  restorers.set(field, { phase, order, seq: registrationSeq++, restore });
}

/** The registered field names (tests / the clear-data check). */
export function registeredStructurePrefFields() {
  return [...restorers.keys()];
}

/**
 * Re-apply every registered field of the given phase from the container's
 * stored record. Returns the names of the fields that had a stored value.
 * @param {any} container a StructureContainer
 * @param {StructurePrefPhase} phase
 * @param {any} [structure] the displayed frame (afterSelect)
 * @returns {string[]}
 */
export function restoreStructurePrefs(container, phase, structure = null) {
  const rec = readStructurePrefs(container);
  if (!rec) return [];
  const applied = [];
  const ordered = [...restorers.entries()]
    .sort(([, a], [, b]) => (a.order - b.order) || (a.seq - b.seq));
  for (const [field, { phase: p, restore }] of ordered) {
    if (p !== phase || rec[field] == null) continue;
    try {
      restore(container, rec[field], structure);
      applied.push(field);
    } catch (err) {
      console.warn(`structurePrefs: restoring '${field}' failed`, err);
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// "Clear local data" (Settings window, ui/panels/defaultPanels.js)
// ---------------------------------------------------------------------------

/** @type {Set<() => void>} */
const clearHooks = new Set();

/**
 * Register a hook that runs inside clearLocalData BEFORE localStorage is
 * wiped: for a module that keeps its own debounced write timer or an
 * in-memory copy of a stored blob that would otherwise be written back.
 * @param {() => void} fn
 * @returns {() => void} unregister
 */
export function onClearLocalData(fn) {
  if (typeof fn === 'function') clearHooks.add(fn);
  return () => clearHooks.delete(fn);
}

/**
 * Wipe everything the app keeps in this browser: cancels the pending
 * structure-pref saves (a flush here would write them straight back), runs
 * the registered hooks, then clears localStorage. Nothing is reloaded and the
 * scene is left as it is; by rule 1 above no module writes again until the
 * user makes a new edit.
 */
export function clearLocalData() {
  cancelPendingStructurePrefSaves();
  for (const fn of clearHooks) {
    try { fn(); } catch (err) { console.warn('structurePrefs: clear hook failed', err); }
  }
  try { localStorage.clear(); } catch { /* storage unavailable */ }
}
