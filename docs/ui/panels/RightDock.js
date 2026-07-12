// The right dock (formerly the "split view"): a wide, resizable pane on the
// right edge of the screen that hosts regular PanelWindows as TABS. Any
// window can be dropped here (drag to the right border) and dragged back out
// (drag its tab away) — the same PanelWindow instances the left dock and
// floating windows use, so "everything is the same kind of Window".
//
// While a window is right-docked its element lives inside #splitPaneBody with
// the cv-right-docked class (title bar hidden — the tab is the chrome) and
// exactly one window carries cv-front (visible, filling the pane). Switching
// tabs only toggles classes: content is never re-rendered, so transient state
// (a loaded file, scroll position) survives a tab switch. The whole dock
// collapses to edge pull-tabs via the » button; individual windows have no
// collapse here.
//
// This module owns only the pane plumbing (chrome, resize handle, tabs, tab
// drag, drop zone, fullscreen-item overlay). Registry/persistence concerns
// stay in PanelManager.js, reached through the hooks passed to initRightDock:
//   resolvePanel(id) -> PanelWindow|null
//   getPref(name) -> boolean            panelPrefs (dragIntoDock/dragOutOfDock)
//   onLayoutChange()                    any persistable state changed
//   setRightReserve(px)                 width the pane occupies on the right
//   closePanelFromTab(panel)            the tab's ✕ (routes closeMode)
//   floatPanelForDrag(panel, pos)       float a pulled-out window mid-gesture

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
    dropHint: document.getElementById('rightDockDropHint'),
  };
}

/** All right-docked windows in pane DOM order (the tab order). */
function attachedPanels() {
  const { body } = els();
  if (!body || !hooks) return [];
  return Array.from(body.querySelectorAll(':scope > .cv-panel'))
    .map((el) => hooks.resolvePanel(/** @type {HTMLElement} */ (el).dataset.panelId))
    .filter(Boolean);
}

/** Right-docked windows that should show as tabs (hiddenUntilStructure
 *  windows stay attached but tab-less until a structure loads). */
function visiblePanels() {
  return attachedPanels().filter((p) => !p.el.hidden);
}

function frontPanel() {
  return frontId && hooks ? hooks.resolvePanel(frontId) : null;
}

export function isRightDockActive() {
  return visiblePanels().length > 0;
}

function applyPaneWidth() {
  const { viewArea } = els();
  if (!viewArea) return;
  // Set on the root (not the pane) — #view and the handle are siblings of
  // the pane, not descendants, so they need it too (CSS vars only inherit
  // down the tree from where they're declared).
  document.documentElement.style.setProperty('--split-pane-fraction', String(paneFraction));
  if (collapsed) viewArea.classList.add('split-pane-collapsed');
  else viewArea.classList.remove('split-pane-collapsed');
}

/**
 * Re-derive the space the pane currently occupies to the right of #view and
 * push that out to everything that needs to stay clear of it: the 3D
 * renderer (resize + a fresh on-demand frame — #view's size can change here
 * without a window resize event ever firing), right-anchored floating panels
 * (Structure info, ...) via PanelManager's right-reserve, and the
 * background-dot (a plain fixed div, via the --split-reserve custom
 * property).
 */
function syncSceneAndSidePanels() {
  const { view } = els();
  if (!view || !hooks) return;
  const reservePx = Math.max(0, window.innerWidth - view.getBoundingClientRect().right);
  hooks.setRightReserve(reservePx);
  document.documentElement.style.setProperty('--split-reserve', `${reservePx}px`);
  resizeRenderer(app.orthographicFrustumSize);
  requestRender();
}

// ---- tabs --------------------------------------------------------------------

/** Rebuild one tab container from the visible right-docked windows: the
 *  horizontal strip in the pane header (the windows' chrome while open) or
 *  the vertical pull-tab stack on the pane edge (shown while collapsed, to
 *  reopen). Windows keep their pane DOM order in both. */
function fillTabs(container, panelsList, { suffix = '', withClose = false, draggable = false } = {}) {
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
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activatePanel(panel); }
    });

    if (withClose) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'split-pane-tab-close';
      close.textContent = '×';
      close.title = `Close ${panel.def.title || ''}`;
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hooks?.closePanelFromTab(panel);
      });
      tab.appendChild(close);
    }

    container.appendChild(tab);
  }
}

function renderTabs() {
  const { tabs, headerTabs } = els();
  const visible = visiblePanels();
  if (headerTabs) fillTabs(headerTabs, visible, { withClose: true, draggable: true });
  if (tabs) {
    fillTabs(tabs, visible, { suffix: ' ▸' });
    tabs.hidden = visible.length === 0;
  }
}

