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
const LAYOUT_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;

/** @type {Map<string, PanelWindow>} */
const panels = new Map();
let dockEl = null;
let stored = { dockOrder: [], panels: {} };
let revealed = false; // set once a structure is loaded (feature panels unhide)
let saveTimer = 0;

const hooks = {
  beforeExpand(panel) {
    if (panel.def.lifecycle === 'rebuild' && revealed) buildContent(panel);
    return true;
  },
  onToggleDock(panel) {
    if (panel.docked) floatPanel(panel);
    else dockPanel(panel);
  },
  onClose(panel) {
    if (panel.def.onClose) panel.def.onClose(panel);
    removePanel(panel.id);
  },
  onLayoutChange: scheduleSave,
  beginDockReorder,
};

export function initPanelSystem() {
  dockEl = document.getElementById('dock');
  loadStoredLayout();
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
  panel.floatPos = clampPos((persisted && persisted.pos) || defaults.anchor || { left: 40, top: 40 });
  panel.sortKey = dockSortKey(def);

  if (def.hiddenUntilStructure && !revealed) panel.el.hidden = true;

  if (def.lifecycle !== 'rebuild') buildContent(panel);

  if (docked) dockPanel(panel);
  else floatPanel(panel, panel.floatPos);

  if (!collapsed && panel.collapsed) {
    if (def.lifecycle === 'rebuild' && !revealed) panel.wantExpanded = true;
    else panel.expand();
  }
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
  for (const panel of panels.values()) {
    if (panel.def.persist === false) continue;
    const entry = { docked: panel.docked, collapsed: panel.collapsed };
    if (!panel.docked) {
      if (!panel.el.hidden && panel.el.isConnected) {
        panel.floatPos = panel.getFloatPosition();
      }
      entry.pos = panel.floatPos;
    }
    data.panels[panel.id] = entry;
  }
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

function dockPanel(panel) {
  let before = null;
  for (const sib of dockedPanels()) {
    if (sib === panel) continue;
    if (panel.sortKey < sib.sortKey) { before = sib.el; break; }
  }
  dockEl.insertBefore(panel.el, before);
  panel.markDocked();
  scheduleSave();
}

function floatPanel(panel, pos) {
  if (!pos) {
    // Undocking: open near the panel's current on-screen spot so the
    // transition reads as "popping out", then remember it as the float pos.
    const rect = panel.el.getBoundingClientRect();
    pos = rect.width
      ? clampPos({ left: Math.round(rect.left) + 24, top: Math.round(rect.top) })
      : panel.floatPos;
  }
  panel.floatPos = pos;
  document.body.appendChild(panel.el);
  panel.markFloating(pos);
  resequenceSortKeys();
  scheduleSave();
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
    const maxTop = Math.max(dockEl.scrollHeight - elH, 0);
    const top = Math.min(Math.max(startTop + (ev.clientY - startY), 0), maxTop);
    el.style.top = `${top}px`;

    // Move the placeholder to the slot whose midpoint the panel centre crossed.
    const centre = top + elH / 2;
    let before = null;
    for (const sib of dockedPanels()) {
      if (sib === panel) continue;
      if (centre < sib.el.offsetTop + sib.el.offsetHeight / 2) { before = sib.el; break; }
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

/** Keep a restored floating position reachable in the current viewport. */
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
