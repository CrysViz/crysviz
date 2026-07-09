// Panel registry + layout management for the unified panel/window system.
//
// Owns the cross-panel concerns: which panels exist, their dock order,
// drag-to-reorder inside #dock, dock<->float transitions, content lifecycle
// ('persistent' content is built once; 'rebuild' content is built lazily on
// first expand and torn down/rebuilt when the active structure changes), and
// layout persistence in localStorage (single versioned key, like the theme).
//
// Per-window DOM/behavior lives in PanelWindow.js.

import { PanelWindow } from './PanelWindow.js';

const LS_KEY = 'panelLayout';
// v2: pos is the INHERENT position, per axis anchored to the nearest viewport
// edge at capture time (v1 stored absolute left/top rect readings; no
// migration — a v1 blob is simply discarded).
const LAYOUT_VERSION = 2;
const SAVE_DEBOUNCE_MS = 250;
const DOCK_GAP = 10; // gap between the dock's right edge and displaced windows
// How far past the dock's right edge a dock-drag must travel before the panel
// is pulled out. Also the hysteresis gap against wantsDockDrop (which triggers
// at the edge itself), so a pulled-out panel doesn't immediately re-dock.
const DRAG_OUT_PX = 24;

// ---- compact round-icon mode --------------------------------------------
// Extra scene width kept free before the floating toolbars collapse to icons,
// so they compact slightly before literally touching.
const COMPACT_SAFETY_GAP_PX = 24;
// Vertical gap between stacked compact icons / their unfolded toolbars.
const COMPACT_STACK_GAP_PX = 20;

// Behavior preferences (the drag-into/out-of-dock toggles in Settings). Kept
// in their own localStorage key, NOT in the versioned panelLayout blob: they
// must survive both Reset UI (which clears LS_KEY) and layout version bumps.
const PREFS_KEY = 'panelPrefs';
const panelPrefs = { dragIntoDock: true, dragOutOfDock: true, dragByHandleOnly: false };

function loadPanelPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.dragIntoDock === 'boolean') panelPrefs.dragIntoDock = parsed.dragIntoDock;
      if (typeof parsed.dragOutOfDock === 'boolean') panelPrefs.dragOutOfDock = parsed.dragOutOfDock;
      if (typeof parsed.dragByHandleOnly === 'boolean') panelPrefs.dragByHandleOnly = parsed.dragByHandleOnly;
    }
  } catch { /* corrupted prefs -> defaults */ }
}

export function getPanelPref(name) {
  return panelPrefs[name];
}

export function setPanelPref(name, value) {
  panelPrefs[name] = !!value;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(panelPrefs)); } catch { /* storage unavailable */ }
}

/** @type {Map<string, PanelWindow>} */
const panels = new Map();
let dockEl = null;
let stored = { dockOrder: [], panels: {} };
let revealed = false; // set once a structure is loaded (feature panels unhide)
let saveTimer = 0;
let dockOccupies = false; // side panel currently takes layout space
let lastUiWidth = 0; // last known #ui width (it measures 0 while hidden)
let rightReservePx = 0; // width reserved on the right (e.g. the EOS split pane)

const hooks = {
  beforeExpand(panel) {
    if (panel.def.lifecycle === 'rebuild' && revealed) buildContent(panel);
    return true;
  },
  onToggleDock(panel) {
    if (panel.docked) floatPanel(panel);
    else redockPanel(panel); // restore the dock slot it last occupied
    refreshCompactFloatingPanels(); // dock occupancy changed
  },
  onClose(panel) {
    if (panel.def.onClose) panel.def.onClose(panel);
    removePanel(panel.id);
  },
  onLayoutChange: scheduleSave,
  onResetPanel(panel) {
    applyPanelDefaults(panel);
    refreshCompactFloatingPanels();
  },
  // A compact panel's icon<->toolbar height change moves anything stacked
  // below it; re-derive the stack the same frame.
  onCompactResize(panel) {
    if (panel.compact) applyCompactPositions();
  },
  beginDockReorder,
  wantsDockDrop,
  dockAtPointer,
  getPref: getPanelPref,
};

/**
 * Restore one panel's default placement: docked/floating state, dock slot or
 * floating anchor, and title-bar (strip) state. The body's collapsed state is
 * left as the user has it.
 */
