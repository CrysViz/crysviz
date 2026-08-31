import { fileBrowser, structureShip } from '../../../state/store.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { updateSingleAtomCutPlaneImmunity } from '../../../render/AtomsFracUpdateModule.js';
import { applyWyckoffOrbitPosition } from '../../SymmetryEditModule.js';
import { createToggleSwitch } from '../../ToggleSwitch.js';

/**
 * A small pill-style on/off switch — a shrunk version of the "Link periodic
 * copies"-style toggle (.toggle_switch/.toggle_slider, toggle_styles.css) —
 * for use in place of a plain checkbox tick where the visual weight of a
 * full-size switch would be too much (category header show/hide toggles).
 * Returns the actual `<input type="checkbox">` (set .checked/.onchange on it
 * as usual) and the `wrapper` to append in the checkbox's place; clicking
 * anywhere on wrapper toggles input natively (a <label> around its own
 * checkbox), no extra wiring needed.
 *
 * The click that toggles it is stopped from bubbling any further, matching
 * every plain-checkbox call site this replaces (they all did the same
 * themselves) — these headers sit inside rows that expand/collapse on their
 * OWN click, and a visible click on this switch lands on the wrapper/slider,
 * never on the invisible input (opacity:0, zero hit-testable area). Stopping
 * propagation only on the input (as the plain-checkbox versions did) misses
 * that click entirely — it bubbles from the wrapper straight past the input
 * without ever reaching its listener — which is exactly what let a toggle
 * click also fire the row's expand/collapse handler.
 * @param {string} [title]
 * @returns {{ wrapper: HTMLLabelElement, input: HTMLInputElement }}
 */
export function createMiniToggleSwitch(title = '') {
  const { switchEl, input } = createToggleSwitch({ small: true, tag: 'label' });
  const wrapper = /** @type {HTMLLabelElement} */ (switchEl);
  wrapper.title = title;
  wrapper.addEventListener('click', (e) => e.stopPropagation());
  return { wrapper, input };
}

export function clampOpacity(value) {
  const opacity = Number(value);
  if (!Number.isFinite(opacity)) return 1;
  return Math.max(0, Math.min(1, opacity));
}

/** Clamp a per-atom/per-species radius multiplier to the slider range. */
export function clampRadiusScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(0.2, Math.min(3, scale));
}

// By default excludes hidden atoms — matches what bond/polyhedron numbering
// needs, since only visible atoms can be a bond endpoint or polyhedron
// center. Pass includeHidden:true for anything that EDITS every atom of an
// element (color/opacity/radius pickers) — those must reach hidden atoms
// too, or a hidden atom would silently keep its pre-hide color/opacity
// forever, surviving even a later restore.
export function getElementAtomIndices(element, { includeHidden = false } = {}) {
  const structure = fileBrowser.selectedStructure;
  const atomIndices = [];
  structure.elements.forEach((currentElement, index) => {
    if (currentElement === element && (includeHidden || !structure.atoms[index]?.hidden)) {
      atomIndices.push(index);
    }
  });
  return atomIndices;
}

/**
 * The Atoms tab's groups, one per distinct site composition.
 *
 * Grouping on the representative element alone is not enough: a site that is
 * 50/50 Na/K has exactly one representative (the tie breaks alphabetically to
 * K), so every such site lands under "K" and the "Na" group comes out empty
 * even though the composition line correctly says there is as much Na as K.
 *
 * Keying on the whole element set instead gives one "(K,Na)" group holding
 * those sites, so every site still appears exactly once - no position is listed
 * twice, which is the thing to avoid - and no group is ever empty.
 *
 * Keyed on the element SET, not the exact occupancies: an Fe0.5/Ni0.5 site and
 * an Fe0.8/Ni0.2 site share a group and show their ratios per row. Otherwise
 * nudging an occupancy would move a row to a different group mid-edit and
 * reshuffle the list under the user's cursor.
 *
 * @param {{includeHidden?: boolean}} [opts]
 * @returns {Array<{key: string, label: string, elements: string[], hasVacancy: boolean, atomIndices: number[], representative: string}>}
 */
