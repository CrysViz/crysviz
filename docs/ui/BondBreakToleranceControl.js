// Polyhedra ▸ Bond breaking tolerance (general.bondBreakTolerance, see
// render/BondBreakTolerance.js): a number input in percent, 0–30, in the
// Polyhedra window under the Use Chemical Filter / Detect Cages / Use WASM
// toggles and above the Colour section (PolyhedraPanel.js). During MD /
// trajectory playback a bond, and the polyhedron corner with it, breaks only
// once it is this much longer than its cutoff and forms again within the
// cutoff. Read every frame, so a change applies on the next frame; nothing
// is rebuilt. Persists in this browser (saveBondBreakPrefs).

import { general, saveBondBreakPrefs, BOND_BREAK_TOLERANCE_MAX } from '../state/store.js';

export const BOND_BREAK_TOLERANCE_HELP = 'While frames play (a trajectory, a relaxation, an MD run) a bond, and the polyhedron '
  + 'corner with it, breaks only once it is this much longer than its cutoff, and forms again within the cutoff. 0 = strict.';

/**
 * Build the row (label left, percent input right, help text below).
 * @returns {HTMLElement}
 */
export function createBondBreakToleranceRow() {
  const row = document.createElement('div');
  row.className = 'cv-poly-search-row';
  row.id = 'bondBreakToleranceRow';

  const head = document.createElement('div');
  head.className = 'cv-poly-search-head';
  const label = document.createElement('label');
  label.className = 'toggle_text';
  label.id = 'bondBreakToleranceLabel';
  label.htmlFor = 'bondBreakTolerance';
  label.textContent = 'Bond breaking tolerance';
  label.title = BOND_BREAK_TOLERANCE_HELP;

  const field = document.createElement('span');
  field.className = 'cv-tol-field';
  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'bondBreakTolerance';
  input.className = 'cv-tol-input';
  input.min = '0';
  input.max = String(Math.round(BOND_BREAK_TOLERANCE_MAX * 100));
  input.step = '1';
  input.title = BOND_BREAK_TOLERANCE_HELP;
  input.setAttribute('aria-label', 'Bond breaking tolerance (%)');
  input.setAttribute('aria-describedby', 'bondBreakToleranceHelp');
  const unit = document.createElement('span');
  unit.className = 'cv-tol-unit';
  unit.textContent = '%';
  field.append(input, unit);
  head.append(label, field);

  const help = document.createElement('div');
  help.className = 'cv-poly-search-status cv-tol-help';
  help.id = 'bondBreakToleranceHelp';
  help.textContent = BOND_BREAK_TOLERANCE_HELP;

  row.append(head, help);

  const sync = () => {
    input.value = String(Math.round((Number(general.bondBreakTolerance) || 0) * 100));
  };
  input.addEventListener('change', () => {
    const pct = Number(input.value);
    const frac = Number.isFinite(pct) ? Math.max(0, Math.min(BOND_BREAK_TOLERANCE_MAX, pct / 100)) : 0;
    general.bondBreakTolerance = Math.round(frac * 100) / 100;
    saveBondBreakPrefs();
    sync();
  });
  sync();
  return row;
}
