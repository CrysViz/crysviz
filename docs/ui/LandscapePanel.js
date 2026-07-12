// Energy Landscape window: one ordinary panel window (registered in
// ui/panels/defaultPanels.js as 'landscape', defaulting to the wide right
// dock) whose body hosts the landscape addon. All actual heatmap/grid content
// and interaction lives in docs/addons/landscape/landscape.js, driven through
// the addon API; the controller owns its own ResizeObserver, so right-dock
// resizes, tab switches and floating-window growth refit automatically.
//
// The window closes with closeMode:'hide' (detached, content kept), so the
// controller — and its loaded JSON — stays alive across close/reopen. It is
// destroyed only when the window content is really torn down
// (removeLandscapePanel via the panel def's onDestroyContent).

import { createAddonAPI } from './AddonAPI.js';
import { createLandscape } from '../addons/landscape/landscape.js';

let controller = null; // the landscape.js controller for the current content
let api = null;        // the addon API for the current content

export function addLandscapePanel(targetId = 'cvPanelBody-landscape') {
  const container = document.getElementById(targetId);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group landscape-intro">
      <p>Per-model energy heatmaps for a loaded landscape JSON. Load a JSON
      (via the header button below, or by dropping a file onto this window)
      to displace atoms live in the main 3D viewer.</p>
    </div>
    <div class="landscape-host"></div>
  `;

  api = createAddonAPI();
  controller = createLandscape(container.querySelector('.landscape-host'), api);
}

export function removeLandscapePanel() {
  controller?.destroy();
  api?.dispose();
  controller = null;
  api = null;
}
