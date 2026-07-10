// Tiled progressive rendering for the ray/path tracers (general.rtTiledRender,
// default ON): each accumulation SAMPLE is rendered as a series of scissored
// screen tiles, one tile per animation frame ("round-based tiling" in
// RayTracingPipeline.render()), so per-frame GPU work stays bounded. This test
// asserts the round state machine deterministically (driving pipeline.render()
// manually inside synchronous evaluate blocks — RAF frames cannot interleave),
// the bypasses (boost, sample 1 after reset), image parity between tiled and
// untiled convergence, that mid-convergence toggling cannot wedge the counter,
// and that the pathtrace subclass inherits the whole mechanism.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Pixels that differ substantially between two screenshots. */
function changedPixelCount(fileA, fileB) {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  let n = 0;
  const total = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 90) n++;
  }
  return n;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- (1) Default ON: setting + checkbox -----------------------------------------
  const def = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('rtTiledToggle'));
    return { setting: general.rtTiledRender, exists: !!toggle, checked: toggle?.checked === true };
  });
  H.check('tiled rendering defaults ON (general.rtTiledRender + #rtTiledToggle checked)',
    def.setting === true && def.exists && def.checked, JSON.stringify(def));

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
  });

  // --- Activate the ray tracer and wait for it to be fully up ---------------------
  // The blue-noise texture loads asynchronously and its onLoad resets the
  // accumulation once — wait for it before any deterministic driving.
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  {
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        return !!p?._blueNoise?.image && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 1;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(1000);
    }
  }

  // --- (2) Deterministic round semantics ------------------------------------------
  // One synchronous evaluate: nothing (RAF loop, texture onLoad) can interleave.
  const round = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    // Settle any pending camera-motion / motion-low-res transition first.
    p.render(ctx); p.render(ctx);
    // Force a fine grid (instance budget) and re-seed from the live target size.
    p._tilePixelBudget = 32 * 32;
    p._seedTileGrid(p._accumTarget.width, p._accumTarget.height);
    const grid = [p._gridX, p._gridY];
    p.resetAccumulation();
    // Sample 1 after ANY reset is always untiled full-frame.
    p.render(ctx);
    const afterFirst = {
      samples: p._uniforms.uSampleCounter.value,
      roundActive: p._roundActive,
      cursor: p._tileCursor,
    };
    // The next roundTiles calls render exactly one round: the cursor advances
    // one tile per call and the sample counter bumps ONLY at round completion.
    p.render(ctx); // starts the round (renders tile 0)
    const roundGrid = [p._roundGridX, p._roundGridY];
    const tiles = roundGrid[0] * roundGrid[1];
    const mid = {
      samples: p._uniforms.uSampleCounter.value,
      roundActive: p._roundActive,
      cursor: p._tileCursor,
    };
    let bumpedEarly = false;
    for (let i = 1; i < tiles; i++) {
      if (p._uniforms.uSampleCounter.value !== afterFirst.samples) bumpedEarly = true;
      p.render(ctx);
    }
    const done = {
      samples: p._uniforms.uSampleCounter.value,
      roundActive: p._roundActive,
      cursor: p._tileCursor,
    };
    const scissorOff = p._accumTarget.scissorTest === false
      && p._previousTarget.scissorTest === false;
    return { grid, roundGrid, tiles, afterFirst, mid, bumpedEarly, done, scissorOff };
  });
  H.check('forced budget yields a multi-tile grid',
    round.grid[0] * round.grid[1] > 1, JSON.stringify(round.grid));
  H.check('sample 1 after reset is untiled (counter 1, no round in flight)',
    round.afterFirst.samples === 1 && round.afterFirst.roundActive === false
      && round.afterFirst.cursor === 0, JSON.stringify(round.afterFirst));
  H.check('a round holds the counter while the tile cursor advances',
    round.mid.roundActive === true && round.mid.cursor === 1
      && round.mid.samples === 1 && round.bumpedEarly === false,
    JSON.stringify({ mid: round.mid, bumpedEarly: round.bumpedEarly, tiles: round.tiles }));
  H.check('the counter bumps exactly at round completion (one sample per round)',
    round.done.samples === 2 && round.done.roundActive === false && round.done.cursor === 0,
    JSON.stringify(round.done));
  H.check('tile scissors are cleared after every frame',
    round.scissorOff === true, JSON.stringify(round));

  // --- (5) Boost bypass abandons an in-flight round --------------------------------
  const boost = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx); // settle
    p._tilePixelBudget = 32 * 32;
    p._seedTileGrid(p._accumTarget.width, p._accumTarget.height);
    p.resetAccumulation();
    p.render(ctx); // untiled sample 1
    p.render(ctx); // starts a round (tile 0 of many)
    const midActive = p._roundActive;
    p.requestBoost(64);
    p.render(ctx); // bypass: abandons the partial round, bursts 64 full frames
    return {
      midActive,
      samples: p._uniforms.uSampleCounter.value,
      roundActive: p._roundActive,
      converged: p.isConverged(),
    };
  });
  H.check('requestBoost bypasses tiling: abandons the round, bursts to the target',
    boost.midActive === true && boost.samples === 64 && boost.roundActive === false
      && boost.converged === true, JSON.stringify(boost));

  // --- (3) Convergence + image parity: tiled vs untiled -----------------------------
  // Drive render() in synchronous chunks (fast + immune to RAF pacing); the
  // adaptive controller may re-grid along the way — irrelevant for parity,
  // which only claims the converged AVERAGE matches the untiled one.
  async function convergeByDriving(maxChunks = 600) {
    for (let i = 0; i < maxChunks; i++) {
      const done = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
        for (let k = 0; k < 16 && !p.isConverged(); k++) p.render(ctx);
        return p.isConverged();
      });
      if (done) return true;
    }
    return false;
  }

  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    p._tilePixelBudget = 20000; // ~2x2 grid at 0.25 scale on the 1400x900 viewport
    p._seedTileGrid(p._accumTarget.width, p._accumTarget.height);
    p.resetAccumulation();
  });
  const tiledConverged = await convergeByDriving();
  H.check('tiled accumulation converges to the sample target', tiledConverged);
  await page.waitForTimeout(600); // let the progress strip fade + canvas settle
  const tiledShot = await H.shotCanvas(page, 'tiling-on-converged');

  // Toggle OFF through the real checkbox (fires change -> reset), reconverge.
  await page.evaluate(() => {
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('rtTiledToggle'));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
  });
  const untiledConverged = await convergeByDriving();
  H.check('untiled accumulation converges to the sample target', untiledConverged);
  await page.waitForTimeout(600);
  const untiledShot = await H.shotCanvas(page, 'tiling-off-converged');

  const parityDelta = changedPixelCount(tiledShot, untiledShot);
  const totalPx = (() => {
    const png = PNG.sync.read(fs.readFileSync(tiledShot));
    return png.width * png.height;
  })();
  H.check('converged tiled image matches the untiled one (parity)',
    parityDelta < totalPx * 0.03, JSON.stringify({ parityDelta, totalPx }));
  H.check('converged image has content', H.nonUniformFraction(tiledShot) > 0.02,
    `nonUniform=${H.nonUniformFraction(tiledShot).toFixed(4)}`);

  // --- (4) Mid-convergence toggling does not wedge ----------------------------------
  await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const toggle = /** @type {HTMLInputElement} */ (document.getElementById('rtTiledToggle'));
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change')); // ON + reset
    p._tilePixelBudget = 20000;
    p._seedTileGrid(p._accumTarget.width, p._accumTarget.height);
    p.resetAccumulation();
    for (let k = 0; k < 5; k++) p.render(ctx); // partway into a round
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change')); // OFF mid-round (abandon + reset)
    p.render(ctx); p.render(ctx);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change')); // back ON mid-accumulation
    p.render(ctx);
  });
  const rewedged = await convergeByDriving();
  H.check('toggling tiling mid-convergence still reaches the target (no wedge)',
    rewedged);

  // --- (6) Pathtrace inherits the tiling mechanism ----------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  {
    // blue-noise wait (see tracerfield.test.js): its onLoad resets once
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        return !!p?._blueNoise?.image && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 2;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(1500);
    }
  }
  const pt = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx); // settle
    p._tilePixelBudget = 20000;
    p._seedTileGrid(p._accumTarget.width, p._accumTarget.height);
    p.resetAccumulation();
    p.render(ctx); // untiled sample 1
    p.render(ctx); // round start
    const roundTiles = p._roundGridX * p._roundGridY;
    for (let i = 1; i < roundTiles; i++) p.render(ctx);
    return {
      id: p.id,
      roundTiles,
      samples: p._uniforms.uSampleCounter.value,
      roundActive: p._roundActive,
    };
  });
  H.check('pathtrace: inherited tiled round completes one sample per round',
    pt.id === 'pathtrace' && pt.roundTiles > 1 && pt.samples === 2 && pt.roundActive === false,
    JSON.stringify(pt));
  const ptShot = await H.shotCanvas(page, 'tiling-pathtrace');
  H.check('pathtrace renders content with tiling active',
    H.nonUniformFraction(ptShot) > 0.02, `nonUniform=${H.nonUniformFraction(ptShot).toFixed(4)}`);

  // --- Cleanup ----------------------------------------------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
