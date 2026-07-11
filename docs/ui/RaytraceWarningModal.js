// Performance-warning modal for the ray/path-tracing pipelines.
//
// Shown each time the user ENTERS a tracer mode from a raster mode (fired from
// ColorPanel's pipeline dropdown; tracer -> tracer switches do not re-warn).
// A "Don't show this again" checkbox persists suppression across sessions via
// the panelPrefs bag (`hideRaytraceWarning`); that pref is also surfaced as a
// toggle in the Settings window. The ShareModule session-restore re-dispatch
// of the pipeline `change` event arms a one-shot suppression so the warning
// does not fire from a restore.

import { getPanelPref, setPanelPref } from './panels/PanelManager.js';

// Built once (lazily) and reused; hidden between shows.
let modal = null;
let okBtn = null;
let dontShowInput = null;

// One-shot suppression armed by suppressRaytraceWarningOnce(), consumed by the
// next maybeShowRaytraceWarning() call (used for the ShareModule restore).
let suppressOnce = false;

let previousFocus = null;

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
  dontShowInput = document.getElementById('raytraceWarningDontShow');

  okBtn.addEventListener('click', closeWarning);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeWarning(); // backdrop click
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWarning();
  });
}

/** Unconditional show (exported for tests / future reuse). */
export function showRaytraceWarning() {
  initRaytraceWarningModal();
  if (dontShowInput) dontShowInput.checked = false;
  previousFocus = document.activeElement;
  modal.hidden = false;
  // Focus the Ok button once the modal is visible.
  setTimeout(() => { if (okBtn) okBtn.focus({ preventScroll: true }); }, 0);
}

/** Show unless the "Don't show this again" pref suppresses it. Called on every
 *  raster -> tracer switch (the ColorPanel handler skips tracer -> tracer), so
 *  without the pref the user is re-warned each time they flip back into a
 *  tracer mode. A one-shot suppression (suppressRaytraceWarningOnce) is
 *  consumed first. */
export function maybeShowRaytraceWarning() {
  if (suppressOnce) { suppressOnce = false; return; }
  if (getPanelPref('hideRaytraceWarning')) return;
  showRaytraceWarning();
}

/** Arm a one-shot suppression consumed by the next maybeShowRaytraceWarning
 *  call (used before the ShareModule session-restore change dispatch). */
export function suppressRaytraceWarningOnce() {
  suppressOnce = true;
}

function closeWarning() {
  if (!modal) return;
  // Persist suppression if the user ticked "Don't show this again".
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
}
