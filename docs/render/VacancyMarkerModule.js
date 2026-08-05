// The symbol(s) that mean "vacancy" rather than a real element.
//
// "Va" is not in the periodic table, but it is a real, tracked species like
// any other element string once it reaches structure.atoms/species — it
// shows up in composition, the atom tables, and everywhere else a species
// does, with no separate bookkeeping of its own. The one place it needs to
// be told apart from a real element is rendering: WedgeAtoms.js gives an
// "element === 'Va'" species the same hatched "this is absence, not a dark
// element" look a partially-occupied site's implicit vacancy fraction
// already gets, instead of resolving a real (grey, unrecognized-element)
// colour for it.
//
// This constant's only remaining job is validation: telling "Va" apart from
// a typo or an unrecognized symbol (ElementValidation.js), and, in a CIF's
// own occupancy table, from a genuinely unknown species worth flagging
// (site_grouping.js).

/**
 * Symbols that mean "vacancy" rather than an element. Deliberately narrow —
 * just "Va" (case-insensitive), the standard crystallography convention —
 * NOT ASE's "X" dummy-atom symbol: X is a generic placeholder (unspecified
 * atom), not specifically a vacancy statement, and silently treating it as
 * one hid genuinely invalid input (a typo, a made-up symbol) instead of
 * flagging it.
 */
export const VACANCY_SYMBOLS = new Set(['Va', 'va', 'VA']);
