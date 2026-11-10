// A leaf module (no imports) so the atom, bond and focus-region modules can
// ask for the in-wedge highlight to refresh without importing
// AsymmetricUnitModule and, through it, UI modules that import them back.
// AsymmetricUnitModule registers the real refresh.
let refresh = () => {};

/** @param {() => void} fn */
export function setAsuHighlightRefresh(fn) {
  refresh = fn;
}

export function refreshAsuHighlight() {
  refresh();
}
