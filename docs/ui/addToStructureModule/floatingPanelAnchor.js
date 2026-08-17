// floatingPanelAnchor.js
//
// Where the on-demand editor panels in this module open (Add Atoms/Vacuum,
// Add Structure, Modify Structure) — all of them go through openEditorPanel().
//
// On a roomy viewport they float just to the right of the left sidebar,
// matching where the old hand-rolled popups used to appear (they used the
// `--popup-left` CSS var, which registerPanel()'s anchor - a plain {left,top}
// pixel pair - can't reference directly). The anchor also has to account for
// viewport width itself: PanelWindow's clampToViewport() only guarantees the
// title bar's LEFT edge stays reachable (by design, so a panel can be
// deliberately dragged mostly off-screen), so a wide panel anchored right of a
// wide sidebar would lose its title-bar icons - including the close button -
// off the right edge.
//
// Below the compact breakpoint there is no room to float at all: PanelManager
// force-docks every non-exempt panel into the main dock, which is a ~380px
// column of an already narrow screen, and these editors were unusable in it.
// They take the side dock instead, along whichever viewport edge is the long
// one.

import { registerPanel, openPanel } from '../panels/PanelManager.js';
import { setSideDockSide } from '../panels/SideDock.js';

const COMPACT_QUERY = '(max-width: 1024px)';
const MAX_PANEL_WIDTH_ESTIMATE = 560; // widest panel this anchor is used for (AddStructureModule)
const VIEWPORT_MARGIN = 8;

function defaultFloatingAnchor() {
  const ui = document.getElementById('ui');
  const desiredLeft = (ui?.getBoundingClientRect().right ?? 410) + 10;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MAX_PANEL_WIDTH_ESTIMATE - VIEWPORT_MARGIN);
  const left = Math.min(desiredLeft, maxLeft);
  return { left, top: 150 };
}

/** Register one of this module's editor panels and bring it up where it
 *  belongs for the current viewport. */
export function openEditorPanel(def) {
  if (!window.matchMedia(COMPACT_QUERY).matches) {
    return registerPanel({
      ...def,
      defaults: { dock: false, collapsed: false, barCollapsed: false, anchor: defaultFloatingAnchor() },
    });
  }
  // Portrait is short of width, landscape short of height: dock to the edge
  // the editor can spread along without squeezing the scene from the side.
  setSideDockSide(window.innerHeight > window.innerWidth ? 'bottom' : 'right');
  const panel = registerPanel({
    ...def,
    defaults: { dock: 'right', collapsed: false, barCollapsed: false },
  });
  // Registration side-docks the window but leaves the pane as it found it —
  // an editor opened by a button press has to become the front tab, and the
  // pane has to be open, or the press looks like it did nothing.
  openPanel(def.id);
  return panel;
}
