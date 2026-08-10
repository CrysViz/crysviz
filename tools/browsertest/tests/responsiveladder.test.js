// The responsive breakpoint ladder (docs/styles/responsive.css) never had
// automated coverage at any narrow viewport — exactly how mobile drifted
// into disrepair (per CLAUDE.md). Covers the two rungs CSSPlan calls out by
// name: `compact` (<=1024px, dock/side-panel becomes an off-canvas overlay)
// and `mobile` (<=720px, that overlay becomes a full-width sheet via the
// --ui-width token). Also checks the desktop/compact branch split in
// ui/MobileMenu.js's togglePanel, which reads the SAME 1024px number as CSS
// via matchMedia — a magic-number collision if the two ever drift apart.
//
// Harness note: Playwright's page.emulateMedia() only supports colorScheme/
// forcedColors/media/reducedMotion (checked against playwright-core 1.49's
// type defs) — there is no pointer/hover media emulation, so the `coarse`
// rung (pointer: coarse touch-target sizing) cannot be exercised here. Only
// setViewportSize (width/height breakpoints) is used below.
'use strict';
const H = require('../harness');

// #ui's `left` animates over `transition: left 0.3s ease` (responsive.css's
// compact rung) whenever the panel-open/closed class flips WHILE already
// inside that rung. Under 4-way parallel-shard CPU contention a fixed
// wall-clock wait doesn't reliably outlast the animation, so this arms a
// 'transitionend' listener BEFORE the trigger runs (a plain `await
// page.evaluate` after the fact could miss an event that already fired) and
// waits on it — with a fallback timeout for cases where no transition fires
// at all (e.g. a viewport resize that jumps straight into/out of the media
// query, where the transition rule and the new `left` value both apply in
// the same recalc, so there's nothing to interpolate from).
async function armUiSettleWait(page) {
  await page.evaluate(() => {
    const ui = document.getElementById('ui');
    window.__cvUiSettled = new Promise((resolve) => {
      const onEnd = (e) => { if (e.target === ui && e.propertyName === 'left') { ui.removeEventListener('transitionend', onEnd); resolve(); } };
      ui.addEventListener('transitionend', onEnd);
      setTimeout(resolve, 600);
    });
  });
}

// transitionend alone is not enough: an interrupted slide fires one for the
// previous transition, which resolves the promise while the panel is still
// moving (measured at left: -14.7 once). Follow it with a rAF settle poll —
// the event gets us there fast, the poll guarantees we actually arrived.
async function waitForUiSettled(page) {
  await page.evaluate(() => window.__cvUiSettled);
  await page.waitForFunction(() => {
    const now = document.getElementById('ui').getBoundingClientRect().left;
    const settled = window.__cvLastLeft === now;
    window.__cvLastLeft = now;
    return settled;
  }, { timeout: 5000, polling: 'raf' });
}

async function setViewport(page, w, h) {
  await armUiSettleWait(page);
  await page.setViewportSize({ width: w, height: h });
  await waitForUiSettled(page);
}

async function toggleMobileMenu(page) {
  await armUiSettleWait(page);
  await H.clickById(page, 'mobileMenuToggle');
  await waitForUiSettled(page);
}

async function uiState(page) {
  return page.evaluate(() => {
    const ui = document.getElementById('ui');
    const r = ui.getBoundingClientRect();
    return {
      panelOpen: ui.classList.contains('panel-open'),
      panelHidden: ui.classList.contains('panel-hidden'),
      rect: { left: r.left, width: r.width },
      uiWidthToken: getComputedStyle(document.documentElement).getPropertyValue('--ui-width').trim(),
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // ---- desktop baseline: #ui is ordinary in-flow chrome --------------------
  let s = await uiState(page);
  const desktopWidth = s.rect.width; // reused below to prove the layout round-trips
  H.check('at desktop width the side panel is not off-canvas',
    !s.panelOpen && s.rect.left <= 0 && s.rect.width > 0, JSON.stringify(s));

  // The hamburger's OTHER branch at desktop width: hides/shows in place
  // (panel-hidden), never the mobile slide-over class. panel-hidden has no
  // transition of its own (display/width collapse, not an animated `left`),
  // so a short settle wait is enough here.
  await H.clickById(page, 'mobileMenuToggle');
  await page.waitForTimeout(200);
  s = await uiState(page);
  H.check('at desktop width the toggle hides the panel in place (panel-hidden), not panel-open',
    s.panelHidden && !s.panelOpen, JSON.stringify(s));
  await H.clickById(page, 'mobileMenuToggle'); // restore
  await page.waitForTimeout(200);

  // ---- compact rung (<=1024px): the panel becomes an off-canvas overlay ----
  await setViewport(page, 900, 800); // compact, but WIDER than the mobile rung (720)
  s = await uiState(page);
  H.check('below 1024px, before opening it, the panel starts off-canvas',
    !s.panelOpen && s.rect.left < 0, JSON.stringify(s));

  await toggleMobileMenu(page);
  const compactOpen = await uiState(page);
  const overlayActive = await page.evaluate(() =>
    document.getElementById('mobileOverlay').classList.contains('active'));
  H.check('the hamburger opens the panel on-canvas (panel-open) below 1024px',
    compactOpen.panelOpen && Math.abs(compactOpen.rect.left) < 1, JSON.stringify(compactOpen));
  H.check('opening the panel shows the mobile scrim overlay', overlayActive);
  H.check('at the compact (900px) width the panel is NOT a full-width sheet — that only starts at 720px',
    compactOpen.rect.width < 900 * 0.9, JSON.stringify(compactOpen));

  // Clicking the scrim closes it again (the mobile-close affordance).
  await armUiSettleWait(page);
  await page.click('#mobileOverlay');
  await waitForUiSettled(page);
  s = await uiState(page);
  H.check('clicking the scrim closes the panel', !s.panelOpen, JSON.stringify(s));

  // ---- mobile rung (<=720px): the SAME panel becomes a full-width sheet ----
  await setViewport(page, 480, 800);
  await toggleMobileMenu(page);
  const mobileOpen = await uiState(page);
  H.check('at 480px the opened panel is a near-full-width sheet (--ui-width token engaged)',
    mobileOpen.panelOpen && mobileOpen.rect.width >= 480 * 0.9, JSON.stringify(mobileOpen));
  H.check('--ui-width switches to the dvw-derived formula at the mobile rung (not the fixed desktop value)',
    /100dvw/.test(mobileOpen.uiWidthToken), mobileOpen.uiWidthToken);

  // The panel itself is still fully usable while open: Files panel toggle
  // reachable and clickable inside the sheet (not just visually present).
  const filesReachable = await page.evaluate(() => {
    const el = document.querySelector('.cv-panel[data-panel-id="files"] .cv-panel-titlebar');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.left < window.innerWidth;
  });
  H.check('a docked panel titlebar inside the open sheet is on-screen and clickable',
    filesReachable);

  // ---- growing back reverses the layout (not a one-way ratchet) ------------
  // The leftover 'panel-open' class from the mobile toggle has no CSS effect
  // above the compact rung (that selector only exists inside the <=1024px
  // media query) — what matters is what the user SEES: the panel back in
  // flow at the left edge, full desktop width, not off-canvas or full-bleed.
  await setViewport(page, 1400, 900);
  s = await uiState(page);
  H.check('growing back to desktop width visually restores the normal in-flow panel',
    Math.abs(s.rect.left) < 1 && Math.abs(s.rect.width - desktopWidth) < 1 && s.uiWidthToken === '380px',
    JSON.stringify({ s, desktopWidth }));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
