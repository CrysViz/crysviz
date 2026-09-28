// Experimental mode: switched on by an `experimental` query parameter on the
// page URL — `index.html?experimental` (any value other than 0/false/off),
// exactly like `?debug` (debug/debugMode.js). Nothing else enables it.
//
// It gates features that work but are not yet benchmarked against the
// reference implementations they mirror, so they can ship in the codebase
// and be exercised by their tests without reaching users by default. Today:
// the phonon mode map (ui/PhononPanel.js), pending a comparison with ModeMap,
// and the Spins panel's Comparison Spins section (ui/SpinComparisonSection.js).
// Read ONCE at module load; share links drop the parameter
// (ShareModule.buildURL) so the mode is never handed on by accident.

const EXPERIMENTAL_MODE = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('experimental')) return false;
    const value = (params.get('experimental') || '').trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'off';
  } catch {
    return false;
  }
})();

/** True when the page was opened with `?experimental`. Constant for the page's life. */
export function isExperimentalMode() {
  return EXPERIMENTAL_MODE;
}
