// Compact round-icon mode for the floating Measure/View toolbars
// (PanelWindow.setCompact + PanelManager compact-stacking + panelWindow.css
// .cv-compact + the background dot reading --compact-stack-bottom).
//
// When the scene (#view) is too narrow for both toolbars, each shrinks to a
// 54px round icon; the icons stack vertically (View below Measure's LIVE
// height), the background dot drops below the stack, and none of it fires off
// Measure's ordinary (non-compact) toolbar height. Clicking an icon unfolds its
// toolbar to the icon's left without moving the icon.
//
// The dot's own visibility is a persisted preference (panelPrefs.backgroundDot,
// default off everywhere), not a width rule — this run opts in explicitly so
// the dot's stack-clearing stays observable at every rung.
'use strict';
const H = require('../harness');

const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

async function setViewport(page, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(400); // rAF-coalesced resize + save debounce
}

async function state(page) {
  return page.evaluate(() => {
    const q = (id) => document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const panel = (id) => {
      const el = q(id);
      return {
        compact: el.classList.contains('cv-compact'),
        collapsed: el.classList.contains('cv-collapsed'),
        barCollapsed: el.classList.contains('cv-bar-collapsed'),
        rect: rect(el),
      };
    };
    const dot = document.getElementById('backgroundDot');
    const stackBottom = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--compact-stack-bottom')) || 0;
    return {
      measure: panel('measure'),
      view: panel('view'),
      stackBottom,
      dotTop: dot ? dot.getBoundingClientRect().top : null,
      dotHidden: dot ? getComputedStyle(dot).display === 'none' : null,
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Dot is off by default; turn it on so its stack-tracking is testable.
  await page.evaluate(async () => {
    (await import('./ui/panels/PanelManager.js')).setPanelPref('backgroundDot', true);
    (await import('./ui/BackgroundPicker.js')).setBackgroundDotVisible(true);
  });

  // Force compaction: hide the dock and shrink the window so the scene is too
  // narrow for both toolbars. (Both events recheck compaction.) The toolbars
  // are icon-only segmented rows now (~220-245px each at touch size), so 720
  // fits both side by side and no longer compacts; 480 does not fit them.
  const W = 480;
  await H.clickById(page, 'mobileMenuToggle'); // hide dock
  await page.waitForTimeout(300);
  await setViewport(page, W, 820);

  let s = await state(page);
  H.check('both toolbars compact to icons when the scene is too narrow',
    s.measure.compact && s.view.compact,
    `measure=${s.measure.compact} view=${s.view.compact}`);
  H.check('both compact icons are ~54px round buttons',
    near(s.measure.rect.width, 54) && near(s.measure.rect.height, 54)
    && near(s.view.rect.width, 54) && near(s.view.rect.height, 54),
    `m=${s.measure.rect.width}x${s.measure.rect.height} v=${s.view.rect.width}x${s.view.rect.height}`);
  H.check('icons stack without overlap (View below Measure, both collapsed)',
    s.view.rect.top >= s.measure.rect.bottom - 1,
    `measureBottom=${s.measure.rect.bottom} viewTop=${s.view.rect.top}`);
  // The dot used to be hidden outright by a width rule here. It now follows
  // the `backgroundDot` panel pref (off by default, enabled above), so the
  // enabled dot stays visible at this rung and its stack-clearing is
  // observable here at all.
  H.check('background dot clears the icon stack at mobile width',
    !s.dotHidden && near(s.dotTop, Math.max(120, s.stackBottom + 20)),
    `dotHidden=${s.dotHidden} dotTop=${s.dotTop} stackBottom=${s.stackBottom}`);
  H.check('the icon stack still publishes --compact-stack-bottom',
    s.stackBottom > 0, `stackBottom=${s.stackBottom}`);

  const viewTopBothCollapsed = s.view.rect.top;
  const measureIconLeft = s.measure.rect.left;
  const measureIconTop = s.measure.rect.top;

  // Expand ONLY Measure: its toolbar unfolds to the icon's left, the icon does
  // NOT move, and View's icon slides down past Measure's now-taller live height.
  await page.click('.cv-panel[data-panel-id="measure"] .cv-panel-compact-btn');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('expanding Measure keeps its icon pinned in place',
    near(s.measure.rect.right, W - 20) && near(s.measure.rect.top, measureIconTop),
    `right=${s.measure.rect.right} top=${s.measure.rect.top}`);
  H.check('Measure stays compact (icon + unfolded toolbar), not un-collapsed',
    s.measure.compact && !s.measure.collapsed, `compact=${s.measure.compact} collapsed=${s.measure.collapsed}`);
  H.check('View icon pushed down below Measure\'s expanded height, no overlap',
    s.view.rect.top >= s.measure.rect.bottom - 1 && s.view.rect.top > viewTopBothCollapsed + 5,
    `viewTop=${s.view.rect.top} measureBottom=${s.measure.rect.bottom} was=${viewTopBothCollapsed}`);
  H.check('--compact-stack-bottom follows the taller stack',
    s.stackBottom >= s.view.rect.bottom - 1,
    `stackBottom=${s.stackBottom} viewBottom=${s.view.rect.bottom}`);

  // Collapse Measure again: View returns to just below Measure's icon.
  await page.click('.cv-panel[data-panel-id="measure"] .cv-panel-compact-btn');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('collapsing Measure returns View to just below the icon',
    near(s.view.rect.top, viewTopBothCollapsed) && near(s.measure.rect.left, measureIconLeft),
    `viewTop=${s.view.rect.top} was=${viewTopBothCollapsed}`);

  // --- the barCollapsed guard: double-clicking the compact icon must NOT
  // restore the full title bar (which would show the wrong bar next compact
  // cycle). Measure floats by default -> barCollapsed true.
  const beforeBar = (await state(page)).measure.barCollapsed;
  await page.dblclick('.cv-panel[data-panel-id="measure"] .cv-panel-compact-btn');
  await page.waitForTimeout(200);
  s = await state(page);
  H.check('bar-collapsed state survives a double-click on the compact icon',
    beforeBar === true && s.measure.barCollapsed === true,
    `before=${beforeBar} after=${s.measure.barCollapsed}`);

  // --- dot must NOT react to Measure's ORDINARY (non-compact) toolbar height.
  // Grow back so nothing is compact, then expand Measure's real toolbar: the
  // stack bottom must be 0 and the dot back at its default 120px resting spot.
  await setViewport(page, 1400, 900);
  s = await state(page);
  H.check('growing back un-compacts both toolbars',
    !s.measure.compact && !s.view.compact,
    `measure=${s.measure.compact} view=${s.view.compact}`);
  H.check('no compact panels -> --compact-stack-bottom is 0, dot at default 120',
    s.stackBottom === 0 && near(s.dotTop, 120),
    `stackBottom=${s.stackBottom} dotTop=${s.dotTop}`);

  // --- the dock DISAPPEARING must not pop compact toolbars open. With the
  // dock shown, crowd the scene via the split reserve (the icon-only toolbars
  // are too narrow for a >1024px window with the dock alone to crowd them —
  // below 1024 the dock is an overlay and no longer narrows the scene), then
  // hide the dock (scene grows past what the toolbars need) and confirm they
  // stay icons.
  await H.clickById(page, 'mobileMenuToggle'); // show dock
  await page.waitForTimeout(300);
  await setViewport(page, 1400, 900);
  await page.evaluate(async () => {
    document.getElementById('viewArea').classList.add('split-active');
    // 0.4: with the dock the scene is ~420px (too narrow for the ~780px the
    // two toolbars + dock toggle need); without it ~840px, which would fit —
    // so the stay-compact check below actually exercises the gate.
    document.documentElement.style.setProperty('--split-pane-fraction', '0.4');
    const { setRightReserve } = await import('./ui/panels/PanelManager.js');
    setRightReserve(0.4 * window.innerWidth);
  });
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('dock shown + crowded scene compacts the toolbars',
    s.measure.compact && s.view.compact, `measure=${s.measure.compact} view=${s.view.compact}`);
  // Above the mobile rung the dot is still shown, and still keeps clear of the
  // icon stack (the tracking that used to be checked at 720px).
  H.check('visible dot tracks --compact-stack-bottom above the mobile rung',
    !s.dotHidden && near(s.dotTop, Math.max(120, s.stackBottom + 20)),
    `dotHidden=${s.dotHidden} dotTop=${s.dotTop} stackBottom=${s.stackBottom}`);
  await H.clickById(page, 'mobileMenuToggle'); // hide dock (scene grows)
  await page.waitForTimeout(400);
  s = await state(page);
  H.check('hiding the dock does NOT auto-pop the compact toolbars back open',
    s.measure.compact && s.view.compact, `measure=${s.measure.compact} view=${s.view.compact}`);
  await page.evaluate(async () => {
    document.getElementById('viewArea').classList.remove('split-active');
    document.documentElement.style.setProperty('--split-pane-fraction', '0');
    const { setRightReserve } = await import('./ui/panels/PanelManager.js');
    setRightReserve(0);
  });
  await page.waitForTimeout(300);

  // --- split-view reserve rechecks compaction in BOTH directions. Shrink #view
  // via the reserve and confirm growing it back un-compacts (a one-way gate,
  // like the dock case, would leave them stuck as icons).
  await setViewport(page, 1400, 900); // dock already hidden -> full-width scene
  await page.evaluate(async () => {
    // Simulate the split pane claiming most of the scene width, exactly as
    // SplitView does: mark #viewArea split-active + set the vw fraction (which
    // narrows #view via CSS) and report the reserve through setRightReserve.
    document.getElementById('viewArea').classList.add('split-active');
    document.documentElement.style.setProperty('--split-pane-fraction', '0.62');
    const { setRightReserve } = await import('./ui/panels/PanelManager.js');
    setRightReserve(0.62 * window.innerWidth);
  });
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('growing the split reserve (shrinking the scene) compacts the toolbars',
    s.measure.compact && s.view.compact, `measure=${s.measure.compact} view=${s.view.compact}`);
  await page.evaluate(async () => {
    document.getElementById('viewArea').classList.remove('split-active');
    document.documentElement.style.setProperty('--split-pane-fraction', '0');
    const { setRightReserve } = await import('./ui/panels/PanelManager.js');
    setRightReserve(0);
  });
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('dropping the split reserve back un-compacts them (both directions)',
    !s.measure.compact && !s.view.compact, `measure=${s.measure.compact} view=${s.view.compact}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
