// Measurement-tool toolbar wiring: distance/angle mode buttons, the Hide
// and Restore mode toggles (click an atom to hide it in Hide mode, click a
// ghost to restore it in Restore mode — kept as two separate, mesh-exclusive
// modes rather than one merged mode, so a Restore-mode drag can never
// accidentally hide a real atom sitting in the same rectangle, and vice
// versa; see ui/SceneInteraction.js for the actual pick/flash/commit logic),
// the clear-all button, and their touch handlers. The toolbar itself lives
// inside the unified "Measure" panel window (ui/panels/defaultPanels.js);
// mobile visibility is handled by that panel's collapse, not a dedicated
// toggle.
//
// The mode toggle + clear logic is exposed as setMeasureMode / clearAllMeasureMode
// so other UI (e.g. keyboard shortcuts) can reuse the exact same behavior.

import { mode, measurements, fileBrowser, general } from '../state/store.js';
import { clearHighlightAtom } from './SelectAndHighlightModule.js';
import { clearMeasureGraphics, clearAllMeasurements, clearMeasure } from '../render/MeasurementModule.js';
import { disposeGhostAtoms } from '../render/GhostAtomsModule.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { updateForces, updateSpins } from '../render/index.js';

function isGhostMode(m) {
  return m === 'hide' || m === 'restore';
}

function clearActiveMeasureButtons() {
  document.querySelectorAll('.measure-tool-btn').forEach(btn => btn.classList.remove('active'));
}

// ---- Restore All popover -----------------------------------------------
//
// Not shown automatically on entering hide mode — opened only by long-
// pressing (mouse-hold or touch) the mode button itself, so it stays out of
// the way of the normal click-to-hide/click-to-restore flow. Restore All is
// the bulk "start over" path; Cancel just dismisses the panel — ghosts and
// the mode stay active either way.

let restorePopover = null;

function buildRestorePopover() {
  if (restorePopover) return restorePopover;
  const el = document.createElement('div');
  el.id = 'restorePopover';
  el.className = 'restore-popover';
  el.hidden = true;
  el.innerHTML = `
    <button type="button" id="restoreAllBtn" class="restore-popover-btn restore-popover-all">Restore All</button>
    <button type="button" id="restoreCancelBtn" class="restore-popover-btn restore-popover-cancel">Cancel</button>
  `;
  document.body.appendChild(el);

  document.getElementById('restoreAllBtn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    restoreAllAtoms();
    hideRestorePopover();
  });
  document.getElementById('restoreCancelBtn').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    hideRestorePopover();
  });
  restorePopover = el;
  return el;
}

function positionRestorePopover(anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  // Right-aligned to the button rather than left-aligned: the measurement
  // toolbar docks at the right edge of the viewport, so left-aligning would
  // run the popover off-screen.
  restorePopover.style.top = `${rect.bottom + 6}px`;
  restorePopover.style.left = 'auto';
  restorePopover.style.right = `${window.innerWidth - rect.right}px`;
}

function showRestorePopover(anchorBtn) {
  const el = buildRestorePopover();
  positionRestorePopover(anchorBtn);
  el.hidden = false;
}

function hideRestorePopover() {
  if (restorePopover) restorePopover.hidden = true;
}

/** Un-hide every atom in the structure at once — the "start over" bulk path,
 *  distinct from clicking/dragging individual atoms/ghosts back.
 *  updateVisualization refreshes the (now-empty) ghost mesh itself, since
 *  mode.measureMode is still 'restore' at this point. Forces/spins are a
 *  separate mesh updateVisualization never touches (see commitHideRestore
 *  in SceneInteraction.js for the same pattern), so refresh those too. */
function restoreAllAtoms() {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  structure.atoms.forEach((atom) => { atom.hidden = false; });
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderComposition: true });
  if (general.forcesActive) updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
}

