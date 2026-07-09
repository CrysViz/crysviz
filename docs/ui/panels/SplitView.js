// Generic right-side split view: splits #viewArea between the 3D #view and a
// content pane, independent of whichever feature panel is using it. Only one
// owner can hold the pane at a time (there is only one physical pane) — a
// panel claims it via openSplitView() when it expands and releases it via
// closeSplitView() when it collapses. See docs/ui/EOSSplitView.js for the EOS
// fit plots' use of this, and docs/ui/DummySplitPanel.js for a minimal
// second example.
//
// This module owns only layout/DOM plumbing (pane, drag handle, pull-tab,
// collapse, fullscreen-item overlay) and the generic click delegation that
// drives it. All actual content — and what any of an owner's own buttons
// inside that content do — is supplied by the owner via the callbacks passed
// to openSplitView().

import { setRightReserve } from './PanelManager.js';
import { resizeRenderer } from '../WindowAndSceneControls.js';
import { requestRender } from '../../render/index.js';
import { app } from '../../state/store.js';

const DEFAULT_PANE_FRACTION = 1 / 3;
const MIN_PANE_PX = 220; // dragged narrower than this -> snap collapsed

let active = null; // the owner config passed to openSplitView(), or null
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
    tab: document.getElementById('splitPaneTab'),
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

/**
 * Claim the pane for `owner`. If another owner currently holds it, that
 * owner is closed first (there is only one pane).
 *
 * owner: {
 *   title: string,                              shown in the pane header
 *   render(bodyEl): void,                       build the pane's content
 *   onAction?(action, itemId, btnEl): void,      any [data-split-action] click
 *                                                inside the pane other than
 *                                                the generic expand/close
 *   onExpandChange?(itemId, expanded): void,     a .split-item was expanded to
 *                                                fullscreen (itemId = its
 *                                                data-split-item) or the
 *                                                fullscreen view was closed
 *                                                (itemId = null)
 *   onResize?(): void,                          the pane's on-screen size
 *                                                just changed (open, drag,
 *                                                un-collapse)
 *   onClose?(): void,                            the pane is being released
 *                                                (by this owner collapsing,
 *                                                or another owner taking it)
 * }
 */
export function openSplitView(owner) {
  wireOnce();
  const { viewArea, pane, title, body, handle, tab } = els();
  if (!viewArea || !pane || !body) return;
  if (active && active !== owner) {
    const prev = active;
    active = null;
    prev.onClose?.();
  }
  active = owner;
  collapsed = false;
  if (title) title.textContent = owner.title || '';
  if (tab) tab.textContent = `${owner.title || ''} ▸`; // ▸
  body.innerHTML = '';
  owner.render(body);
  viewArea.classList.add('split-active');
  pane.hidden = false;
  if (handle) handle.hidden = false;
  if (tab) tab.hidden = false;
  applyPaneWidth();
  syncSceneAndSidePanels();
  requestAnimationFrame(() => active?.onResize?.());
}

/** Release the pane, if `owner` is the one currently holding it (or always,
 *  if no owner is given — e.g. a hard reset). */
export function closeSplitView(owner) {
  if (owner && active !== owner) return;
  const { viewArea, pane, body, handle, tab } = els();
  const prev = active;
  active = null;
  if (viewArea) viewArea.classList.remove('split-active', 'split-pane-collapsed');
  if (pane) pane.hidden = true;
  if (handle) handle.hidden = true;
  if (tab) tab.hidden = true;
  closeExpandedItem();
  if (body) body.innerHTML = '';
  syncSceneAndSidePanels();
  prev?.onClose?.();
}

/** Whether the pane is currently open, optionally scoped to a specific owner. */
export function isSplitViewActive(owner) {
  return owner ? active === owner : !!active;
}

function setCollapsed(next) {
  collapsed = next;
  applyPaneWidth();
  syncSceneAndSidePanels();
  if (!collapsed) active?.onResize?.();
}

function closeExpandedItem() {
  const { viewArea, overlay } = els();
  const hadExpanded = !!document.querySelector('.split-pane .split-item.expanded');
  document.querySelectorAll('.split-pane .split-item.expanded').forEach((w) => w.classList.remove('expanded'));
  overlay?.classList.remove('active');
  viewArea?.classList.remove('split-item-expanded');
  if (hadExpanded) active?.onExpandChange?.(null, false);
}

function wireOnce() {
  if (wired) return;
  wired = true;
  const { viewArea, pane, handle, tab, overlay } = els();

  const collapseBtn = document.getElementById('splitPaneCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => setCollapsed(true));
  if (tab) tab.addEventListener('click', () => setCollapsed(false));

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
        active?.onResize?.();
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
        viewArea?.classList.add('split-item-expanded');
        active?.onExpandChange?.(itemId ?? null, true);
      } else if (action === 'close') {
        closeExpandedItem();
      } else {
        active?.onAction?.(action, itemId ?? null, btn);
      }
    });
  }

  if (overlay) {
    overlay.addEventListener('click', () => closeExpandedItem());
  }

  // A plain browser window resize changes #view's pixel size too (the pane's
  // width is a fraction of the viewport) — keep the reserve/dot/renderer in
  // sync without waiting for the next pane interaction.
  window.addEventListener('resize', () => { if (active) syncSceneAndSidePanels(); });
}
