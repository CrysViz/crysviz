// Site composition in saved sessions (.crysviz files, share links).
//
// A session stores atoms as elements + positions, which says nothing about a
// disordered site: Fe 0.5 / Ni 0.3 / Co 0.2 on one site came back as plain Fe.
// The record here carries what is missing: the species of every site that is
// more than one fully occupied species with no extras — a mixed or partially
// vacant site, or one with an oxidation state or a colour of its own — as a
// sparse {atomIndex: [{element, occupancy, oxidationState?, color?}]} map,
// aligned with the saved atoms. An ordered structure writes nothing.
//
// PURE: no DOM, no store. Saved files and links are untrusted input, so a
// record is validated entry by entry and a bad entry is skipped.

const MAX_SPECIES_PER_SITE = 32;

/** True for a site that needs no record: one species, fully occupied, no
 *  oxidation state, no colour of its own. */
export function isPlainSite(species) {
  if (!Array.isArray(species) || !species.length) return true;
  const s = species[0];
  return species.length === 1 && s.occupancy === 1 && s.oxidationState == null && s.color == null;
}

/** One site's species as saved: element and occupancy, plus oxidationState
 *  and color only when set. */
function serializeSpecies(species) {
  return species.map((s) => ({
    element: s.element,
    occupancy: s.occupancy,
    ...(s.oxidationState != null ? { oxidationState: s.oxidationState } : {}),
    ...(s.color != null ? { color: s.color } : {}),
  }));
}

/**
 * The sparse record for a list of sites, or null when every site is plain.
 * @param {Array<Array<object> | null | undefined>} speciesLists one entry per atom, index-aligned
 * @returns {Record<number, Array<object>> | null}
 */
export function siteSpeciesRecord(speciesLists) {
  /** @type {Record<number, Array<object>>} */
  const out = {};
  speciesLists.forEach((sp, i) => {
    if (!isPlainSite(sp)) out[i] = serializeSpecies(/** @type {Array<object>} */ (sp));
  });
  return Object.keys(out).length ? out : null;
}

/**
 * A saved site's species list in Atom form, or null when it is not usable.
 * @param {unknown} list
 * @returns {Array<{element: string, occupancy: number, oxidationState: number | null, color: number | null}> | null}
 */
export function validSpeciesList(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_SPECIES_PER_SITE) return null;
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const { element, occupancy, oxidationState = null, color = null } = /** @type {any} */ (s);
    if (typeof element !== 'string' || !element || element.length > 16 || /\s/.test(element)) return null;
    if (typeof occupancy !== 'number' || !Number.isFinite(occupancy) || occupancy < 0 || occupancy > 1) return null;
    if (oxidationState !== null
      && (typeof oxidationState !== 'number' || !Number.isFinite(oxidationState) || Math.abs(oxidationState) > 20)) return null;
    if (color !== null && !(Number.isInteger(color) && color >= 0 && color <= 0xffffff)) return null;
    out.push({ element, occupancy, oxidationState, color });
  }
  return out;
}

/**
 * Put a saved record's species back on the atoms, as their as-loaded state.
 * @param {Array<{setSpecies: Function}>} atoms
 * @param {unknown} record
 * @param {(i: number) => boolean} [matches] whether atom i is the saved atom i
 * @returns {number} sites restored
 */
export function restoreSiteSpecies(atoms, record, matches = () => true) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 0;
  let restored = 0;
  for (const [key, list] of Object.entries(record)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= atoms.length || !matches(i)) continue;
    const species = validSpeciesList(list);
    if (!species) continue;
    atoms[i].setSpecies(species, { asLoaded: true });
    restored++;
  }
  return restored;
}
