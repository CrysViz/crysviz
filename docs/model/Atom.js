import { ColoredObject } from './ColoredObject.js';

import {getElementDefaultColor} from '../defaults/color_texture_defaults.js'

/** Occupancies below this are treated as absent; also the Σocc>1 warning slack. */
const OCCUPANCY_EPS = 1e-6;

/**
 * Build the canonical species list for a site.
 *
 * Accepts either an explicit species array or the flat
 * (element, occupancy, oxidationState) form used by every existing Atom
 * construction site, so callers that know nothing about disorder keep working
 * unchanged.
 *
 * @param {Array<{element:string,occupancy?:number,oxidationState?:number|null,color?:number|null}>|null} species
 * @param {string} element
 * @param {number} occupancy
 * @param {number|null} oxidationState
 * @returns {Array<{element:string,occupancy:number,oxidationState:number|null,color:number|null}>}
 */
function normalizeSpecies(species, element, occupancy, oxidationState) {
  const list = (Array.isArray(species) && species.length) ? species : null;
  if (!list) {
    const occ = Number.isFinite(occupancy) ? Math.max(0, Math.min(1, occupancy)) : 1;
    return [{
      element: element || '',
      occupancy: occ,
      oxidationState: Number.isFinite(oxidationState) ? oxidationState : null,
      // A user-chosen colour for just this species, distinct from the whole
      // atom's userColor: a mixed site needs each of its species independently
      // recolourable (each wedge, each dot). null defers to the element's
      // default colour.
      color: null,
    }];
  }
  return list.map((s) => ({
    element: s.element || '',
    occupancy: Number.isFinite(s.occupancy) ? Math.max(0, Math.min(1, s.occupancy)) : 1,
    oxidationState: Number.isFinite(s.oxidationState) ? s.oxidationState : null,
    color: Number.isFinite(s.color) ? s.color : null,
  }));
}

export class Atom extends ColoredObject {
  constructor({
    element = '',
    position = [],
    coordination = [],
    color = null,
    userColor=null,
    opacity = 1,
    elementOpacity = 1,
    defaultColor = null,
    elementColor = null,
    cutPlaneImmune = false,
    radiusScale = 1,
    hash = null,
    wyckoff = null,
    uuid = null,
    species = null,
    occupancy = 1,
    oxidationState = null,
  } = {}) {
    super({ color, defaultColor });
    this.position = position;
    // NOTE: the `coordination` constructor argument is intentionally ignored
    // here. Coordination is not known at construction time; it is filled in
    // later by neighbour/bond analysis, so the field just starts as null.
    this.coordination = null;
    this.defaultColor = getElementDefaultColor(element);
    this.userColor=null;
    this.elementColor = elementColor || this.defaultColor;
    const normalizedElementOpacity = Number.isFinite(elementOpacity) ? Math.max(0, Math.min(1, elementOpacity)) : 1;
    this.elementOpacity = normalizedElementOpacity;
    this.color = color || this.elementColor;
    this.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : this.elementOpacity;
    this.cutPlaneImmune = !!cutPlaneImmune;
    // Per-atom size multiplier on the element's default radius (1 = default).
    this.radiusScale = Number.isFinite(radiusScale) && radiusScale > 0 ? radiusScale : 1;
    this.uuid = uuid;
    // Hidden atoms are excluded from rendering and from every other panel
    // (composition, bonds, forces, spins, polyhedra, symmetry) but stay in
    // structure.atoms so they can be restored exactly as they were. Not part
    // of `original` below — hiding isn't something a reset-to-as-loaded
    // action should touch.
    this.hidden = false;
    // Site composition. An ordered site is a single entry at occupancy 1, which
    // must stay indistinguishable from the pre-occupancy behaviour. A site whose
    // occupancies sum below 1 is partially vacant; that missing fraction is
    // derived (see getVacancyFraction) and never stored as an entry, so there is
    // exactly one representation of it.
    //
    // `oxidationState` is null for "unknown", which is deliberately distinct
    // from 0 ("explicitly neutral") — the badge renderer draws one and not the
    // other. structure.elements[i] remains the element source of truth for now;
    // see PLAN_occupancy_charges_vacancies.md D3 for the intended projection.
    this.species = normalizeSpecies(species, element, occupancy, oxidationState);
    this.original = Object.freeze({
      element,
      species: this.species.map((s) => Object.freeze({ ...s })),
      position: [...position],
      color: color,
      opacity: this.opacity,
      elementOpacity: this.elementOpacity,
      cutPlaneImmune: this.cutPlaneImmune,
      radiusScale: this.radiusScale,
    });
  }

  // Get the current color of the atom
  getColor() {
    if (!this.userColor) return this.color;
    else return this.userColor
  }

  /**
   * Total occupancy of the site. Below 1 means partially vacant.
   * @returns {number}
   */
  getTotalOccupancy() {
    return this.species.reduce((sum, s) => sum + s.occupancy, 0);
  }

