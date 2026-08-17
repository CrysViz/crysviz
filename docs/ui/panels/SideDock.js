// The side dock (formerly the "split view"): a wide, resizable pane on the
// right edge of the screen — or, via the ⇩/⇒ header toggle, along the BOTTOM
// edge (dockSide) — that hosts regular PanelWindows as TABS. Any window can
// be dropped here (drag to the docked border) and dragged back out (drag its
// tab away) — the same PanelWindow instances the main dock and floating
// windows use, so "everything is the same kind of Window".
//
// While a window is side-docked its element lives inside #splitPaneBody with
// the cv-side-docked class (title bar hidden — the tab is the chrome) and
// exactly one window carries cv-front (visible, filling the pane). Switching
// tabs only toggles classes: content is never re-rendered, so transient state
// (a loaded file, scroll position) survives a tab switch. The whole dock
// collapses to edge pull-tabs via the » button; individual windows have no
// collapse here.
//
// This module owns only the pane plumbing (chrome, resize handle, tabs, tab
// drag, drop zone, fullscreen-item overlay). Registry/persistence concerns
// stay in PanelManager.js, reached through the hooks passed to initSideDock:
//   resolvePanel(id) -> PanelWindow|null
//   getPref(name) -> boolean            panelPrefs (dragIntoDock/dragOutOfDock)
//   onLayoutChange()                    any persistable state changed
//   setRightReserve(px)                 width the pane occupies on the right
//   setBottomReserve(px)                height it occupies when docked bottom
//   floatPanelForDrag(panel, pos)       float a pulled-out window mid-gesture
//   hasCompactLauncher(panel) -> bool   the window currently has its own round
//                                       launcher icon in the scene

import { resizeRenderer } from '../WindowAndSceneControls.js';
import { requestRender } from '../../render/index.js';
import { app } from '../../state/store.js';
import { showInfoPanel } from '../InfoPanel.js';

const DEFAULT_PANE_FRACTION = 1 / 3;
const MIN_PANE_PX = 220; // dragged narrower than this -> snap collapsed
const DRAG_THRESHOLD = 4; // px of movement before a tab press becomes a drag
// How far outside the tab strip a tab drag must travel before the window is
// pulled out of the dock (hysteresis against accidental pull-outs).
const DRAG_OUT_PX = 24;
// Drop-zone width along the right screen edge while the dock is closed or
// collapsed (with the pane open, the whole pane is the drop zone).
const EDGE_BAND_PX = 48;

let hooks = null;
let collapsed = false;
let paneFraction = DEFAULT_PANE_FRACTION;
let frontId = null; // id of the window currently shown in the pane body
// Which viewport edge the dock hugs: 'right' (default) or 'bottom'. Bottom
// mode aligns the pane's left edge with the 3D scene's left edge (not the
// full viewport) so it never overlaps the #ui side panel — see
// #viewArea.split-dock-bottom in sideDock.css. Persisted in the layout
// blob's historical rightDock.side field (kept for persisted-layout compatibility).
let dockSide = 'right';
let wired = false;

function els() {
  return {
    viewArea: document.getElementById('viewArea'),
    view: document.getElementById('view'),
    pane: document.getElementById('splitPane'),
    body: document.getElementById('splitPaneBody'),
    handle: document.getElementById('splitHandle'),
    tabs: document.getElementById('splitPaneTabs'),
    headerTabs: document.getElementById('splitPaneHeaderTabs'),
    overlay: document.getElementById('splitPaneOverlay'),
    infoBtn: document.getElementById('splitPaneInfoBtn'),
    dockBtn: document.getElementById('splitPaneDockBtn'),
    dropHint: document.getElementById('sideDockDropHint'),
  };
}

/** All side-docked windows in pane DOM order (the tab order). */
function attachedPanels() {
  const { body } = els();
  if (!body || !hooks) return [];
  return Array.from(body.querySelectorAll(':scope > .cv-panel'))
    .map((el) => hooks.resolvePanel(/** @type {HTMLElement} */ (el).dataset.panelId))
    .filter(Boolean);
}

