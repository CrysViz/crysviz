// The load progress overlay over the 3D view (index.html #bootProgress): from
// the first paint until the first structure is drawn, and again while a large
// share link or .crysviz session is opened, so a long load reads as progress
// rather than a stuck page. Each step names what is happening and moves the
// bar on; once a load has taken 2 s, a seconds counter after the text shows it
// is still going.
//
// No continuous animation on purpose: a CSS animation over the 3D view keeps
// the compositor redrawing it every frame, and in the browser tests (software
// rendering) that took the CPU from the polyhedra workers — opening a styled
// share link went from 5 s to 20 s. The counter changes twice a second.
//
// Most of a large load is synchronous work on the main thread, which no DOM
// update can interrupt: a step is shown, then the caller awaits nextPaint()
// before starting the work.
//
// The start-up: on a slow connection most of it is downloading the viewer's
// ~400 script files, a stretch with no step to show (it looked stuck: the bar
// sat still for seconds). startBootProgress() (host/early.js, first thing)
// starts the seconds counter at once and moves the bar with every script file
// that arrives, against the count the last start-up needed (kept in this
// browser; a first visit uses BOOT_SCRIPTS_GUESS).

const root = () => document.getElementById('bootProgress');

let hideTimer = 0;
let tickTimer = 0;
let startedAt = 0;

const BOOT_SCRIPTS_KEY = 'crysviz.bootScripts';
/** Script files a start-up fetches, for a first visit (what this version
 *  needs to the first structure and its windows, measured; the real count is
 *  kept after each start-up). */
const BOOT_SCRIPTS_GUESS = 430;
/** The start-up's script download: its observer and count, while it runs. */
let bootScripts = null;

function tick() {
  const el = /** @type {HTMLElement|null} */ (document.getElementById('bootProgressElapsed'));
  if (!el) return;
  const seconds = Math.floor((performance.now() - startedAt) / 1000);
  el.textContent = seconds >= 2 ? `${seconds} s` : '';
}

/**
 * Whether this is the first start-up in this browser (no start-up has
 * finished here yet, or its local data was cleared). Then nothing can have
 * been customised yet, so the example structure may be drawn before the
 * windows (host/early.js): saved settings — per-structure prefs, custom
 * element colours, radii and bond lengths — are applied by the windows' code,
 * and a later start-up keeps that before the first structure.
 */
export function isFirstStart() {
  try { return localStorage.getItem(BOOT_SCRIPTS_KEY) === null; } catch { return true; }
}

/** Move the bar to `fraction` (0–1) unless it is already past it. */
function advanceFill(fraction) {
  const fill = /** @type {HTMLElement|null} */ (document.getElementById('bootProgressFill'));
  if (!fill) return;
  const current = Number(/scaleX\(([\d.]+)\)/.exec(fill.style.transform)?.[1] ?? 0);
  fill.style.transform = `scaleX(${Math.max(current, Math.min(1, fraction)).toFixed(3)})`;
}

/**
 * The start-up's own progress, from its first script: the seconds counter
 * runs from the start, and the bar moves with each script file downloaded
 * (up to 95 %, the rest is for the steps), so a slow download reads as
 * progress. Ended by finishLoadProgress().
 */
export function startBootProgress() {
  const el = root();
  if (!el || el.hidden) return;
  // Take over from the CSS creep (styles.css), where it has got to.
  const fill = /** @type {HTMLElement|null} */ (document.getElementById('bootProgressFill'));
  const crept = fill ? Number(/matrix\(([\d.]+)/.exec(getComputedStyle(fill).transform)?.[1] ?? 0) : 0;
  el.classList.add('is-tracking');
  if (crept > 0) advanceFill(crept);
  tick();
  if (!tickTimer) tickTimer = window.setInterval(tick, 500);
  if (bootScripts || typeof PerformanceObserver === 'undefined') return;
  let expected = BOOT_SCRIPTS_GUESS;
  try { expected = Number(localStorage.getItem(BOOT_SCRIPTS_KEY)) || expected; } catch { /* storage unavailable */ }
  const state = { count: 0, expected, observer: /** @type {PerformanceObserver|null} */ (null) };
  try {
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (/\.m?js(?:[?#]|$)/.test(entry.name)) state.count += 1;
      }
      if (!el.hidden && !el.classList.contains('is-done')) {
        advanceFill(0.08 + 0.87 * Math.min(1, state.count / state.expected));
      }
    });
    state.observer.observe({ type: 'resource', buffered: true });
    bootScripts = state;
  } catch { /* no resource timing: the steps alone move the bar */ }
}

/** End the start-up's download tracking; keep its count for the next visit. */
function endBootProgress() {
  if (!bootScripts) return;
  bootScripts.observer?.disconnect();
  if (bootScripts.count > 50) {
    try { localStorage.setItem(BOOT_SCRIPTS_KEY, String(bootScripts.count)); } catch { /* storage unavailable */ }
  }
  bootScripts = null;
}

/**
 * Show (or update) the overlay.
 * @param {string} text what is happening, e.g. "Opening the shared structure…"
 * @param {{fraction?: number|null, compact?: boolean}} [options] how far the
 *   whole load is, 0–1 (the bar never moves backwards within one load);
 *   compact: the structure is already drawn, so the card moves to the bottom
 *   of the view out of its way
 */
export function setLoadStep(text, { fraction = null, compact = false } = {}) {
  const el = root();
  if (!el) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
  if (el.hidden || el.classList.contains('is-done')) {
    // A new load (the first-paint one is already running: index.html).
    startedAt = performance.now();
    const fill = /** @type {HTMLElement|null} */ (document.getElementById('bootProgressFill'));
    if (fill) fill.style.transform = '';
  } // else the page's own load, counted from navigation (startedAt 0)
  el.hidden = false;
  el.classList.remove('is-done');
  el.classList.add('is-tracking'); // no CSS creep: the steps move the bar
  el.classList.toggle('is-compact', compact);
  const label = document.getElementById('bootProgressText');
  if (label && text) label.textContent = text;
  if (fraction != null) advanceFill(fraction);
  tick();
  if (!tickTimer) tickTimer = window.setInterval(tick, 500);
}

/** Fill the bar, fade the overlay out and hide it. Safe to call twice. */
export function finishLoadProgress() {
  endBootProgress();
  const el = root();
  if (!el || el.hidden) return;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  const fill = /** @type {HTMLElement|null} */ (document.getElementById('bootProgressFill'));
  if (fill) fill.style.transform = 'scaleX(1)';
  el.classList.add('is-done');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = 0;
    el.hidden = true;
    el.classList.remove('is-done', 'is-compact');
    if (fill) fill.style.transform = '';
    const elapsed = document.getElementById('bootProgressElapsed');
    if (elapsed) elapsed.textContent = '';
  }, 300);
}

/** Whether the overlay is showing. */
export function isLoadProgressShown() {
  const el = root();
  return !!el && !el.hidden && !el.classList.contains('is-done');
}

/**
 * Resolve once the current step has been painted, so its text is on screen
 * before the caller blocks the main thread. Two animation frames; a timer
 * stands in where frames do not run (a background tab).
 */
export function nextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 100);
  });
}
