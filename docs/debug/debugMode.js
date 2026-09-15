// Debug mode: switched on by a `debug` query parameter on the page URL —
// `index.html?debug` (any value other than 0/false). Nothing else enables it.
//
// The flag is read ONCE at module load. ShareModule strips its own state
// parameters from the URL after a shared link loads and FileURLLoader clears
// the hash, but both leave every other query parameter in place, so `?debug`
// survives a shared-link load and a reload of the same tab. Share links
// built while debugging drop the parameter (ShareModule.buildURL), so the
// mode is never handed to somebody else by accident.
//
// What it gates today: the Debug panel (ui/DebugPanel.js) and the sampler
// behind it (debug/debugSampler.js). The trace hooks the rest of the app
// calls (debug/debugTrace.js) are always safe to call — they are no-ops
// unless the sampler is listening.

const DEBUG_MODE = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('debug')) return false;
    const value = (params.get('debug') || '').trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'off';
  } catch {
    return false;
  }
})();

/** True when the page was opened with `?debug`. Constant for the page's life. */
export function isDebugMode() {
  return DEBUG_MODE;
}
