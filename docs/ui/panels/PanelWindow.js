// Unified panel/window component. Every UI panel is one of these: a small
// title bar (drag grip, collapse/expand triangle, title, dock/undock toggle,
// optional close button) above a content body. A panel is either "docked"
// (stacked inside #dock in the side panel) or "floating" (a fixed-position
// window over the canvas).
//
// This class owns the per-window DOM and behavior: collapse/expand (including
// the expand-upward rule near the bottom viewport edge), floating drag with
// viewport clamping, and z-order raising. Cross-panel concerns (registry,
// dock order, drag-to-reorder, persistence) live in PanelManager.js and are
// reached through the `hooks` object passed to the constructor:
//   beforeExpand(panel) -> boolean   lazy content build; false vetoes expand
//   onToggleDock(panel)              dock/undock button pressed
//   onClose(panel)                   close button pressed (closable panels)
//   onLayoutChange()                 any persistable state changed
//   beginDockReorder(panel, event)   drag started on a docked panel's title bar

const VIEWPORT_MARGIN = 8;
const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag

// Runtime z-order for floating windows. Base sits above the legacy fixed
// panels (z-index 1000) and below the About overlay.
let floatZ = 1200;

export class PanelWindow {
  constructor(def, hooks) {
    this.def = def;
    this.hooks = hooks;
    this.id = def.id;
    this.bodyId = `cvPanelBody-${def.id}`;
    this.available = true;
    this.collapsed = true;
    this.docked = true;
    this.barCollapsed = false; // title bar shrunk to a thin strip
    // Floating window displaced to the dock's right edge so the visible dock
    // doesn't cover it; cleared when the user repositions the window.
    // dockShiftBase remembers the pre-displacement left position.
    this.dockShifted = false;
    this.dockShiftBase = 0;
    // Remembered dock slot: the id of the panel this one sat above when it was
    // last undocked, so re-docking can restore that position (null = was last).
    this.redockBeforeId = null;
    this.redockRemembered = false;
    this._moving = false; // a floating drag is in progress
    // Lifecycle/layout bookkeeping maintained by PanelManager:
    this.built = false;        // content has been built into the body
    this.stale = false;        // built content refers to a previous structure
    this.wantExpanded = false; // persisted-expanded, waiting for first structure
    this.floatPos = null;      // last known floating position
    this.sortKey = 0;          // dock ordering key

    const el = document.createElement('section');
    el.className = 'cv-panel cv-docked cv-collapsed';
    el.dataset.panelId = def.id;

    const bar = document.createElement('header');
    bar.className = 'cv-panel-titlebar';

    const grip = document.createElement('span');
    grip.className = 'cv-panel-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⦀';

    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'cv-panel-fold';
    fold.setAttribute('aria-expanded', 'false');
    fold.title = 'Expand';
    fold.textContent = '▶';

    const title = document.createElement('span');
    title.className = 'cv-panel-title';
    title.innerHTML = def.title || '';

    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'cv-panel-home';
    homeBtn.title = 'Restore default position';
    homeBtn.textContent = '⌂';

    const barBtn = document.createElement('button');
    barBtn.type = 'button';
    barBtn.className = 'cv-panel-barhide';
    barBtn.title = 'Hide title bar (double-click the strip to restore)';
    barBtn.textContent = '―';

    const dockBtn = document.createElement('button');
    dockBtn.type = 'button';
    dockBtn.className = 'cv-panel-dock';
    dockBtn.title = 'Undock';
    dockBtn.textContent = '🗗';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cv-panel-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.hidden = !def.closable;

    bar.appendChild(grip);
    bar.appendChild(fold);
    bar.appendChild(title);
    bar.appendChild(homeBtn);
    bar.appendChild(barBtn);
    bar.appendChild(dockBtn);
    bar.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'cv-panel-body';
    body.id = this.bodyId;

    el.appendChild(bar);
    el.appendChild(body);

    this.el = el;
    this.titlebar = bar;
    this.titleEl = title;
    this.foldBtn = fold;
    this.dockBtn = dockBtn;
    this.body = body;

    fold.addEventListener('click', () => this.toggleCollapsed());
    homeBtn.addEventListener('click', () => this.hooks.onResetPanel(this));
    barBtn.addEventListener('click', () => {
      // Hiding the bar of a collapsed window would leave only the thin
      // strip — open the body along with it.
      if (this.collapsed) this.expand();
      this.collapseBar();
    });
    dockBtn.addEventListener('click', () => this.hooks.onToggleDock(this));
    closeBtn.addEventListener('click', () => this.hooks.onClose(this));

    bar.addEventListener('pointerdown', (e) => this._onTitlebarPointerDown(e));
    // A shrunk title bar is restored by double-clicking the thin strip.
    bar.addEventListener('dblclick', () => {
      if (this.barCollapsed) this.expandBar();
    });
    // Raise a floating window on any press inside it.
    el.addEventListener('pointerdown', () => { if (!this.docked) this.raise(); });

    // Content swaps can grow a floating window at runtime (e.g. the structure
    // panel's Bonds tab widening it); re-anchor so it grows into the viewport.
    this._sizeObserver = new ResizeObserver(() => this._keepInViewport());
    this._sizeObserver.observe(el);
  }

