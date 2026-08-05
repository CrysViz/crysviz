// Access layer over the global structure-selection state held in store.js.
//
// Prefer these accessors over reading/writing `fileBrowser` / `structureShip`
// directly. Today they are thin wrappers around the store singletons, but
// routing access through this module lets the backing representation change
// later (e.g. a real selection model) without touching every call site.
//
// Current backing fields (see store.js):
//   fileBrowser.selectedStructure -> the active/primary structure
//   fileBrowser.overlayEntries    -> the overlaid structures (Structure Overlay module)
//   fileBrowser.selectedRow / selectedRowIndex -> active file-browser row
//   structureShip.container       -> list of StructureContainer (one per file/trajectory)

import { fileBrowser, structureShip } from './store.js';

const containerIds = new WeakMap();
let nextContainerId = 1;

// --- Active (primary) structure ---------------------------------------------

export function getActiveStructure() {
  return fileBrowser.selectedStructure;
}

export function setActiveStructure(structure) {
  fileBrowser.selectedStructure = structure;
}

export function hasActiveStructure() {
  return fileBrowser.selectedStructure != null;
}

export function getActiveRow() {
  return fileBrowser.selectedRow;
}

export function getActiveRowIndex() {
  return fileBrowser.selectedRowIndex;
}

// --- Overlay structures (Structure Overlay module) --------------------------

export function getOverlayStructures() {
  return fileBrowser.overlayEntries.map((entry) => entry.structure);
}

export function hasOverlayStructures() {
  return fileBrowser.overlayEntries.length > 0;
}

// --- Loaded containers (one per file / trajectory) --------------------------

export function getContainers() {
  return structureShip.container;
}

/** Return the stable, page-local opaque id for a StructureContainer. */
export function getContainerId(container) {
  if (!container || (typeof container !== 'object' && typeof container !== 'function')) {
    return null;
  }
  let id = containerIds.get(container);
  if (!id) {
    id = `structure-${nextContainerId++}`;
    containerIds.set(container, id);
  }
  return id;
}

export function getContainerById(id) {
  if (typeof id !== 'string') return null;
  return getContainers().find((container) => getContainerId(container) === id) || null;
}

export function getContainerForStructure(structure) {
  if (!structure) return null;
  return getContainers().find((container) => container.structures.includes(structure)) || null;
}

export function getContainerCount() {
  return structureShip.container.length;
}

// --- Active-structure change notifications ----------------------------------
// A tiny pub/sub so features (e.g. addons) can react when the active structure
// switches — a new frame/row is selected, or a structure is loaded. The file
// browser (the one place that mutates the active structure) calls
// notifyActiveStructureChange() from its selection path; subscribers get the
// new active structure. Subscribers must unsubscribe (the returned fn) when
// they go away.

const activeChangeSubs = new Set();

export function onActiveStructureChange(cb) {
  if (typeof cb !== 'function') return () => {};
  activeChangeSubs.add(cb);
  return () => activeChangeSubs.delete(cb);
}

export function notifyActiveStructureChange() {
  const structure = getActiveStructure();
  for (const cb of [...activeChangeSubs]) {
    try { cb(structure); } catch (err) { console.error('active-structure-change subscriber failed', err); }
  }
}