/** Un-collapse (if needed) and bring a window's tab to front. */
function activatePanel(panel) {
  if (collapsed) {
    collapsed = false;
    applyPaneWidth();
  }
  setRightFront(panel);
  syncSceneAndSidePanels();
  hooks?.onLayoutChange();
}

/** Show `panel` in the pane body (hiding the other right-docked windows).
 *  Only toggles classes — never re-renders anyone. */
export function setRightFront(panel) {
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
 *  bar that normally hosts it is hidden while right-docked). */
function updateHeaderInfoBtn() {
  const { infoBtn } = els();
  if (infoBtn) infoBtn.hidden = !frontPanel()?.def.infoMd;
}

// ---- tab drag: reorder within the strip, or pull the window out ---------------

function onTabPointerDown(panel, tab, e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (/** @type {HTMLElement} */ (e.target).closest('.split-pane-tab-close')) return;
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
    // same gesture as a floating title-bar drag (from there the left dock's
    // drag-into-dock works too).
    const r = strip.getBoundingClientRect();
    const outside = mv.clientY < r.top - DRAG_OUT_PX || mv.clientY > r.bottom + DRAG_OUT_PX
      || mv.clientX < r.left - DRAG_OUT_PX || mv.clientX > r.right + DRAG_OUT_PX;
    if (outside && hooks?.getPref('dragOutOfDock')) {
      cleanup();
      strip.releasePointerCapture(e.pointerId);
      // floatPanelForDrag detaches the window from the pane (via the
      // manager's right-dock guard) and floats it under the pointer.
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
    commitTabOrder();
  };

  strip.addEventListener('pointermove', onMove);
  strip.addEventListener('pointerup', onUp);
  strip.addEventListener('pointercancel', onUp);
}

/** After a reorder drag: make the pane body's child order (the canonical tab
 *  order, what persistence reads) match the header strip. */
