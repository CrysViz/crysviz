// Grouping of co-located atom_site rows into single crystallographic sites.
//
// CIF expresses substitutional disorder as several atom_site rows sharing one
// position — "Fe1A Fe3+ ... 0.5" / "Fe1B Ni2+ ... 0.5" — rather than as one row
// with a species list. Left alone those rows are separate atoms sitting exactly
// on top of each other, and expand_asu's positional dedup then silently throws
// all but the first away, so the Ni in that example never reaches the model at
// all.
//
// Grouping has to happen BEFORE symmetry expansion. Doing it after is not
// equivalent: the rows are already gone by then. Doing it instead by loosening
// expand_asu's dedup would regress CIFs that legitimately list redundant
// symmetry-equivalent rows, which that dedup exists to collapse — so the
// expansion seeds one atom per *site* and its dedup is left exactly as it was.
//
// Exported separately from the CIF parser because every structure-mutating path
// needs it, not just file load: two atoms typed at the same coordinates in the
// Add Atom panel are the same disorder statement and must group identically.
//
// Some CIF writers spell a site's unoccupied fraction out as its own row
// ("Fe1 Fe 0.8" / "Va1 Va 0.2") rather than just leaving it out of the
// occupancy sum. "Va" is treated as a real, trackable species here (like any
// other element string, just not a real one) rather than special-cased out
// of the sum — WedgeAtoms.js gives an "element === 'Va'" species the hatched
// "vacancy" look at render time instead of resolving a real colour for it,
// so a site's explicit and implicit (occupancies not summing to 1) vacant
// fractions both end up looking the same without this layer needing to tell
// them apart.

import { VACANCY_SYMBOLS } from '../../render/VacancyMarkerModule.js';
import { elementData } from '../../ui/PeriodicTablePickerCore.js';

/** Fractional-coordinate tolerance for treating two rows as co-located. */
export const SITE_TOLERANCE = 1e-3;

/** Occupancy sums above 1 + this are reported as suspect. */
const OCCUPANCY_SLACK = 1e-3;

/**
 * Shortest distance between two fractional coordinates along one axis,
 * accounting for periodic wrap-around (0.999 and 0.001 are adjacent).
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function periodicDelta(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

/**
 * @param {number[]} p
 * @param {number[]} q
 * @param {number} tol
 * @returns {boolean}
 */
export function sameSite(p, q, tol) {
  return periodicDelta(p[0], q[0]) <= tol
    && periodicDelta(p[1], q[1]) <= tol
    && periodicDelta(p[2], q[2]) <= tol;
}

/**
 * Group co-located rows into sites.
 *
 * Grouping is on position alone. _atom_site_disorder_group is carried through
 * for display but deliberately not used as a grouping key: rows in different
 * disorder groups at one position are alternative occupants of that same site,
 * which is exactly what we want merged.
 *
 * @param {{
 *   positions: number[][],
 *   symbols: string[],
 *   occupancies?: (number|null)[]|null,
 *   oxidationStates?: (number|null)[]|null,
 *   labels?: string[]|null,
 *   disorderGroups?: (string|null)[]|null,
 * }} rows
 * @param {number} [tol]
 * @returns {{
 *   positions: number[][],
 *   species: Array<Array<{element:string,occupancy:number,oxidationState:number|null}>>,
 *   labels: string[],
 *   rowToSite: number[],
 *   warnings: string[],
 * }}
 */
