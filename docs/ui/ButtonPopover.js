// A button whose long press (mouse hold or touch) opens a small menu under it,
// in the Hide/Restore popover look (.restore-popover, MeasurementToolbar.js):
// Reset view's Recenter menu (WindowAndSceneControls.js) and the Camera
// panel's Sync tabs menu (CameraPanel.js). A plain click still does the
// button's own job; the click that ends a long press does not.

const LONG_PRESS_MS = 550;

/** Call `onLongPress()` when `btn` is held, and swallow the click that ends the hold. */
export function wireButtonLongPress(btn, onLongPress) {
  if (!btn || btn.dataset.longPressWired) return;
  btn.dataset.longPressWired = '1';
  let timer = 0;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false;
    cancel();
    timer = window.setTimeout(() => { fired = true; onLongPress(); }, LONG_PRESS_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => btn.addEventListener(type, cancel));
  // A touch long-press would otherwise open the browser's own menu, which
  // steals the pointerup this relies on.
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // The click that ends a long press must not also do the button's job
  // (capture: before the button's own handler).
  btn.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

/** Hide the menu `el` on Escape or a press outside it. */
export function wirePopoverDismiss(el) {
  document.addEventListener('pointerdown', (e) => {
    if (!el.hidden && !el.contains(/** @type {Node} */ (e.target))) el.hidden = true;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) el.hidden = true;
  });
}

/** Show the menu `el` under `btn` (above it if there is no room below), inside the window. */
export function openPopoverUnder(el, btn) {
  el.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const below = r.bottom + 6;
  el.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  el.style.right = 'auto';
}
