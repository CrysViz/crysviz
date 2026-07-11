// Thin accumulation-progress bar along the top edge of the 3D view (#view,
// so the dock/UI column is excluded), for the progressive ray/path-tracing
// pipelines: fills left-to-right with sampleCounter/targetSamples while the
// image refines, then fades out once converged. Driven per-frame from
// RayTracingPipeline.render() (and its pathtrace subclass); hidden on
// pipeline dispose. Pure DOM overlay — pointer-events none, themed via
// --highlight-color.

let barEl = null;
let fillEl = null;
let hideTimer = null;

// Stacking: the strip must sit ABOVE the PNG-export backdrop (#pngExportModal,
// position:fixed z-index:3000 on <body>) so the export accumulation stays
// visible while the modal is open. Raising the z-index alone is not reliable:
// #view is `position:relative; z-index:auto` in the normal layout (NOT a
// stacking context, so a high-z-index child WOULD win) but becomes
// `position:fixed` in the docked/panel-hidden layout, which ALWAYS establishes
// a stacking context at z-index:auto — trapping any descendant below the modal.
// So the strip is parented to <body> (the root stacking context) with
// position:fixed and geometry mirrored from #view's bounding rect (recomputed
// each update), and z-index 3100 (just above the 3000 export backdrop, below no
// higher layer — 3000 is the top of the styles.css z-index scale).
function ensureBar() {
  if (barEl) return barEl;
  if (!document.body) return null;
  barEl = document.createElement('div');
  barEl.id = 'tracerProgress';
  barEl.style.cssText = 'position:fixed; height:3px;'
    + ' z-index:3100; pointer-events:none; opacity:0; transition:opacity 0.4s;'
    + ' background: rgba(128,128,128,0.15);';
  fillEl = document.createElement('div');
  fillEl.id = 'tracerProgressFill';
  fillEl.style.cssText = 'height:100%; width:0%;'
    + ' background: var(--highlight-color, #4caf50); transition:width 0.15s linear;';
  barEl.appendChild(fillEl);
  document.body.appendChild(barEl);
  return barEl;
}

/** Mirror the strip's fixed geometry onto #view's current bounding rect, so it
 *  spans the 3D view (excluding the UI column) regardless of layout/resize. */
function positionBar() {
  const view = document.getElementById('view');
  if (!view || !barEl) return;
  const r = view.getBoundingClientRect();
  barEl.style.left = `${r.left}px`;
  barEl.style.top = `${r.top}px`;
  barEl.style.width = `${r.width}px`;
}

/** Per-frame progress update from the tracer pipelines. */
export function updateTracerProgress(samples, target) {
  const bar = ensureBar();
  if (!bar) return;
  positionBar(); // keep aligned to #view across resizes / panel-collapse / docked mode
  // Perceptual mapping: Monte-Carlo error falls off as 1/sqrt(N), so most of
  // the visible quality arrives early — a linear bar would crawl through its
  // last half while the image looks done. sqrt makes bar motion track the
  // perceived refinement; the bar's END is still the exact point where the
  // accumulator stops (nothing changes after that).
  const fraction = Math.min(1, Math.max(0, samples / Math.max(1, target)));
  fillEl.style.width = `${(Math.sqrt(fraction) * 100).toFixed(1)}%`;
  if (fraction < 1) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    bar.style.opacity = '1';
  } else if (bar.style.opacity !== '0' && !hideTimer) {
    // converged: let the full bar be seen briefly, then fade out
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (barEl) barEl.style.opacity = '0';
    }, 350);
  }
}

/** Hide immediately (pipeline switch/dispose). */
export function hideTracerProgress() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (barEl) barEl.style.opacity = '0';
}
