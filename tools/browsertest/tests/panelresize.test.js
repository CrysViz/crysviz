// Floating panel windows vs browser-window resize and dock hide/show:
// a window's inherent position (floatPos, persisted in panelLayout) is never
// changed by displacement — shrinking the window only pulls a panel back as
// far as title-bar reachability requires, growing it back restores the panel
// exactly, and dock displacement composes with all of it (PanelManager's
// updateFloatPlacements / PanelWindow's captureFloatPosition+clampToViewport).
'use strict';
const H = require('../harness');

/** Panel rect + the saved panelLayout position, read together. */
async function panelState(page, id) {
  return page.evaluate((id) => {
    const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const r = el.getBoundingClientRect();
    let saved = null;
    try {
      const layout = JSON.parse(localStorage.getItem('panelLayout'));
      saved = layout.panels[id] ? layout.panels[id].pos : null;
    } catch { /* no layout yet */ }
    return {
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height,
      rightGap: window.innerWidth - r.right,
      bottomGap: window.innerHeight - r.bottom,
      compact: el.classList.contains('cv-compact'),
      saved,
    };
  }, id);
}

/** Drag a floating panel by its title bar so its top-left lands at (left, top). */
async function dragPanelTo(page, id, left, top) {
  const start = await page.evaluate((id) => {
    const el = document.querySelector(`.cv-panel[data-panel-id="${id}"]`);
    const bar = el.querySelector('.cv-panel-titlebar');
    const er = el.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    return { elLeft: er.left, elTop: er.top, barX: br.left + br.width / 2, barY: br.top + br.height / 2 };
  }, id);
  await page.mouse.move(start.barX, start.barY);
  await page.mouse.down();
  // Priming move: crosses the 4px drag threshold, whose event is consumed to
  // establish the grab point (the panel does not move yet). From here on the
  // panel follows the pointer 1:1, so aim relative to this grab position.
  await page.mouse.move(start.barX + 6, start.barY + 6);
  await page.mouse.move(start.barX + 6 + (left - start.elLeft), start.barY + 6 + (top - start.elTop),
    { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400); // past the 250ms layout-save debounce
}

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(400); // resize handler is rAF-coalesced + save debounce
}

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const PANEL = 'view';

  // -- initial derived placement: inherent {left:82} is displaced past the dock
  const uiWidth = await page.evaluate(() => document.getElementById('ui').getBoundingClientRect().width);
  let s = await panelState(page, PANEL);
  H.check('boot: displaced right of the visible dock', s.left >= uiWidth + 9,
    `left=${s.left} uiWidth=${uiWidth}`);
  H.check('boot: saved pos is the inherent default, not the displaced one',
    s.saved && s.saved.left === 82, JSON.stringify(s.saved));

  // -- right-edge default windows track the edge without ever being dragged ---
  let info = await panelState(page, 'info');
  H.check('boot: info window sits at its right/bottom default anchor',
    near(info.rightGap, 20) && near(info.bottomGap, 20),
    `rightGap=${info.rightGap} bottomGap=${info.bottomGap}`);
  // Above the 1024px compact breakpoint: below it the Structure window leaves
  // the floating layer for its side-dock sheet (compactHome).
  await setViewport(page, 1100, 700);
  info = await panelState(page, 'info');
  H.check('resize: default-anchored info window tracks the right/bottom edges',
    near(info.rightGap, 20) && near(info.bottomGap, 20),
    `rightGap=${info.rightGap} bottomGap=${info.bottomGap}`);
  await setViewport(page, 1400, 900);

  // -- corner park: nearest-edge capture, edge tracked through resize ---------
  let target = await panelState(page, PANEL);
  await dragPanelTo(page, PANEL, 1400 - target.width - 60, 900 - target.height - 60);
  const parked = await panelState(page, PANEL);
  H.check('drag to corner captures right/bottom anchors',
    parked.saved && near(parked.saved.right, 60) && near(parked.saved.bottom, 60),
    JSON.stringify(parked.saved));

  // Stays above the 1024px compact breakpoint: below it 'view' folds to its
  // icon (see the crowding section further down) and no longer tracks a corner.
  await setViewport(page, 1100, 600);
  s = await panelState(page, PANEL);
  H.check('shrink: corner panel hugs the corner', near(s.rightGap, 60) && near(s.bottomGap, 60),
    `rightGap=${s.rightGap} bottomGap=${s.bottomGap}`);
  H.check('shrink: saved pos unchanged', s.saved && near(s.saved.right, 60) && near(s.saved.bottom, 60),
    JSON.stringify(s.saved));

  await setViewport(page, 1400, 900);
  s = await panelState(page, PANEL);
  H.check('grow back: corner panel restored exactly',
    near(s.left, parked.left) && near(s.top, parked.top), `left=${s.left} top=${s.top}`);

  // -- mid-canvas park with the dock hidden: reversible viewport clamp --------
  await H.clickById(page, 'mobileMenuToggle'); // hide dock
  await page.waitForTimeout(300);
  await dragPanelTo(page, PANEL, 150, 100);
  s = await panelState(page, PANEL);
  H.check('drag to mid-canvas captures left/top anchors',
    s.saved && near(s.saved.left, 150) && near(s.saved.top, 100), JSON.stringify(s.saved));

  // 'view' is compact-capable: a compact viewport (and a scene narrow enough
  // to crowd the two toolbars) collapses it to its round icon (pinned to the
  // compact stack anchor, not its floatPos) — while the saved inherent pos is
  // left untouched for restore.
  await setViewport(page, 700, 500);
  s = await panelState(page, PANEL);
  H.check('shrink to compact width: view compacts to its icon', s.compact,
    `compact=${s.compact} left=${s.left}`);
  H.check('compacting does not touch the saved pos',
    s.saved && near(s.saved.left, 150) && near(s.saved.top, 100), JSON.stringify(s.saved));

  await setViewport(page, 300, 400); // even narrower: compact icon clamped on screen
  s = await panelState(page, PANEL);
  H.check('shrink past reach: compact icon pulled back on screen', s.left <= 260 && s.top >= 0,
    `left=${s.left} top=${s.top}`);
  H.check('clamp does not touch the saved pos',
    s.saved && near(s.saved.left, 150) && near(s.saved.top, 100), JSON.stringify(s.saved));

  await setViewport(page, 1400, 900);
  s = await panelState(page, PANEL);
  H.check('grow back: view un-compacts to its exact mid-canvas pos',
    !s.compact && near(s.left, 150) && near(s.top, 100),
    `compact=${s.compact} left=${s.left} top=${s.top}`);

  // -- dock displacement composes with resize ---------------------------------
  await H.clickById(page, 'mobileMenuToggle'); // show dock
  await page.waitForTimeout(300);
  s = await panelState(page, PANEL);
  H.check('dock shown: panel displaced past it', s.left >= uiWidth + 9, `left=${s.left}`);

  await setViewport(page, 1200, 800);
  await setViewport(page, 1400, 900);
  s = await panelState(page, PANEL);
  H.check('resize with dock shown: still displaced, saved pos intact',
    s.left >= uiWidth + 9 && s.saved && near(s.saved.left, 150), `left=${s.left} saved=${JSON.stringify(s.saved)}`);

  await H.clickById(page, 'mobileMenuToggle'); // hide dock again
  await page.waitForTimeout(300);
  s = await panelState(page, PANEL);
  H.check('dock hidden: back to the inherent position', near(s.left, 150) && near(s.top, 100),
    `left=${s.left} top=${s.top}`);

  // -- persistence across reload ----------------------------------------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  s = await panelState(page, PANEL);
  H.check('reload: inherent position survives (dock visible again -> displaced)',
    s.saved && near(s.saved.left, 150) && near(s.saved.top, 100) && s.left >= uiWidth + 9,
    `left=${s.left} saved=${JSON.stringify(s.saved)}`);

  // -- a remembered dock order differing from registration order is restored,
  //    exercised through the v2 -> v4 migration path: float positions and the
  //    dock order survive, while the old eos stub entry is dropped (eos gets
  //    its new default: a main-dock controls window) ---------------------------
  await page.evaluate(() => {
    localStorage.setItem('panelLayout', JSON.stringify({
      version: 2,
      dockOrder: ['files', 'eos', 'backend'], // swapped vs registration order
      panels: {
        view: { docked: false, collapsed: false, bar: false, pos: { left: 222, top: 111 } },
        eos: { docked: true, collapsed: false, bar: false },
      },
    }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const migrated = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const layout = JSON.parse(localStorage.getItem('panelLayout'));
    return {
      domOrder: Array.from(document.querySelectorAll('#dock > .cv-panel'))
        .map((el) => el.dataset.panelId),
      version: layout.version,
      viewPos: layout.panels.view?.pos || null,
      eosDock: getPanel('eos')?.dock ?? null,
      eosCollapsed: !!getPanel('eos')?.collapsed,
      plotsClosed: !!getPanel('eosPlots')?.closed,
      plotsDock: getPanel('eosPlots')?.dock ?? null,
    };
  });
  H.check('v2 blob migrated: remembered dock order restored',
    migrated.domOrder.indexOf('files') !== -1
      && migrated.domOrder.indexOf('files') < migrated.domOrder.indexOf('backend'),
    JSON.stringify(migrated.domOrder.slice(0, 4)));
  H.check('migration re-saves as v4', migrated.version === 4, String(migrated.version));
  H.check('migration keeps the v2 float position', migrated.viewPos
    && migrated.viewPos.left === 222 && migrated.viewPos.top === 111,
    JSON.stringify(migrated.viewPos));
  H.check('migration drops the old eos stub entry (new defaults apply)',
    migrated.eosDock === 'left' && migrated.eosCollapsed
      && migrated.plotsClosed && migrated.plotsDock === 'right',
    JSON.stringify(migrated));

  // -- a v3 blob (the merged-window dev iteration) also migrates: its stale
  //    eos/landscape side-dock entries are dropped, everything else survives --
  await page.evaluate(() => {
    localStorage.setItem('panelLayout', JSON.stringify({
      version: 3,
      dockOrder: ['files', 'backend'],
      rightDock: { order: ['eos', 'splitDemo'], front: 'eos', collapsed: false, fraction: 0.4 },
      panels: {
        view: { dock: false, closed: false, collapsed: false, bar: false, pos: { left: 333, top: 99 } },
        eos: { dock: 'right', closed: false, collapsed: false, bar: false },
        landscape: { dock: 'right', closed: true, collapsed: false, bar: false },
      },
    }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const v3m = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const layout = JSON.parse(localStorage.getItem('panelLayout'));
    return {
      version: layout.version,
      viewPos: layout.panels.view?.pos || null,
      sideOrder: layout.rightDock.order,
      sideFraction: layout.rightDock.fraction,
      eosDock: getPanel('eos')?.dock ?? null,
      eosClosed: !!getPanel('eos')?.closed,
      landscapeDock: getPanel('landscape')?.dock ?? null,
    };
  });
  H.check('v3 blob migrated to v4, float pos + pane fraction kept',
    v3m.version === 4 && v3m.viewPos?.left === 333 && Math.abs(v3m.sideFraction - 0.4) < 1e-6,
    JSON.stringify(v3m));
  H.check('v3 stale eos/landscape side-dock entries dropped (main-dock defaults apply)',
    v3m.eosDock === 'left' && !v3m.eosClosed && v3m.landscapeDock === 'left'
      && !v3m.sideOrder.includes('eos'),
    JSON.stringify(v3m));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
