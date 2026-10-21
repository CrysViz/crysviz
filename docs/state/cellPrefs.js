import { general, fileBrowser } from './store.js';
import { getContainerForStructure } from './structures.js';
import {
  saveStructurePref, scheduleStructurePrefSave, registerStructurePrefField, structurePrefsKey,
} from './structurePrefs.js';
import { normalizePeriodicBounds } from '../render/LatticeModule.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { tileSupercell } from '../ui/SuperCellModule.js';
import { refreshPeriodicBoundaryControls } from '../ui/LatticeSupercellPanel.js';
import { restoreAtomColors } from '../utils/ColorModule.js';

// ---------------------------------------------------------------------------
// Per-structure persistence of the "Cell & Supercell" window's cell state
// (issue #18, state/structurePrefs.js):
//
//   periodicBounds: { xmin, xmax, ymin, ymax, zmin, zmax }   fractional, -2..2
//     The "Active Cell Boundary". Dropped when it is the 0..1 unit cell.
//     Saved (debounced) from the boundary section's commit() / Reset
//     (ui/LatticeSupercellPanel.js); restored afterSelect, which also turns
//     "Show Periodic Images" on, exactly as a boundary edit does.
//
//   supercell: { nx, ny, nz }   positive integers
//     Dropped when 1×1×1. Saved from the Supercell section's Apply / Reset
//     buttons only, never from createSupercell. Restored in the beforeSelect
//     phase: the freshly loaded (base-cell) structure is re-tiled in the model
//     before its first selection/render, so the first rebuild already draws
//     the supercell and every afterSelect field (focus regions, planes, ...)
//     sees the cell the user had when they saved it. Single-frame eager
//     containers only: createSupercell re-tiles just the displayed frame of a
//     trajectory (other frames / a store-backed trajectory's rematerialised
//     frames stay 1×1×1), so a trajectory is neither saved nor restored.
//
// ORDER vs. the per-atom-index fields: a record saved after a supercell was
// built indexes the SUPERCELL's atoms. The 'colors' restorer (beforeSelect,
// registered by utils/ColorModule.js) may run before this one and paint the
// base cell only (indices past the base cell are skipped), so after tiling
// the colours are re-applied here to the supercell: cloneAtom already carried
// the base cell's colours onto every image, and the re-apply adds any colour
// the user put on one specific image. (Only an image whose colour was RESET
// while its base-cell atom stayed coloured comes back coloured.) Other
// beforeSelect per-atom fields that run before 'supercell' in registration
// order see the base cell; the afterSelect ones all see the supercell.
// ---------------------------------------------------------------------------

const PBND_LIMIT = 2; // ui/LatticeSupercellPanel.js PBND_LIMIT_MIN/MAX

/** The stored form of a boundary, or null for the default unit cell. */
function periodicBoundsPrefValue(bounds) {
  const clamp = (v) => Math.max(-PBND_LIMIT, Math.min(PBND_LIMIT, v));
  const [[xmin, xmax], [ymin, ymax], [zmin, zmax]] = normalizePeriodicBounds(bounds)
    .map(([lo, hi]) => [clamp(lo), clamp(hi)]);
  if (xmin === 0 && ymin === 0 && zmin === 0 && xmax === 1 && ymax === 1 && zmax === 1) return null;
  return { xmin, xmax, ymin, ymax, zmin, zmax };
}

/**
 * A USER edit of the cell boundary (the boundary section's commit/Reset):
 * persist general.periodicBounds for this structure (debounced: the range
 * sliders fire per pointer move). The value is captured now, since the
 * boundary is global state that a row switch inside the window keeps.
 * @param {any} [structure]
 */
export function schedulePeriodicBoundsSave(structure = fileBrowser.selectedStructure) {
  if (!structure) return;
  const value = periodicBoundsPrefValue(general.periodicBounds);
  scheduleStructurePrefSave(structure, 'periodicBounds', () => value);
}

function restorePeriodicBounds(_container, value) {
  if (!value || typeof value !== 'object') return;
  const bounds = periodicBoundsPrefValue(value) ?? { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
  general.periodicBounds = bounds;
  general.showPeriodic = true;
  const toggle = /** @type {HTMLInputElement | null} */ (document.getElementById('showPeriodic'));
  if (toggle) toggle.checked = true;
  refreshPeriodicBoundaryControls();
  // Same flags as the boundary section's commit(): reRenderPeriodic makes the
  // arrows, the volumetric field and the planes follow the boundary.
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPeriodic: true });
}

/** Whether a container's supercell can be persisted (one eager frame). */
function supportsSupercellPref(container) {
  if (!container || container.store) return false;
  const frames = container.frameCount ?? container.structures?.length ?? 0;
  return frames === 1 && !!container.structures?.[0]?.atoms;
}

function supercellFactors(value) {
  if (!value || typeof value !== 'object') return null;
  const f = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);
  const nx = f(value.nx); const ny = f(value.ny); const nz = f(value.nz);
  return nx === 1 && ny === 1 && nz === 1 ? null : { nx, ny, nz };
}

/**
 * Fix the container's storage key on its CURRENT atoms. Called before a user
 * supercell edit: the key is a fingerprint of the first frame, cached on first
 * use, and a container loaded without the restore pass (a share link) may not
 * have one yet; computing it after the tiling would fingerprint the supercell
 * and the next load of the same file would not find the record.
 * @param {any} [structure]
 */
export function pinCellPrefsKey(structure = fileBrowser.selectedStructure) {
  const container = structure ? getContainerForStructure(structure) : null;
  if (container) structurePrefsKey(container);
}

/**
 * A USER supercell edit (the Supercell section's Apply / Reset, after
 * createSupercell): persist the factors now on the structure.
 * @param {any} [structure]
 */
export function saveSupercellPref(structure = fileBrowser.selectedStructure) {
  const container = structure ? getContainerForStructure(structure) : null;
  if (!supportsSupercellPref(container)) return false;
  return saveStructurePref(container, 'supercell', supercellFactors(structure.supercell));
}

function restoreSupercell(container, value) {
  const factors = supercellFactors(value);
  if (!factors || !supportsSupercellPref(container)) return;
  const structure = container.structures[0];
  const cur = structure.supercell || {};
  if ((cur.nx || 1) !== 1 || (cur.ny || 1) !== 1 || (cur.nz || 1) !== 1) return; // not the base cell
  structurePrefsKey(container); // (already cached by the registry's read; fingerprint the base cell)
  tileSupercell(structure, factors.nx, factors.ny, factors.nz);
  restoreAtomColors(container);
}

// order -10: the supercell changes the atom count, so it is tiled before any
// per-atom-index field (colours, radius scales) of the same phase is applied.
registerStructurePrefField('supercell', restoreSupercell, { phase: 'beforeSelect', order: -10 });
registerStructurePrefField('periodicBounds', restorePeriodicBounds);
