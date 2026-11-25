// Features ▸ Show Polyhedra ▸ Fast | Auto | Advanced (general.polyhedraMode,
// see the note in state/store.js), a compact three-way control on the Show
// Polyhedra toggle's line, right-aligned, with no label or status line of its own: the
// control's aria-label and the feature search call it "Polyhedra Search", and
// what runs for the selected structure now is in its tooltip ("Auto: fast now
// (40 000 atoms; Fast from 2 000)"). Advanced is the full search
// (radical-Voronoi coordination, cages); Fast is the hull of the bonded
// neighbours, linear in the atom count, for large MD cells; Auto picks Fast
// from general.polyhedraFastMin atoms on.
//
// The tooltip follows computePolyhedra's 'crysviz:polyhedra-mode' event and a
// structure change; it is computed from the same effectivePolyhedraMode(), so
// it is right while polyhedra are off too (nothing is computed then).

import { general, fileBrowser, savePolyhedraSearchPrefs } from '../state/store.js';
import { updatePolyhedra, effectivePolyhedraMode } from '../render/index.js';
import { formatAtomCount } from './PolyhedraFastNotice.js';

const MODES = [
  { value: 'fast', text: 'Fast', title: 'Fast polyhedra search: the hull of each atom’s bonded neighbours (bond lengths and the element rule), no cages. Linear in the number of atoms.' },
  { value: 'auto', text: 'Auto', title: '' }, // title set in sync(): it names the threshold
  { value: 'advanced', text: 'Advanced', title: 'Advanced polyhedra search: coordination shells from the radical Voronoi cell, second-shell cations removed, empty cages found.' },
];

/** What runs for the selected structure: "Fast (40 000 atoms)", or with
 *  Auto the threshold too: "Auto: fast now (40 000 atoms; Fast from 2 000)".
 *  The control's tooltip; the Auto button's tooltip ends with it too. */
export function polyhedraSearchStatus(structure = fileBrowser.selectedStructure) {
  const setting = general.polyhedraMode === 'fast' || general.polyhedraMode === 'advanced'
    ? general.polyhedraMode : 'auto';
  const name = setting === 'fast' ? 'Fast' : setting === 'advanced' ? 'Advanced' : 'Auto';
  if (!structure?.atoms) return name;
  const mode = effectivePolyhedraMode(structure);
  const atoms = `${formatAtomCount(structure.atoms.length)} atoms`;
  return setting === 'auto'
    ? `Auto: ${mode} now (${atoms}; Fast from ${formatAtomCount(general.polyhedraFastMin)})`
    : `${name} (${atoms})`;
}

/**
 * Build the three-way control's box; defaultPanels.js puts it on the Show
 * Polyhedra toggle's line (toggle_styles.css .cv-poly-toggle-line).
 * @returns {HTMLElement}
 */
export function createPolyhedraSearchRow() {
  const row = document.createElement('div');
  row.className = 'cv-poly-search-row cv-poly-search-sub';
  row.id = 'polyhedraSearchRow';

  // Radio semantics, not a tab row (.segmented-control): the buttons choose a
  // setting, they do not switch which content the window shows.
  const seg = document.createElement('div');
  seg.className = 'cv-seg3';
  seg.id = 'polyhedraSearchControl';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Polyhedra Search');
  /** @type {HTMLButtonElement[]} */
  const buttons = MODES.map(({ value, text, title }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `polyhedraSearch${text}`;
    btn.dataset.value = value;
    btn.setAttribute('role', 'radio');
    // What the feature search lists ("Fast polyhedra search"); the face stays short.
    btn.setAttribute('aria-label', `${text} polyhedra search`);
    btn.textContent = text;
    if (title) btn.title = title;
    btn.addEventListener('click', () => {
      if (general.polyhedraMode === value) return;
      general.polyhedraMode = value;
      savePolyhedraSearchPrefs();
      sync();
      document.dispatchEvent(new CustomEvent('crysviz:polyhedra-mode', {
        detail: { mode: effectivePolyhedraMode(), setting: value, atoms: fileBrowser.selectedStructure?.atoms?.length ?? 0 },
      }));
      updatePolyhedra();
    });
    seg.appendChild(btn);
    return btn;
  });
  row.append(seg);

  function sync() {
    const setting = general.polyhedraMode === 'fast' || general.polyhedraMode === 'advanced'
      ? general.polyhedraMode : 'auto';
    for (const btn of buttons) {
      const on = btn.dataset.value === setting;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    const status = polyhedraSearchStatus();
    seg.title = `Polyhedra Search — ${status}`;
    // The buttons cover nearly all of the control, so the Auto button (whose
    // tooltip names the threshold) carries what runs now as well.
    const threshold = `Auto: Fast from ${formatAtomCount(general.polyhedraFastMin)} atoms on, Advanced below`;
    const atoms = fileBrowser.selectedStructure?.atoms?.length;
    buttons[1].title = setting === 'auto' && atoms
      ? `${threshold}. Now: ${effectivePolyhedraMode()} (${formatAtomCount(atoms)} atoms)` : threshold;
  }
  sync();
  for (const ev of ['crysviz:polyhedra-mode', 'crysviz:polyhedra-rebuilt', 'crysviz:atoms-changed']) {
    document.addEventListener(ev, sync);
  }
  return row;
}
