/**
 * Opt-in cross-origin isolation for the static (GitHub Pages) deployment, so
 * the threaded PET-MAD wasm can run — see ../coi-serviceworker.js for why a
 * service worker and why opt-in.
 *
 * State lives in localStorage (`crysviz.multithread`); `ensureIsolation()` is
 * called from host/early.js before the app boots: when the flag is set and the
 * page is not isolated yet, it registers the service worker and reloads once.
 * The PET-MAD controls flip the flag through setMultithreadEnabled().
 */

const STORAGE_KEY = 'crysviz.multithread';
const RELOAD_GUARD_KEY = 'crysviz.multithread.reloaded';
const SW_PATH = './coi-serviceworker.js';

function readFlag() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the user asked for the multi-threaded PET-MAD build. */
export function isMultithreadRequested() {
  return readFlag();
}

/** Whether this page can use SharedArrayBuffer (wasm threads) right now. */
export function isIsolated() {
  return typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
}

/** Service workers (and so this shim) are available in this context. */
export function canRequestIsolation() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && window.isSecureContext && globalThis.origin !== 'null';
}

// Contexts where the shim must stay out: the widget embed (an iframe whose
// host page we do not control) and the postMessage hand-offs, which COOP
// would cut off from their opener.
function contextForbidsIsolation() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('widget')) return true;
  const hash = window.location.hash;
  return hash === '#load-message' || hash === '#load-opener';
}

/**
 * Boot-time hook. Resolves to true when a reload has been triggered (the
 * caller should stop booting), false otherwise.
 */
export async function ensureIsolation() {
  if (!readFlag() || isIsolated() || !canRequestIsolation() || contextForbidsIsolation()) {
    return false;
  }
  // One reload per flag flip: an engine that ignores credentialless would
  // otherwise reload forever.
  let guarded = false;
  try {
    guarded = sessionStorage.getItem(RELOAD_GUARD_KEY) === '1';
  } catch { /* no sessionStorage */ }
  if (guarded) return false;
  try {
    const registration = await navigator.serviceWorker.register(SW_PATH, { scope: './' });
    // A fresh registration has no controller yet; the first reload picks it up.
    await registration.update().catch(() => { /* best effort */ });
    try { sessionStorage.setItem(RELOAD_GUARD_KEY, '1'); } catch { /* ignore */ }
    window.location.reload();
    return true;
  } catch (error) {
    console.warn('[coi] service worker registration failed; staying single-threaded:', error);
    return false;
  }
}

/**
 * Turn the multi-threaded mode on or off. Both directions reload the page (the
 * headers only take effect on a navigation); callers ask first
 * (ui/LeaveGuard.js confirmAppReload). Resolves to true when the reload is
 * under way, false when it could not be started (no service workers here, or
 * the registration failed), in which case nothing is changed.
 * @param {boolean} enabled
 * @returns {Promise<boolean>}
 */
export async function setMultithreadEnabled(enabled) {
  if (!canRequestIsolation()) return false;
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch { /* storage unavailable: nothing to persist */ }
  if (enabled) {
    if (await ensureIsolation()) return true;
    // Not reloading after all: leave the flag as it was, so the next start
    // does not try again behind the user's back.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return false;
  }
  const registration = await navigator.serviceWorker.getRegistration(SW_PATH).catch(() => null);
  if (registration) {
    await registration.unregister().catch(() => { /* ignore */ });
  }
  window.location.reload();
  return true;
}
