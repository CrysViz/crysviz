// Top-center banner over the 3D view (#view), shown whenever "Show Forces"
// and "Show Spins" are both on at once — the two arrow sets share the same
// visual language (a shaft + tip per atom) and are otherwise indistinguishable
// without reading the legend, so this exists purely to stop that confusion.
// Reactive to general.forcesActive/spinsActive: call updateForceSpinWarning()
// anywhere either flag can change (currently only the two Features-menu
// toggle handlers in ui/panels/defaultPanels.js set them).

import { general } from '../state/store.js';

let banner = null;

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-warning-banner cv-force-spin-warning';
  banner.textContent = '⚠ Forces and Spins are both shown as arrows';
  view.appendChild(banner);
  return banner;
}

export function updateForceSpinWarning() {
  const el = ensureBanner();
  if (!el) return;
  el.style.display = (general.forcesActive && general.spinsActive) ? 'block' : 'none';
}