export function groupCoLocatedSites(rows, tol = SITE_TOLERANCE) {
  const { positions, symbols } = rows;
  const occupancies = rows.occupancies ?? null;
  const oxidationStates = rows.oxidationStates ?? null;
  const labels = rows.labels ?? null;

  const sitePositions = [];
  const siteSpecies = [];
  const siteLabels = [];
  const rowToSite = [];
  const warnings = [];

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    let siteIndex = -1;
    for (let s = 0; s < sitePositions.length; s++) {
      if (sameSite(pos, sitePositions[s], tol)) { siteIndex = s; break; }
    }

    const occ = occupancies && Number.isFinite(occupancies[i]) ? occupancies[i] : 1;
    const symbol = String(symbols[i]).trim();
    // Not "Va" and not a real periodic-table symbol — most likely a typo or a
    // writer-specific placeholder this parser doesn't know. Flagged rather
    // than silently kept as an unremarked species: the row still becomes a
    // species entry below either way (nothing disappears), but the warning
    // is the caller's cue to check it (same "surface via the warnings
    // array" convention as the total-occupancy check just below).
    if (!VACANCY_SYMBOLS.has(symbol) && !elementData[symbol]) {
      warnings.push(`"${symbol}" (${labels ? labels[i] : `row ${i}`}) is not a recognized element symbol.`);
    }
    const entry = {
      element: symbols[i],
      occupancy: occ,
      oxidationState: oxidationStates && Number.isFinite(oxidationStates[i])
        ? oxidationStates[i]
        : null,
    };

    if (siteIndex === -1) {
      // Keep the first row's position as the site's: averaging co-located rows
      // would drift the site off any special position its symmetry requires.
      sitePositions.push([pos[0], pos[1], pos[2]]);
      siteSpecies.push([entry]);
      siteLabels.push(labels ? labels[i] : '');
      rowToSite.push(sitePositions.length - 1);
    } else {
      siteSpecies[siteIndex].push(entry);
      rowToSite.push(siteIndex);
    }
  }

  siteSpecies.forEach((species, s) => {
    const total = species.reduce((sum, e) => sum + e.occupancy, 0);
    if (total > 1 + OCCUPANCY_SLACK) {
      warnings.push(
        `Site ${siteLabels[s] || s} has total occupancy ${total.toFixed(3)} (> 1)`
      );
    }
  });

  return { positions: sitePositions, species: siteSpecies, labels: siteLabels, rowToSite, warnings };
}

/**
 * Merge co-located atoms of a loaded structure into single disordered sites,
 * in place, and return how many atoms were absorbed.
 *
 * This is the same statement as the CIF grouping above, applied to atoms the
 * user typed rather than ones a file supplied: two rows at one position with
 * occupancies summing to at most 1 describe one mixed site, not two atoms
 * inside each other.
 *
 * Only for one-shot commits (the Add Atom panel). The live Modify editor
 * rebuilds the whole structure from its table on every keystroke and diffs it
 * by uuid, so merging there would delete a row the user is still editing.
 *
 * @param {any} structure
 * @param {number} [tol]
 * @returns {number} atoms absorbed into an existing site
 */
export function mergeCoLocatedAtoms(structure, tol = SITE_TOLERANCE) {
  const atoms = structure?.atoms;
  if (!atoms?.length) return 0;

  const keptAtoms = [];
  const keptElements = [];
  let merged = 0;

  atoms.forEach((atom, i) => {
    const host = keptAtoms.find((k) => sameSite(k.position, atom.position, tol));
    if (!host) {
      keptAtoms.push(atom);
      keptElements.push(structure.elements[i]);
      return;
    }
    // Over-filling is not a disorder statement, so leave those as separate
    // atoms and let the collision warning speak for them.
    const combined = host.getTotalOccupancy() + atom.getTotalOccupancy();
    if (combined > 1 + OCCUPANCY_SLACK) {
      keptAtoms.push(atom);
      keptElements.push(structure.elements[i]);
      return;
    }
    host.species = [...host.species, ...atom.species];
    merged++;
  });

  if (!merged) return 0;

  structure.atoms = keptAtoms;
  // Keep the projection in step: a merged site's element is now whichever
  // species dominates it, which may not be the one that seeded the site.
  structure.elements = keptAtoms.map((a) => a.getRepresentativeElement());
  structure.uniqueElements = [...new Set(structure.elements)];
  structure._hasFractionalOccupancy = undefined;
  return merged;
}

/**
 * Representative element of a species list: highest occupancy wins, ties break
 * alphabetically so the choice is stable across reloads and independent of
 * atom_site ordering. Mirrors Atom.getRepresentativeSpecies().
 *
 * @param {Array<{element:string,occupancy:number}>} species
 * @returns {string}
 */
export function representativeElement(species) {
  if (!species || !species.length) return '';
  let best = species[0];
  for (const s of species) {
    if (s.occupancy > best.occupancy) best = s;
    else if (s.occupancy === best.occupancy && s.element < best.element) best = s;
  }
  return best.element;
}
