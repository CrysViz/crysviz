// A short green confirmation over the 3D view (#view) after an action taken
// from the feature search, which does it without showing the control:
// "✓ Bonds switched off", "✓ 2×2×2 supercell built (104 atoms)". The warning
// banners' shell (styles/warningBanners.css: Forces+Spins, Disorder, …) in
// green instead of amber, placed below any warning on screen, and gone after
// a moment (one fade-out, no continuous animation over the 3D view).

let banner = null;
let hideTimer = 0;
let leaveTimer = 0;

const SHOW_MS = 2200;
const FADE_MS = 300; // the opacity transition in warningBanners.css

/**
 * Show a confirmation for a moment (a new one replaces the one showing).
 * @param {string} text what was done, without the tick: "Bonds switched off"
 */
export function showConfirmation(text) {
  const view = document.getElementById('view');
  if (!view) return;
  if (!banner || !banner.isConnected) {
    banner = document.createElement('div');
    banner.className = 'cv-warning-banner cv-confirm-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    view.appendChild(banner);
  }
  banner.textContent = `✓ ${text}`;
  // The warnings keep their slots at the top; this goes below the lowest one
  // on screen.
  const viewTop = view.getBoundingClientRect().top;
  let top = 5;
  for (const warning of view.querySelectorAll('.cv-warning-banner:not(.cv-confirm-banner)')) {
    const el = /** @type {HTMLElement} */ (warning);
    if (getComputedStyle(el).display === 'none') continue;
    top = Math.max(top, el.getBoundingClientRect().bottom - viewTop + 4);
  }
  banner.style.top = `${Math.round(top)}px`;
  banner.classList.remove('is-leaving');
  banner.style.display = 'block';
  clearTimeout(hideTimer);
  clearTimeout(leaveTimer);
  hideTimer = window.setTimeout(() => {
    banner.classList.add('is-leaving');
    leaveTimer = window.setTimeout(() => {
      banner.style.display = 'none';
      banner.classList.remove('is-leaving');
    }, FADE_MS);
  }, SHOW_MS);
}
