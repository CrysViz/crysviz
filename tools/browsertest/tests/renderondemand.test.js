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

  // Pointer movement over the canvas invalidates (hover highlight path).
  // Coordinates must land on the canvas, which sits right of the #ui sidebar.
  await page.mouse.move(900, 450);
  await page.mouse.move(920, 460);
  await page.waitForTimeout(300);
  const f2 = await frameCount(page);
  H.check('pointer move re-renders', f2 > f1, `frames ${f1} -> ${f2}`);

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
  await page.waitForTimeout(1500);
  const f7 = await frameCount(page);
  await page.waitForTimeout(2000);
  const f8 = await frameCount(page);
  H.check('returns to idle', f8 - f7 <= 1, `frames ${f7} -> ${f8} over 2s`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