// Toggle a measurement mode ('distance' | 'angle' | 'hide' | 'restore').
// Clicking the active mode turns it off. `button`, if given, receives the
// `.active` class.
//
// Entering/leaving 'hide' or 'restore' has side effects no other mode has:
// it builds/tears down the hidden-atom ghost mesh (render/GhostAtomsModule.js)
// so hidden atoms render as translucent ghosts while either mode is active —
// clickable only in restore mode, purely visual context in hide mode.
// Checked against the PREVIOUS mode, not just whether the target is one of
// these two, so hide -> distance/angle (or vice versa) also cleans up
// correctly, while switching directly between hide and restore leaves the
// ghost mesh alone (still valid — the hidden set didn't change).
export function setMeasureMode(targetMode, button) {
  const previousMode = mode.measureMode;
  const wasActive = previousMode === targetMode;
  clearActiveMeasureButtons();
  measurements.selectedAtoms.forEach(() => clearHighlightAtom());
  measurements.selectedAtoms = [];
  clearMeasureGraphics();
  if (wasActive) {
    mode.measureMode = 'none';
  } else {
    mode.measureMode = targetMode;
    if (button) button.classList.add('active');
  }

  const enteringGhostMode = isGhostMode(mode.measureMode) && !isGhostMode(previousMode);
  const leavingGhostMode = isGhostMode(previousMode) && !isGhostMode(mode.measureMode);
  if (enteringGhostMode) {
    // mode.measureMode is already hide/restore here, so updateVisualization's
    // own ghost-refresh hook builds the mesh — no separate call needed.
    updateVisualization({});
  } else if (leavingGhostMode) {
    disposeGhostAtoms();
    updateVisualization({});
    hideRestorePopover();
  }
}

export function clearAllMeasureMode() {
  const wasGhostMode = isGhostMode(mode.measureMode);
  clearAllMeasurements();
  clearActiveMeasureButtons();
  mode.measureMode = 'none';
  clearMeasure();
  if (wasGhostMode) {
    disposeGhostAtoms();
    updateVisualization({});
    hideRestorePopover();
  }
}

// Long-press (mouse-hold or touch) on the Restore mode button opens the
// Restore All popover, leaving a plain click/tap free to just toggle the
// mode — mirrors the long-press pattern already used for touch atom
// selection in ui/SceneInteraction.js, applied here to a DOM button instead
// of the 3D canvas so it works the same way with mouse or touch.
const LONG_PRESS_MS = 550;

function setupLongPressRestoreAll(btn) {
  let timer = null;
  let fired = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

  btn.addEventListener('pointerdown', (e) => {
    fired = false;
    clear();
    timer = setTimeout(() => {
      fired = true;
      showRestorePopover(btn);
    }, LONG_PRESS_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => {
    btn.addEventListener(evt, clear);
  });
  btn.addEventListener('click', (e) => {
    if (fired) {
      // The long-press already opened the popover — suppress the mode
      // toggle that would otherwise follow this same click.
      e.preventDefault(); e.stopPropagation();
      fired = false;
      return;
    }
    setMeasureMode('restore', btn);
  });
}

export function setupMeasurementToolbar() {
  const distanceBtn = document.getElementById('distanceModeBtn');
  const angleBtn = document.getElementById('angleModeBtn');
  const hideBtn = document.getElementById('hideAtomsBtn');
  const restoreBtn = document.getElementById('restoreBtn');
  const clearBtn = document.getElementById('clearAllMeasurements');

  distanceBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); setMeasureMode('distance', distanceBtn);
  });
  angleBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); setMeasureMode('angle', angleBtn);
  });
  hideBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); setMeasureMode('hide', hideBtn);
  });
  // Restore's click toggles the mode; long-press opens the Restore All
  // popover. See setupLongPressRestoreAll above.
  setupLongPressRestoreAll(restoreBtn);
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); clearAllMeasureMode();
  });

  // Touch handlers for better mobile support
  [distanceBtn, angleBtn, hideBtn, clearBtn].forEach(btn => {
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation(); btn.click();
    });
  });
}