function applyPanelDefaults(panel) {
  const defaults = panel.def.defaults || {};
  if (defaults.docked !== false) {
    dockPanelAtDefaultOrder(panel);
  } else {
    floatPanel(panel, clampPos({ ...(defaults.anchor || { left: 40, top: 40 }) }));
  }
  const barCollapsed = defaults.barCollapsed !== undefined
    ? !!defaults.barCollapsed
    : defaults.docked === false;
  if (barCollapsed) panel.collapseBar();
  else panel.expandBar();
}

/** Insert a panel into the dock at the slot its DEFAULT order dictates,
 *  relative to the other docked panels' default orders. */
function dockPanelAtDefaultOrder(panel) {
  const orderOf = (p) => (p.def.defaults && p.def.defaults.order) || 0;
  let before = null;
  for (const sib of dockedPanels()) {
    if (sib === panel) continue;
    if (orderOf(panel) < orderOf(sib)) { before = sib.el; break; }
  }
  dockEl.insertBefore(panel.el, before);
  panel.markDocked();
  resequenceSortKeys();
  scheduleSave();
}

/** Restore every window to its defaults and forget the remembered layout. */
export function resetAllPanels() {
  stored = { dockOrder: [], panels: {} };
  // Reset in default-order sequence so each dock insertion lands correctly.
  const all = [...panels.values()].sort(
    (a, b) => ((a.def.defaults?.order) || 0) - ((b.def.defaults?.order) || 0));
  for (const panel of all) applyPanelDefaults(panel);
  refreshCompactFloatingPanels();
  saveLayout();
}