  setTitle(html) {
    this.titleEl.innerHTML = html;
  }

  isExpanded() {
    return !this.collapsed;
  }

  isDocked() {
    return this.docked;
  }

  toggleCollapsed() {
    if (this.collapsed) this.expand();
    else this.collapse();
  }

  expand() {
    if (!this.collapsed || !this.available) return;
    if (this.hooks.beforeExpand && this.hooks.beforeExpand(this) === false) return;
    if (!this.docked) this._anchorForExpansion();
    this.collapsed = false;
    this.el.classList.remove('cv-collapsed');
    this.foldBtn.textContent = '▼';
    this.foldBtn.title = 'Collapse';
    this.foldBtn.setAttribute('aria-expanded', 'true');
    if (this.def.onExpand) this.def.onExpand(this);
    this.hooks.onLayoutChange();
  }

  collapse() {
    if (this.collapsed) return;
    this.collapsed = true;
    this.el.classList.add('cv-collapsed');
    this.foldBtn.textContent = '▶';
    this.foldBtn.title = 'Expand';
    this.foldBtn.setAttribute('aria-expanded', 'false');
    if (this.def.onCollapse) this.def.onCollapse(this);
    this.hooks.onLayoutChange();
  }

  /** Shrink the title bar to a thin strip (dblclick restores). */
  collapseBar() {
    if (this.barCollapsed) return;
    this.barCollapsed = true;
    this.el.classList.add('cv-bar-collapsed');
    this.hooks.onLayoutChange();
  }

  expandBar() {
    if (!this.barCollapsed) return;
    this.barCollapsed = false;
    this.el.classList.remove('cv-bar-collapsed');
    this.hooks.onLayoutChange();
  }

  setAvailable(v) {
    this.available = !!v;
    this.el.classList.toggle('cv-unavailable', !this.available);
    this.foldBtn.disabled = !this.available;
    if (!this.available && !this.collapsed) this.collapse();
  }

  raise() {
    floatZ += 1;
    this.el.style.zIndex = String(floatZ);
  }

  remove() {
    this._sizeObserver.disconnect();
    this.el.remove();
  }

  // ---- dock / float transitions (DOM moves are done by PanelManager) ------

  /** Called by the manager after the element has been appended to #dock. */
  markDocked() {
    this.docked = true;
    this.dockShifted = false;
    this.el.classList.add('cv-docked');
    this.el.classList.remove('cv-floating');
    this.dockBtn.textContent = '🗗';
    this.dockBtn.title = 'Undock';
    // Clear floating geometry.
    const s = this.el.style;
    s.left = s.right = s.top = s.bottom = s.zIndex = '';
  }

  /** Called by the manager after the element has been moved to document.body. */
  markFloating(pos) {
    this.docked = false;
    this.el.classList.add('cv-floating');
    this.el.classList.remove('cv-docked');
    this.dockBtn.textContent = '⭰';
    this.dockBtn.title = 'Dock into side panel';
    this.applyFloatPosition(pos);
    this.raise();
  }

  /** pos: any of {left, right, top, bottom}; numbers are px, strings pass through. */
  applyFloatPosition(pos) {
    const s = this.el.style;
    const css = (v) => (typeof v === 'number' ? `${v}px` : v);
    s.left = pos.left !== undefined ? css(pos.left) : 'auto';
    s.right = pos.right !== undefined ? css(pos.right) : 'auto';
    s.top = pos.top !== undefined ? css(pos.top) : 'auto';
    s.bottom = pos.bottom !== undefined ? css(pos.bottom) : 'auto';
  }

  /** Current persistable floating position (left/top after drags, or bottom-anchored). */
  getFloatPosition() {
    const rect = this.el.getBoundingClientRect();
    if (this.el.style.bottom && this.el.style.bottom !== 'auto') {
      return { left: Math.round(rect.left), bottom: Math.round(window.innerHeight - rect.bottom) };
    }
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  }

  // ---- expand-upward near the bottom edge ---------------------------------

  /** Measure the panel's full (expanded) height without showing it. */
  _measureExpandedHeight() {
    this.body.style.visibility = 'hidden';
    this.el.classList.remove('cv-collapsed');
    const h = this.el.offsetHeight;
    this.el.classList.add('cv-collapsed');
    this.body.style.visibility = '';
    return h;
  }

