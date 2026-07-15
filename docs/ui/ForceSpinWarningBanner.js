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
  banner.className = 'cv-force-spin-warning';
  banner.textContent = '⚠ Forces and Spins are both shown as arrows';
  banner.style.cssText = `
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    padding: 6px 14px;
    border-radius: 6px;
    background: rgba(40, 30, 0, 0.85);
    border: 1px solid rgba(255, 193, 7, 0.6);
    color: #ffc107;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    display: none;
  `;
  view.appendChild(banner);
  return banner;
}

export function updateForceSpinWarning() {
  const el = ensureBanner();
  if (!el) return;
  el.style.display = (general.forcesActive && general.spinsActive) ? 'block' : 'none';
}