export function initPanelSystem() {
  dockEl = document.getElementById('dock');
  loadStoredLayout();
  loadPanelPrefs();

  // Floating windows react to the layout changing around them through one
  // derivation (see updateFloatPlacements): windows in the dock's column are
  // displaced right while it occupies space, and every window is kept
  // reachable in the viewport — both reversibly, returning to the inherent
  // position (floatPos) when the dock hides or the browser window grows back.
  dockOccupies = dockOccupiesSpace();
  measureUiWidth();
  const observer = new MutationObserver(() => {
    const wasOccupying = dockOccupies;
    updateFloatPlacements(); // general repositioning: always runs, both directions
    // Only the dock APPEARING can crowd Measure/View enough to justify auto-
    // compacting. The dock disappearing only grows the scene; popping the
    // toolbars back open then reads as an unwanted surprise (hiding the dock is
    // often done to reduce clutter, e.g. before a screenshot).
    if (!wasOccupying && dockOccupies) refreshCompactFloatingPanels();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const ui = document.getElementById('ui');
  if (ui) observer.observe(ui, { attributes: true, attributeFilter: ['class'] });
  let resizePending = false;
  window.addEventListener('resize', () => {
    if (resizePending) return;
    resizePending = true;
    // A real window resize is symmetric — recheck compaction both directions.
    requestAnimationFrame(() => {
      resizePending = false;
      updateFloatPlacements();
      refreshCompactFloatingPanels();
    });
  });
}

export function getPanel(id) {
  return panels.get(id) || null;
}

export function isPanelActive(id) {
  const p = panels.get(id);
  return !!p && p.built && p.isExpanded();
}

export function registerPanel(def) {
  const existing = panels.get(def.id);
  if (existing) return existing;

  const panel = new PanelWindow(def, hooks);
  panels.set(def.id, panel);

  const persisted = def.persist === false ? null : stored.panels[def.id];
  const defaults = def.defaults || {};
  const docked = persisted ? !!persisted.docked : defaults.docked !== false;
  const collapsed = persisted ? !!persisted.collapsed : defaults.collapsed !== false;
  // The remembered position is taken verbatim (a layout saved on a larger
  // screen must survive a session in a small window); floatPanel derives an
  // on-screen placement from it without modifying it.
  panel.floatPos = sanitizePos(persisted && persisted.pos)
    || sanitizePos(defaults.anchor) || { left: 40, top: 40 };
  panel.sortKey = dockSortKey(def);

  if (def.hiddenUntilStructure && !revealed) panel.el.hidden = true;

  // Title-bar strip state: remembered, or per-panel default; floating-by-
  // default windows start with the bar shrunk unless the default says
  // otherwise.
  const barCollapsed = persisted
    ? !!persisted.bar
    : (defaults.barCollapsed !== undefined ? !!defaults.barCollapsed : defaults.docked === false);
  if (barCollapsed) panel.collapseBar();

  if (docked) {
    // A panel remembered as docked but with no remembered slot (e.g. an MD
    // monitor docked in a past run) goes to the top, like the dock button.
    const atTop = !!persisted && !stored.dockOrder.includes(def.id);
    dockPanel(panel, atTop);
  } else {
    floatPanel(panel, panel.floatPos);
  }

  // Build persistent content only after the panel is attached: builders
  // resolve their target container by id (document.getElementById), which
  // fails on a detached panel body.
  if (def.lifecycle !== 'rebuild') buildContent(panel);

  if (!collapsed && panel.collapsed) {
    if (def.lifecycle === 'rebuild' && !revealed) panel.wantExpanded = true;
    else panel.expand();
  }
  // Once a compact-capable panel is attached, re-check crowding immediately so
  // Measure/View compact as soon as both exist, not only on the next resize.
  if (def.compactIcon) refreshCompactFloatingPanels();
  return panel;
}

/**
 * Re-sync panels to a newly selected structure: rebuild the content of built
 * 'rebuild' panels (expanded ones immediately, collapsed ones lazily) and
 * re-evaluate every panel's availability. Replaces the old per-row
 * updateControlSpinForcePanel() re-sync.
 */
export function refreshActivePanels() {
  for (const panel of panels.values()) {
    const avail = panel.def.available ? !!panel.def.available() : true;
    if (panel.def.lifecycle === 'rebuild' && panel.built) {
      if (!avail) {
        panel.collapse();
        destroyContent(panel);
      } else if (panel.isExpanded()) {
        destroyContent(panel);
        buildContent(panel);
      } else {
        panel.stale = true;
      }
    }
    panel.setAvailable(avail);
  }
}

/**
 * Called once the first structure is loaded: unhide the feature panels
 * (replaces the old structureControls2 display gating) and expand any panel
 * whose persisted state was "expanded".
 */
export function revealFeaturePanels() {
  revealed = true;
  for (const panel of panels.values()) {
    if (panel.def.hiddenUntilStructure) panel.el.hidden = false;
  }
  // Newly unhidden windows become measurable only now: derive their on-screen
  // placement (viewport clamp) before any wantExpanded expansion below
  // decides its grow-upward anchoring from the applied position.
  updateFloatPlacements();
  for (const panel of panels.values()) {
    if (panel.wantExpanded) {
      panel.wantExpanded = false;
      panel.expand();
    }
  }
  refreshActivePanels();
}

/**
 * Fully remove a panel (content teardown + DOM + registry). Used for
 * transient windows (MD monitor, histogram, ...) and by the ✕ close button.
 */
export function removePanel(id) {
  const panel = panels.get(id);
  if (!panel) return;
  destroyContent(panel);
  panel.remove();
  panels.delete(id);
}

/**
 * Rebuild one panel's content in place (no-op if never built). Used when a
 * frame/step change invalidates a specific panel (e.g. the Cell panel's
 * lattice inputs) without re-syncing everything.
 */
export function rebuildPanel(id) {
  const panel = panels.get(id);
  if (!panel || !panel.built) return;
  destroyContent(panel);
  if (panel.isExpanded()) buildContent(panel);
  else panel.stale = true;
}

/** Re-evaluate available() for all panels without touching built content. */
export function refreshPanelAvailability() {
  for (const panel of panels.values()) {
    if (panel.def.available) panel.setAvailable(!!panel.def.available());
  }
}

/**
 * Bring a panel fully into view: restore its title bar (if shrunk to the thin
 * handle) and expand its body. Called when a Features master toggle turns its
 * feature on, so the panel "reappears" instead of staying a greyed handle or a
 * collapsed bar. No-op if the panel is unavailable or not yet revealed.
 */
export function revealPanel(id) {
  const panel = panels.get(id);
  if (!panel || !panel.available || panel.el.hidden) return;
  panel.expandBar();
  panel.expand();
}

export function resetLayout() {
  try { localStorage.removeItem(LS_KEY); } catch { /* storage unavailable */ }
  stored = { dockOrder: [], panels: {} };
}

export function saveLayout() {
  if (!dockEl) return;
  const data = { version: LAYOUT_VERSION, dockOrder: [], panels: {} };
  for (const p of dockedPanels()) {
    if (p.def.persist !== false) data.dockOrder.push(p.id);
  }
  // Keep remembered dock positions of panels that are not currently
  // registered (e.g. a closed MD monitor), roughly at their old slot, so they
  // return there when re-created.
  for (const id of stored.dockOrder) {
    if (!panels.has(id) && !data.dockOrder.includes(id)) {
      const oldIdx = stored.dockOrder.indexOf(id);
      data.dockOrder.splice(Math.min(oldIdx, data.dockOrder.length), 0, id);
    }
  }
  for (const panel of panels.values()) {
    if (panel.def.persist === false) continue;
    const entry = { docked: panel.docked, collapsed: panel.collapsed, bar: panel.barCollapsed };
    // The inherent position is persisted verbatim: dock displacement and
    // viewport clamping are derived at apply time (updateFloatPlacements)
    // and must never leak into the stored layout.
    if (!panel.docked) entry.pos = panel.floatPos;
    data.panels[panel.id] = entry;
  }
  // Keep remembered entries of currently-unregistered panels.
  for (const [id, entry] of Object.entries(stored.panels)) {
    if (!(id in data.panels) && !panels.has(id)) data.panels[id] = entry;
  }
  // Refresh the in-memory snapshot so panels registered later in the session
  // (e.g. the MD monitor on its next run) resolve against the latest state.
  stored = { dockOrder: data.dockOrder, panels: data.panels };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

// ---- content lifecycle ------------------------------------------------------

function buildContent(panel) {
  if (panel.built && !panel.stale) return;
  if (panel.built) destroyContent(panel);
  if (panel.def.buildContent) panel.def.buildContent(panel.body);
  panel.built = true;
  panel.stale = false;
}

function destroyContent(panel) {
  if (!panel.built) return;
  if (panel.def.onDestroyContent) panel.def.onDestroyContent();
  panel.body.innerHTML = '';
  panel.built = false;
}

// ---- dock / float -----------------------------------------------------------

/** Docked panels in current DOM order. */
function dockedPanels() {
  if (!dockEl) return [];
  return Array.from(dockEl.querySelectorAll(':scope > .cv-panel'))
    .map((el) => panels.get(/** @type {HTMLElement} */ (el).dataset.panelId))
    .filter(Boolean);
}

/**
 * Sort key for initial dock placement: panels found in the persisted
 * dockOrder keep that relative order (keys 0..n); unknown panels sort after
 * them by their default order.
 */
function dockSortKey(def) {
  const idx = stored.dockOrder.indexOf(def.id);
  if (idx >= 0) return idx;
  return 100000 + ((def.defaults && def.defaults.order) || 0);
}

/** Initial-registration dock insertion. Unlike the mutation paths (reorder
 *  drop, undock, dock-at-pointer) this must NOT resequence: panels register
 *  one by one carrying their stored-order sort keys, and resequencing the
 *  already-docked ones to DOM indices would make later stored keys compare
 *  against the wrong scale — a remembered dock order that differs from the
 *  registration order would not be restored. */
function dockPanel(panel, atTop = false) {
  let before = null;
  const siblings = dockedPanels().filter((sib) => sib !== panel);
  if (atTop) {
    before = siblings.length ? siblings[0].el : null;
    // The top slot means the smallest sort key, so panels still to register
    // sort consistently against this one.
    if (siblings.length) {
      panel.sortKey = Math.min(...siblings.map((sib) => sib.sortKey)) - 1;
    }
  } else {
    before = sortKeyBefore(panel);
  }
  dockEl.insertBefore(panel.el, before);
  panel.markDocked();
  scheduleSave();
}

/** The docked-sibling element this panel should be inserted before to honor
 *  its sort key (null → append at the end). */
function sortKeyBefore(panel) {
  for (const sib of dockedPanels()) {
    if (sib === panel) continue;
    if (panel.sortKey < sib.sortKey) return sib.el;
  }
  return null;
}

/**
 * Re-dock a floating panel into the slot it last occupied (remembered on
 * undock). If the panel it sat above is gone, fall back to sort-key order.
 */
function redockPanel(panel) {
  let before;
  if (panel.redockRemembered) {
    if (panel.redockBeforeId === null) {
      before = null; // was the last docked panel
    } else {
      const anchor = panels.get(panel.redockBeforeId);
      before = (anchor && anchor.docked && anchor.el.parentElement === dockEl)
        ? anchor.el
        : sortKeyBefore(panel);
    }
  } else {
    before = sortKeyBefore(panel);
  }
  dockEl.insertBefore(panel.el, before);
  panel.markDocked();
  resequenceSortKeys();
  scheduleSave();
}

/** Is a floating title-bar drag currently over the visible side panel (and
 *  drag-into-dock enabled)? Queried by PanelWindow on every drag move. */
function wantsDockDrop(ev) {
  if (!panelPrefs.dragIntoDock || !dockEl || !dockOccupiesSpace()) return false;
  const ui = document.getElementById('ui');
  if (!ui) return false;
  const r = ui.getBoundingClientRect();
  return ev.clientX >= r.left && ev.clientX < r.right
      && ev.clientY >= r.top && ev.clientY <= r.bottom;
}

/**
 * Commit a drag-into-dock: insert the floating panel at the dock slot under
 * the pointer, then hand the still-active gesture to the reorder drag so the
 * user can keep positioning it. Caller (PanelWindow) has already torn down
 * its move listeners and released pointer capture.
 */
function dockAtPointer(panel, ev) {
  panel.floatPos = panel.captureFloatPosition(); // last float pos, before styles clear
  const pointerY = ev.clientY - dockEl.getBoundingClientRect().top;
  let before = null;
  for (const sib of dockedPanels()) {
    if (pointerY < sib.el.offsetTop + sib.el.offsetHeight / 2) { before = sib.el; break; }
  }
  dockEl.insertBefore(panel.el, before);
  panel.markDocked();
  resequenceSortKeys();
  beginDockReorder(panel, ev); // re-captures the pointer, gesture continues
}

/** @param {{noDockShift?: boolean}} [opts] noDockShift skips the displacement
 *  past the dock (used when a drag-out must keep the panel under the pointer). */
function floatPanel(panel, pos, opts = {}) {
  // Remember the dock slot (the panel it sits above) so re-docking restores it.
  if (panel.docked) {
    const siblings = dockedPanels();
    const idx = siblings.indexOf(panel);
    const after = idx >= 0 ? siblings[idx + 1] : null;
    panel.redockBeforeId = after ? after.id : null;
    panel.redockRemembered = true;
  }
  if (!pos) {
    // Undocking: open near the panel's current on-screen spot so the
    // transition reads as "popping out", then remember it as the float pos.
    const rect = panel.el.getBoundingClientRect();
    pos = rect.width
      ? clampPos({ left: Math.round(rect.left) + 24, top: Math.round(rect.top) })
      : panel.floatPos;
  }
  panel.floatPos = pos;
  // A window whose base position would be covered by the dock is displaced
  // just past its right edge (only as far as needed) while it occupies space.
  panel.dockShifted = !opts.noDockShift && dockOccupies
    && typeof pos.left === 'number' && pos.left < lastUiWidth + DOCK_GAP;
  document.body.appendChild(panel.el);
  panel.markFloating(pos);
  // Re-apply once the floating styles are in effect: the derived placement
  // (dock displacement + viewport clamp) measures the element's floated size.
  panel.applyFloatPosition(derivedFloatPos(panel));
  resequenceSortKeys();
  scheduleSave();
}

// ---- dock-visibility displacement of floating windows ------------------------

/** Does the side panel currently reserve layout space? (On mobile it slides
 *  OVER the canvas, so floating windows never need to make room for it.) */
function dockOccupiesSpace() {
  if (window.innerWidth <= 1024) return false;
  const ui = document.getElementById('ui');
  return !!ui && ui.getBoundingClientRect().width > 0;
}

function measureUiWidth() {
  const ui = document.getElementById('ui');
  const w = ui ? ui.getBoundingClientRect().width : 0;
  if (w > 0) lastUiWidth = w;
  return lastUiWidth;
}

/**
 * The single derivation from a window's inherent position (floatPos) to its
 * applied on-screen position: dock displacement first (a window in the
 * visible dock's column moves just past its right edge), then the viewport
 * clamp (title bar kept reachable). Pure — floatPos is never modified, so
 * hiding the dock or growing the browser window back restores the window
 * exactly.
 */
function derivedFloatPos(panel) {
  // Compact panels ignore floatPos and dock displacement entirely: they stack
  // in a fixed corner via compactAnchorFor. Split-view reserve still applies to
  // a right-anchored one so it clears the pane.
  if (panel.compact) {
    const anchor = compactAnchorFor(panel);
    if (anchor) {
      const pos = { ...anchor };
      if (rightReservePx > 0 && typeof pos.right === 'number') pos.right += rightReservePx;
      return panel.clampToViewport(pos);
    }
  }
  const pos = { ...panel.floatPos };
  if (panel.dockShifted && dockOccupies && typeof pos.left === 'number') {
    pos.left = Math.max(pos.left, lastUiWidth + DOCK_GAP);
  }
  if (rightReservePx > 0 && typeof pos.right === 'number') {
    pos.right += rightReservePx;
  }
  return panel.clampToViewport(pos);
}

/**
 * Reserve width on the right edge (e.g. the EOS split pane) so right-anchored
 * floating windows (Structure info, ...) stay clear of it instead of sliding
 * underneath. Pure additive offset on top of the panel's inherent floatPos —
 * never mutates it, so it unwinds exactly when the reservation drops to 0.
 */
export function setRightReserve(px) {
  rightReservePx = Math.max(0, px || 0);
  updateFloatPlacements();
  document.documentElement.style.setProperty('--compact-stack-bottom', `${compactStackBottomPx()}px`);
  // Both directions, unlike the dock-hide observer: dragging the split-view
  // separator is a live, continuous resize the user is performing right now
  // (same category as a window resize), not a discrete "hide this UI" toggle.
  // Gating it one-way would leave Measure/View stuck as icons after the pane
  // shrinks back until some unrelated resize came along.
  refreshCompactFloatingPanels();
}

/**
 * Re-derive every floating window's placement. Called when the side panel is
 * hidden/shown and when the browser window is resized. The dockShifted flag
 * is sticky: it is (re)decided only when the dock's occupancy actually
 * changes (and at float time), so a window the user deliberately parked over
 * the visible dock is not re-displaced by unrelated resizes.
 */
function updateFloatPlacements() {
  const occupies = dockOccupiesSpace();
  const occupancyChanged = occupies !== dockOccupies;
  if (occupies) measureUiWidth();
  dockOccupies = occupies;
  for (const panel of panels.values()) {
    if (panel.docked || panel.el.hidden || !panel.el.isConnected) continue;
    if (occupancyChanged) {
      panel.dockShifted = occupies && typeof panel.floatPos.left === 'number'
        && panel.floatPos.left < lastUiWidth + DOCK_GAP;
    }
    panel.applyFloatPosition(derivedFloatPos(panel));
  }
}

// ---- compact round-icon mode ------------------------------------------------

/** The 3D scene element's live rect — the ground truth for available width. */
function sceneRect() {
  const view = document.getElementById('view');
  return view ? view.getBoundingClientRect() : null;
}

/**
 * How far a compact-capable panel's expanded toolbar reaches in from the scene
 * edge it anchors near (right-anchored: from the scene's left edge inward;
 * left-anchored: from the scene's right edge inward). Measured once while the
 * panel is expanded and non-compact (its toolbar is fixed-size) and cached.
 */
function sceneReach(panel) {
  if (panel._sceneReach != null) return panel._sceneReach;
  if (panel.compact) return 0; // not measurable mid-compact; retry once it isn't
  const scene = sceneRect();
  const rect = panel.el.getBoundingClientRect();
  if (!scene || !rect.width) return 0;
  const reach = typeof panel.floatPos?.left === 'number'
    ? rect.right - scene.left
    : scene.right - rect.left;
  panel._sceneReach = reach;
  return reach;
}

/** Scene width the two toolbars need before they crowd each other. */
function requiredSceneWidthForCompact() {
  let leftReach = 0;
  let rightReach = 0;
  for (const panel of panels.values()) {
    if (!panel.compactBtn || panel.docked) continue;
    if (typeof panel.floatPos?.left === 'number') leftReach = Math.max(leftReach, sceneReach(panel));
    else rightReach = Math.max(rightReach, sceneReach(panel));
  }
  return leftReach + rightReach + COMPACT_SAFETY_GAP_PX;
}

/** Re-evaluate whether the compact-capable floating panels should be icons. */
function refreshCompactFloatingPanels() {
  const scene = sceneRect();
  const available = scene ? scene.width : window.innerWidth;
  const small = available < requiredSceneWidthForCompact();
  for (const panel of panels.values()) {
    if (panel.compactBtn) panel.setCompact(small && !panel.docked);
  }
  applyCompactPositions();
}

/**
 * Resolve a compact panel's anchor: a fixed {left|right, top} for a stack head
 * (compactAnchor), or, for a follower (compactStackAfter), the head's anchor
 * pushed down by the previous panel's LIVE rendered height — recursively, so a
 * follower sits below whatever the panel above currently is (icon or unfolded).
 */
function compactAnchorFor(panel) {
  if (panel.def.compactAnchor) return panel.def.compactAnchor;
  const prev = panel.def.compactStackAfter && panels.get(panel.def.compactStackAfter);
  if (!prev) return null;
  const prevAnchor = compactAnchorFor(prev);
  if (!prevAnchor) return null;
  const prevHeight = prev.el.getBoundingClientRect().height || 0;
  return { ...prevAnchor, top: (prevAnchor.top || 0) + prevHeight + COMPACT_STACK_GAP_PX };
}

/** Re-apply every compact panel's stacked position and publish the stack's
 *  bottom edge (read by the background dot in styles.css). */
function applyCompactPositions() {
  for (const panel of panels.values()) {
    if (panel.compactBtn && !panel.docked) panel.applyFloatPosition(derivedFloatPos(panel));
  }
  document.documentElement.style.setProperty('--compact-stack-bottom', `${compactStackBottomPx()}px`);
}

/** Lowest bottom edge of any CURRENTLY-compact icon/toolbar. Checks
 *  panel.compact explicitly: Measure is right-anchored in its normal toolbar
 *  layout too, and reacting to that ordinary height would be wrong. */
function compactStackBottomPx() {
  let bottom = 0;
  for (const panel of panels.values()) {
    if (!panel.compactBtn || !panel.compact || panel.docked || !panel.el.isConnected) continue;
    const rect = panel.el.getBoundingClientRect();
    if (rect.height) bottom = Math.max(bottom, rect.bottom);
  }
  return bottom;
}

/** After any dock mutation, docked panels' sort keys follow their DOM order. */
function resequenceSortKeys() {
  dockedPanels().forEach((p, i) => { p.sortKey = i; });
}

// ---- drag-to-reorder inside the dock ---------------------------------------

function beginDockReorder(panel, startEv) {
  const el = panel.el;
  const bar = panel.titlebar;
  const elH = el.offsetHeight;
  const startTop = el.offsetTop; // #dock is position:relative
  const startY = startEv.clientY;
  const grabDX = startEv.clientX - el.getBoundingClientRect().left;
  // The side panel doesn't move mid-drag, so its edge can be captured once.
  const uiRect = (document.getElementById('ui') || dockEl).getBoundingClientRect();

  const placeholder = document.createElement('div');
  placeholder.className = 'cv-dock-placeholder';
  placeholder.style.height = `${elH}px`;
  dockEl.insertBefore(placeholder, el);

  el.classList.add('cv-dragging');
  el.style.position = 'absolute';
  el.style.top = `${startTop}px`;
  el.style.left = '0';
  el.style.right = '0';

  bar.setPointerCapture(startEv.pointerId);

  const onMove = (ev) => {
    // Dragged far enough right of the dock: pull the panel out and continue
    // the same gesture as a floating move.
    if (panelPrefs.dragOutOfDock && dockOccupiesSpace()
        && ev.clientX > uiRect.right + DRAG_OUT_PX) {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      bar.releasePointerCapture(startEv.pointerId);
      // Land in the placeholder slot FIRST so floatPanel records that slot as
      // redockBeforeId (panel.docked is still true) — the dock button then
      // restores the panel to where it was pulled from.
      dockEl.insertBefore(el, placeholder);
      placeholder.remove();
      el.classList.remove('cv-dragging');
      el.style.position = '';
      el.style.top = '';
      el.style.left = '';
      el.style.right = '';
      const barH = bar.offsetHeight || 24;
      const pos = clampPos({
        left: ev.clientX - Math.min(grabDX, 180), // keep the grip near the pointer
        top: ev.clientY - Math.round(barH / 2),
      });
      floatPanel(panel, pos, { noDockShift: true });
      panel.beginFloatDrag(ev); // gesture continues as a floating move
      return;
    }

    const maxTop = Math.max(dockEl.scrollHeight - elH, 0);
    const top = Math.min(Math.max(startTop + (ev.clientY - startY), 0), maxTop);
    el.style.top = `${top}px`;

    // Move the placeholder to the slot whose midpoint the POINTER crossed.
    // (Comparing the dragged panel's centre instead would make the top slot
    // unreachable: with the panel clamped at top 0, its centre can never rise
    // above half its own height, i.e. never above the first bar's midpoint.)
    const pointerY = ev.clientY - dockEl.getBoundingClientRect().top;
    let before = null;
    for (const sib of dockedPanels()) {
      if (sib === panel) continue;
      if (pointerY < sib.el.offsetTop + sib.el.offsetHeight / 2) { before = sib.el; break; }
    }
    if (placeholder.nextElementSibling !== before) dockEl.insertBefore(placeholder, before);
  };

  const onUp = () => {
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
    bar.removeEventListener('pointercancel', onUp);
    dockEl.insertBefore(el, placeholder);
    placeholder.remove();
    el.classList.remove('cv-dragging');
    el.style.position = '';
    el.style.top = '';
    el.style.left = '';
    el.style.right = '';
    resequenceSortKeys();
    scheduleSave();
  };

  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
}

// ---- persistence ------------------------------------------------------------

function loadStoredLayout() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === LAYOUT_VERSION) {
      stored = {
        dockOrder: Array.isArray(parsed.dockOrder) ? parsed.dockOrder : [],
        panels: parsed.panels && typeof parsed.panels === 'object' ? parsed.panels : {},
      };
    }
  } catch { /* corrupted layout -> defaults */ }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = 0; saveLayout(); }, SAVE_DEBOUNCE_MS);
}

