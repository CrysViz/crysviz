// The facade an addon receives as the second argument of its build(container,
// api) call. It is a thin, stable convenience layer over app internals so addon
// code never imports the viewer's guts directly. Anything beyond this an addon
// may still reach through its own module imports; the API is a stability layer,
// not a sandbox.
//
// Position writes mirror the MD/relax viewer path exactly:
//   setFracPositions -> write structure.atoms[i].position, then applyFrameFast
//     (render/FastFrameModule.js): the same in-place fast path MD streaming and
//     the relaxer use for live per-frame updates (atoms + bonds, no topology
//     rebuild). Cheap; call it on every interaction tick (drag, slider input).
//   commitPositions  -> the full re-sync the relax loop runs on its
//     BOND_TOPOLOGY_STRIDE / run-end: re-establish the periodic wrapping then a
//     full updateVisualization rebuild (bond topology, polyhedra). Call it once
//     when an interaction ENDS (pointer up / slider release) so bonds that were
//     strided over during the fast path are rebuilt correctly.

import { getActiveStructure, getContainers, onActiveStructureChange } from '../state/structures.js';
import { selectStructure as fbSelectStructure } from './FileBrowswerPanel.js';
import { general } from '../state/store.js';
import { applyFrameFast } from '../render/FastFrameModule.js';
import { runPeriodicWrapped } from '../render/index.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { parse_any } from '../io/load_structure.js';
import { initializeUIOnLoad } from './StructureInputModule.js';

/**
 * Build the API object handed to an addon's build(). `registerStructureChange`
 * is provided by the caller to wire the addon's onStructureChange(cb) into the
 * app's structure-switch path (the caller owns the subscriber list so it can
 * clear it when the addon is destroyed).
 *
 * @param {{ registerStructureChange?: (cb: (structure:any)=>void) => void,
 *           toolbar?: HTMLElement|null }} deps
 */
export function createAddonAPI({ registerStructureChange, toolbar = null } = {}) {
  // Every subscription this API hands out registers its teardown here, so
  // dispose() can drop them all at once when the addon's pane closes.
  const subs = new Set();

  const api = {
    // ---- read -------------------------------------------------------------
    /** The active (primary) structure shown in the main 3D viewer, or null. */
    getStructure() {
      return getActiveStructure();
    },

    // ---- file browser -----------------------------------------------------
    /**
     * The structures currently loaded in the file browser, one entry per row:
     * `{ index, name, frames }` where `index` feeds selectStructure() and
     * `frames` is how many frames/steps that entry holds (a trajectory has
     * more than one). Read-only snapshot.
     */
    getStructures() {
      return getContainers().map((c, i) => ({
        index: i,
        name: c.fileName,
        frames: c.structures.length,
      }));
    },

    /**
     * Select a loaded structure — same as the user clicking its file-browser
     * row. `index` is a row from getStructures(); `step` is the 0-based frame
     * within it (default 0). Drives the browser highlight + 3D view and fires
     * onStructureChange. Returns false if index/step is out of range. Use this
     * to map an addon's own UI (e.g. an EOS E–V point) to a loaded structure.
     */
    selectStructure(index, step = 0) {
      return fbSelectStructure(index, step);
    },

    // ---- drive positions --------------------------------------------------
    /**
     * Write fractional coordinates into the active structure and push them to
     * the viewer via the fast in-place path. `frac` is an array of [x,y,z]
     * fractional triples, one per atom (structure.atoms order). Returns true if
     * the fast path applied; false if it bailed (topology changed) — callers can
     * fall back to commitPositions() in that case.
     */
    setFracPositions(frac) {
      const structure = getActiveStructure();
      if (!structure || !Array.isArray(frac)) return false;
      const atoms = structure.atoms;
      const n = Math.min(atoms.length, frac.length);
      for (let i = 0; i < n; i++) {
        const f = frac[i];
        if (f) atoms[i].position = [f[0], f[1], f[2]];
      }
      return applyFrameFast(structure);
    },

    /**
     * Full re-sync for when an interaction ends: re-establish the periodic
     * wrapping and run a full updateVisualization rebuild so bond topology (and
     * polyhedra, if shown) match the final positions. Mirrors the relax loop's
     * full-apply path.
     */
    commitPositions() {
      const structure = getActiveStructure();
      if (!structure) return;
      const frac = structure.atoms.map((a) => a.position);
      runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);
      updateVisualization({
        atomsUpdate: true,
        bondsUpdate: true,
        reRenderAtoms: true,
        reRenderBonds: true,
        reRenderLattice: true,
        reRenderOther: false,
        reRenderComposition: false,
        reRenderPolyhedra: general.showPolyhedra || general.completePolyhedra,
      });
    },

    // ---- load a whole structure ------------------------------------------
    /**
     * Parse `text` (POSCAR/CIF/XYZ/... — `format`/`name` help the sniffer pick a
     * parser via the filename) and add it to the file browser as a new entry,
     * selecting it. Routes through the same io/load path the upload UI uses.
     * Async (the CIF path is async). Returns the created StructureContainer.
     */
    async loadStructure(text, format = '', name = 'addon_structure') {
      // `format` is folded into the filename the sniffer keys off (parse_any
      // dispatches on the filename extension / content), e.g. ('...', 'cif').
      const fileName = format && !String(name).toLowerCase().includes(String(format).toLowerCase())
        ? `${name}.${format}`
        : name;
      const container = await parse_any(text, fileName);
      initializeUIOnLoad(container);
      return container;
    },

    // ---- subscriptions ----------------------------------------------------
    /**
     * Subscribe to active-structure changes — fired whenever a different frame
     * or row becomes active in the file browser (user click, step change,
     * selectStructure(), or a load). The callback gets the new active
     * structure. Returns an unsubscribe fn; dispose() also drops it.
     */
    onStructureChange(cb) {
      if (typeof cb !== 'function') return () => {};
      const off = onActiveStructureChange(cb);
      subs.add(off);
      return () => { subs.delete(off); off(); };
    },

    // ---- theme ------------------------------------------------------------
    /**
     * Current theme info for restyling addon canvases. `name` is the effective
     * concrete theme id (ThemeManager stamps it on <html data-theme>); `isDark`
     * is a convenience read of the OS preference. `token(name)` reads any theme
     * CSS custom property (e.g. '--highlight-color') resolved on :root.
     */
    getTheme() {
      const name = document.documentElement.getAttribute('data-theme') || '';
      const isDark = window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
      return {
        name,
        isDark: !!isDark,
        token: (prop) => getComputedStyle(document.documentElement).getPropertyValue(prop).trim(),
      };
    },

    /**
     * Subscribe to theme changes. ThemeManager updates <html data-theme> on every
     * theme switch, so a MutationObserver on that attribute is the change signal
     * without coupling to ThemeManager internals. Returns an unsubscribe fn.
     */
    onThemeChange(cb) {
      if (typeof cb !== 'function') return () => {};
      const obs = new MutationObserver(() => cb(api.getTheme()));
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const off = () => obs.disconnect();
      subs.add(off);
      return () => { subs.delete(off); off(); };
    },

    // ---- lifecycle --------------------------------------------------------
    /**
     * Drop every subscription this API handed out (structure + theme). Call it
     * from your owner's onClose so listeners don't fire into a torn-down addon.
     */
    dispose() {
      for (const off of [...subs]) { try { off(); } catch (err) { /* already gone */ } }
      subs.clear();
    },
  };
  return api;
}
