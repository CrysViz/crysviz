// Thin file-loading progress strip along the top edge of the 3D view — the
// same strip the ray/path tracers show their accumulation in
// (render/TracerProgressModule.js), styled by the same .tracer-progress-bar /
// .tracer-progress-fill rules, but its own element so a load and a tracer
// never fight over one bar. Fills with the fraction of the file read, then
// fades out. Used by the CHGCAR / ELFCAR loader, whose parse runs in a pool
// worker and reports progress back (io/ReadChgcarModule.js).
//
// Parented to <body> with position:fixed and geometry mirrored from #view's
// bounding rect on every update, for the stacking reasons given in
// TracerProgressModule.js's header.

let barEl = null;
let fillEl = null;
let hideTimer = null;

function ensureBar() {
  if (barEl) return barEl;
  if (!document.body) return null;
  barEl = document.createElement('div');
  barEl.id = 'loadProgress';
  barEl.className = 'tracer-progress-bar';
  barEl.setAttribute('role', 'progressbar');
  barEl.setAttribute('aria-label', 'Loading file');
  barEl.setAttribute('aria-valuemin', '0');
  barEl.setAttribute('aria-valuemax', '100');
  barEl.style.opacity = '0';
  fillEl = document.createElement('div');
  fillEl.className = 'tracer-progress-fill';
  barEl.appendChild(fillEl);
  document.body.appendChild(barEl);
  return barEl;
}

function positionBar() {
  const view = document.getElementById('view');
  if (!view || !barEl) return;
  const r = view.getBoundingClientRect();
  barEl.style.left = `${r.left}px`;
  barEl.style.top = `${r.top}px`;
  barEl.style.width = `${r.width}px`;
}

/**
 * Show the strip at `fraction` (0-1) of the way through a load.
 * @param {number} fraction
 */
export function showLoadProgress(fraction) {
  const bar = ensureBar();
  if (!bar) return;
  positionBar();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  if (bar.style.opacity === '0') {
    // A new load: jump to the start instead of sliding back from the full
    // width the previous load left behind.
    fillEl.style.transition = 'none';
    fillEl.style.width = `${(f * 100).toFixed(1)}%`;
    void fillEl.offsetWidth;
    fillEl.style.transition = '';
  }
  fillEl.style.width = `${(f * 100).toFixed(1)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  bar.style.opacity = '1';
}

/** Let the full strip be seen briefly, then fade it out. */
export function hideLoadProgress() {
  if (!barEl || hideTimer) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (barEl) barEl.style.opacity = '0';
  }, 250);
}
