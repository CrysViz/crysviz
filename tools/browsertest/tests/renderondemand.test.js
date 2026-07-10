// On-demand rendering: the rAF loop keeps running, but renderer.render() only
// fires when something invalidated the frame (requestRender). Asserts that the
// GPU is idle when nothing changes, and that camera moves, pointer movement
// and updateVisualization() each wake it up again.
'use strict';
const H = require('../harness');

const frameCount = (page) => page.evaluate(async () => {
  const { app } = await import('./state/store.js');
  return app.renderer.info.render.frame;
});

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

  H.check('WebGL2 available', await H.webglAvailable(page));

  // The initial load must have produced at least one real frame.
  const shot = await H.shotCanvas(page, 'renderondemand-initial');
  const drawn = H.nonUniformFraction(shot);
  H.check('initial render happened', drawn > 0.01, `nonUniform=${drawn.toFixed(4)}`);

  // Idle: after settling, no further renderer.render() calls.
  await page.waitForTimeout(2000);
  const f0 = await frameCount(page);
  await page.waitForTimeout(2000);
  const f1 = await frameCount(page);
  H.check('idle: renderer stops', f1 - f0 <= 1, `frames ${f0} -> ${f1} over 2s`);

  // Plain pointer movement over the canvas must NOT wake the renderer: real
  // mice emit micro-move events continuously while resting on the canvas, and
  // hover only drives the DOM tooltip. (Canvas sits right of the #ui sidebar.)
  await page.mouse.move(900, 450);
  await page.mouse.move(920, 460);
  await page.waitForTimeout(300);
  const f2 = await frameCount(page);
  H.check('hover move stays idle', f2 - f1 <= 1, `frames ${f1} -> ${f2}`);

  // A real drag-rotate renders (TrackballControls 'change' path).
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(920 + i * 10, 460 + i * 5);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const f2b = await frameCount(page);
  H.check('drag-rotate re-renders', f2b > f2, `frames ${f2} -> ${f2b}`);

  // Programmatic camera move: controls.update() detects it and fires 'change'.
  await page.waitForTimeout(1500);
  const f3 = await frameCount(page);
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    app.camera.position.x += 3;
  });
  await page.waitForTimeout(300);
  const f4 = await frameCount(page);
  H.check('camera move re-renders', f4 > f3, `frames ${f3} -> ${f4}`);

  // Scene mutation through the central entry point invalidates.
  await page.waitForTimeout(1500);
  const f5 = await frameCount(page);
  await page.evaluate(async () => {
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    updateVisualization();
  });
  await page.waitForTimeout(300);
  const f6 = await frameCount(page);
  H.check('updateVisualization re-renders', f6 > f5, `frames ${f5} -> ${f6}`);

  // And it settles back to idle afterwards.
  const idle = await waitForRenderIdle(page, { settleMs: 2000, timeout: 10000 });
  H.check('returns to idle', idle.end - idle.start <= 1,
    `frames ${idle.start} -> ${idle.end} over 2s`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
