// Top-center banner over the 3D view (#view), shown whenever polyhedra are on
// ("Show Polyhedra" or "Complete Polyhedra") while one or more structures are
// overlaid — polyhedra rendering for overlay structures isn't implemented yet
// (see the note in ui/ComparisonPanel.js), so this flags the gap directly in
// the viewport instead of only in a panel the user might not have open.
// Reactive to general.showPolyhedra/completePolyhedra and
// fileBrowser.overlayEntries: call updatePolyhedraComparisonWarning()
// anywhere either can change — currently done once, at the top of
// updatePolyhedra() (render/PolyhedraModule.js), which already re-runs on
// every relevant toggle or overlay-entries change.

import { general, fileBrowser } from '../state/store.js';

let banner = null;

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-warning-banner cv-polyhedra-comparison-warning';
  banner.textContent = '⚠ Polyhedra are not shown for overlay structures';
  view.appendChild(banner);
  return banner;
}

export function updatePolyhedraComparisonWarning() {
  const el = ensureBanner();
  if (!el) return;
  const polyhedraOn = !!(general.showPolyhedra || general.completePolyhedra);
  el.style.display = (polyhedraOn && fileBrowser.overlayEntries.length > 0) ? 'block' : 'none';
}
