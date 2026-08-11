// Unified panel/window component. Every UI panel is one of these: a small
// title bar (drag grip, collapse/expand triangle, title, ≡ window menu,
// optional close button) above a content body. A panel is either docked in
// the main dock (stacked inside #dock in the side panel), docked in the
// side dock (a tab in the wide right pane — ui/panels/SideDock.js; the
// title bar is hidden there, the tab is the chrome), or "floating" (a
// fixed-position window over the canvas). dock ∈ {'left','right',false}.
//
// The ≡ button opens a dropdown menu of window options. Its first section is
// always "Position" (Float / Main dock / Side dock / Default — replacing the
// old ⌂ and ↦/⇤ title-bar buttons); a panel definition can append its own
// sections via def.menuSections — an array (or a function of the panel
// returning an array, for dynamic state) of
//   { title: string, items: [{ label, checked?, onSelect() }] }
// e.g. a future color-bar window offering Vertical/Horizontal orientation.
//
// This class owns the per-window DOM and behavior: collapse/expand (including
// the expand-upward rule near the bottom viewport edge), floating drag with
// viewport clamping, and z-order raising. Cross-panel concerns (registry,
// dock order, drag-to-reorder, persistence) live in PanelManager.js and are
// reached through the `hooks` object passed to the constructor:
//   beforeExpand(panel) -> boolean   lazy content build; false vetoes expand
//   positionPanel(panel, mode)       ≡ menu Position action; mode is one of
//                                    'float' | 'left' | 'right' | 'default'
//   onClose(panel)                   close button pressed (closable panels)
//   onLayoutChange()                 any persistable state changed
//   beginDockReorder(panel, event)   drag started on a docked panel's title bar
//   wantsDockDrop(event) -> boolean  floating drag is over the dock and the
//                                    drag-into-dock setting is enabled
//   dockAtPointer(panel, event)      commit a drag-into-dock; the manager
//                                    continues the gesture as a reorder drag
//   wantsSideDockDrop(event) -> boolean  floating drag RELEASED over the
//                                    side dock's drop zone (checked on
//                                    pointerup only — the right edge is a
//                                    normal parking spot for floating
//                                    windows, so no live commit)
//   sideDockAtPointer(panel, event) commit a drop into the side dock
//   updateSideDockHint(event|null)  show/hide the side-dock drop highlight
//                                    while a floating drag is in progress

