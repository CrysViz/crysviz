import { fileBrowser, structureShip } from '../../../state/store.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { updateSingleAtomCutPlaneImmunity } from '../../../render/AtomsFracUpdateModule.js';
import { applyWyckoffOrbitPosition } from '../../SymmetryEditModule.js';

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
  const wrapper = document.createElement('label');
  wrapper.className = 'toggle_switch toggle_switch--sm';
  wrapper.title = title;
  wrapper.addEventListener('click', (e) => e.stopPropagation());
  const input = document.createElement('input');
  input.type = 'checkbox';
  const slider = document.createElement('span');
  slider.className = 'toggle_slider';
  wrapper.appendChild(input);
  wrapper.appendChild(slider);
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
  trajContainer.structures.forEach((frame) => {
    if (frame !== structure) fn(frame);
  });
}

let pressHoldStylesInjected = false;
function ensurePressHoldPopupStyles() {
  if (pressHoldStylesInjected) return;
  pressHoldStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .press-hold-popup {
      position: fixed;
      z-index: 10000;
      transform: translate(-50%, -100%);
      margin-top: -8px;
      animation: pressHoldPopupIn 0.12s ease-out;
    }
    @keyframes pressHoldPopupIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* Colors follow the app's own accent tokens (styles.css .theme-standard/
       .theme-symmetry, set on <body> per the active backend mode) instead of
       a fixed color, so the popup matches whichever theme is active. */
    .press-hold-popup-btn {
      display: block;
      white-space: nowrap;
      background: var(--highlight-color, var(--accent-color, #2a8f4f));
      color: var(--panel-fg, #f5fbff);
      border: 1px solid var(--border-color, rgba(255,255,255,0.3));
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
      transition: background 0.15s ease;
    }
    .press-hold-popup-btn:hover { filter: brightness(1.12); }
    .press-hold-popup-btn:disabled { cursor: default; filter: none; }
    .press-hold-popup-arrow {
      position: absolute;
      left: 50%;
      bottom: -5px;
      width: 10px;
      height: 10px;
      transform: translateX(-50%) rotate(45deg);
      background: var(--highlight-color, var(--accent-color, #2a8f4f));
      border-right: 1px solid var(--border-color, rgba(255,255,255,0.3));
      border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.3));
    }
    /* Not enough room above the button (e.g. panel dragged near the top of
       the viewport) — flip the popup below it instead. */
    .press-hold-popup.below {
      transform: translate(-50%, 0);
      margin-top: 8px;
    }
    .press-hold-popup.below .press-hold-popup-arrow {
      top: -5px;
      bottom: auto;
      border-right: none;
      border-bottom: none;
      border-left: 1px solid var(--border-color, rgba(255,255,255,0.3));
      border-top: 1px solid var(--border-color, rgba(255,255,255,0.3));
    }
  `;
  document.head.appendChild(style);
}

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
  ensurePressHoldPopupStyles();
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

export function updateAtomCoordinates(atomIndex, newCoords) {
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
  if (orbit) {
    applyWyckoffOrbitPosition(orbit.representativeIndex, newCoords);
    return;
  }

  fileBrowser.selectedStructure.atoms[atomIndex].position = [...newCoords];
  structureShip.container[fileBrowser.selectedRowIndex].structures[fileBrowser.stepInput].atoms[atomIndex].position = [...newCoords];

  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: "open",
  });
}
