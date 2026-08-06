// Mobile hamburger menu + responsive panel toggle.
// Extracted from crystal-viewer.js (Stage 3). Wires the #mobileMenuToggle and
// #mobileOverlay elements to show/hide the #ui panel (desktop hide vs mobile
// slide-over) and refreshes the renderer after the layout change.

import { app } from '../state/store.js';
import { resizeRenderer } from './WindowAndSceneControls.js';

// Must match responsive.css's `compact` rung exactly (max-width: 1024px) —
// that's the query that switches #ui from in-flow desktop chrome to a
// fixed off-canvas panel. PanelManager.js's dockOccupiesSpace() has the same
// number for the same reason; CSS has no custom-media mechanism to share a
// single declaration across both languages, so matchMedia's query string is
// the closest thing to one: at least the two threads run through the same
// browser evaluation instead of JS re-deriving it from window.innerWidth.
const COMPACT_QUERY = '(max-width: 1024px)';

export function setupMobileMenu() {
  const hamburger = document.getElementById('mobileMenuToggle');
  const overlay = document.getElementById('mobileOverlay');
  const ui = document.getElementById('ui');
  const compactQuery = window.matchMedia(COMPACT_QUERY);

  function togglePanel() {
    if (!ui) return;

    if (!compactQuery.matches) {
      // Desktop: toggle panel-hidden
      ui.classList.toggle('panel-hidden');
      document.body.classList.toggle('panel-hidden');
    } else {
      // Mobile: toggle panel-open
      ui.classList.toggle('panel-open');
      if (overlay) overlay.classList.toggle('active');
    }

    // Refresh renderer immediately after layout change
    if (typeof resizeRenderer === 'function') {
      resizeRenderer(app.orthographicFrustumSize);
    }
  }

  function closePanel() {
    if (!ui) return;
    ui.classList.remove('panel-open', 'panel-hidden');
    document.body.classList.remove('panel-hidden');
    if (overlay) overlay.classList.remove('active');
  }

  if (hamburger) {
    hamburger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    hamburger.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
  }

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      closePanel();
    });

    overlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      closePanel();
    });
  }
}
