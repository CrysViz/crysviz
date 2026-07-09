// Energy Landscape addon's wiring onto the shared right-side split view (see
// docs/ui/panels/SplitView.js for the generic pane/handle/tab/overlay
// plumbing this builds on, and docs/ui/DummySplitPanel.js /
// docs/ui/EOSSplitView.js for the two reference shapes this follows). Owns
// only the docked-panel description and the render/resize/close plumbing —
// all actual heatmap/grid content and interaction lives in
// docs/addons/landscape/landscape.js, driven through the addon API.

import { openSplitView, closeSplitView } from './panels/SplitView.js';
import { createAddonAPI } from './AddonAPI.js';
import { createLandscape } from '../addons/landscape/landscape.js';

let controller = null; // the landscape.js controller for the currently open pane
let structureChangeCb = null; // registered by createLandscape via the addon API

function renderContent(body) {
  const api = createAddonAPI({
    registerStructureChange: (cb) => { structureChangeCb = cb; },
    toolbar: null,
  });
  controller = createLandscape(body, api);
}

function handleResize() {
  // landscape.js drives its own ResizeObserver on the container it's given, so
  // this is a safe no-op unless the controller exposes an explicit refit.
  controller?.refit?.();
}

function handleClose() {
  controller?.destroy();
  controller = null;
  structureChangeCb = null;
}

const owner = {
  title: 'Energy Landscape',
  render: renderContent,
  onResize: handleResize,
  onClose: handleClose,
};

export function openLandscapeSplitView() {
  openSplitView(owner);
}

export function closeLandscapeSplitView() {
  closeSplitView(owner);
}

export function addLandscapePanel(targetId = 'cvPanelBody-landscape') {
  const container = document.getElementById(targetId);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group">
      <p>Per-model energy heatmaps for a loaded landscape JSON. Expand this
      panel to open the Energy Landscape on the right — load a JSON there
      (via its own header button, or by dropping a file onto the pane) to
      displace atoms live in the main 3D viewer.</p>
    </div>
  `;
}

export function removeLandscapePanel() {
  // The landscape controller's lifecycle is owned by the split-view pane
  // (render()/onClose() above), not the dock — nothing panel-specific to
  // tear down here.
}
