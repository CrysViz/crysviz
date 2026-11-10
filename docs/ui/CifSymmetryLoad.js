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
//
// The same moment offers to read the file's errors — the standard
// uncertainties it gives for the cell and the coordinates (io/cif/cif_errors.js,
// model/cifErrors.js): as a tick box in the symmetry dialog when there is one,
// and as a dialog of its own otherwise (a CIF without symmetry, an mCIF).
// Reading them is the default; the last answer is remembered as the next one.
// Not reading them drops them from the structure.

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
import { noticeDialog, choiceDialog } from './ConfirmModal.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { refreshBackendTheme } from './BackendPanel/BackendTheme.js';
import { getPanelPref, setPanelPref } from './panels/PanelManager.js';
import { acceptCifErrors, discardCifErrors } from '../model/cifErrors.js';
import { refreshCifErrors } from './CifErrorsDisplay.js';

// H-M symbols vary in spacing/underscores/case between writers and Moyo
// ("F m -3 m", "Fm-3m", "Fm_-3m"); collapse those before comparing by name.
function normalizeHm(symbol) {
  return String(symbol ?? '').replace(/[\s_]+/g, '').toLowerCase();
}

/** What the CIF gives errors for, in a line: "the cell (a, b, c, β) and
 *  18 of 21 atomic coordinates". */
export function describeCifErrors(structure) {
  const rec = structure?.cifErrors;
  if (!rec) return '';
  const names = ['a', 'b', 'c', 'α', 'β', 'γ'];
  const cellNames = names.filter((_, k) => rec.cell.su[k] > 0);
  const coords = rec.sites.length * 3;
  const withSu = rec.sites.reduce((n, site) => n + site.su.filter((v) => v > 0).length, 0);
  const parts = [];
  if (cellNames.length) parts.push(`the cell (${cellNames.join(', ')})`);
  if (withSu) parts.push(withSu === coords ? 'every atomic coordinate' : `${withSu} of ${coords} atomic coordinates`);
  return parts.join(' and ');
}

/** The remembered answer: read a CIF's errors by default? */
function readErrorsDefault() {
  return !!getPanelPref('readCifErrors');
}

/** Keep the CIF's errors (and show them) or drop them; remember the answer. */
function applyCifErrorsChoice(structure, read) {
  setPanelPref('readCifErrors', !!read);
  if (read) {
    acceptCifErrors(structure);
    refreshCifErrors();
  } else {
    discardCifErrors(structure);
  }
}

/** The errors question on its own, for a CIF that gets no symmetry dialog
 *  (one declaring no symmetry beyond P1). */
async function offerCifErrorsOnly(structure, fileName) {
  const name = fileName || 'This CIF';
  const read = await choiceDialog(
    `${name} gives standard uncertainties (errors) for ${describeCifErrors(structure)}. `
      + 'Read them to see measured lengths and angles with their errors, e.g. 2.3456(12) Å?',
    {
      title: 'Read errors from the CIF?',
      choices: [
        { value: true, label: 'Read the errors', id: 'cifErrorsRead',
          description: 'Measurements and the inspectors show each value with its s.u. "Show CIF Errors" (Features) hides them.' },
        { value: false, label: 'Load without errors', id: 'cifErrorsSkip',
          description: 'Values are shown as for any other file.' },
      ],
      cancelValue: readErrorsDefault(),
    },
  );
  applyCifErrorsChoice(structure, read);
}

/**
 * Offer the symmetry choice for a freshly loaded CIF structure, and the errors
 * (standard uncertainties) when the file gives any. The symmetry part is a
 * no-op for any structure without CIF-declared symmetry, or one declaring
 * only P1; the errors are then asked about on their own.
 *
 * @param {any} structure the loaded (and currently selected) structure
 * @param {string} fileName for the dialog copy
 */
export async function offerCifSymmetryChoice(structure, fileName = '') {
  const errorsOffered = !!structure?.cifErrors?.pending;
  // Widget mode is an embed with no app chrome: a blocking dialog there would
  // hang the host page's load. It gets the plain structure, as before.
  if (document.body.classList.contains('widget-mode')) {
    if (errorsOffered) discardCifErrors(structure);
    return;
  }
  const cifSym = structure?.cifSymmetry;
  if (!cifSym) {
    if (errorsOffered) await offerCifErrorsOnly(structure, fileName);
    return;
  }

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
  if (!declaresGroup) {
    if (errorsOffered) await offerCifErrorsOnly(structure, fileName);
    return;
  }

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
    errors: errorsOffered ? { summary: describeCifErrors(structure), read: readErrorsDefault() } : null,
  });

  // Decided before any symmetrising: atoms it moves by less than their error
  // keep it (model/cifErrors.js).
  if (errorsOffered) applyCifErrorsChoice(structure, !!choice?.readErrors);

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
