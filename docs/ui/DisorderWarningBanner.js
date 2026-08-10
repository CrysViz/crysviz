// Top-center banner over the 3D view (#view), shown when the selected structure
// has fractionally occupied sites and a feature that cannot represent them is
// active.
//
// Interatomic potentials and ML force fields need one definite species per
// site: there is no defined force on an atom that is half Fe and half Ni, so
// MD and relaxation are disabled outright rather than quietly returning numbers
// for a structure they cannot describe. Polyhedra are disabled for the same
// family of reason - a coordination polyhedron's identity comes from its centre
// and ligand species, which a mixed site does not have a single answer for.
//
// Reactive: call updateDisorderWarning() wherever the selected structure or
// those flags can change.
//
// The actual "Order Structure" workflow (Random/Majority, build, energy
// comparison, Use/Keep All) lives inline in the Cell & Supercell panel — see
// addOrderStructureSection() in LatticeSupercellPanel.js. This banner's own
// action button just brings that panel into view rather than hosting any of
// the workflow itself.

import { general, fileBrowser } from '../state/store.js';

let banner = null;

/**
 * True when any visible atom of the selected structure is a mixed or partially
 * occupied site. Cached per structure — occupancy only changes when the
 * structure itself is edited or reloaded.
 *
 * @param {any} [structure]
 * @returns {boolean}
 */
export function structureHasFractionalOccupancy(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms?.length) return false;
  if (structure._hasFractionalOccupancy === undefined) {
    structure._hasFractionalOccupancy = structure.atoms.some((a) => a.isDisordered?.());
  }
  return !!structure._hasFractionalOccupancy;
}

/** Drop the cached flag after a structure edit. */
export function invalidateFractionalOccupancyCache(structure = fileBrowser.selectedStructure) {
  if (structure) structure._hasFractionalOccupancy = undefined;
}

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-warning-banner cv-disorder-warning';
  view.appendChild(banner);
  return banner;
}

export function updateDisorderWarning() {
  const el = ensureBanner();
  if (!el) return;
  const disordered = structureHasFractionalOccupancy();
  if (!disordered) { el.style.display = 'none'; return; }

  const blocked = [];
  if (general.showPolyhedra) blocked.push('Polyhedra');
  if (!blocked.length) { el.style.display = 'none'; return; }

  // textContent replaces all children, so the action button below is never
  // appended twice across repeated calls.
  el.textContent = `⚠ ${blocked.join(' and ')} unavailable for fractionally occupied sites`;
  // The banner is the one place the user is already looking when disorder
  // blocks something, so it carries the way out rather than making them hunt
  // for it in a menu — but the workflow itself lives in the Cell & Supercell
  // panel now, so this just opens/expands/scrolls to that.
  const action = document.createElement('button');
  action.textContent = 'Order structure…';
  action.className = 'cv-disorder-warning-action';
  action.onclick = async () => {
    const { openPanel, getPanel } = await import('./panels/PanelManager.js');
    openPanel('cell');
    const panel = getPanel('cell');
    panel?.expand();
    panel?.el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  el.appendChild(action);
  el.style.display = 'block';
}
