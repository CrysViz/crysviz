// floatingPanelAnchor.js
//
// Default open position for the on-demand floating panels in this module
// (Add Atoms/Vacuum, Add Structure): just to the right of the left sidebar,
// matching where the old hand-rolled popups used to appear (they used the
// `--popup-left` CSS var, which registerPanel()'s anchor - a plain {left,top}
// pixel pair - can't reference directly).
//
// On narrow/mobile viewports (<1024px) the sidebar (#ui) can span most of
// the screen width when open, so anchoring "just right of it" pushes a wide
// panel mostly or entirely off-screen - including its title bar's right-side
// icons (home/minimize/dock/close), which is where the close button lives.
// PanelWindow's own clampToViewport() only guarantees the title bar's LEFT
// edge stays reachable (by design, so a panel can be deliberately dragged
// mostly off-screen); it does not protect the right side, so the anchor
// itself has to account for viewport width instead.
const MAX_PANEL_WIDTH_ESTIMATE = 560; // widest panel this anchor is used for (AddStructureModule)
const VIEWPORT_MARGIN = 8;

export function defaultFloatingAnchor() {
  const ui = document.getElementById('ui');
  const desiredLeft = (ui?.getBoundingClientRect().right ?? 410) + 10;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MAX_PANEL_WIDTH_ESTIMATE - VIEWPORT_MARGIN);
  const left = Math.min(desiredLeft, maxLeft);
  return { left, top: 150 };
}
