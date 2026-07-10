import { fileBrowser } from '../../state/store.js';

function setLogoForTheme(themeName) {
  const figure = document.getElementById('aboutTrigger');
  if (!figure) return;

  if (themeName === 'symmetry') {
    figure.src = './data/CrysViz_logo_clear_back_beta_blue.png';
  } else {
    figure.src = './data/CrysViz_logo_clear_back_beta.png';
  }
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
