// "Export CIF with symmetry" dialog.
//
// A symmetric CIF writes only one atom per orbit, so whatever tolerance the
// symmetry search used, the file is the structure symmetrized to it. The user
// therefore has to see that tolerance — and what it yields — before the file
// is written, which a bare Download-menu click cannot show. This dialog has
// the tolerance box (one value, shared with the Symmetry panel), a live
// preview of the result (space group, operations, sites vs atoms, the largest
// deviation absorbed, whether the translations came out as exact fractions),
// and a ladder of tolerances showing where the found symmetry jumps. Export
// writes exactly the previewed text; "P1 instead" writes the plain cell.
//
// With the Wyckoff editor active the tolerance is the lock's and read-only, so
// the file matches the editor. Reuses the modal card styles (styles.css).

import { general } from '../state/store.js';
import { defaultSymprec } from './SymmetryEditModule.js';
import {
  prepareSymmetricCif, symmetryLadder, activeSymmetryLock, CIF_TOLERANCE_LADDER,
} from './CifSymmetryExport.js';
import { cifToFile, currentBaseName, downloadTextFile } from './SavePanel.js';

let modal = null;
let previousFocus = null;
/** Result of the latest successful preview; what Export writes. */
let preview = null;
/** Sequence number so a slow older preview cannot overwrite a newer one. */
let previewSeq = 0;
let debounceTimer = null;

const MODAL_HTML = `
  <div class="png-export-modal cif-export-modal" role="dialog" aria-modal="true" aria-labelledby="cifExportTitle">
    <h3 id="cifExportTitle">Export CIF with symmetry</h3>
    <p class="cif-export-note">
      The cell is written as displayed, with the symmetry found in it at this
      tolerance and one atom per orbit. Only that asymmetric unit is written, so the
      file is the structure symmetrized to the tolerance below.
    </p>
    <div class="cif-export-row">
      <label for="cifExportTol">Tolerance (Å)
        <input type="number" id="cifExportTol" min="0" step="0.001">
      </label>
      <span class="cif-export-lock" id="cifExportLock" hidden>from the active Wyckoff lock</span>
    </div>
    <div class="cif-export-ladder" id="cifExportLadder" role="group" aria-label="Symmetry found at other tolerances"></div>
    <dl class="sym-kv cif-export-preview" id="cifExportPreview">
      <dt>Space group</dt><dd class="sym-mono" id="cifExportSpg">…</dd>
      <dt>Operations</dt><dd class="sym-mono" id="cifExportOps">…</dd>
      <dt>Sites / atoms</dt><dd class="sym-mono" id="cifExportSites">…</dd>
      <dt>Largest deviation</dt><dd class="sym-mono" id="cifExportDev">…</dd>
      <dt>Translations</dt><dd class="sym-mono" id="cifExportTrans">…</dd>
    </dl>
    <p class="cif-export-status" id="cifExportStatus" hidden></p>
    <div class="paste-modal-actions">
      <button type="button" id="cifExportGo" class="png-primary">Export CIF</button>
      <button type="button" id="cifExportP1">P1 instead</button>
      <button type="button" id="cifExportCancel">Cancel</button>
    </div>
  </div>
`;

const byId = (id) => document.getElementById(id);

function initModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'cifExportModal';
  modal.hidden = true;
  modal.innerHTML = MODAL_HTML;
  document.body.appendChild(modal);

  byId('cifExportGo').addEventListener('click', exportSymmetric);
  byId('cifExportP1').addEventListener('click', exportP1);
  byId('cifExportCancel').addEventListener('click', close);
  byId('cifExportTol').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => refreshPreview(), 250);
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

/** The tolerance in the box, pushed back into the store (and the Symmetry
 *  panel's own box) so the app has one value. */
function readTolerance() {
  const input = /** @type {HTMLInputElement} */ (byId('cifExportTol'));
  const v = parseFloat(input.value);
  const tolerance = Number.isFinite(v) && v > 0 ? v : defaultSymprec();
  if (!input.disabled) {
    general.symmetryTolerance = tolerance;
    const panelBox = /** @type {HTMLInputElement|null} */ (byId('symTolInput'));
    if (panelBox) panelBox.value = String(tolerance);
  }
  return tolerance;
}