/** Side-docked windows that should show as tabs (hiddenUntilStructure
 *  windows stay attached but tab-less until a structure loads). */
function visiblePanels() {
  return attachedPanels().filter((p) => !p.el.hidden);
}

function frontPanel() {
  return frontId && hooks ? hooks.resolvePanel(frontId) : null;
}

export function isSideDockActive() {
  return visiblePanels().length > 0;
}

function applyPaneWidth() {
  const { viewArea } = els();
  if (!viewArea) return;
  // Set on the root (not the pane) — #view and the handle are siblings of
  // the pane, not descendants, so they need it too (CSS vars only inherit
  // down the tree from where they're declared).
  document.documentElement.style.setProperty('--split-pane-fraction', String(paneFraction));
  viewArea.classList.toggle('split-dock-bottom', dockSide === 'bottom');
  if (collapsed) viewArea.classList.add('split-pane-collapsed');
  else viewArea.classList.remove('split-pane-collapsed');
}

/** Switch which viewport edge the dock hugs. No-op if already there. */
export function setSideDockSide(side) {
  if (dockSide === side || (side !== 'right' && side !== 'bottom')) return;
  dockSide = side;
  applyPaneWidth();
  syncSceneAndSidePanels();
  updateDockBtn();
  hooks?.onLayoutChange();
}

function updateDockBtn() {
  const { dockBtn } = els();
  if (!dockBtn) return;
  dockBtn.textContent = dockSide === 'bottom' ? '⇒' : '⇩';
  dockBtn.title = dockSide === 'bottom' ? 'Dock to the right' : 'Dock to the bottom';
}

/**
 * Re-derive the space the pane currently occupies next to #view and push
 * that out to everything that needs to stay clear of it: the 3D renderer
 * (resize + a fresh on-demand frame — #view's size can change here without a
 * window resize event ever firing), floating panels anchored to that same
 * edge (Structure info, ...) via PanelManager's right-/bottom-reserve, and
 * plain fixed-position chrome (the background-dot, the axes gizmo/legend)
 * via the --split-reserve / --split-reserve-bottom custom properties.
 */
function syncSceneAndSidePanels() {
  const { view } = els();
  if (!view || !hooks) return;
  const rect = view.getBoundingClientRect();
  // Only the pane's own docked edge reserves space; the other axis is left
  // alone (side-docked reserves no height, bottom-docked reserves no width).
  const rightReservePx = dockSide === 'bottom' ? 0 : Math.max(0, window.innerWidth - rect.right);
  const bottomReservePx = dockSide === 'bottom' ? Math.max(0, window.innerHeight - rect.bottom) : 0;
  hooks.setRightReserve(rightReservePx);
  hooks.setBottomReserve(bottomReservePx);
  document.documentElement.style.setProperty('--split-reserve', `${rightReservePx}px`);
  document.documentElement.style.setProperty('--split-reserve-bottom', `${bottomReservePx}px`);
  resizeRenderer(app.orthographicFrustumSize);
  requestRender();
}

// ---- tabs --------------------------------------------------------------------

/** Rebuild one tab container from the visible side-docked windows: the
 *  horizontal strip in the pane header (the windows' chrome while open) or
 *  the vertical pull-tab stack on the pane edge (shown while collapsed, to
 *  reopen). Windows keep their pane DOM order in both. */