export function getSiteSignatureGroups({ includeHidden = false } = {}) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return [];

  /** @type {Map<string, {key:string,label:string,elements:string[],hasVacancy:boolean,atomIndices:number[],representative:string}>} */
  const groups = new Map();

  structure.atoms.forEach((atom, index) => {
    if (!includeHidden && atom?.hidden) return;

    const species = atom?.species?.length
      ? atom.species.map((s) => s.element)
      : [structure.elements[index]];
    const elements = [...new Set(species)].sort();
    const hasVacancy = (atom?.getVacancyFraction?.() ?? 0) > 1e-3;
    const key = elements.join(',') + (hasVacancy ? ',Vac' : '');

    let group = groups.get(key);
    if (!group) {
      const parts = hasVacancy ? [...elements, 'Vac'] : elements;
      group = {
        key,
        // A single fully-occupied species keeps the bare element symbol, so an
        // ordered structure's panel looks exactly as it did before occupancy.
        label: parts.length === 1 ? parts[0] : `(${parts.join(',')})`,
        elements,
        hasVacancy,
        atomIndices: [],
        representative: structure.elements[index],
      };
      groups.set(key, group);
    }
    group.atomIndices.push(index);
  });

  // Sort by representative element, pure compositions before mixed ones, so
  // everything containing a given element stays adjacent in the list.
  return [...groups.values()].sort((a, b) =>
    a.elements[0].localeCompare(b.elements[0])
    || a.elements.length - b.elements.length
    || a.key.localeCompare(b.key));
}

export function getElementOpacityValues(element) {
  return Array.from(new Set(
    getElementAtomIndices(element).map((atomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[atomIndex];
      return atom.getOpacity?.() ?? atom.opacity ?? 1;
    })
  ));
}

export function setSwatchOpacity(swatch, opacity) {
  swatch.style.opacity = `${clampOpacity(opacity)}`;
}

export function areAllAtomsCutPlaneImmune(atomIndices) {
  return atomIndices.length > 0 && atomIndices.every((atomIndex) => !!fileBrowser.selectedStructure.atoms[atomIndex].cutPlaneImmune);
}

export function setCutPlaneImmunityForAtoms(atomIndices, immune) {
  atomIndices.forEach((atomIndex) => {
    const atom = fileBrowser.selectedStructure.atoms[atomIndex];
    atom.setCutPlaneImmune(immune);
    fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach((imageIndex) => {
      updateSingleAtomCutPlaneImmunity(imageIndex, immune);
    });
  });
}

/**
 * Run a callback against every OTHER frame of the current file's trajectory
 * — the propagation primitive behind every Apply/Reset button's press-and-
 * hold ("whole trajectory") variant. Uses each frame's own data (never a
 * wholesale copy of the current frame's state) so per-frame specifics —
 * force-derived colors, alpha/size overrides a color-only reset must leave
 * alone — stay correct on every frame instead of being overwritten by
 * whatever the current frame happens to have. No-op on single-frame files.
 * `fn` must be a pure data mutator (no mesh/render calls) since these frames
 * are not the one currently on screen — see callers for concrete examples.
 */
export function applyToOtherTrajectoryFrames(structure, fn) {
  const trajContainer = structureShip.container[fileBrowser.selectedRowIndex];
  if (!trajContainer || trajContainer.structures.length < 2) return;
  // Through the container's frame seam: an eager container visits its
  // structures exactly as the old forEach did, while a store-backed
  // trajectory materialises each frame, applies `fn`, and keeps only the
  // frames `fn` actually changed. May run asynchronously for a container
  // whose frames come from disk — these are UI mutators with no return
  // value, so fire-and-forget is safe.
  trajContainer.forEachFrameMaterialized(fn, { skip: structure });
}

// Styling lives in styles/structureInfoPanel.css (.press-hold-popup and
// friends) — it's always loaded with the app, so there's nothing left to
// inject here.
let openPressHoldPopup = null; // at most one at a time, across every button

/**
 * Wire a button so a normal click/tap runs `onPress` (today's frame-local
 * behavior), while press-and-hold — pointerdown held past `holdMs` — pops
 * open a small floating confirm button reading `holdLabel` (e.g. "Apply to
 * trajectory" / "Reset trajectory") right above it. `onConfirm` only runs if
 * the user then clicks THAT popup; releasing without clicking it, or
 * clicking anywhere else, dismisses it with no effect. This is the "whole
 * trajectory" variant of every color/style Apply/Reset button in the
 * Structure Info panel — give the button a `title` mentioning press-and-hold
 * for discoverability, since there's no other visible cue before it fires.
 * @param {HTMLButtonElement} button
 * @param {{ onPress?: (e: Event) => void, onConfirm?: (e: Event) => void, holdLabel?: string, holdMs?: number }} [options]
 */
