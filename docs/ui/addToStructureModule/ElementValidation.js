// Shared "is this a real element" validation for every atom/site table in
// this module (Add Atom, Add Vacuum, Modify/Add Structure, Symmetry Wyckoff
// generation) — was four near-identical copies, two of which had drifted to
// forget the vacancy-symbol exemption entirely (so typing "Va" there was
// wrongly blocked), which is exactly the kind of divergence duplicating a
// one-line rule across files invites. One copy, one rule: a real
// periodic-table symbol or "Va" (VACANCY_SYMBOLS) passes; anything else
// (including ASE's "X" dummy-atom symbol) is flagged.

import { elementData } from '../PeriodicTablePickerCore.js';
import { VACANCY_SYMBOLS } from '../../render/VacancyMarkerModule.js';

function isValidSymbol(element) {
  return !!elementData[element] || VACANCY_SYMBOLS.has(String(element).trim());
}

/**
 * Summary message for a table's invalid rows, or null if none.
 * @param {Array<{element: string}>} rows
 * @returns {string|null}
 */
export function invalidElementMessage(rows) {
  const bad = [...new Set(rows.filter((r) => !isValidSymbol(r.element)).map((r) => r.element || '(empty)'))];
  if (!bad.length) return null;
  return `Not a recognized element: ${bad.join(', ')}. Use the periodic table picker (⚛) to pick one.`;
}

/**
 * Indices (into `rows`) of every invalid row, for highlighting.
 * @param {Array<{element: string}>} rows
 * @returns {number[]}
 */
export function invalidElementIndices(rows) {
  return rows.reduce((indices, r, i) => {
    if (!isValidSymbol(r.element)) indices.push(i);
    return indices;
  }, []);
}
