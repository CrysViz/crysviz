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
//   wantsDockDrop(event) -> boolean  floating drag is over the dock and the
//                                    drag-into-dock setting is enabled
//   dockAtPointer(panel, event)      commit a drag-into-dock; the manager
//                                    continues the gesture as a reorder drag

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
    // doesn't cover it; cleared when the user repositions the window. The
    // pre-displacement position stays in floatPos (displacement and clamping
    // are derived at apply time and never written back), so hiding the dock
    // restores it exactly.
    this.dockShifted = false;
    // Remembered dock slot: the id of the panel this one sat above when it was
    // last undocked, so re-docking can restore that position (null = was last).
    this.redockBeforeId = null;
    this.redockRemembered = false;
    this._moving = false; // a floating drag is in progress
    // Lifecycle/layout bookkeeping maintained by PanelManager:
    this.built = false;        // content has been built into the body
    this.stale = false;        // built content refers to a previous structure
    this.wantExpanded = false; // persisted-expanded, waiting for first structure
    /** Inherent floating position (user/system chosen), per axis anchored to
     *  one edge. Never overwritten by displacement/clamping (derived at apply
     *  time), so it is what dock-hide and window-grow restore.
     *  @type {{left?: number, right?: number, top?: number, bottom?: number}|null} */
    this.floatPos = null;
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
    dockBtn.textContent = '↦';

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

    // Compact mode (def.compactIcon set): on a narrow viewport, a floating
    // panel too small to fit alongside its siblings shrinks to just this
    // round icon button — see PanelManager's refreshCompactFloatingPanels.
    let compactBtn = null;
    if (def.compactIcon) {
      compactBtn = document.createElement('button');
      compactBtn.type = 'button';
      compactBtn.className = 'cv-panel-compact-btn';
      compactBtn.title = def.compactLabel || `Toggle ${def.title}`;
      const icon = document.createElement('img');
      icon.src = def.compactIcon;
      icon.alt = '';
      compactBtn.appendChild(icon);
      compactBtn.addEventListener('click', () => this.toggleCollapsed());
      bar.appendChild(compactBtn);
    }
    this.compactBtn = compactBtn;
    this.compact = false;
    // Cached reach into the scene, lazily measured and reused by
    // PanelManager's sceneReach (this panel's toolbar content is fixed-size
    // and anchored, so one measurement while expanded holds for the panel's
    // whole lifetime).
    this._sceneReach = null;

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
    // A shrunk title bar is restored by double-clicking the thin strip —
    // but not by double-clicking the compact icon button that also lives in
    // this bar once compact (that's a normal way to toggle the toolbar
    // open/closed twice quickly, not a request to restore the full bar; the
    // dblclick would otherwise bubble up and flip barCollapsed permanently).
    bar.addEventListener('dblclick', (e) => {
      const onCompactBtn = compactBtn && e.target instanceof Node && compactBtn.contains(e.target);
      if (this.barCollapsed && !onCompactBtn) this.expandBar();
    });
    // Raise a floating window on any press inside it.
    el.addEventListener('pointerdown', () => { if (!this.docked) this.raise(); });

    // Content swaps can grow a floating window at runtime (e.g. the structure
    // panel's Bonds tab widening it); re-anchor so it grows into the viewport.
    this._lastSize = { w: 0, h: 0 }; // for _keepInViewport's growth detection
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
    // Same reason _keepInViewport opts a compact panel out entirely: its
    // top/bottom is owned by compactAnchorFor, re-applied right below via
    // onCompactResize — this generic upward-growth flip would fight that.
    if (!this.docked && !this.compact) this._anchorForExpansion();
    this.collapsed = false;
    this.el.classList.remove('cv-collapsed');
    this.foldBtn.textContent = '▼';
    this.foldBtn.title = 'Collapse';
    this.foldBtn.setAttribute('aria-expanded', 'true');
    if (this.def.onExpand) this.def.onExpand(this);
    // A compact panel's rendered height just changed (icon -> icon+toolbar),
    // which can shift where anything stacked below it (in the same
    // right-anchored column) belongs — see PanelManager's applyCompactPositions.
    this.hooks.onCompactResize?.(this);
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
    this.hooks.onCompactResize?.(this);
    this.hooks.onLayoutChange();
  }

  /** Shrink the title bar to a thin strip (dblclick restores). */
  collapseBar() {
    if (this.barCollapsed) return;
    this.barCollapsed = true;
    this.el.classList.add('cv-bar-collapsed');
    this.hooks.onLayoutChange();
  }

  /** Restore the title bar from its thin shrunk strip to the full bar. */
  expandBar() {
    if (!this.barCollapsed) return;
    this.barCollapsed = false;
    this.el.classList.remove('cv-bar-collapsed');
    this.hooks.onLayoutChange();
  }

  /**
   * Shrink to (or restore from) a round icon-only button — used when a
   * floating panel doesn't have room to sit alongside its siblings (see
   * PanelManager's refreshCompactFloatingPanels). No-op if this panel wasn't
   * given a def.compactIcon. Entering compact mode also collapses the body;
   * barCollapsed is left exactly as it was (the CSS for .cv-compact fully
   * overrides .cv-bar-collapsed's titlebar look on its own), so leaving
   * compact mode again restores whichever titlebar style — full or the thin
   * bar-hide strip — the panel had before, instead of always landing on the
   * full titlebar.
   *
   * Leaving compact mode always re-expands the body, since while compact the
   * fold button itself is hidden (only the round icon shows) — without this,
   * a body left collapsed from compact mode would have no visible way back
   * open, looking like the toolbar had simply vanished.
   */
  setCompact(v) {
    if (!this.compactBtn || this.compact === !!v) return;
    this.compact = !!v;
    this.el.classList.toggle('cv-compact', this.compact);
    if (this.compact) this.collapse();
    else this.expand();
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
    this.dockBtn.textContent = '↦';
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
    this.dockBtn.textContent = '⇤';
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

  /**
   * Read the current on-screen rect as a new inherent floating position,
   * anchored per axis to the nearest viewport edge: a window parked near the
   * right or bottom edge keeps hugging that edge when the browser window is
   * resized (position:fixed right/bottom track it natively).
   */
  captureFloatPosition() {
    const rect = this.el.getBoundingClientRect();
    const pos = {};
    const rightGap = window.innerWidth - rect.right;
    if (rect.left <= rightGap) pos.left = Math.round(rect.left);
    else pos.right = Math.round(rightGap);
    const bottomGap = window.innerHeight - rect.bottom;
    if (rect.top <= bottomGap) pos.top = Math.round(rect.top);
    else pos.bottom = Math.round(bottomGap);
    return pos;
  }

  /**
   * Clamp a floating position into the current viewport, returning a new
   * object (the inherent position is never mutated). Uses exactly the
   * drag-move constraints (>=40px of the title bar reachable horizontally,
   * the bar's top row on screen), so every position the user can drag to is a
   * fixed point at the viewport size it was chosen in — a window only moves
   * once shrinking the browser window would put its bar out of reach, and it
   * returns to the inherent position when the window grows back.
   */
  clampToViewport(pos) {
    const out = { ...pos };
    const elW = this.el.offsetWidth;
    const elH = this.el.offsetHeight;
    if (!elW) return out; // not measurable (hidden/detached): leave untouched
    const bar = this.titlebar;
    const barLeft = bar.offsetLeft;
    const barW = Math.max(bar.offsetWidth, 40);
    const barH = bar.offsetHeight;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    if (typeof out.left === 'number') {
      out.left = clamp(out.left, 40 - (barLeft + barW), window.innerWidth - 40 - barLeft);
    }
    if (typeof out.right === 'number') {
      // The same two bar-reachability bounds, expressed from the right edge.
      out.right = clamp(out.right, 40 + barLeft - elW,
        window.innerWidth - elW + (barLeft + barW) - 40);
    }
    if (typeof out.top === 'number') {
      out.top = clamp(out.top, 0, window.innerHeight - barH);
    }
    if (typeof out.bottom === 'number') {
      out.bottom = clamp(out.bottom, barH - elH, window.innerHeight - elH);
    }
    return out;
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
    // A compact panel's position is fully owned by PanelManager's
    // compactAnchorFor/applyCompactPositions (explicitly re-applied on every
    // state change that could move it). This generic safety net writes the
    // same style.right/top/bottom properties independently of that, purely
    // from its own rect — expanding a wide toolbar close enough to the left
    // edge made it silently overwrite a correct compactAnchor position (e.g.
    // right:20) with its own guess (e.g. right:8), instantly breaking the
    // Measure/View stack's alignment. Compact panels opt out entirely.
    if (this.compact) return;
    const rect = this.el.getBoundingClientRect();
    if (!rect.width) return;
    // Only own-size GROWTH may re-anchor. Shrinking must not: when the
    // browser window shrinks, the viewport-relative max-width/max-height can
    // shrink the element too, and flipping anchors then would visibly move a
    // window whose position was not the problem. Window-resize reactions are
    // handled by PanelManager's updateFloatPlacements instead.
    const grew = rect.width > this._lastSize.w + 1 || rect.height > this._lastSize.h + 1;
    this._lastSize = { w: rect.width, h: rect.height };
    const s = this.el.style;
    const leftAnchored = !s.right || s.right === 'auto';
    if (grew && leftAnchored && rect.right > window.innerWidth - VIEWPORT_MARGIN) {
      s.right = `${Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right)}px`;
      s.left = 'auto';
    }
    const topAnchored = !s.bottom || s.bottom === 'auto';
    if (grew && topAnchored && rect.bottom > window.innerHeight - VIEWPORT_MARGIN) {
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
    // "Only drag windows by handle" (Settings): restrict drag starts to the
    // ⦀ grip so the rest of the title bar never grabs the window.
    if (this.hooks.getPref?.('dragByHandleOnly') && !target.closest('.cv-panel-grip')) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;

    const bar = this.titlebar;
    bar.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      if (this.docked) {
        // Hand the whole gesture over to the manager's reorder logic.
        bar.releasePointerCapture(e.pointerId);
        this.hooks.beginDockReorder(this, ev);
        return;
      }
      this._startFloatMove(ev, e.pointerId);
    };

    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      // Plain click on the title bar toggles collapse — except on the thin
      // strip of a hidden bar, where only double-click (restore) acts.
      if (!this.barCollapsed) this.toggleCollapsed();
    };

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  }

  /** Public entry used by PanelManager after pulling a panel out of the dock:
   *  continue the still-active pointer gesture as a floating move. */
  beginFloatDrag(ev) {
    this._startFloatMove(ev, ev.pointerId);
  }

  /** Run a floating title-bar drag (threshold already crossed). */
  _startFloatMove(ev, pointerId) {
    const bar = this.titlebar;
    bar.setPointerCapture(pointerId); // no-op if already captured
    this._anchorTopLeft();
    this._moving = true;
    const rect = this.el.getBoundingClientRect();
    const grabDX = ev.clientX - rect.left;
    const grabDY = ev.clientY - rect.top;
    this.el.classList.add('cv-drag-moving');

    const teardown = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      this.el.classList.remove('cv-drag-moving');
      this._moving = false;
    };

    const onMove = (mv) => {
      if (this.hooks.wantsDockDrop && this.hooks.wantsDockDrop(mv)) {
        // Dragged over the dock: dock at the pointer slot and continue the
        // gesture as a reorder drag. Capture is released explicitly (the
        // reparent into #dock would drop it anyway).
        teardown();
        bar.releasePointerCapture(pointerId);
        this.hooks.dockAtPointer(this, mv);
        return;
      }
      // Floating move, clamped so the title bar (or the collapsed handle,
      // which is a short centered strip) stays reachable: its top never goes
      // above the viewport, and at least 40px of it stays visible
      // horizontally.
      const barLeft = bar.offsetLeft;
      const barW = Math.max(bar.offsetWidth, 40);
      const barH = bar.offsetHeight;
      const left = Math.min(
        Math.max(mv.clientX - grabDX, 40 - (barLeft + barW)),
        window.innerWidth - 40 - barLeft);
      const top = Math.min(Math.max(mv.clientY - grabDY, 0),
        window.innerHeight - barH);
      this.el.style.left = `${left}px`;
      this.el.style.top = `${top}px`;
    };

    const onUp = () => {
      teardown();
      // A user-chosen position replaces any dock displacement, and becomes
      // the new inherent position, anchored to the nearest viewport edges.
      this.dockShifted = false;
      this.floatPos = this.captureFloatPosition();
      this.applyFloatPosition(this.floatPos);
      this.hooks.onLayoutChange();
    };

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  }
}
