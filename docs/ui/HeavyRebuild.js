// Display toggles that rebuild every atom and bond — bonds, periodic images,
// neighbour bonds, polyhedra — cost seconds of main-thread work at 10^5
// atoms. Two things keep the app from looking frozen there:
//  - runHeavyRebuild(fn): on a large structure the busy strip
//    (render/TracerProgressModule.js, the ray tracer's progress bar) is shown
//    and painted before the rebuild runs, and keeps sweeping during it. Small
//    structures run fn at once, exactly as before.
//  - setPlaybackLock(on): while a large trajectory plays, those toggles are
//    greyed out with a "pause first" hint. Each would stall playback for
//    seconds (polyhedra even rebuild every frame).

import { fileBrowser, groups } from '../state/store.js';
import { peekAtoms } from '../model/materializeFrame.js';
import { LARGE_REBUILD_ATOMS } from '../render/BondsFracUpdateModule.js';
import { showBusyProgress, hideBusyProgress } from '../render/TracerProgressModule.js';

export const HEAVY_TOGGLE_IDS = ['showBonds', 'showPeriodic', 'PBCBondToggle', 'showPolyhedra', 'completePolyhedraToggle'];
export const PAUSE_FIRST_MSG = 'Pause playback first: on a structure this large this rebuilds every atom and bond';

/** Large enough for a full rebuild to take a noticeable time: the structure's
 *  atoms or the drawn atoms (periodic images included), whichever is more. */
export function isLargeDisplay() {
  const atoms = peekAtoms(fileBrowser.selectedStructure)?.length ?? 0;
  return Math.max(atoms, groups.atomsMesh?.count ?? 0) >= LARGE_REBUILD_ATOMS;
}

// The busy strip on screen — its frame committed to the compositor, which then
// runs the sweep on its own — before the work blocks the thread: the second
// animation frame starts after the first was presented. (The timeout covers
// frames that never come, e.g. a hidden tab.)
const nextPaint = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; setTimeout(resolve, 0); } };
  requestAnimationFrame(() => requestAnimationFrame(go));
  setTimeout(go, 150);
});

let queue = Promise.resolve();
let pending = 0;

/**
 * Run a display rebuild, behind the busy strip on a large structure. Runs are
 * serialised, so a second toggle waits for the first.
 * @param {() => void} fn
 * @returns {Promise<void>}
 */
export function runHeavyRebuild(fn) {
  if (!isLargeDisplay()) {
    fn();
    return Promise.resolve();
  }
  pending += 1;
  showBusyProgress();
  document.body.classList.add('cv-busy');
  const run = queue.then(async () => {
    try {
      await nextPaint();
      fn();
    } finally {
      hideBusyProgress();
      pending -= 1;
      if (!pending) document.body.classList.remove('cv-busy');
    }
  });
  queue = run.catch(() => {});
  return run;
}

let locked = false;

/** Whether the heavy toggles are locked for playback. */
export const playbackLocked = () => locked;

/**
 * Grey out (or release) the heavy toggles. A row the Polyhedron Inspector
 * holds (.is-forced-disabled) stays disabled after release.
 * @param {boolean} on
 */
export function setPlaybackLock(on) {
  if (on === locked) return;
  locked = on;
  for (const id of HEAVY_TOGGLE_IDS) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (!input) continue;
    const row = /** @type {HTMLElement|null} */ (input.closest('.toggle_row'));
    input.disabled = on || !!row?.classList.contains('is-forced-disabled');
    if (!row) continue;
    row.classList.toggle('is-playback-locked', on);
    if (on) {
      row.dataset.titleBeforeLock = row.title;
      row.title = PAUSE_FIRST_MSG;
    } else {
      if (row.title === PAUSE_FIRST_MSG) row.title = row.dataset.titleBeforeLock ?? '';
      delete row.dataset.titleBeforeLock;
    }
  }
}
