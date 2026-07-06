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

function ensureBar() {
  if (barEl) return barEl;
  const view = document.getElementById('view');
  if (!view) return null;
  barEl = document.createElement('div');
  barEl.id = 'tracerProgress';
  barEl.style.cssText = 'position:absolute; top:0; left:0; right:0; height:3px;'
    + ' z-index:1100; pointer-events:none; opacity:0; transition:opacity 0.4s;'
    + ' background: rgba(128,128,128,0.15);';
  fillEl = document.createElement('div');
  fillEl.id = 'tracerProgressFill';
  fillEl.style.cssText = 'height:100%; width:0%;'
    + ' background: var(--highlight-color, #4caf50); transition:width 0.15s linear;';
  barEl.appendChild(fillEl);
  view.appendChild(barEl);
  return barEl;
}

/** Per-frame progress update from the tracer pipelines. */
export function updateTracerProgress(samples, target) {
  const bar = ensureBar();
  if (!bar) return;
  const fraction = Math.min(1, Math.max(0, samples / Math.max(1, target)));
  fillEl.style.width = `${(fraction * 100).toFixed(1)}%`;
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
