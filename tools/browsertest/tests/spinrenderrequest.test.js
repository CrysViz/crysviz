// SpinModule.js/ForceModule.js's updateSpins()/updateForces() must call
// requestRender() themselves (AnimateModule.js's on-demand rendering only
// repaints when something invalidates the frame). A programmatic caller
// (WidgetMode.js, MD.js, relaxer.js, ShareModule.js, FileBrowswerPanel.js)
// dispatches no DOM event, so without that call the arrows are added to the
// scene but never painted until the user happens to interact.
'use strict';
const H = require('../harness');

const frameCount = (page) => page.evaluate(async () => {
  const { app } = await import('./state/store.js');
  return app.renderer.info.render.frame;
});

// Same idiom as renderondemand.test.js.
async function waitForRenderIdle(page, { settleMs = 1000, timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = { start: await frameCount(page), end: null };
  while (Date.now() <= deadline) {
    const start = await frameCount(page);
    await page.waitForTimeout(settleMs);
    const end = await frameCount(page);
    last = { start, end };
    if (end - start <= 1) return last;
  }
  return last;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Give the loaded structure spins and forces (same in-page-construction
  // idiom forcepanel.test.js uses for forces) — no DOM events involved.
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { Spin, Force } = await import('./model/index.js');
    const s = fileBrowser.selectedStructure;
    s.spins = s.atoms.map((_, i) => new Spin({ vector: [0, 0, i % 2 ? 1 : -1] }));
    s.forces = s.atoms.map((_, i) => new Force({ vector: [0.1 + i * 0.3, 0.05, -0.02 * i] }));
  });

  // --- Spins: updateSpins() called with NO DOM events must still repaint ---
  await waitForRenderIdle(page);
  const spinResult = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const before = app.renderer.info.render.frame;
    const { updateSpins } = await import('./render/index.js');
    updateSpins(1.0);
    // Give the rAF loop a chance to actually run the pending render.
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: app.renderer.info.render.frame };
  });
  H.check('updateSpins() re-renders with no DOM event dispatched',
    spinResult.after > spinResult.before, `frames ${spinResult.before} -> ${spinResult.after}`);

  // --- Forces: same contract for updateForces() ---
  await waitForRenderIdle(page);
  const forceResult = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const before = app.renderer.info.render.frame;
    const { updateForces } = await import('./render/index.js');
    updateForces();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: app.renderer.info.render.frame };
  });
  H.check('updateForces() re-renders with no DOM event dispatched',
    forceResult.after > forceResult.before, `frames ${forceResult.before} -> ${forceResult.after}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
