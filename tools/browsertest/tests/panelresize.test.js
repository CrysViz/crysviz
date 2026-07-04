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

  // -- initial derived placement: inherent {left:68} is displaced past the dock
  const uiWidth = await page.evaluate(() => document.getElementById('ui').getBoundingClientRect().width);
  let s = await panelState(page, PANEL);
  H.check('boot: displaced right of the visible dock', s.left >= uiWidth + 9,
    `left=${s.left} uiWidth=${uiWidth}`);
  H.check('boot: saved pos is the inherent default, not the displaced one',
    s.saved && s.saved.left === 68, JSON.stringify(s.saved));

  // -- corner park: nearest-edge capture, edge tracked through resize ---------
  let target = await panelState(page, PANEL);
  await dragPanelTo(page, PANEL, 1400 - target.width - 60, 900 - target.height - 60);
  const parked = await panelState(page, PANEL);
  H.check('drag to corner captures right/bottom anchors',
    parked.saved && near(parked.saved.right, 60) && near(parked.saved.bottom, 60),
    JSON.stringify(parked.saved));

  await setViewport(page, 900, 600);
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

  await setViewport(page, 700, 500); // still reachable: untouched
  s = await panelState(page, PANEL);
  H.check('shrink while reachable: panel does not move', near(s.left, 150) && near(s.top, 100),
    `left=${s.left} top=${s.top}`);

  await setViewport(page, 300, 400); // bar would leave the viewport: clamped
  s = await panelState(page, PANEL);
  H.check('shrink past reach: bar pulled back on screen', s.left <= 260 && s.top >= 0,
    `left=${s.left} top=${s.top}`);
  H.check('clamp does not touch the saved pos',
    s.saved && near(s.saved.left, 150) && near(s.saved.top, 100), JSON.stringify(s.saved));

  await setViewport(page, 1400, 900);
  s = await panelState(page, PANEL);
  H.check('grow back: mid-canvas panel restored exactly', near(s.left, 150) && near(s.top, 100),
    `left=${s.left} top=${s.top}`);

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

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
