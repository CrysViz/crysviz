// Overall UI font scale: a single multiplier applied to the panel/window fonts
// via the --cv-font-scale CSS custom property (see styles/panelWindow.css).
// Class-based panel fonts (title bars, headlines, control labels, body text)
// scale; inline px font-sizes set in JS do not.

const LS_KEY = 'crysviz.fontScale.v1';

export const FONT_SCALE_MIN = 0.7;
export const FONT_SCALE_MAX = 1.6;
export const FONT_SCALE_DEFAULT = 1;

/** Read the persisted scale (falls back to 1 if unset/invalid). */
export function getFontScale() {
  try {
    const raw = parseFloat(localStorage.getItem(LS_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : FONT_SCALE_DEFAULT;
  } catch {
    // Opaque-origin iframe (sandbox without allow-same-origin): any localStorage
    // access throws SecurityError. Fall back to the default rather than kill boot.
    return FONT_SCALE_DEFAULT;
  }
}

/** Apply a scale to the document (does not persist). */
export function applyFontScale(scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : FONT_SCALE_DEFAULT;
  document.documentElement.style.setProperty('--cv-font-scale', String(s));
}

/** Apply and persist a scale. */
export function setFontScale(scale) {
  applyFontScale(scale);
  try { localStorage.setItem(LS_KEY, String(scale)); } catch { /* storage may be blocked */ }
}

/** Apply the persisted scale — call once at startup. */
export function initFontScale() {
  applyFontScale(getFontScale());
}
