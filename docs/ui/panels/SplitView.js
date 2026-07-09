// Generic right-side split view: splits #viewArea between the 3D #view and a
// content pane, independent of whichever feature panel is using it. Several
// owners can hold the pane at once — each keeps its own persistent content and
// gets a tab in the stack on the pane's edge; exactly one owner is "front"
// (visible in the body) at a time, and clicking a tab brings its owner front
// (un-collapsing the pane if needed). A panel claims a slot via openSplitView()
// when it expands and releases it via closeSplitView() when it collapses. See
// docs/ui/EOSSplitView.js and docs/ui/DummySplitPanel.js for owner examples.
//
// This module owns only layout/DOM plumbing (pane, drag handle, tab stack,
// collapse, fullscreen-item overlay) and the generic click delegation that
// drives it. Each owner's content — and what its own buttons do — is supplied
// by the owner via the callbacks passed to openSplitView(). Switching which
// owner is front never re-renders an owner or fires its onClose(): content is
// built once (into a per-owner container) and only shown/hidden, so transient
// state (a loaded file, scroll position) survives a tab switch.

import { setRightReserve } from './PanelManager.js';
import { resizeRenderer } from '../WindowAndSceneControls.js';
import { requestRender } from '../../render/index.js';
import { app } from '../../state/store.js';

const DEFAULT_PANE_FRACTION = 1 / 3;
const MIN_PANE_PX = 220; // dragged narrower than this -> snap collapsed

const owners = [];              // open owners, in the order they were opened
const containers = new Map();   // owner -> its persistent content <div>
let front = null;               // the owner currently shown in the body, or null
let collapsed = false;
let wired = false;
let paneFraction = DEFAULT_PANE_FRACTION;

function els() {
  return {
    viewArea: document.getElementById('viewArea'),
    view: document.getElementById('view'),
    pane: document.getElementById('splitPane'),
    title: document.getElementById('splitPaneTitle'),
    body: document.getElementById('splitPaneBody'),
    handle: document.getElementById('splitHandle'),
    tabs: document.getElementById('splitPaneTabs'),
    headerTabs: document.getElementById('splitPaneHeaderTabs'),
    overlay: document.getElementById('splitPaneOverlay'),
  };
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
  if (!view) return;
  const reservePx = Math.max(0, window.innerWidth - view.getBoundingClientRect().right);
  setRightReserve(reservePx);
  document.documentElement.style.setProperty('--split-reserve', `${reservePx}px`);
  resizeRenderer(app.orthographicFrustumSize);
  requestRender();
}

/** Rebuild both tab renderings from the same owner list: a horizontal strip in
 *  the pane header (shown while open, so tabs sit on top) and the vertical
 *  pull-tab stack on the pane edge (shown while collapsed, to reopen). Owners
 *  keep their open order in both (tabs don't jump on switch); the front owner's
 *  tab is marked active. The pane's `.split-multi` class (owners > 1) drives
 *  whether the header strip shows in CSS. */
function fillTabs(container, suffix) {
  container.innerHTML = '';
  for (const owner of owners) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'split-pane-tab' + (owner === front ? ' active' : '');
    btn.textContent = `${owner.title || ''}${suffix}`;
    btn.title = owner.title || 'Show panel';
    btn.addEventListener('click', () => {
      collapsed = false;
      applyPaneWidth();
      setFront(owner);
      syncSceneAndSidePanels();
    });
    container.appendChild(btn);
  }
}

function renderTabs() {
  const { viewArea, tabs, headerTabs } = els();
  if (headerTabs) fillTabs(headerTabs, '');
  if (tabs) {
    fillTabs(tabs, ' ▸');
    tabs.hidden = owners.length === 0;
  }
  if (viewArea) viewArea.classList.toggle('split-multi', owners.length > 1);
}

/** Show `owner`'s content in the body (hiding the others) and make it front.
 *  Does not re-render or close anyone. */
function setFront(owner) {
  if (!owners.includes(owner)) return;
  front = owner;
  for (const [o, el] of containers) el.hidden = o !== owner;
  const { title } = els();
  if (title) title.textContent = owner.title || '';
  renderTabs();
  requestAnimationFrame(() => { if (front === owner) owner.onResize?.(); });
}

/**
 * Claim a slot in the pane for `owner`. If `owner` is already open, this just
 * brings it to front (and un-collapses); otherwise its content is built once
 * into a fresh per-owner container. Other open owners are left untouched.
 *
 * owner: {
 *   title: string,                              shown in the pane header + tab
 *   render(bodyEl): void,                       build the owner's content
 *   onAction?(action, itemId, btnEl): void,      any [data-split-action] click
 *                                                inside the pane other than
 *                                                the generic expand/close
 *   onExpandChange?(itemId, expanded): void,     a .split-item was expanded to
 *                                                fullscreen (itemId = its
 *                                                data-split-item) or the
 *                                                fullscreen view was closed
 *                                                (itemId = null)
 *   onResize?(): void,                          the owner's on-screen size
 *                                                just changed (open, drag,
 *                                                un-collapse, brought front)
 *   onClose?(): void,                            this owner's slot is being
 *                                                released (its panel collapsed,
 *                                                or a hard reset)
 * }
 */
