// Energy Landscape windows: a CONTROLS window in the main dock (description +
// the addon's 📂 load button / drop target) and a separate PLOTS window
// ('landscapePlots') defaulting to the wide side dock. The plots window is
// not opened by hand — loading a landscape JSON (button or drop) opens it via
// the addon's onContent hook, so it appears exactly when there is something
// to show. All heatmap/grid content and interaction lives in
// docs/addons/landscape/landscape.js, driven through the addon API; the
// controller owns its own ResizeObserver, so side-dock resizes, tab switches
// and floating-window growth refit automatically.
//
// The plots window closes with closeMode:'hide' (detached, content kept): the
// controller — and its loaded JSON — stays alive across close/reopen. Its
// heatmaps live in a module-held host div that is re-parented into the plots
// window body, so the controller is created once (with the controls window)
// and never rebuilt.

import { createAddonAPI } from './AddonAPI.js';
import { createLandscape } from '../addons/landscape/landscape.js';
import { openPanel } from './panels/PanelManager.js';

let controller = null; // the landscape.js controller (created with the controls window)
let api = null;        // the addon API for the controller
let plotHost = null;   // persistent heatmap host, re-parented into the plots window

function ensureController(controlsHost) {
  if (controller) return;
  plotHost = document.createElement('div');
  plotHost.className = 'landscape-host';
  api = createAddonAPI();
  controller = createLandscape(plotHost, api, {
    controlsHost,
    // A load attempt started — surface the plots window (front tab of the
    // side dock by default) so the rows, or the error box, are visible.
    onContent() { openPanel('landscapePlots'); },
  });
}

/** Controls window ('landscape', main dock) body. */
export function addLandscapePanel(targetId = 'cvPanelBody-landscape') {
  const container = document.getElementById(targetId);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group landscape-intro">
      <p>Per-model energy heatmaps for a loaded landscape JSON. Load a JSON
      below (or drop a file here) — the Energy Landscape plot opens on the
      right, and clicking its tiles displaces atoms live in the main 3D
      viewer.</p>
      <div class="landscape-controls-host" id="landscapeControlsHost"></div>
    </div>
  `;

  ensureController(container.querySelector('#landscapeControlsHost'));
}

export function removeLandscapePanel() {
  controller?.destroy();
  api?.dispose();
  controller = null;
  api = null;
  plotHost = null;
}

/** Plots window ('landscapePlots', side dock by default) body: adopt the
 *  persistent heatmap host. */
export function addLandscapePlotsPanel(targetId = 'cvPanelBody-landscapePlots') {
  const container = document.getElementById(targetId);
  if (!container) return;
  // Normally the controls window built first (it is registered open); the
  // fallback covers a console/test openPanel before that, with the loader
  // landing inside the plots body itself.
  ensureController(null);
  container.appendChild(plotHost);
}

export function removeLandscapePlotsPanel() {
  // Detach (don't destroy) before the manager wipes the window body — the
  // controller and its loaded data survive for the next open.
  plotHost?.remove();
}
