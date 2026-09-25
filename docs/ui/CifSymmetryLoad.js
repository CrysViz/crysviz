// Load-time reconciliation of a CIF's declared symmetry with the symmetry the
// geometry actually has. Called from core/crystal-viewer.js right after a CIF is
// registered: it detects the space group with Moyo, compares it to what the file
// declared (io/load_structure.js kept that on structure.cifSymmetry), and — when
// there is a decision to make — asks the user through CifSymmetryModal.js whether
// to keep the CIF's symmetry (Wyckoff editor, in the file's own setting),
// symmetrise to the detected group at a chosen tolerance, or load plain.
//
// Doing nothing (loading plain) is the historical behaviour, so any early return
// here leaves the structure exactly as it loaded before this feature existed.

import { general } from '../state/store.js';
import {
  analyzeStructureSymmetry,
  activateWyckoffMode,
  activateWyckoffModeFromCif,
  cifSymmetryIsUsable,
  symmetrizeFractionalPositions,
  defaultSymprec,
  describeMoyoFailure,
} from './SymmetryEditModule.js';
import { promptCifSymmetry } from './CifSymmetryModal.js';
import { noticeDialog } from './ConfirmModal.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { refreshBackendTheme } from './BackendPanel/BackendTheme.js';

// H-M symbols vary in spacing/underscores/case between writers and Moyo
// ("F m -3 m", "Fm-3m", "Fm_-3m"); collapse those before comparing by name.
function normalizeHm(symbol) {
  return String(symbol ?? '').replace(/[\s_]+/g, '').toLowerCase();
}

/**
 * Offer the symmetry choice for a freshly loaded CIF structure. No-op for any
 * structure without CIF-declared symmetry, or one declaring only P1.
 *
 * @param {any} structure the loaded (and currently selected) structure
 * @param {string} fileName for the dialog copy
 */
export async function offerCifSymmetryChoice(structure, fileName = '') {
  const cifSym = structure?.cifSymmetry;
  if (!cifSym) return;
  // Widget mode is an embed with no app chrome: a blocking dialog there would
  // hang the host page's load. It gets the plain structure, as before.
  if (document.body.classList.contains('widget-mode')) return;

  const hasCifOps = Array.isArray(cifSym.symops) && cifSym.symops.length > 1;
  // Only offer to KEEP the file's operations when they actually close on the
  // atoms that were loaded; a file whose atom list contradicts its own
  // operations can still be symmetrised or loaded plain.
  const cifOpsUsable = hasCifOps && cifSymmetryIsUsable(structure, cifSym);
  const cifNumber = Number.isFinite(cifSym.number) ? cifSym.number : null;
  const cifHm = cifSym.hmName || null;

  // Nothing to keep or reconcile when the file declares no symmetry beyond the
  // identity — load it plainly and silently, as the app always did.
  const declaresGroup = hasCifOps
    || (cifHm && normalizeHm(cifHm) !== 'p1')
    || (cifNumber != null && cifNumber !== 1);
  if (!declaresGroup) return;

  const tolerance = defaultSymprec();
  let detected = null;
  let detectError = '';
  try {
    detected = await analyzeStructureSymmetry(structure, tolerance);
  } catch (error) {
    detectError = describeMoyoFailure(error, tolerance);
  }

  const detNumber = detected?.number ?? null;
  const detHm = detected?.hm_symbol ?? null;

  // Match on IT number when both sides have one (setting-independent); fall back
  // to the H-M symbol; leave it unknown (null) if neither can be compared.
  /** @type {boolean|null} */
  let match = null;
  if (!detectError) {
    if (cifNumber != null && detNumber != null) match = cifNumber === detNumber;
    else if (cifHm && detHm) match = normalizeHm(cifHm) === normalizeHm(detHm);
  }

  const choice = await promptCifSymmetry({
    fileName,
    cif: { number: cifNumber, hm: cifHm },
    detected: detectError ? null : { number: detNumber, hm: detHm },
    match,
    hasCifOps: cifOpsUsable,
    detectError,
    tolerance,
  });

  if (!choice || choice.action === 'normal') return;

  try {
    if (choice.action === 'keep') {
      // Prefer the CIF's own operations (exact setting preserved); fall back to
      // the detected symmetry only when the file carried no usable operations —
      // 'keep' is then only offered on a confirmed match, so both agree.
      // On a confirmed match Moyo's per-atom Wyckoff letters describe these
      // very sites, so the CIF-setting lock gets real letters instead of '?'.
      const locked = cifOpsUsable
        ? activateWyckoffModeFromCif(structure, cifSym, tolerance, { dataset: match === true ? detected : null })
        : null;
      if (!locked) await activateWyckoffMode(structure, tolerance);
    } else if (choice.action === 'symmetrize') {
      const tol = choice.tolerance ?? tolerance;
      general.symmetryTolerance = tol;
      await activateWyckoffMode(structure, tol);
      // Snap every atom onto its exact symmetry site under the freshly built
      // lock, then keep the lock so the editor opens on the symmetrised cell.
      const snapped = symmetrizeFractionalPositions(structure.atoms.map((atom) => [...atom.position]), structure);
      snapped.forEach((position, index) => { structure.atoms[index].position = position; });
    }
  } catch (error) {
    await noticeDialog(describeMoyoFailure(error, choice.tolerance ?? tolerance), { title: 'Symmetry' });
    return;
  }

  // Reflect the new lock: the Wyckoff lock tints the whole UI blue (the
  // Symmetry panel's own Wyckoff button does the same after locking), then
  // re-render and rebuild the Structure Info panel as Wyckoff orbit rows
  // (updateVisualization runs renderComposition for the 'open' state). Atoms
  // moved in the symmetrise case, hence the atom/bond pass.
  refreshBackendTheme();
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: 'open',
  });
  document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
}