export function wirePressHoldPopup(button, { onPress, onConfirm, holdLabel = 'Apply to Trajectory', holdMs = 500 } = {}) {
  let timer = null;
  let holdFired = false;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  function closePopup() {
    if (openPressHoldPopup) {
      openPressHoldPopup.remove();
      openPressHoldPopup = null;
    }
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener('scroll', closePopup, true);
    window.removeEventListener('resize', closePopup, true);
  }
  function onDocPointerDown(e) {
    if (!openPressHoldPopup?.contains(e.target)) closePopup();
  }
  function openPopup() {
    closePopup(); // only one at a time, anywhere in the panel
    const popup = document.createElement('div');
    popup.className = 'press-hold-popup';
    const rect = button.getBoundingClientRect();
    // Not enough room above the button (panel dragged near the top of the
    // viewport) — flip below instead of running off-screen.
    const showBelow = rect.top < 60;
    if (showBelow) popup.classList.add('below');
    popup.style.left = `${rect.left + rect.width / 2}px`;
    popup.style.top = showBelow ? `${rect.bottom}px` : `${rect.top}px`;
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'press-hold-popup-btn';
    confirmBtn.textContent = holdLabel;
    confirmBtn.onclick = (e) => {
      e.stopPropagation();
      onConfirm?.(e);
      // Confirm ON THE POPUP itself (not the original button) so the tick is
      // guaranteed visible even when the action rebuilds/replaces the row the
      // original button lives in (e.g. a category Reset repopulating the tab).
      confirmBtn.textContent = `✓ ${holdLabel}`;
      confirmBtn.disabled = true;
      // Detach the dismiss listeners now (a confirmed popup no longer needs
      // click-outside/scroll-to-dismiss — it just shows the tick and closes
      // itself) rather than leaving the shared closePopup() reachable via
      // them: by the time the tick's delay elapses, openPressHoldPopup may
      // already point at a DIFFERENT button's popup, and closePopup() would
      // wrongly tear that one down instead of this one.
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('scroll', closePopup, true);
      window.removeEventListener('resize', closePopup, true);
      setTimeout(() => {
        popup.remove();
        if (openPressHoldPopup === popup) openPressHoldPopup = null;
      }, 900);
    };
    const arrow = document.createElement('div');
    arrow.className = 'press-hold-popup-arrow';
    popup.appendChild(confirmBtn);
    popup.appendChild(arrow);
    document.body.appendChild(popup);
    openPressHoldPopup = popup;
    // Deferred so the pointerdown that triggered the hold itself doesn't
    // immediately re-trigger this same listener and close the popup.
    setTimeout(() => document.addEventListener('pointerdown', onDocPointerDown, true), 0);
    window.addEventListener('scroll', closePopup, true);
    window.addEventListener('resize', closePopup, true);
  }

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary mouse button / touch only
    holdFired = false;
    timer = setTimeout(() => {
      holdFired = true;
      clearTimer();
      openPopup();
    }, holdMs);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
    button.addEventListener(type, clearTimer);
  });
  button.addEventListener('click', (e) => {
    if (holdFired) {
      // The hold already opened the popup — swallow the click that follows
      // pointerup so onPress doesn't ALSO run right after.
      holdFired = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    onPress?.(e);
  });
}

// `rebuildComposition` false is the live-drag path: it re-lays-out atoms and
// bonds but leaves the Structure Info composition panel alone. Rebuilding it
// ("open") tears down and recreates this atom's row — and with it the very
// slider the user is dragging — so a drag only ever registers its first frame.
// The Apply button and slider-release go through the full path; the drag
// itself must not.
function applyAtomCoordinates(atomIndex, newCoords, { rebuildComposition }) {
  if (!fileBrowser.selectedStructure) {
    console.error("updateAtomCoordinates: selected structure not found");
    return;
  }
  if (atomIndex >= fileBrowser.selectedStructure.atoms.length) {
    console.error('Invalid atom index or structure data');
    return;
  }

  const orbit = fileBrowser.selectedStructure.symmetry?.mode === 'wyckoff'
    ? fileBrowser.selectedStructure.symmetry.orbitGroups?.find((group) => group.atomIndices.includes(atomIndex))
    : null;
  // false means the move was refused (it would have collapsed a site) — the
  // caller shows that instead of pretending the atom moved.
  if (orbit) return applyWyckoffOrbitPosition(orbit.representativeIndex, newCoords);

  fileBrowser.selectedStructure.atoms[atomIndex].position = [...newCoords];
  structureShip.container[fileBrowser.selectedRowIndex].structures[fileBrowser.stepInput].atoms[atomIndex].position = [...newCoords];

  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: rebuildComposition ? "open" : false,
  });
  // The Modify Structure panel shows the same coordinates in its atom table
  // and is not part of the composition rebuild — this is how it learns.
  document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
}

export function updateAtomCoordinates(atomIndex, newCoords) {
  return applyAtomCoordinates(atomIndex, newCoords, { rebuildComposition: true });
}

// Live variant for slider drags — same edit, no composition rebuild (which
// would destroy the slider mid-drag). See applyAtomCoordinates.
export function updateAtomCoordinatesLive(atomIndex, newCoords) {
  return applyAtomCoordinates(atomIndex, newCoords, { rebuildComposition: false });
}