export function openSplitView(owner) {
  wireOnce();
  const { viewArea, pane, body, handle } = els();
  if (!viewArea || !pane || !body) return;

  if (!owners.includes(owner)) {
    owners.push(owner);
    const container = document.createElement('div');
    container.className = 'split-owner-pane';
    body.appendChild(container);
    containers.set(owner, container);
    owner.render(container);
  }

  collapsed = false;
  viewArea.classList.add('split-active');
  pane.hidden = false;
  if (handle) handle.hidden = false;
  applyPaneWidth();
  setFront(owner);
  syncSceneAndSidePanels();
  requestAnimationFrame(() => front?.onResize?.());
}

/** Release a slot. With an owner, releases just that owner (its content is
 *  destroyed and its onClose fires); the pane stays open on another owner if
 *  any remain. With no owner, releases everyone (a hard reset). */
export function closeSplitView(owner) {
  if (!owner) {
    for (const o of [...owners]) removeOwner(o);
    hidePaneChrome();
    return;
  }
  if (!owners.includes(owner)) return;
  removeOwner(owner);
  if (owners.length === 0) {
    hidePaneChrome();
  } else {
    if (front === owner || !front) setFront(owners[owners.length - 1]);
    else renderTabs();
    syncSceneAndSidePanels();
  }
}

function removeOwner(owner) {
  const idx = owners.indexOf(owner);
  if (idx === -1) return;
  owners.splice(idx, 1);
  const el = containers.get(owner);
  if (el) el.remove();
  containers.delete(owner);
  if (front === owner) front = null;
  owner.onClose?.();
}

/** Tear down all pane chrome once no owner is left. */
function hidePaneChrome() {
  const { viewArea, pane, body, handle, tabs, headerTabs } = els();
  front = null;
  collapsed = false;
  if (viewArea) viewArea.classList.remove('split-active', 'split-pane-collapsed', 'split-multi');
  if (pane) pane.hidden = true;
  if (handle) handle.hidden = true;
  if (tabs) { tabs.innerHTML = ''; tabs.hidden = true; }
  if (headerTabs) headerTabs.innerHTML = '';
  closeExpandedItem();
  if (body) body.innerHTML = '';
  syncSceneAndSidePanels();
}

/** Whether the pane is currently open, optionally scoped to a specific owner
 *  (true if that owner has an open slot, front or not). */
export function isSplitViewActive(owner) {
  return owner ? owners.includes(owner) : owners.length > 0;
}

function setCollapsed(next) {
  collapsed = next;
  applyPaneWidth();
  renderTabs(); // collapse/expand changes whether the stack shows
  syncSceneAndSidePanels();
  if (!collapsed) front?.onResize?.();
}

function closeExpandedItem() {
  const { viewArea, overlay } = els();
  const hadExpanded = !!document.querySelector('.split-pane .split-item.expanded');
  document.querySelectorAll('.split-pane .split-item.expanded').forEach((w) => w.classList.remove('expanded'));
  overlay?.classList.remove('active');
  viewArea?.classList.remove('split-item-expanded');
  if (hadExpanded) front?.onExpandChange?.(null, false);
}

function wireOnce() {
  if (wired) return;
  wired = true;
  const { pane, handle, overlay } = els();

  const collapseBtn = document.getElementById('splitPaneCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setCollapsed(true));

  // Drag the splitter: resize while open, snap to the collapsed tab if
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
          setCollapsed(true);
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
        front?.onResize?.();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  if (pane) {
    pane.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-split-action]');
      if (!btn) return;
      const action = btn.dataset.splitAction;
      const itemId = btn.dataset.splitItem;
      if (action === 'expand') {
        const wrapper = btn.closest('.split-item');
        wrapper?.classList.add('expanded');
        overlay?.classList.add('active');
        document.getElementById('viewArea')?.classList.add('split-item-expanded');
        front?.onExpandChange?.(itemId ?? null, true);
      } else if (action === 'close') {
        closeExpandedItem();
      } else {
        front?.onAction?.(action, itemId ?? null, btn);
      }
    });
  }

  if (overlay) {
    overlay.addEventListener('click', () => closeExpandedItem());
  }

  // A plain browser window resize changes #view's pixel size too (the pane's
  // width is a fraction of the viewport) — keep the reserve/dot/renderer in
  // sync without waiting for the next pane interaction.
  window.addEventListener('resize', () => { if (owners.length) syncSceneAndSidePanels(); });
}
