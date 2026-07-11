// Performance-warning modal for the ray/path-tracing pipelines.
//
// Shown each time the user ENTERS a tracer mode from a raster mode (fired from
// ColorPanel's pipeline dropdown; tracer -> tracer switches do not re-warn).
//
// The modal is a CONFIRM gate that DEFERS the pipeline switch: when it is shown
// the prior (raster) pipeline keeps rendering — the GUI stays responsive — and
// the actual switch only happens if the user presses Ok. maybeShowRaytraceWarning
// takes { onConfirm, onCancel } and returns true when it deferred the decision to
// those callbacks (modal shown), or false when suppression means the caller
// should just switch immediately. Ok -> onConfirm() (perform the switch);
// Cancel / Escape / backdrop-click -> onCancel() (revert the dropdown). Exactly
// one callback fires per showing (guarded against rapid Ok+Escape double-fires).
//
// A "Don't show this again" checkbox persists suppression across sessions via the
// panelPrefs bag (`hideRaytraceWarning`) on EITHER button — the user has read the
// warning regardless of which choice they make; that pref is also surfaced as a
// toggle in the Settings window. The ShareModule session-restore re-dispatch of
// the pipeline `change` event arms a one-shot suppression so the warning does not
// fire from a restore (and the restore then switches immediately).
//
// showRaytraceWarning() is an unconditional, INFORMATIONAL show (no callbacks):
// the Cancel button is hidden and Ok / Escape / backdrop just close it (used by
// the Settings-window re-read flow and tests).

import { getPanelPref, setPanelPref } from './panels/PanelManager.js';

// Built once (lazily) and reused; hidden between shows.
let modal = null;
let okBtn = null;
let cancelBtn = null;
let dontShowInput = null;

// One-shot suppression armed by suppressRaytraceWarningOnce(), consumed by the
// next maybeShowRaytraceWarning() call (used for the ShareModule restore).
let suppressOnce = false;

let previousFocus = null;

// Confirm-mode state: the pending { onConfirm, onCancel } callbacks (null in
// informational mode) and a guard so exactly one callback fires per showing.
let pending = null;
let resolved = true;

const WARNING_HTML = `
  <div class="rt-warning-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="raytraceWarningTitle">
    <h3 id="raytraceWarningTitle">Ray &amp; path tracing performance</h3>
    <div class="rt-warning-body">
      <p><strong>These modes can be slow.</strong> Ray tracing and path tracing render the scene by simulating light rays on your GPU. Depending on your hardware, browser support, the size of the system you are investigating, and which features are enabled (fields, planes, polyhedra, transparency, materials), these modes may become very slow.</p>
      <p>On less powerful hardware, a recommended way of working is to set up the visualization — orientation, colors, cut planes, measurements — using the default rendering mode (Depth peeling), and switch over to ray or path tracing at the end for a nicer visual rendering.</p>
      <p>Note that PNG export renders at maximum settings (full resolution, full sample count), so exports may take considerably longer than the on-screen view.</p>
      <p><strong>What are these modes?</strong> <strong>Ray tracing</strong> follows a ray of light from the camera into the scene and applies physically-motivated rules at each surface: mirror-like reflections, refraction through glass, and shadows. It is deterministic, so the image sharpens after only a handful of passes — a good balance of quality and speed.</p>
      <p><strong>Path tracing</strong> simulates full global illumination: light is followed along many random paths, capturing indirect illumination (light bouncing between atoms), color bleeding, soft area-light shadows, and emissive materials that genuinely light their surroundings. It converges to the most realistic image but needs many more passes — expect it to start noisy and refine over time (slower).</p>
    </div>
    <label class="rt-warning-check"><input type="checkbox" id="raytraceWarningDontShow">Don't show this again</label>
    <div class="paste-modal-actions">
      <button type="button" id="raytraceWarningOk">Ok</button>
      <button type="button" id="raytraceWarningCancel">Cancel</button>
    </div>
  </div>
`;

