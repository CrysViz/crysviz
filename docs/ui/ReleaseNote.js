// Release note: a small card announcing something new, beside the sidebar's
// search field (bottom centre when the sidebar is hidden or on a phone).
//
// Shown on every visit until the user ticks "Don't show this again" — saved
// on EITHER button, like the ray-tracing warning (RaytraceWarningModal.js).
// The saved value is the note's id, a date first ("2026-10-28-search"), so a
// later note shows again while this one stays dismissed: a note is hidden
// when panelPrefs.releaseNoteSeen >= its id. "Close" hides it for this visit
// only; "Try it", or opening the search any other way, does too.

import { getPanelPref, setPanelPref } from './panels/PanelManager.js';
import { openFeatureSearch, isFeatureSearchOpen } from './FeatureSearch.js';
import { searchShortcutLabel } from './FeatureStoreModal.js';

const NOTE_ID = '2026-10-28-search';
const GAP = 12; // px between the search field and the card

let card = null;
let dontShowInput = null;
let watchTimer = 0;

/** Has the user dismissed this note (or a later one) for good? */
export function isReleaseNoteDismissed() {
  return String(getPanelPref('releaseNoteSeen') || '') >= NOTE_ID;
}

export function isReleaseNoteOpen() {
  return !!card && !card.hidden;
}

function build() {
  if (card) return;
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const how = touch
    ? 'Tap the search field at the top of the left panel'
    : `Press <kbd class="feature-search-kbd">${searchShortcutLabel()}</kbd> or click the search field`;
  card = document.createElement('div');
  card.id = 'releaseNote';
  card.className = 'release-note';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', 'releaseNoteTitle');
  card.hidden = true;
  card.innerHTML = `
    <div class="release-note-badge">New</div>
    <h2 class="release-note-title" id="releaseNoteTitle">Search everything</h2>
    <p class="release-note-text">${how} to find any window, button or setting — including
      windows not in your sidebar, which it adds for you.</p>
    <p class="release-note-text">Search with the term you know: <em>lattice vibrations</em>
      finds Phonons, <em>relaxation</em> finds Atomistic.</p>
    <label class="release-note-check"><input type="checkbox" id="releaseNoteDontShow">Don't show this again</label>
    <div class="release-note-actions">
      <button type="button" class="release-note-close" id="releaseNoteClose">Close</button>
      <button type="button" class="release-note-try" id="releaseNoteTry">Try it</button>
    </div>`;
  document.body.appendChild(card);
  dontShowInput = /** @type {HTMLInputElement} */ (card.querySelector('#releaseNoteDontShow'));
  card.querySelector('#releaseNoteClose').addEventListener('click', () => closeReleaseNote());
  card.querySelector('#releaseNoteTry').addEventListener('click', () => {
    closeReleaseNote();
    openFeatureSearch();
  });
}

/** Beside the sidebar's search field while it is on screen, else bottom centre. */
function place() {
  const trigger = document.getElementById('featureSearchButton');
  const r = trigger?.getBoundingClientRect();
  const visible = !!r && r.width > 0 && r.right > 0 && r.left < window.innerWidth
    && r.right + GAP + card.offsetWidth <= window.innerWidth;
  card.classList.toggle('release-note-anchored', visible);
  card.style.left = visible ? `${r.right + GAP}px` : '';
  card.style.top = visible ? `${Math.max(GAP, r.top + r.height / 2 - 28)}px` : '';
}

export function showReleaseNote() {
  build();
  dontShowInput.checked = false;
  card.hidden = false;
  place();
  // The sidebar can slide away or the window resize while the card is up;
  // opening the search any other way (Ctrl/Cmd+F) means the note did its job.
  clearInterval(watchTimer);
  watchTimer = window.setInterval(() => {
    if (isFeatureSearchOpen()) closeReleaseNote();
    else place();
  }, 400);
}

/** Hide the card; a ticked "Don't show this again" is saved either way. */
export function closeReleaseNote() {
  if (!card || card.hidden) return;
  if (dontShowInput.checked) setPanelPref('releaseNoteSeen', NOTE_ID);
  card.hidden = true;
  clearInterval(watchTimer);
}

/** Show the note with the windows (the next frame), unless dismissed. Full
 *  app only. */
export function initReleaseNote() {
  if (isReleaseNoteDismissed()) return;
  requestAnimationFrame(() => {
    if (!isReleaseNoteDismissed() && !isFeatureSearchOpen()) showReleaseNote();
  });
}