function fillTabs(container, panelsList, { suffix = '', withMenu = false, draggable = false } = {}) {
  container.innerHTML = '';
  for (const panel of panelsList) {
    const tab = document.createElement('div');
    tab.className = 'split-pane-tab' + (panel.id === frontId ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.dataset.panelId = panel.id;
    tab.title = panel.def.title || 'Show window';

    const label = document.createElement('span');
    label.className = 'split-pane-tab-label';
    label.textContent = `${panel.def.title || ''}${suffix}`;
    tab.appendChild(label);

    if (draggable) {
      // Click activates; a >4px drag reorders tabs or pulls the window out.
      tab.addEventListener('pointerdown', (ev) => onTabPointerDown(panel, tab, ev));
    } else {
      tab.addEventListener('click', () => activatePanel(panel));
    }
    tab.addEventListener('keydown', (ev) => {
      // Space is reserved globally as a keyboard-shortcut modifier
      // (ui/KeyboardShortcuts.js) — Enter alone activates the tab.
      if (ev.key === 'Enter') { ev.preventDefault(); activatePanel(panel); }
    });

    if (withMenu) {
      // The ≡ window menu (Position / Close / def.menuSections) — the tab is
      // the window's only chrome while side-docked, so this is where its
      // menu lives. Deliberately NOT a ✕: a bare close here permanently
      // unregistered transient windows, and non-closable ones have no
      // business closing at all (their menu simply has no Close item).
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'split-pane-tab-menu';
      menuBtn.textContent = '≡';
      menuBtn.title = `${panel.def.title || 'Window'} options`;
      menuBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        panel.toggleMenuAt(menuBtn);
      });
      tab.appendChild(menuBtn);
    }

    container.appendChild(tab);
  }
}

function renderTabs() {
  const { tabs, headerTabs } = els();
  const visible = visiblePanels();
  if (headerTabs) fillTabs(headerTabs, visible, { withMenu: true, draggable: true });
  if (tabs) {
    // One pull-tab on the collapsed edge, not one per window: with every
    // window listed the edge became a full-height wall of vertical labels,
    // which is most of what the dock is hiding when you collapse it. The tab
    // names the front window because that is the one reopening lands on; the
    // rest stay reachable from the header strip once the pane is open.
    //
    // A window that already has its own launcher icon in the scene is skipped:
    // one sheet, one way in. Only windows with no other way back get a tab, so
    // a pane holding just Structure info shows no tab at all, while an editor
    // docked beside it keeps one.
    const needTab = visible.filter((p) => !hooks?.hasCompactLauncher?.(p));
    const front = needTab.find((p) => p.id === frontId) || needTab[0];
    fillTabs(tabs, front ? [front] : [], { suffix: ' ▸' });
    tabs.hidden = !front;
  }
}

/** Un-collapse (if needed) and bring a window's tab to front. */
function activatePanel(panel) {
  if (collapsed) {
    collapsed = false;
    applyPaneWidth();
  }
  setSideFront(panel);
  syncSceneAndSidePanels();
  hooks?.onLayoutChange();
}

/** Show `panel` in the pane body (hiding the other side-docked windows).
 *  Only toggles classes — never re-renders anyone. */
export function setSideFront(panel) {
  const { body } = els();
  if (!body || !panel || panel.el.parentElement !== body) return;
  frontId = panel.id;
  for (const el of body.querySelectorAll(':scope > .cv-panel')) {
    el.classList.toggle('cv-front', el === panel.el);
  }
  updateHeaderInfoBtn();
  renderTabs();
}

/** The pane-header "i" button mirrors the front window's infoMd (the title
 *  bar that normally hosts it is hidden while side-docked). */
function updateHeaderInfoBtn() {
  const { infoBtn } = els();
  if (infoBtn) infoBtn.hidden = !frontPanel()?.def.infoMd;
}

// ---- tab drag: reorder within the strip, or pull the window out ---------------