  /**
   * The unoccupied fraction of the site, derived rather than stored.
   * @returns {number}
   */
  getVacancyFraction() {
    return Math.max(0, 1 - this.getTotalOccupancy());
  }

  /** True when this site is anything other than a single fully-occupied species. */
  isDisordered() {
    return this.species.length > 1 || this.getTotalOccupancy() < 1 - OCCUPANCY_EPS;
  }

  /**
   * The species that stands in for the whole site wherever a single value is
   * needed (bond halves, cage-polyhedron colour, the element projection).
   *
   * Highest occupancy wins; ties break alphabetically so the choice is stable
   * across reloads and unaffected by atom_site ordering. The derived vacancy
   * fraction can never win — an Fe 0.4 site is still an Fe site, and colouring
   * it "absent" would be useless.
   *
   * @returns {{element:string,occupancy:number,oxidationState:number|null,color:number|null}}
   */
  getRepresentativeSpecies() {
    let best = this.species[0];
    for (const s of this.species) {
      if (s.occupancy > best.occupancy) best = s;
      else if (s.occupancy === best.occupancy && s.element < best.element) best = s;
    }
    return best;
  }

  /** @returns {string} */
  getRepresentativeElement() {
    return this.getRepresentativeSpecies().element;
  }

  /**
   * The single colour to use anywhere that cannot show every species at once
   * — bond halves, cage-polyhedron faces. userColor still wins outright (an
   * explicit whole-atom override predates species colours and must keep
   * behaving exactly as it did), but next in line is the representative
   * species' OWN colour rather than jumping straight to the plain element
   * default: without this, recolouring a species had no visible effect
   * anywhere except the wedge sphere itself, which is what "the bonds don't
   * adapt to the colour change" was reporting.
   *
   * @returns {number|string}
   */
  getRepresentativeColor() {
    if (this.userColor) return this.userColor;
    if (this.isDisordered()) {
      const rep = this.getRepresentativeSpecies();
      if (Number.isFinite(rep.color)) return rep.color;
      // NOT this.color: that field is seeded once, at construction, from
      // whichever species happened to be species[0] at the time (e.g. the
      // original atom before a lower-occupancy addition made it the minority
      // species) — it does not track which species is representative as
      // occupancies change. Falling back to it here silently picks "whichever
      // species came first" instead of "whichever species occupies most",
      // which is what a disordered site with no explicit per-species colour
      // should show on bonds/polyhedra.
      return getElementDefaultColor(rep.element);
    }
    return this.color;
  }

  // Set a custom color for the atom (accepts hex string or number)
  setColor(cssHex) {
    if (!cssHex) return false;
    let hex = cssHex.toString().trim();
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
    this.color = parseInt(hex, 16);
    return true;
  }

  /**
   * Set a user colour for one species on this site (a wedge, on a disordered
   * atom), independent of the atom's own userColor. Same hex-parsing rule as
   * setColor. Pass null to clear back to the element default.
   *
   * @param {number} index
   * @param {string|null} cssHex
   * @returns {boolean}
   */
  setSpeciesColor(index, cssHex) {
    if (!this.species[index]) return false;
    if (cssHex == null) { this.species[index].color = null; return true; }
    let hex = cssHex.toString().trim();
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
    this.species[index].color = parseInt(hex, 16);
    return true;
  }

  getOpacity() {
    return this.opacity;
  }

  setOpacity(value) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return false;
    this.opacity = Math.max(0, Math.min(1, opacity));
    return true;
  }

  setElementOpacity(value) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return false;
    this.elementOpacity = Math.max(0, Math.min(1, opacity));
    return true;
  }

  resetOpacity() {
    this.opacity = this.original.opacity ?? 1;
    return true;
  }

  resetToElementOpacity() {
    this.opacity = this.elementOpacity ?? 1;
    return true;
  }

  getRadiusScale() {
    return this.radiusScale ?? 1;
  }

  setRadiusScale(value) {
    const scale = Number(value);
    if (!Number.isFinite(scale) || scale <= 0) return false;
    this.radiusScale = Math.min(scale, 10);
    return true;
  }

  resetRadiusScale() {
    this.radiusScale = this.original.radiusScale ?? 1;
    return true;
  }

  setCutPlaneImmune(value) {
    this.cutPlaneImmune = !!value;
    return true;
  }

  resetCutPlaneImmune() {
    this.cutPlaneImmune = this.original.cutPlaneImmune ?? false;
    return true;
  }

  // Reset to the element's custom color (if set), otherwise to default
  resetToElementColor() {
    this.color = this.elementColor;
    this.userColor=null;
    return true;
  }

  // Reset to the element's default color (from map)
  resetToDefaultColor() {
    this.color = getElementDefaultColor(this.original.element);
    this.elementColor = this.color;
    this.userColor=null;
    // A disordered site's wedges each render their OWN species' colour
    // (species[i].color, set via setSpeciesColor), not this.color at all —
    // without this they would survive a "Reset Colors" untouched.
    this.species.forEach((s) => { s.color = null; });
    return true;
  }
}
