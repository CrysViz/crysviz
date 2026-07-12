// Drag & drop between the three window homes (docs/ui/panels/RightDock.js +
// PanelManager/PanelWindow): a floating window dragged to the right border
// shows the drop highlight and docks into the right dock ON RELEASE; its tab
// can be dragged back out to float in the same gesture; and from floating it
// drags into the left dock — "everything is the same kind of Window". Also
// covers the persisted v3 rightDock layout round-trip across a reload.
'use strict';
const H = require('../harness');

const PANEL = 'info'; // the Structure window: floating by default (right/bottom)

async function panelInfo(page, id) {
  return page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel(id);
    const el = p?.el;
    return {
      dock: p?.dock ?? null,
      closed: !!p?.closed,
      floating: !!el?.classList.contains('cv-floating'),
      front: !!el?.classList.contains('cv-front'),
      inRightDock: !!document.querySelector(`#splitPaneBody > .cv-panel[data-panel-id="${id}"]`),
      inLeftDock: !!document.querySelector(`#dock .cv-panel[data-panel-id="${id}"]`),
      splitActive: document.getElementById('viewArea').classList.contains('split-active'),
    };
  }, id);
}

async function barCenter(page, id) {
  return page.evaluate((id) => {
    const bar = document.querySelector(`.cv-panel[data-panel-id="${id}"] .cv-panel-titlebar`);
    const r = bar.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const vp = page.viewportSize();

  // ---- 1. floating -> right dock: highlight while hovering, dock on release
  let s = await panelInfo(page, PANEL);
  H.check('Structure window starts floating', s.dock === false && s.floating, JSON.stringify(s));

  let bar = await barCenter(page, PANEL);
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.x - 6, bar.y - 6); // cross the 4px drag threshold
  // Park mid-screen first: no highlight expected there.
  await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 6 });
  const hintMid = await page.evaluate(() => !document.getElementById('rightDockDropHint').hidden);
  // Into the right-edge drop band: highlight must appear.
  await page.mouse.move(vp.width - 20, vp.height / 2, { steps: 8 });
  const hintEdge = await page.evaluate(() => !document.getElementById('rightDockDropHint').hidden);
  await page.mouse.up();
  await page.waitForTimeout(400);
  H.check('no drop highlight mid-screen', hintMid === false);
  H.check('drop highlight shows over the right-edge band', hintEdge === true);
  s = await panelInfo(page, PANEL);
  H.check('release in the band docks the window right (front tab)',
    s.dock === 'right' && s.inRightDock && s.front && s.splitActive, JSON.stringify(s));
  const hintAfter = await page.evaluate(() => !document.getElementById('rightDockDropHint').hidden);
  H.check('drop highlight cleared after the drop', hintAfter === false);

  // ---- 2. the v3 rightDock layout round-trips across a reload -------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  s = await panelInfo(page, PANEL);
  const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('panelLayout')));
  H.check('reload restores the window into the right dock',
    s.dock === 'right' && s.inRightDock && s.front && s.splitActive, JSON.stringify(s));
  H.check('panelLayout v3 rightDock block round-trips',
    layout.version === 3 && layout.rightDock
      && layout.rightDock.order.includes(PANEL) && layout.rightDock.front === PANEL,
    JSON.stringify(layout.rightDock));

  // ---- 3. drag the tab out of the strip: window floats in the same gesture
  const tabRect = await page.evaluate((id) => {
    const tab = [...document.querySelectorAll('#splitPaneHeaderTabs .split-pane-tab')]
      .find((t) => t.dataset.panelId === id);
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, PANEL);
  await page.mouse.move(tabRect.x, tabRect.y);
  await page.mouse.down();
  await page.mouse.move(tabRect.x - 6, tabRect.y + 6); // threshold
  await page.mouse.move(tabRect.x - 40, tabRect.y + 120, { steps: 8 }); // out of the strip band
  await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 8 }); // keep dragging as a float
  await page.mouse.up();
  await page.waitForTimeout(400);
  s = await panelInfo(page, PANEL);
  H.check('dragging its tab away pulls the window out to float',
    s.dock === false && s.floating && !s.inRightDock, JSON.stringify(s));
  H.check('right dock hides once its last window leaves', s.splitActive === false);

  // ---- 4. keep going: floating -> left dock (drag over the side panel) ----
  const dockVisible = await page.evaluate(() =>
    document.getElementById('ui').getBoundingClientRect().width > 0);
  H.check('left dock visible for the drop', dockVisible);
  const uiCenter = await page.evaluate(() => {
    const r = document.getElementById('ui').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  bar = await barCenter(page, PANEL);
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.x + 6, bar.y + 6); // threshold
  await page.mouse.move(uiCenter.x, uiCenter.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  s = await panelInfo(page, PANEL);
  H.check('dragging over the side panel docks the window left',
    s.dock === 'left' && s.inLeftDock, JSON.stringify(s));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