function onTabPointerDown(panel, tab, e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (/** @type {HTMLElement} */ (e.target).closest('button')) return;
  e.preventDefault();
  const { headerTabs: strip } = els();
  if (!strip) return;
  const startX = e.clientX;
  const startY = e.clientY;
  // Capture on the strip (a stable node) — renderTabs() re-renders tabs, and
  // capture on a removed tab element would silently end the gesture. Guarded:
  // synthetic pointer events (tests) have no capturable pointer id, and a
  // failed capture only degrades to hover-routed moves.
  try { strip.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
  let dragging = false;

  const cleanup = () => {
    strip.removeEventListener('pointermove', onMove);
    strip.removeEventListener('pointerup', onUp);
    strip.removeEventListener('pointercancel', onUp);
    tab.classList.remove('cv-tab-dragging');
  };

  const onMove = (mv) => {
    if (!dragging) {
      if (Math.abs(mv.clientX - startX) < DRAG_THRESHOLD
          && Math.abs(mv.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      tab.classList.add('cv-tab-dragging');
    }
    // Left the strip band: pull the window out of the dock and continue the
    // same gesture as a floating title-bar drag (from there the main dock's
    // drag-into-dock works too).
    const r = strip.getBoundingClientRect();
    const outside = mv.clientY < r.top - DRAG_OUT_PX || mv.clientY > r.bottom + DRAG_OUT_PX
      || mv.clientX < r.left - DRAG_OUT_PX || mv.clientX > r.right + DRAG_OUT_PX;
    if (outside && hooks?.getPref('dragOutOfDock') && hooks?.canFloat?.() !== false) {
      cleanup();
      strip.releasePointerCapture(e.pointerId);
      hooks.onUserMutation?.(panel);
      // floatPanelForDrag detaches the window from the pane (via the
      // manager's side-dock guard) and floats it under the pointer.
      hooks.floatPanelForDrag(panel, {
        left: Math.max(0, mv.clientX - 90),
        top: Math.max(0, mv.clientY - 12),
      });
      panel.beginFloatDrag(mv); // gesture continues as a floating move
      return;
    }
    // Horizontal reorder: move the tab before the sibling whose midpoint the
    // pointer crossed (live — the tab itself is the drag feedback).
    let before = null;
    for (const sib of Array.from(strip.children)) {
      if (sib === tab) continue;
      const sr = sib.getBoundingClientRect();
      if (mv.clientX < sr.left + sr.width / 2) { before = sib; break; }
    }
    if (tab.nextElementSibling !== before) strip.insertBefore(tab, before);
  };

  const onUp = (up) => {
    cleanup();
    if (!dragging) {
      if (up.type === 'pointerup') activatePanel(panel);
      return;
    }
    commitTabOrder(panel);
  };

  strip.addEventListener('pointermove', onMove);
  strip.addEventListener('pointerup', onUp);
  strip.addEventListener('pointercancel', onUp);
}

/** After a reorder drag: make the pane body's child order (the canonical tab
 *  order, what persistence reads) match the header strip. */
function commitTabOrder(movedPanel) {
  const { body, headerTabs } = els();
  if (!body || !headerTabs) return;
  hooks.onUserMutation?.(movedPanel);
  for (const tab of Array.from(headerTabs.children)) {
    const panel = hooks.resolvePanel(/** @type {HTMLElement} */ (tab).dataset.panelId);
    if (panel && panel.el.parentElement === body) {
      body.appendChild(panel.el);
    }
  }
  renderTabs();
  hooks.onLayoutChange();
}

// ---- dock / undock -------------------------------------------------------------

function showPaneChrome() {
  const { viewArea, pane, handle } = els();
  viewArea?.classList.add('split-active');
  if (pane) pane.hidden = false;
  if (handle) handle.hidden = false; // CSS hides it while collapsed
  applyPaneWidth();
}

/** Hide all pane chrome (no visible windows left). Attached-but-hidden
 *  windows stay in the pane body; `collapsed` keeps its value (it is a
 *  persisted layout property now). */
function hidePaneChrome() {
  const { viewArea, pane, handle, tabs, headerTabs, body } = els();
  frontId = null;
  viewArea?.classList.remove('split-active', 'split-pane-collapsed');
  if (pane) pane.hidden = true;
  if (handle) handle.hidden = true;
  if (tabs) { tabs.innerHTML = ''; tabs.hidden = true; }
  if (headerTabs) headerTabs.innerHTML = '';
  if (body?.querySelector('.split-item.expanded, .trajPlot.expanded')) closeExpandedSplitItem();
  syncSceneAndSidePanels();
}

/**
 * Put a window into the side dock. The element is inserted into the pane
 * body (before `beforeEl`, or appended) and marked side-docked; with
 * `front` it becomes the visible tab, with `expand` its body is expanded
 * (building deferred content). Chrome only shows if the window is visible
 * (hiddenUntilStructure windows wait for revealFeaturePanels).
 */
export function sideDockPanel(panel, { beforeEl = null, front = true, expand = true } = {}) {
  wireOnce();
  const { body } = els();
  if (!body || !hooks) return;
  if (panel.el.parentElement !== body) body.insertBefore(panel.el, beforeEl);
  panel.markSideDocked();
  if (!panel.el.hidden) {
    showPaneChrome();
    const fp = frontPanel();
    const frontValid = fp && fp.el.parentElement === body && !fp.el.hidden;
    if (front || !frontValid) setSideFront(panel);
    else renderTabs();
  }
  if (expand) panel.expand();
  syncSceneAndSidePanels();
  hooks.onLayoutChange();
}

/**
 * Take a window out of the side dock: its element is detached (the caller
 * re-attaches it — float, main dock, or closed) and the pane re-fronts the
 * last remaining tab, or hides entirely. panel.dock is NOT changed here:
 * closePanel keeps it 'right' as the remembered reopen location; float/dock
 * transitions overwrite it via markFloating/markDocked.
 */
export function sideUndockPanel(panel) {
  const { body } = els();
  if (!body || panel.el.parentElement !== body) return;
  if (panel.el.querySelector('.split-item.expanded, .trajPlot.expanded')) closeExpandedSplitItem();
  panel.el.remove();
  panel.el.classList.remove('cv-side-docked', 'cv-front');
  if (frontId === panel.id) frontId = null;
  const visible = visiblePanels();
  if (!visible.length) {
    hidePaneChrome();
  } else {
    if (!frontId) setSideFront(visible[visible.length - 1]);
    else renderTabs();
    syncSceneAndSidePanels();
  }
  hooks?.onLayoutChange();
}

/** Collapse the whole dock to edge pull-tabs (»/handle-snap) or restore it. */
export function setSideDockCollapsed(next) {
  collapsed = !!next;
  applyPaneWidth();
  renderTabs(); // collapse/expand changes whether the pull-tab stack shows
  syncSceneAndSidePanels();
  hooks?.onLayoutChange();
}

/**
 * Re-derive chrome/front/tabs from the current window visibility. Called
 * after revealFeaturePanels (hiddenUntilStructure windows restored into the
 * side dock become visible only then) and availability changes.
 */
export function refreshSideDock() {
  const visible = visiblePanels();
  if (!visible.length) {
    const { pane } = els();
    if (pane && !pane.hidden) hidePaneChrome();
    return;
  }
  showPaneChrome();
  const fp = frontPanel();
  const frontValid = fp && !fp.el.hidden && fp.el.parentElement === els().body;
  if (!frontValid) setSideFront(visible[visible.length - 1]);
  else renderTabs();
  syncSceneAndSidePanels();
}

/** Re-derive the tab strips alone. Called when a window's launcher icon
 *  appears or disappears, which changes who still needs a pull-tab. Does no
 *  layout sync — refreshSideDock() would re-enter through the reserve. */
export function refreshSideDockTabs() {
  renderTabs();
}

/**
 * How far the open pane reaches in from the edge it hugs, in px. This is NOT
 * the same as the reserve syncSceneAndSidePanels publishes: below the compact
 * breakpoint the pane lies OVER the scene instead of shrinking it, so the
 * reserve is 0 while the pane still covers this much of the viewport. Anything
 * that has to stay clear of the pane itself (the compact launcher icons) needs
 * this number, not the reserve.
 */
export function sideDockOverlapPx() {
  const { pane } = els();
  const none = { right: 0, bottom: 0 };
  if (collapsed || !pane || pane.hidden) return none;
  const r = pane.getBoundingClientRect();
  if (!r.width || !r.height) return none;
  return dockSide === 'bottom'
    ? { right: 0, bottom: Math.max(0, window.innerHeight - r.top) }
    : { right: Math.max(0, window.innerWidth - r.left), bottom: 0 };
}

// ---- persistence (read/written by PanelManager's layout blob) ------------------

export function getSideDockLayout() {
  return {
    order: attachedPanels().map((p) => p.id),
    front: frontId,
    collapsed,
    fraction: paneFraction,
    side: dockSide,
  };
}

/** Apply the remembered pane fraction/collapsed/side state (called before
 *  the panels register — DOM state follows as they dock in). */
export function applySideDockLayout(saved) {
  if (!saved || typeof saved !== 'object') return;
  const f = Number(saved.fraction);
  if (Number.isFinite(f) && f > 0) paneFraction = Math.min(0.8, Math.max(0.1, f));
  collapsed = !!saved.collapsed;
  dockSide = saved.side === 'bottom' ? 'bottom' : 'right';
  updateDockBtn();
}

/** Restore the dock's own defaults (Reset UI). */
export function resetSideDockLayout() {
  paneFraction = DEFAULT_PANE_FRACTION;
  collapsed = false;
  dockSide = 'right';
  updateDockBtn();
  applyPaneWidth();
}

// ---- drop zone (floating drags, checked by PanelWindow via manager hooks) ------

/**
 * Which edge this pointer position would drop into, or null if it isn't over
 * a drop zone:
 * - dock open: the pane's own rect (its current side);
 * - dock EMPTY (no visible windows): a band along EITHER the right or the
 *   bottom screen edge — the drop decides where the dock appears (in the
 *   shared corner, the nearer edge wins);
 * - dock holding windows but collapsed to pull-tabs: only its own edge's
 *   band (a drop must not silently relocate an occupied dock).
 */
export function sideDockDropSideAt(ev) {
  if (!hooks || !hooks.getPref('dragIntoDock')) return null;
  const { pane } = els();
  if (pane && !pane.hidden && !collapsed) {
    const r = pane.getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right
        && ev.clientY >= r.top && ev.clientY <= r.bottom;
    return inside ? dockSide : null;
  }
  const rightGap = window.innerWidth - ev.clientX;
  const bottomGap = window.innerHeight - ev.clientY;
  const inRight = rightGap <= EDGE_BAND_PX;
  const inBottom = bottomGap <= EDGE_BAND_PX;
  if (visiblePanels().length === 0) {
    if (inRight && inBottom) return rightGap <= bottomGap ? 'right' : 'bottom';
    if (inRight) return 'right';
    if (inBottom) return 'bottom';
    return null;
  }
  return (dockSide === 'bottom' ? inBottom : inRight) ? dockSide : null;
}

/** Is this pointer position over the dock's drop zone? */
export function wantsSideDockDrop(ev) {
  return sideDockDropSideAt(ev) !== null;
}

/** Show/position the drop highlight while a floating drag hovers the zone
 *  (null hides it — drag ended or moved away). Geometry is set inline: the
 *  open pane's rect, or the band of whichever edge would take the drop. */
export function updateSideDockHint(ev) {
  const { dropHint, pane } = els();
  if (!dropHint) return;
  const side = ev ? sideDockDropSideAt(ev) : null;
  const active = side !== null;
  dropHint.hidden = !active;
  dropHint.classList.toggle('active', active);
  if (!active) return;
  const open = pane && !pane.hidden && !collapsed;
  const s = dropHint.style;
  if (open) {
    const r = pane.getBoundingClientRect();
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    s.right = s.bottom = 'auto';
  } else if (side === 'bottom') {
    s.left = '0';
    s.right = '0';
    s.bottom = '0';
    s.top = 'auto';
    s.width = 'auto';
    s.height = `${EDGE_BAND_PX}px`;
  } else {
    s.top = '0';
    s.bottom = '0';
    s.right = '0';
    s.left = 'auto';
    s.height = 'auto';
    s.width = `${EDGE_BAND_PX}px`;
  }
}

// ---- fullscreen-item overlay (the ⛶ button on .split-item blocks) --------------
//
// Generic helpers for feature content (EOS plots, the demo counter, the
// trajectory plot's own .trajPlot root — see TrajectoryPlot.js): expand one
// item to (almost) fullscreen over a dark overlay. Works from any window
// state — side-docked, floating or main-docked (the host window gets
// cv-has-expanded-item, which lifts the body's backdrop-filter so the
// fixed-position item isn't trapped inside it, and raises a floating host
// above the overlay). closeExpandedSplitItem() matches both `.split-item` and
// `.trajPlot` since the trajectory plot deliberately isn't a `.split-item`
// (its own CSS is tuned independently, see trajectoryPanel.css).

export function expandSplitItem(wrapper) {
  if (!wrapper) return;
  const { viewArea, overlay } = els();
  wrapper.classList.add('expanded');
  overlay?.classList.add('active');
  viewArea?.classList.add('split-item-expanded');
  wrapper.closest('.cv-panel')?.classList.add('cv-has-expanded-item');
}

export function closeExpandedSplitItem() {
  const { viewArea, overlay } = els();
  document.querySelectorAll('.split-item.expanded, .trajPlot.expanded')
    .forEach((w) => w.classList.remove('expanded'));
  document.querySelectorAll('.cv-panel.cv-has-expanded-item')
    .forEach((el) => el.classList.remove('cv-has-expanded-item'));
  overlay?.classList.remove('active');
  viewArea?.classList.remove('split-item-expanded');
}

// ---- one-time wiring ------------------------------------------------------------

export function initSideDock(h) {
  hooks = h;
  wireOnce();
}

function wireOnce() {
  if (wired) return;
  wired = true;
  const { handle, overlay, infoBtn, dockBtn } = els();

  const collapseBtn = document.getElementById('splitPaneCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setSideDockCollapsed(true));

  updateDockBtn();
  if (dockBtn) {
    dockBtn.addEventListener('click', () => setSideDockSide(dockSide === 'bottom' ? 'right' : 'bottom'));
  }

  if (infoBtn) {
    infoBtn.addEventListener('click', () => {
      const md = frontPanel()?.def.infoMd;
      if (md) showInfoPanel(md);
    });
  }

  // Drag the splitter: resize while open, snap to the collapsed pull-tabs if
  // dragged past most of the pane's width/height.
  if (handle) {
    handle.addEventListener('pointerdown', (startEv) => {
      if (collapsed) return;
      startEv.preventDefault();
      handle.setPointerCapture(startEv.pointerId);

      // The pane's CSS size is a vw/vh-based fraction of the whole viewport
      // (it's viewport-fixed, not a flex child of #viewArea) — the fraction
      // must be computed against the same basis, not #viewArea's narrower
      // extent (which excludes the #ui dock), or the drag and the rendered
      // size disagree.
      const onMove = (ev) => {
        const sizePx = dockSide === 'bottom'
          ? Math.max(0, window.innerHeight - ev.clientY)
          : Math.max(0, window.innerWidth - ev.clientX);
        const basis = dockSide === 'bottom' ? window.innerHeight : window.innerWidth;
        if (sizePx < MIN_PANE_PX) {
          setSideDockCollapsed(true);
          return;
        }
        paneFraction = Math.min(0.8, sizePx / basis);
        collapsed = false;
        applyPaneWidth();
        syncSceneAndSidePanels();
      };
      const onUp = () => {
        handle.releasePointerCapture(startEv.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        syncSceneAndSidePanels();
        hooks?.onLayoutChange();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  if (overlay) {
    overlay.addEventListener('click', () => closeExpandedSplitItem());
  }

  // A plain browser window resize changes #view's pixel size too (the pane's
  // width is a fraction of the viewport) — keep the reserve/dot/renderer in
  // sync without waiting for the next pane interaction.
  window.addEventListener('resize', () => { if (isSideDockActive()) syncSceneAndSidePanels(); });
}
