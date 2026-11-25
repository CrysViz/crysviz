// A leaf module (no imports) so rebuildAtoms() can hand the atom selection
// over to the new atoms mesh without importing ui/SelectAndHighlightModule.js,
// which imports the render modules back. SelectAndHighlightModule adds the
// handler that carries the selection over; the Selection Inspector one that
// re-checks its note on linked copies (same idea as asuHighlightHook.js).
//
// A rebuild (Neighbour Bonds, Show Periodic Images, the display boundary,
// Complete Polyhedra, ...) makes a fresh mesh: the selection glow lives in
// its per-instance attributes and is gone, and the on-screen copies may be
// numbered differently. `prevImageKeys` names each old instance by its source
// atom and periodic offset ("12:0,1,0", structure.atomImageKeys), so the
// handler can find the same copies in the new numbering. It is null when the
// old mesh showed a different structure (a structure or frame switch), whose
// selection the Files list restores itself.

/** @typedef {{ prevMesh: object|null, prevImageKeys: string[]|null }} AtomsRebuiltInfo */

/** @type {Array<(info: AtomsRebuiltInfo) => void>} */
const handlers = [];

/** Called after every rebuild of the main atoms mesh, in the order added.
 *  @param {(info: AtomsRebuiltInfo) => void} fn */
export function onAtomsRebuilt(fn) {
  handlers.push(fn);
}

/** @param {AtomsRebuiltInfo} info */
export function atomsRebuilt(info) {
  for (const fn of handlers) {
    try { fn(info); } catch (error) { console.error('Atoms-rebuilt handler failed', error); }
  }
}