/** Build the modal DOM once, hidden. Idempotent. */
export function initRaytraceWarningModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.id = 'raytraceWarningModal';
  modal.hidden = true;
  modal.innerHTML = WARNING_HTML;
  document.body.appendChild(modal);

  okBtn = document.getElementById('raytraceWarningOk');
  cancelBtn = document.getElementById('raytraceWarningCancel');
  dontShowInput = document.getElementById('raytraceWarningDontShow');

  okBtn.addEventListener('click', () => finish(true));
  cancelBtn.addEventListener('click', () => finish(false));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) finish(false); // backdrop click acts as Cancel
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(false); // Escape acts as Cancel
  });
}

/** Open the modal. In confirm mode the Cancel button is shown and the caller's
 *  onConfirm/onCancel decide the pipeline switch; in informational mode Cancel
 *  is hidden and Ok/Escape/backdrop just close it. */
function openModal(confirm, onConfirm, onCancel) {
  initRaytraceWarningModal();
  resolved = false;
  pending = confirm ? { onConfirm, onCancel } : null;
  if (dontShowInput) dontShowInput.checked = false;
  if (cancelBtn) cancelBtn.hidden = !confirm;
  previousFocus = document.activeElement;
  modal.hidden = false;
  // Focus the Ok button once the modal is visible.
  setTimeout(() => { if (okBtn) okBtn.focus({ preventScroll: true }); }, 0);
}

/** Unconditional, informational show (exported for tests / Settings re-read).
 *  No callbacks: Cancel is hidden and any dismissal just closes the modal. */
export function showRaytraceWarning() {
  openModal(false);
}

/** Show unless the "Don't show this again" pref suppresses it. Called on every
 *  raster -> tracer switch (the ColorPanel handler skips tracer -> tracer).
 *  In confirm mode the pipeline switch is DEFERRED to the callbacks:
 *    - returns true  -> modal shown; onConfirm()/onCancel() will fire the switch
 *      or the revert (caller must NOT switch itself).
 *    - returns false -> suppressed (one-shot restore or the pref); caller should
 *      switch immediately as before.
 *  A one-shot suppression (suppressRaytraceWarningOnce) is consumed first.
 *  @param {{ onConfirm?: () => void, onCancel?: () => void }} [callbacks]
 *  @returns {boolean} */
export function maybeShowRaytraceWarning({ onConfirm, onCancel } = {}) {
  if (suppressOnce) { suppressOnce = false; return false; }
  if (getPanelPref('hideRaytraceWarning')) return false;
  openModal(true, onConfirm, onCancel);
  return true;
}

/** Arm a one-shot suppression consumed by the next maybeShowRaytraceWarning
 *  call (used before the ShareModule session-restore change dispatch). */
export function suppressRaytraceWarningOnce() {
  suppressOnce = true;
}

/** Close the modal, persist the "Don't show again" pref (on EITHER button), and
 *  fire exactly one confirm-mode callback. Guarded so a rapid Ok+Escape (or any
 *  double dismissal) only resolves once. */
function finish(confirmed) {
  if (!modal || resolved) return;
  resolved = true;
  // Persist suppression if the user ticked "Don't show this again" — they have
  // read the warning regardless of Ok vs Cancel.
  if (dontShowInput && dontShowInput.checked) {
    setPanelPref('hideRaytraceWarning', true);
    // Keep the Settings-window toggle in sync if it is currently built.
    const settingsToggle = /** @type {HTMLInputElement} */ (
      document.getElementById('disableRaytraceWarningToggle'));
    if (settingsToggle) settingsToggle.checked = true;
  }
  modal.hidden = true;
  const target = previousFocus;
  previousFocus = null;
  if (target && typeof target.focus === 'function') {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
  const cbs = pending;
  pending = null;
  if (cbs) {
    if (confirmed) { if (cbs.onConfirm) cbs.onConfirm(); }
    else if (cbs.onCancel) cbs.onCancel();
  }
}