/**
 * Validate a stored/default floating position without altering its values:
 * per axis keep one anchor key if it is a plausible finite px number, else
 * return null so the caller falls back. Unlike clampPos this never rewrites
 * an off-viewport position — clamping is derived at apply time instead.
 */
function sanitizePos(pos) {
  if (!pos || typeof pos !== 'object') return null;
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 20000;
  const out = {};
  if (ok(pos.left)) out.left = pos.left;
  else if (ok(pos.right)) out.right = pos.right;
  if (ok(pos.top)) out.top = pos.top;
  else if (ok(pos.bottom)) out.bottom = pos.bottom;
  if ((out.left === undefined && out.right === undefined)
      || (out.top === undefined && out.bottom === undefined)) return null;
  return out;
}

/** Keep a NEW floating position (undock spot, drag-out, defaults) reachable
 *  in the current viewport. Remembered positions are NOT clamped with this —
 *  they stay verbatim and are clamped only at apply time (derivedFloatPos). */
function clampPos(pos) {
  const out = { ...pos };
  if (typeof out.left === 'number') {
    out.left = Math.min(Math.max(out.left, 0), Math.max(window.innerWidth - 80, 0));
  }
  if (typeof out.top === 'number') {
    out.top = Math.min(Math.max(out.top, 0), Math.max(window.innerHeight - 40, 0));
  }
  if (typeof out.bottom === 'number') {
    out.bottom = Math.min(Math.max(out.bottom, 0), Math.max(window.innerHeight - 40, 0));
  }
  return out;
}