function commitTabOrder() {
  const { body, headerTabs } = els();
  if (!body || !headerTabs) return;
  for (const tab of Array.from(headerTabs.children)) {
    const panel = hooks.resolvePanel(/** @type {HTMLElement} */ (tab).dataset.panelId);
    if (panel && panel.el.parentElement === body) body.appendChild(panel.el);
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
  if (body?.querySelector('.split-item.expanded')) closeExpandedSplitItem();
  syncSceneAndSidePanels();
}

/**
 * Put a window into the right dock. The element is inserted into the pane
 * body (before `beforeEl`, or appended) and marked right-docked; with
 * `front` it becomes the visible tab, with `expand` its body is expanded
 * (building deferred content). Chrome only shows if the window is visible
 * (hiddenUntilStructure windows wait for revealFeaturePanels).
 */
export function rightDockPanel(panel, { beforeEl = null, front = true, expand = true } = {}) {
  wireOnce();
  const { body } = els();
  if (!body || !hooks) return;
  if (panel.el.parentElement !== body) body.insertBefore(panel.el, beforeEl);
  panel.markRightDocked();
  if (!panel.el.hidden) {
    showPaneChrome();
    const fp = frontPanel();
    const frontValid = fp && fp.el.parentElement === body && !fp.el.hidden;
    if (front || !frontValid) setRightFront(panel);
    else renderTabs();
  }
  if (expand) panel.expand();
  syncSceneAndSidePanels();
  hooks.onLayoutChange();
}

/**
 * Take a window out of the right dock: its element is detached (the caller
 * re-attaches it — float, left dock, or closed) and the pane re-fronts the
 * last remaining tab, or hides entirely. panel.dock is NOT changed here:
 * closePanel keeps it 'right' as the remembered reopen location; float/dock
 * transitions overwrite it via markFloating/markDocked.
 */
export function rightUndockPanel(panel) {
  const { body } = els();
  if (!body || panel.el.parentElement !== body) return;
  if (panel.el.querySelector('.split-item.expanded')) closeExpandedSplitItem();
  panel.el.remove();
  panel.el.classList.remove('cv-right-docked', 'cv-front');
  if (frontId === panel.id) frontId = null;
  const visible = visiblePanels();
  if (!visible.length) {
    hidePaneChrome();
  } else {
    if (!frontId) setRightFront(visible[visible.length - 1]);
    else renderTabs();
    syncSceneAndSidePanels();
  }
  hooks?.onLayoutChange();
}

/** Collapse the whole dock to edge pull-tabs (»/handle-snap) or restore it. */
export function setRightDockCollapsed(next) {
  collapsed = !!next;
  applyPaneWidth();
  renderTabs(); // collapse/expand changes whether the pull-tab stack shows
  syncSceneAndSidePanels();
  hooks?.onLayoutChange();
}

/**
 * Re-derive chrome/front/tabs from the current window visibility. Called
 * after revealFeaturePanels (hiddenUntilStructure windows restored into the
 * right dock become visible only then) and availability changes.
 */
export function refreshRightDock() {
  const visible = visiblePanels();
  if (!visible.length) {
    const { pane } = els();
    if (pane && !pane.hidden) hidePaneChrome();
    return;
  }
  showPaneChrome();
  const fp = frontPanel();
  const frontValid = fp && !fp.el.hidden && fp.el.parentElement === els().body;
  if (!frontValid) setRightFront(visible[visible.length - 1]);
  else renderTabs();
  syncSceneAndSidePanels();
}

// ---- persistence (read/written by PanelManager's layout blob) ------------------

export function getRightDockLayout() {
  return {
    order: attachedPanels().map((p) => p.id),
    front: frontId,
    collapsed,
    fraction: paneFraction,
  };
}

/** Apply the remembered pane fraction/collapsed state (called before the
 *  panels register — DOM state follows as they dock in). */
export function applyRightDockLayout(saved) {
  if (!saved || typeof saved !== 'object') return;
  const f = Number(saved.fraction);
  if (Number.isFinite(f) && f > 0) paneFraction = Math.min(0.8, Math.max(0.1, f));
  collapsed = !!saved.collapsed;
}

/** Restore the dock's own defaults (Reset UI). */
export function resetRightDockLayout() {
  paneFraction = DEFAULT_PANE_FRACTION;
  collapsed = false;
  applyPaneWidth();
}

// ---- drop zone (floating drags, checked by PanelWindow via manager hooks) ------

/** Is this pointer position over the right dock's drop zone? The open pane's
 *  own rect while open; a narrow band along the right screen edge while the
 *  dock is collapsed, hidden or empty. */
export function wantsRightDockDrop(ev) {
  if (!hooks || !hooks.getPref('dragIntoDock')) return false;
  const { pane } = els();
  if (pane && !pane.hidden && !collapsed) {
    const r = pane.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right
        && ev.clientY >= r.top && ev.clientY <= r.bottom;
  }
  return ev.clientX >= window.innerWidth - EDGE_BAND_PX;
}

/** Show/position the drop highlight while a floating drag hovers the zone
 *  (null hides it — drag ended or moved away). */
export function updateRightDockHint(ev) {
  const { dropHint, pane } = els();
  if (!dropHint) return;
  const active = !!ev && wantsRightDockDrop(ev);
  dropHint.hidden = !active;
  dropHint.classList.toggle('active', active);
  if (active) {
    const open = pane && !pane.hidden && !collapsed;
    dropHint.style.width = open ? `${pane.getBoundingClientRect().width}px` : '';
  }
}

// ---- fullscreen-item overlay (the ⛶ button on .split-item blocks) --------------
//
// Generic helpers for feature content (EOS plots, the demo counter): expand
// one .split-item to (almost) fullscreen over a dark overlay. Works from any
// window state — right-docked, floating or left-docked (the host window gets
// cv-has-expanded-item, which lifts the body's backdrop-filter so the
// fixed-position item isn't trapped inside it, and raises a floating host
// above the overlay).

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
  document.querySelectorAll('.split-item.expanded')
    .forEach((w) => w.classList.remove('expanded'));
  document.querySelectorAll('.cv-panel.cv-has-expanded-item')
    .forEach((el) => el.classList.remove('cv-has-expanded-item'));
  overlay?.classList.remove('active');
  viewArea?.classList.remove('split-item-expanded');
}

// ---- one-time wiring ------------------------------------------------------------

export function initRightDock(h) {
  hooks = h;
  wireOnce();
}

function wireOnce() {
  if (wired) return;
  wired = true;
  const { handle, overlay, infoBtn } = els();

  const collapseBtn = document.getElementById('splitPaneCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setRightDockCollapsed(true));

  if (infoBtn) {
    infoBtn.addEventListener('click', () => {
      const md = frontPanel()?.def.infoMd;
      if (md) showInfoPanel(md);
    });
  }

  // Drag the splitter: resize while open, snap to the collapsed pull-tabs if
  // dragged past most of the pane's width.
  if (handle) {
    handle.addEventListener('pointerdown', (startEv) => {
      if (collapsed) return;
      startEv.preventDefault();
      handle.setPointerCapture(startEv.pointerId);

      // The pane's CSS width is a vw-based fraction of the whole viewport
      // (it's viewport-fixed, not a flex child of #viewArea) — the fraction
      // must be computed against the same basis, not #viewArea's narrower
      // width (which excludes the #ui dock), or the drag and the rendered
      // width disagree.
      const onMove = (ev) => {
        const paneWidthPx = Math.max(0, window.innerWidth - ev.clientX);
        if (paneWidthPx < MIN_PANE_PX) {
          setRightDockCollapsed(true);
          return;
        }
        paneFraction = Math.min(0.8, paneWidthPx / window.innerWidth);
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
  window.addEventListener('resize', () => { if (isRightDockActive()) syncSceneAndSidePanels(); });
}
