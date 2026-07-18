// Top-center banner over the 3D view (#view), shown whenever polyhedra are on
// ("Show Polyhedra" or "Complete Polyhedra") while a comparison structure is
// active — polyhedra rendering for the comparison structure isn't implemented
// yet (see the note in ui/ComparisonPanel.js), so this flags the gap directly
// in the viewport instead of only in a panel the user might not have open.
// Reactive to general.showPolyhedra/completePolyhedra and
// fileBrowser.comparisonStructure: call updatePolyhedraComparisonWarning()
// anywhere either can change — currently done once, at the top of
// updatePolyhedra() (render/PolyhedraModule.js), which already re-runs on
// every relevant toggle or comparison-structure change.

import { general, fileBrowser } from '../state/store.js';

let banner = null;

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-polyhedra-comparison-warning';
  banner.textContent = '⚠ Polyhedra are not shown for the comparison structure';
  banner.style.cssText = `
    position: absolute;
    top: 38px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2000;
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

export function updatePolyhedraComparisonWarning() {
  const el = ensureBanner();
  if (!el) return;
  const polyhedraOn = !!(general.showPolyhedra || general.completePolyhedra);
  el.style.display = (polyhedraOn && !!fileBrowser.comparisonStructure) ? 'block' : 'none';
}
