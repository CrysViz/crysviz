// Access layer over the global structure-selection state held in store.js.
//
// Prefer these accessors over reading/writing `fileBrowser` / `structureShip`
// directly. Today they are thin wrappers around the store singletons, but
// routing access through this module lets the backing representation change
// later (e.g. a real selection model) without touching every call site.
//
// Current backing fields (see store.js):
//   fileBrowser.selectedStructure   -> the active/primary structure
//   fileBrowser.comparisonStructure -> the overlay structure (comparison mode)
//   fileBrowser.selectedRow / selectedRowIndex -> active file-browser row
//   structureShip.container         -> list of StructureContainer (one per file/trajectory)

import { fileBrowser, structureShip } from './store.js';

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

// --- Comparison (overlay) structure -----------------------------------------

export function getComparisonStructure() {
  return fileBrowser.comparisonStructure;
}

export function setComparisonStructure(structure) {
  fileBrowser.comparisonStructure = structure;
}

export function hasComparisonStructure() {
  return fileBrowser.comparisonStructure != null;
}

// --- Loaded containers (one per file / trajectory) --------------------------

export function getContainers() {
  return structureShip.container;
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
