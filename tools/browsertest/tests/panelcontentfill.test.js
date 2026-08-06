// A docked panel's content must fill its pane, the way every panel does
// except historically the Atomistic window: its content is authored to live
// in #ui (the ~380px left sidebar — backendPanel.css's .backend-control-group
// caps at 360px to clear the sidebar's own padding). Adopted into a right-
// docked pane far wider than the sidebar, that cap used to travel with it and
// strand the controls in a narrow column (panelWindow.css). Forces is the
// reference panel: its content has never carried a sidebar-era cap and always
// fills the pane. Asserts the RELATIONSHIP (content width tracks pane width,
// same as Forces does) rather than an absolute pixel number, which would pin
// the layout and break on any legitimate width change.
'use strict';
const H = require('../harness');

/** Dock a panel into the right pane (same path the ≡ menu's "Right dock"
 *  item uses) and expand it, then wait for the width to stop changing —
 *  more robust than a fixed timeout if a future change adds a transition. */
async function dockRightAndSettle(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel(id);
    p.hooks.positionPanel(p, 'right');
    p.expand();
  }, id);
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const w = await page.evaluate((id) => {
      const el = document.querySelector(`.cv-panel[data-panel-id="${id}"] .cv-panel-body`);
      return el ? el.getBoundingClientRect().width : -1;
    }, id);
    if (w === prev) return;
    prev = w;
    await page.waitForTimeout(100);
  }
}

/** Widest immediate content wrapper each panel actually builds:
 *  Atomistic -> #BackendCalcPanel (the Relax/MD action card),
 *  Forces -> #forcePanel (the whole controls group). */
async function contentFillRatio(page, id, contentSelector) {
  return page.evaluate(({ id, contentSelector }) => {
    const body = document.querySelector(`.cv-panel[data-panel-id="${id}"] .cv-panel-body`);
    const content = document.querySelector(contentSelector);
    if (!body || !content) return null;
    const paneWidth = body.getBoundingClientRect().width;
    const contentWidth = content.getBoundingClientRect().width;
    return { paneWidth, contentWidth, ratio: contentWidth / paneWidth };
  }, { id, contentSelector });
}

/** Drag the right dock's resize splitter to a target viewport-x, the same
 *  gesture a user performs — the pane fraction lives in a module-level
 *  variable in RightDock.js (RightDock.js:43), so setting the CSS var
 *  directly from a test gets silently clobbered the next time anything calls
 *  applyPaneWidth(). Dragging through the real handle is the only way to
 *  actually change it. */
async function dragHandleTo(page, targetX) {
  const start = await page.evaluate(() => {
    const r = document.getElementById('splitHandle').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(targetX, start.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await dockRightAndSettle(page, 'forces');

  // Widen the pane well past the default ~1/3-viewport split: a reintroduced
  // 360px-ish cap would then be obvious (ratio collapsing toward ~0.3-0.4)
  // instead of hiding inside a tolerance sized for the default pane width.
  const vp = page.viewportSize();
  await dragHandleTo(page, Math.round(vp.width * 0.25));
  const forces = await contentFillRatio(page, 'forces', '#forcePanel');
  H.check('Forces content is present and measurable', !!forces, JSON.stringify(forces));
  H.check('pane actually widened', forces.paneWidth > 700, String(forces.paneWidth));

  await dockRightAndSettle(page, 'backend');
  const atomistic = await contentFillRatio(page, 'backend', '#BackendCalcPanel');
  H.check('Atomistic content is present and measurable', !!atomistic, JSON.stringify(atomistic));

  H.check('Atomistic content fills its pane (ratio well above the old 360px-in-wide-pane collapse)',
    atomistic.ratio >= 0.85, JSON.stringify(atomistic));

  H.check('Atomistic tracks the pane the same way Forces does (uniform mechanism, not a per-panel patch)',
    Math.abs(atomistic.ratio - forces.ratio) <= 0.1,
    JSON.stringify({ atomistic, forces }));

  // Same relationship must hold at a second, different (narrower) pane width
  // — proves it's an actual fill (tracks the container), not a coincidence
  // at one size.
  await dragHandleTo(page, Math.round(vp.width * 0.6));
  const atomisticNarrow = await contentFillRatio(page, 'backend', '#BackendCalcPanel');
  H.check('pane actually changed width', Math.abs(atomisticNarrow.paneWidth - atomistic.paneWidth) > 100,
    JSON.stringify({ atomisticNarrow, atomistic }));
  H.check('Atomistic still fills its pane at a different pane width',
    atomisticNarrow.ratio >= 0.85, JSON.stringify(atomisticNarrow));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
