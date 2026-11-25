// Top-center note over the 3D view (#view) while Auto picked the fast
// polyhedra search for a large structure (the Fast | Auto | Advanced control
// under Features ▸ Show Polyhedra). Fast draws the hull of each centre's bonded neighbours and finds no cages, so a
// structure that needs the full search (cages, ambiguous shells) can look
// different from the same structure below the threshold; the note says why and
// where to switch. Not shown when the user chose Fast themselves — they know.
//
// Driven from render/PolyhedraModule.js: computePolyhedra() reports the mode it
// runs, and updatePolyhedra() re-checks on every toggle (no structure: only
// hide when polyhedra are off).

import { general } from '../state/store.js';

let banner = null;
let shownFor = null; // { atoms } while the note is on

/** "40 000": thousands split by a narrow no-break space, as in the status text. */
export function formatAtomCount(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function ensureBanner() {
  if (banner && banner.isConnected) return banner;
  const view = document.getElementById('view');
  if (!view) return null;
  banner = document.createElement('div');
  banner.className = 'cv-warning-banner cv-polyhedra-fast-notice';
  banner.setAttribute('role', 'status');
  view.appendChild(banner);
  return banner;
}

/** Below whichever other warnings are on screen (they keep fixed slots). */
function placeBanner(el) {
  const view = el.parentElement;
  if (!view) return;
  const viewTop = view.getBoundingClientRect().top;
  let top = 5;
  for (const other of view.querySelectorAll('.cv-warning-banner:not(.cv-confirm-banner):not(.cv-polyhedra-fast-notice)')) {
    const o = /** @type {HTMLElement} */ (other);
    if (getComputedStyle(o).display === 'none') continue;
    top = Math.max(top, o.getBoundingClientRect().bottom - viewTop + 4);
  }
  el.style.top = `${Math.round(top)}px`;
}

/**
 * Show or hide the note.
 * @param {any} [structure] the structure being computed; omitted = keep the
 *   last decision and only re-check that polyhedra are still on
 * @param {'fast'|'advanced'} [mode] the search computePolyhedra runs for it
 */
export function updatePolyhedraFastNotice(structure, mode) {
  if (structure !== undefined) {
    shownFor = (mode === 'fast' && general.polyhedraMode !== 'fast' && general.polyhedraMode !== 'advanced')
      ? { atoms: structure?.atoms?.length ?? 0 }
      : null;
  }
  const el = ensureBanner();
  if (!el) return;
  const on = !!shownFor && !!general.showPolyhedra;
  if (!on) { el.style.display = 'none'; return; }
  el.textContent = `Fast polyhedra search (${formatAtomCount(shownFor.atoms)} atoms): `
    + 'bonded neighbours only, no cages — Features ▸ Show Polyhedra ▸ Fast | Auto | Advanced';
  el.style.display = 'block';
  placeBanner(el);
}