import { showInfoPanel } from '../InfoPanel.js';

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
    /** Where the window lives: 'left' (#dock), 'right' (the wide side dock,
     *  shown as a tab), or false (floating). The legacy boolean `docked`
     *  getter below means "not floating" and covers both docks.
     *  @type {'left'|'right'|false} */
    this.dock = 'left';
    // Registered but detached from the DOM (closeMode:'hide' windows, e.g.
    // EOS). PanelManager owns attach/detach; `dock` keeps the remembered
    // location for reopening.
    this.closed = false;
    // Set by PanelManager when a side-docked panel is auto-closed because its
    // feature became unavailable, so it can be reopened when the feature returns.
    this._closedForUnavailable = false;
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
    // Compact round-icon mode (only for panels that declare a compactIcon):
    // when the scene is too narrow for the floating toolbars, the window
    // shrinks to a 54px icon; clicking the icon unfolds the toolbar again.
    this.compact = false;
    this.compactBtn = null;
    this._sceneReach = null; // cached toolbar reach into the scene (see manager)

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

    // Optional "i" info button — opens a markdown blurb about this panel.
    // Lives as a direct child of the title bar, so it hides along with the
    // rest of the bar's controls when the bar is shrunk to its thin strip.
    let infoBtn = null;
    if (def.infoMd) {
      infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'cv-panel-info info-button';
      infoBtn.title = 'About this panel';
      infoBtn.textContent = 'i';
      infoBtn.addEventListener('click', () => showInfoPanel(def.infoMd));
    }

    // ≡ window menu (Position section + any def.menuSections) — replaces the
    // old ⌂ restore-default and ↦/⇤ dock-toggle buttons.
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'cv-panel-menu-btn';
    menuBtn.title = 'Window options';
    menuBtn.textContent = '≡';

    const barBtn = document.createElement('button');
    barBtn.type = 'button';
    barBtn.className = 'cv-panel-barhide';
    barBtn.title = 'Hide title bar (double-click the strip to restore)';
    barBtn.textContent = '―';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cv-panel-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.hidden = !def.closable;

    bar.appendChild(grip);
    bar.appendChild(fold);
    bar.appendChild(title);
    if (infoBtn) bar.appendChild(infoBtn);
    bar.appendChild(menuBtn);
    bar.appendChild(barBtn);
    bar.appendChild(closeBtn);

    // Round compact-mode icon button (hidden until .cv-compact via CSS). Lives
    // inside the same title bar; clicking it folds/unfolds the toolbar.
    let compactBtn = null;
    if (def.compactIcon) {
      compactBtn = document.createElement('button');
      compactBtn.type = 'button';
      compactBtn.className = 'cv-panel-compact-btn';
      compactBtn.title = def.compactLabel || def.title || '';
      const cimg = document.createElement('img');
      cimg.src = def.compactIcon;
      cimg.alt = '';
      compactBtn.appendChild(cimg);
      compactBtn.addEventListener('click', () => this.toggleCollapsed());
      bar.appendChild(compactBtn);
      this.compactBtn = compactBtn;
    }

    const body = document.createElement('div');
    body.className = 'cv-panel-body';
    body.id = this.bodyId;

    el.appendChild(bar);
    el.appendChild(body);

    this.el = el;
    this.titlebar = bar;
    this.titleEl = title;
    this.foldBtn = fold;
    this.body = body;
    this._menuEl = null;      // the open ≡ dropdown, if any (portaled to body)
    this._menuCleanup = null; // outside-click/Escape listeners teardown

    fold.addEventListener('click', () => this.toggleCollapsed());
    menuBtn.addEventListener('click', () => this._toggleMenu(menuBtn));
    barBtn.addEventListener('click', () => {
      // Hiding the bar of a collapsed window would leave only the thin
      // strip — open the body along with it.
      if (this.collapsed) this.expand();
      this.collapseBar();
    });
    closeBtn.addEventListener('click', () => this.hooks.onClose(this));

    bar.addEventListener('pointerdown', (e) => this._onTitlebarPointerDown(e));
    // A shrunk title bar is restored by double-clicking the thin strip — but
    // NOT when the double-click landed on the compact round icon (an ordinary
    // way to toggle the toolbar open/closed twice), which would otherwise flip
    // barCollapsed off and persist the wrong bar state for the next compact
    // cycle.
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

  /** Legacy boolean: in either dock (i.e. not floating). Most cross-panel
   *  logic (float placement, compact mode) only cares about this. */
  get docked() {
    return this.dock !== false;
  }

  isExpanded() {
    return !this.collapsed;
  }

  isDocked() {
    return this.docked;
  }

  isSideDocked() {
    return this.dock === 'right';
  }

  toggleCollapsed() {
    // Side-docked windows have no individual collapse — the whole side dock
    // collapses to edge pull-tabs instead (SideDock.js).
    if (this.dock === 'right') return;
    if (this.collapsed) this.expand();
    else this.collapse();
  }

  /**
   * Enter/leave compact round-icon mode. Compacting also collapses the body
   * (icon-only = collapsed); leaving compact always re-expands it, because the
   * fold button is hidden while compact (only the round icon shows), so a body
   * left collapsed from a prior cycle would have no visible control to reopen.
   */
  setCompact(v) {
    if (!this.compactBtn || this.compact === !!v) return;
    this.compact = !!v;
    this.el.classList.toggle('cv-compact', this.compact);
    if (this.compact) this.collapse();
    else this.expand();
  }

  expand() {
    if (!this.collapsed || !this.available) return;
    if (this.hooks.beforeExpand && this.hooks.beforeExpand(this) === false) return;
    // A compact panel's position is owned by the compact-stacking system
    // (re-applied via onCompactResize below); skip the generic bottom-anchor
    // safety net, which would fight it.
    if (!this.docked && !this.compact) this._anchorForExpansion();
    this.collapsed = false;
    this.el.classList.remove('cv-collapsed');
    this.foldBtn.textContent = '▼';
    this.foldBtn.title = 'Collapse';
    this.foldBtn.setAttribute('aria-expanded', 'true');
    if (this.def.onExpand) this.def.onExpand(this);
    this.hooks.onLayoutChange();
    this.hooks.onCompactResize?.(this);
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
    this.hooks.onCompactResize?.(this);
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
    this._closeMenu();
    this._sizeObserver.disconnect();
    this.el.remove();
  }

  // ---- ≡ window menu -------------------------------------------------------

  /** The menu's sections: the built-in Position section first, then whatever
   *  the panel definition contributes via def.menuSections (see the header
   *  comment for the shape). */
  _menuSections() {
    const mode = this.dock === 'right' ? 'right' : (this.dock === 'left' ? 'left' : 'float');
    const move = (m) => { this.hooks.positionPanel(this, m); };
    /** @type {{title?: string, items: {label: string, checked?: boolean, onSelect: () => void}[]}[]} */
    const sections = [{
      title: 'Position',
      items: [
        { label: 'Float', checked: mode === 'float', onSelect: () => move('float') },
        { label: 'Main dock', checked: mode === 'left', onSelect: () => move('left') },
        { label: 'Side dock', checked: mode === 'right', onSelect: () => move('right') },
        { label: 'Default', onSelect: () => move('default') },
      ],
    }];
    const extra = typeof this.def.menuSections === 'function'
      ? this.def.menuSections(this)
      : this.def.menuSections;
    if (Array.isArray(extra)) sections.push(...extra);
    // Closable windows get a Close item at the end. While side-docked this
    // is the ONLY close path (the title-bar ✕ is hidden with the bar, and
    // the tab deliberately carries no ✕ — a stray click there permanently
    // unregistered transient windows).
    if (this.def.closable) {
      sections.push({ items: [{ label: 'Close', onSelect: () => this.hooks.onClose(this) }] });
    }
    return sections;
  }

  _toggleMenu(anchorBtn) {
    if (this._menuEl) this._closeMenu();
    else this._openMenu(anchorBtn);
  }

  /** Open/toggle the ≡ menu anchored at an arbitrary element — used by the
   *  side dock's tab ≡ button, where the title bar (and its own ≡) is
   *  hidden. */
  toggleMenuAt(anchorEl) {
    this._toggleMenu(anchorEl);
  }

  /** Build and show the dropdown. Portaled to document.body (position:fixed):
   *  a docked window's title bar lives inside #ui's scroll container, which
   *  would clip an in-place dropdown. */
  _openMenu(anchorBtn) {
    const menu = document.createElement('div');
    menu.className = 'cv-panel-menu';
    for (const section of this._menuSections()) {
      if (section.title) {
        const header = document.createElement('div');
        header.className = 'cv-panel-menu-header';
        header.textContent = section.title;
        menu.appendChild(header);
      } else if (menu.childElementCount) {
        // Untitled section after another: a thin separator line.
        const sep = document.createElement('div');
        sep.className = 'cv-panel-menu-sep';
        menu.appendChild(sep);
      }
      for (const item of section.items || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cv-panel-menu-item' + (item.checked ? ' checked' : '');
        btn.textContent = item.label;
        btn.addEventListener('click', () => {
          this._closeMenu();
          item.onSelect();
        });
        menu.appendChild(btn);
      }
    }
    document.body.appendChild(menu);
    // Below the ≡ button, kept inside the viewport (measure after append).
    const r = anchorBtn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(r.left, window.innerWidth - mw - VIEWPORT_MARGIN))}px`;
    menu.style.top = r.bottom + 4 + mh > window.innerHeight - VIEWPORT_MARGIN
      ? `${Math.max(VIEWPORT_MARGIN, r.top - 4 - mh)}px`
      : `${r.bottom + 4}px`;
    this._menuEl = menu;

    const onOutside = (ev) => {
      const t = /** @type {Node} */ (ev.target);
      if (menu.contains(t) || anchorBtn.contains(t)) return;
      this._closeMenu();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') this._closeMenu(); };
    // Capture-phase so a click that some panel handler swallows still closes
    // the menu; registered after this click event finished bubbling.
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    this._menuCleanup = () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  _closeMenu() {
    this._menuEl?.remove();
    this._menuEl = null;
    this._menuCleanup?.();
    this._menuCleanup = null;
  }

  // ---- dock / float transitions (DOM moves are done by PanelManager) ------

  /** Called by the manager after the element has been appended to #dock. */
  markDocked() {
    this.dock = 'left';
    this.dockShifted = false;
    this.el.classList.add('cv-docked');
    this.el.classList.remove('cv-floating', 'cv-side-docked', 'cv-front');
    // Clear floating geometry.
    const s = this.el.style;
    s.left = s.right = s.top = s.bottom = s.zIndex = '';
  }

  /** Called by SideDock after the element has been inserted into the right
   *  pane's body. The title bar is hidden there (the tab is the chrome);
   *  floatPos is deliberately NOT touched — it is where the window returns
   *  when pulled back out. */
  markSideDocked() {
    this.dock = 'right';
    this.dockShifted = false;
    this.el.classList.add('cv-side-docked');
    this.el.classList.remove('cv-docked', 'cv-floating', 'cv-drag-moving');
    const s = this.el.style;
    s.left = s.right = s.top = s.bottom = s.zIndex = '';
  }

  /** Called by the manager after the element has been moved to document.body. */
  markFloating(pos) {
    this.dock = false;
    this.el.classList.add('cv-floating');
    this.el.classList.remove('cv-docked', 'cv-side-docked', 'cv-front');
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
    // Compact panels are positioned entirely by the compact-stacking system;
    // this generic safety net would silently overwrite a correct compactAnchor.
    if (this.compact) return;
    // Never re-anchor mid-drag: near the right edge the window's shrink-to-fit
    // width changes (firing this observer), and pinning `right` while the drag
    // keeps setting `left` over-constrains the box, stretching it toward its
    // max-width as it is dragged back left.
    if (this._moving || this.docked || this.el.hidden || !this.el.isConnected) return;
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
    // The title bar is hidden while side-docked (the tab is the chrome);
    // defensive in case a hidden bar still receives a press.
    if (this.dock === 'right') return;
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
      if (this.dock === 'left') {
        // Hand the whole gesture over to the manager's reorder logic.
        bar.releasePointerCapture(e.pointerId);
        this.hooks.beginDockReorder(this, ev);
        return;
      }
      this._startFloatMove(ev, e.pointerId);
    };

    const onUp = (ev) => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      // Plain click on the title bar toggles collapse — except on the thin
      // strip of a hidden bar, where only double-click (restore) acts.
      if (!this.barCollapsed) {
        this.toggleCollapsed();
      } else if (ev.type === 'pointerup' && ev.pointerType === 'touch') {
        // Touch has no reliable dblclick: this handler's own preventDefault +
        // setPointerCapture above suppress the browser's tap-to-dblclick
        // synthesis, so double-tapping the collapsed handle does nothing on
        // touch devices. A single untapped-into-a-drag tap restores it instead.
        this.expandBar();
      }
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
      this.hooks.updateSideDockHint?.(null);
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
      // Side-dock drop is on-release only (the right edge is a normal
      // parking spot); while hovering the zone, just show the highlight.
      this.hooks.updateSideDockHint?.(mv);
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

    const onUp = (up) => {
      teardown();
      // Released over the side dock's drop zone: dock there instead of
      // parking. Only a real pointerup commits (a pointercancel must not).
      if (up.type === 'pointerup'
          && this.hooks.wantsSideDockDrop && this.hooks.wantsSideDockDrop(up)) {
        this.hooks.sideDockAtPointer(this, up);
        return;
      }
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
