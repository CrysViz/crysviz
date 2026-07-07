import { fileBrowser, general } from '../../state/store.js';

function setLogoForTheme(themeName) {
  const figure = document.getElementById('aboutTrigger');
  if (!figure) return;

  if (themeName === 'ase') {
    figure.src = './data/CrysViz_logo_clear_back_beta_red.png';
  } else if (themeName === 'symmetry' || themeName === 'locked-ase') {
    figure.src = './data/CrysViz_logo_clear_back_beta_blue.png';
  } else {
    figure.src = './data/CrysViz_logo_clear_back_beta.png';
  }
}

export function resolveBackendTheme() {
  const structure = fileBrowser.selectedStructure;
  const symmetryLocked = structure?.symmetry?.mode === 'wyckoff';
  // Any atomistic compute mode tints the UI red, so switching Viz <-> Relax/MD
  // is an immediate whole-interface color change (the original behavior of the
  // mode switch). The Wyckoff lock keeps its blue / purple overlays.
  const atomisticMode = general.backendState === 'relax'
    || general.backendState === 'md'
    || general.backendState === 'live';

  if (symmetryLocked && atomisticMode) return 'locked-ase';
  if (symmetryLocked) return 'symmetry';
  if (atomisticMode) return 'ase';
  return 'standard';
}

export function applyBackendTheme(themeName) {
  const body = document.body;
  if (!body) return;

  const themeClasses = ['theme-standard', 'theme-ase', 'theme-symmetry', 'theme-locked-ase'];
  body.classList.remove(...themeClasses);
  body.classList.add(`theme-${themeName}`);
  setLogoForTheme(themeName);
}

export function refreshBackendTheme() {
  applyBackendTheme(resolveBackendTheme());
}
