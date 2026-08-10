import { fileBrowser } from '../../state/store.js';

// The logo's wordmark is a pale grey that only reads on a dark dock, so each
// backend tint needs a dark-lettered twin. The *_black_lettering files are the
// same artwork with every neutral pixel repainted #616161 — the rule the
// original CrysViz_logo_clear_back_black_lettering.png already followed.
const LOGOS = {
  standard: {
    dark: './data/CrysViz_logo_clear_back_beta.png',
    light: './data/CrysViz_logo_clear_back_beta_black_lettering.png',
  },
  symmetry: {
    dark: './data/CrysViz_logo_clear_back_beta_blue.png',
    light: './data/CrysViz_logo_clear_back_beta_blue_black_lettering.png',
  },
};

// The About modal carries the same logo without the beta badge, and its own
// surface (--about-bg) follows the palette, so it flips on the same signal.
const ABOUT_LOGOS = {
  dark: './data/CrysViz_logo_clear_back.png',
  light: './data/CrysViz_logo_clear_back_black_lettering.png',
};

// Whether the dock itself is light — NOT whether the light MODE is selected.
// The default palette keeps dark panels in both of its modes (it declares
// --color-scheme: dark in themes/default/theme.css and its light mode adds no
// override at all), so asking the mode would swap the logo on a dock that is
// still charcoal. The light palettes are exactly the ones that redeclare it.
function dockIsLight() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--color-scheme').trim() === 'light';
}

function setLogoForTheme(themeName) {
  const surface = dockIsLight() ? 'light' : 'dark';
  const header = /** @type {HTMLImageElement | null} */ (document.getElementById('aboutTrigger'));
  if (header) header.src = (LOGOS[themeName] || LOGOS.standard)[surface];
  const about = /** @type {HTMLImageElement | null} */ (document.querySelector('#aboutModal .logo'));
  if (about) about.src = ABOUT_LOGOS[surface];
}

export function resolveBackendTheme() {
  const structure = fileBrowser.selectedStructure;
  const symmetryLocked = structure?.symmetry?.mode === 'wyckoff';
  // Only the Wyckoff lock tints the UI now (blue). Relax/MD compute modes no
  // longer recolor the interface.
  if (symmetryLocked) return 'symmetry';
  return 'standard';
}

export function applyBackendTheme(themeName) {
  const body = document.body;
  if (!body) return;

  const themeClasses = ['theme-standard', 'theme-symmetry'];
  body.classList.remove(...themeClasses);
  body.classList.add(`theme-${themeName}`);
  setLogoForTheme(themeName);
}

export function refreshBackendTheme() {
  applyBackendTheme(resolveBackendTheme());
}