function setStatus(text, kind = '') {
  const el = byId('cifExportStatus');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('cif-export-error', kind === 'error');
  el.classList.toggle('cif-export-warn', kind === 'warn');
}

function fillPreview(result) {
  byId('cifExportSpg').textContent = `${result.hm} (${result.number})`;
  byId('cifExportOps').textContent = String(result.operationCount);
  byId('cifExportSites').textContent = `${result.siteCount} / ${result.atomCount}`;
  byId('cifExportDev').textContent = `${result.maxDeviation.toExponential(2)} Å`;
  byId('cifExportTrans').textContent = result.exactTranslations ? 'exact fractions' : 'decimals';
}

function clearPreview(text = '…') {
  for (const id of ['cifExportSpg', 'cifExportOps', 'cifExportSites', 'cifExportDev', 'cifExportTrans']) {
    byId(id).textContent = text;
  }
}

async function refreshPreview() {
  const seq = ++previewSeq;
  const tolerance = readTolerance();
  const goBtn = /** @type {HTMLButtonElement} */ (byId('cifExportGo'));
  goBtn.disabled = true;
  setStatus('');
  try {
    const result = await prepareSymmetricCif(tolerance);
    if (seq !== previewSeq) return;
    preview = result;
    fillPreview(result);
    goBtn.disabled = false;
    if (!result.exactTranslations) {
      setStatus('Some symmetry translations are not simple fractions (the origin is off a symmetry '
        + 'element); they are written as decimals, which not every CIF reader accepts.', 'warn');
    }
  } catch (error) {
    if (seq !== previewSeq) return;
    preview = null;
    clearPreview('—');
    setStatus(String(error?.message ?? error), 'error');
  }
  markLadder(tolerance);
}

function markLadder(tolerance) {
  for (const btn of byId('cifExportLadder').querySelectorAll('button')) {
    btn.classList.toggle('is-active', Number(btn.dataset.tolerance) === tolerance);
  }
}

async function renderLadder() {
  const host = byId('cifExportLadder');
  host.innerHTML = '';
  const seq = previewSeq;
  const rungs = await symmetryLadder(CIF_TOLERANCE_LADDER);
  if (seq !== previewSeq && modal.hidden) return;
  host.innerHTML = '';
  for (const rung of rungs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tolerance = String(rung.tolerance);
    // Compact H-M ("Pnnm") like the Symmetry panel: four rungs share one row.
    const group = rung.error ? 'no result' : `${String(rung.hm).replace(/\s+/g, '')} (${rung.number})`;
    const sites = rung.error ? '' : `${rung.siteCount} site${rung.siteCount === 1 ? '' : 's'}`;
    btn.innerHTML = `<span class="cif-ladder-tol">${rung.tolerance} Å</span>`
      + `<span class="cif-ladder-res">${group}</span><span class="cif-ladder-sites">${sites}</span>`;
    btn.title = rung.error || `${rung.hm} (${rung.number}), ${sites} — use ${rung.tolerance} Å`;
    btn.addEventListener('click', () => {
      /** @type {HTMLInputElement} */ (byId('cifExportTol')).value = String(rung.tolerance);
      refreshPreview();
    });
    host.appendChild(btn);
  }
  markLadder(readTolerance());
}

function exportSymmetric() {
  if (!preview) return;
  try {
    downloadTextFile(currentBaseName() + '.cif', preview.text);
    close();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function exportP1() {
  try {
    downloadTextFile(currentBaseName() + '.cif', cifToFile());
    close();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function close() {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  previewSeq += 1; // drop any preview still in flight
  const target = previousFocus;
  previousFocus = null;
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
}

/** Open the dialog for the selected structure. */
export function showCifExportModal() {
  initModal();
  const lock = activeSymmetryLock();
  const input = /** @type {HTMLInputElement} */ (byId('cifExportTol'));
  input.disabled = !!lock;
  input.value = String(lock?.tolerance ?? defaultSymprec());
  byId('cifExportLock').hidden = !lock;
  // With a lock the tolerance is fixed, so a ladder would only show values
  // the export will not use.
  byId('cifExportLadder').hidden = !!lock;
  preview = null;
  clearPreview();
  setStatus('');
  previousFocus = document.activeElement;
  modal.hidden = false;
  refreshPreview();
  if (!lock) renderLadder();
  setTimeout(() => input.focus({ preventScroll: true }), 0);
}