  /**
   * Before expanding a floating panel, decide its anchoring: if growing
   * downward would push it off-screen, pin the bottom edge instead so the
   * panel grows upward and its bottom stays where it was.
   */
  _anchorForExpansion() {
    const rect = this.el.getBoundingClientRect();
    const fullH = this._measureExpandedHeight();
    const s = this.el.style;
    const bottomAnchored = s.bottom && s.bottom !== 'auto';
    if (bottomAnchored) return; // already grows upward
    if (rect.top + fullH > window.innerHeight - VIEWPORT_MARGIN) {
      s.bottom = `${Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.bottom)}px`;
      s.top = 'auto';
    }
  }

  /**
   * Called by a ResizeObserver whenever this window's size changes. If a
   * floating window has grown past the right or bottom viewport edge, flip it
   * to right/bottom anchoring: the far edge is pulled back to the viewport
   * margin and stays fixed there, so the window extends left/up instead.
   * (Anchoring flips back to left/top when the user drags the window.)
   */
  _keepInViewport() {
    // Never re-anchor mid-drag: near the right edge the window's shrink-to-fit
    // width changes (firing this observer), and pinning `right` while the drag
    // keeps setting `left` over-constrains the box, stretching it toward its
    // max-width as it is dragged back left.
    if (this._moving || this.docked || this.el.hidden || !this.el.isConnected) return;
    const rect = this.el.getBoundingClientRect();
    if (!rect.width) return;
    const s = this.el.style;
    const leftAnchored = !s.right || s.right === 'auto';
    if (leftAnchored && rect.right > window.innerWidth - VIEWPORT_MARGIN) {
      s.right = `${Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right)}px`;
      s.left = 'auto';
    }
    const topAnchored = !s.bottom || s.bottom === 'auto';
    if (topAnchored && rect.bottom > window.innerHeight - VIEWPORT_MARGIN) {
      s.bottom = `${Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.bottom)}px`;
      s.top = 'auto';
    }
    // Growth must never push the title bar out of reach: an upward-growing
    // (bottom-anchored) window is moved down so its top stays on screen, and
    // a leftward-growing (right-anchored) window is moved right likewise.
    if (rect.top < VIEWPORT_MARGIN && s.bottom && s.bottom !== 'auto') {
      s.bottom = `${Math.max(0, window.innerHeight - VIEWPORT_MARGIN - rect.height)}px`;
    }
    if (rect.left < VIEWPORT_MARGIN && s.right && s.right !== 'auto') {
      s.right = `${Math.max(0, window.innerWidth - VIEWPORT_MARGIN - rect.width)}px`;
    }
    if (rect.top < VIEWPORT_MARGIN && (!s.bottom || s.bottom === 'auto')) {
      s.top = `${VIEWPORT_MARGIN}px`;
    }
  }

  /** Freeze the current rect as left/top anchoring (used at drag start). */
  _anchorTopLeft() {
    const rect = this.el.getBoundingClientRect();
    const s = this.el.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.right = 'auto';
    s.bottom = 'auto';
  }

  // ---- title bar pointer handling ------------------------------------------

  _onTitlebarPointerDown(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let grabDX = 0;
    let grabDY = 0;

    const bar = this.titlebar;
    bar.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD &&
            Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        if (this.docked) {
          // Hand the whole gesture over to the manager's reorder logic.
          bar.releasePointerCapture(e.pointerId);
          bar.removeEventListener('pointermove', onMove);
          bar.removeEventListener('pointerup', onUp);
          bar.removeEventListener('pointercancel', onUp);
          this.hooks.beginDockReorder(this, ev);
          return;
        }
        this._anchorTopLeft();
        this._moving = true;
        const rect = this.el.getBoundingClientRect();
        grabDX = ev.clientX - rect.left;
        grabDY = ev.clientY - rect.top;
        this.el.classList.add('cv-drag-moving');
      }
      // Floating move, clamped so the title bar (or the collapsed handle,
      // which is a short centered strip) stays reachable: its top never goes
      // above the viewport, and at least 40px of it stays visible
      // horizontally.
      const barLeft = bar.offsetLeft;
      const barW = Math.max(bar.offsetWidth, 40);
      const barH = bar.offsetHeight;
      const left = Math.min(
        Math.max(ev.clientX - grabDX, 40 - (barLeft + barW)),
        window.innerWidth - 40 - barLeft);
      const top = Math.min(Math.max(ev.clientY - grabDY, 0),
        window.innerHeight - barH);
      this.el.style.left = `${left}px`;
      this.el.style.top = `${top}px`;
    };

    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      this.el.classList.remove('cv-drag-moving');
      this._moving = false;
      if (!dragging) {
        // Plain click on the title bar toggles collapse — except on the thin
        // strip of a hidden bar, where only double-click (restore) acts.
        if (!this.barCollapsed) this.toggleCollapsed();
      } else {
        // A user-chosen position replaces any dock displacement.
        if (!this.docked) this.dockShifted = false;
        this.hooks.onLayoutChange();
      }
    };

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  }
}
