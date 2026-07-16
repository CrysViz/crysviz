// Volumetric field isosurfaces in the ray/path tracers. A synthetic Gaussian
// blob field is attached to the default structure and driven through the REAL
// field path (setActiveField + updateField, the same calls the CHGCAR/cube
// readers use). The raster pipeline (depthpeel) draws it as a marching-cubes
// mesh; the tracers ray-march it as an implicit surface from the same
// Isosurface source. Asserts the field visibly appears in both, that clearing
// it restores the no-field image, and that path tracing renders it error-free.
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

  // Poll the tracer accumulation until it reaches n samples (the pipeline
  // self-drives to convergence via requestRender under render-on-demand).
  async function waitForSamples(n, timeout = 90000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const s = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        return app.pipeline?._uniforms?.uSampleCounter?.value ?? 0;
      });
      if (s >= n || Date.now() > deadline) return s;
      await page.waitForTimeout(1500);
    }
  }

  // Poll until the encoder's field pass reaches the wanted enabled state (the
  // re-encode happens on a render frame, which races a plain sample-count wait).
  async function waitForFieldEnabled(want, timeout = 60000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const e = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        return app.pipeline?._encoder?.fieldEnabled ?? null;
      });
      if (e === want || Date.now() > deadline) return e;
      await page.waitForTimeout(1000);
    }
  }

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame (no depth-peel preview stalling RAF assertions)
  });

  // --- Raster baseline (depthpeel, no field) --------------------------------------
  await page.waitForTimeout(600);
  const rasterBaseline = await H.shotCanvas(page, 'field-raster-nofield');

  // --- Ray-traced baseline (no field) ---------------------------------------------
  // Pixel-compared tracer shots are taken at CONVERGENCE (64 samples): early
  // frames are Monte-Carlo noisy (anti-alias jitter), converged images are
  // deterministic averages.
  const CONVERGED = 64;
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitForSamples(CONVERGED);
  const noFieldEnabled = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { enabled: app.pipeline?._encoder?.fieldEnabled, u: app.pipeline?._uniforms?.uFieldEnabled?.value };
  });
  H.check('no field: tracer field pass disabled (dummy volume bound)',
    noFieldEnabled.enabled === false && noFieldEnabled.u === false, JSON.stringify(noFieldEnabled));
  const tracerBaseline = await H.shotCanvas(page, 'field-tracer-nofield');

  // --- Build a synthetic Gaussian-blob field and drive the real field path --------
  const fieldInfo = await page.evaluate(async () => {
    const { Field } = await import('./model/index.js');
    const { fileBrowser, groups } = await import('./state/store.js');
    const { setActiveField, updateField, requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    const lat = structure.lattice;
    const nx = 24, ny = 24, nz = 24;
    const values = new Float32Array(nx * ny * nz);
    const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
    const sigma = 5.0;
    let maxV = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const dx = i - cx, dy = j - cy, dz = k - cz;
          const v = Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * sigma * sigma));
          values[i + nx * (j + ny * k)] = v;
          if (v > maxV) maxV = v;
        }
    const voxel = [
      [lat[0][0] / nx, lat[0][1] / nx, lat[0][2] / nx],
      [lat[1][0] / ny, lat[1][1] / ny, lat[1][2] / ny],
      [lat[2][0] / nz, lat[2][1] / nz, lat[2][2] / nz],
    ];
    const field = new Field({
      nx, ny, nz, origin: [0, 0, 0], voxel, values,
      isoValue: 0.5, minValue: 0, maxValue: maxV, useAbsoluteIsoValue: false,
    });
    setActiveField(field, false);
    updateField(0.5);
    requestRender();
    const iso = groups.isosurfaceGroup;
    return {
      maxV,
      posVerts: iso?.meshes?.positive?.geometry?.attributes?.position?.count ?? 0,
      inScene: !!iso?.parent,
      activeField: !!groups.activeField,
    };
  });
  H.check('marching cubes produced an isosurface mesh for the blob',
    fieldInfo.posVerts > 0 && fieldInfo.inScene && fieldInfo.activeField && fieldInfo.maxV > 0.9,
    JSON.stringify(fieldInfo));

  // --- Raster: the isosurface appears (depthpeel) ---------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(800);
  const rasterField = await H.shotCanvas(page, 'field-raster-field');
  const rasterDelta = changedPixelCount(rasterBaseline, rasterField);
  H.check('raster (depthpeel): the field isosurface is drawn',
    rasterDelta > 500, JSON.stringify({ rasterDelta }));

  // --- Ray tracer: the field ray-marches into the traced image --------------------
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitForSamples(CONVERGED);
  const withFieldState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return {
      id: app.pipeline?.id, enabled: app.pipeline?._encoder?.fieldEnabled,
      uEnabled: u?.uFieldEnabled?.value, dims: u?.uFieldDims?.value?.toArray?.(),
      iso: u?.uFieldIso?.value, samples: u?.uSampleCounter?.value,
    };
  });
  H.check('raytrace: field encoded + uniforms wired (enabled, dims, iso)',
    withFieldState.id === 'raytrace' && withFieldState.enabled === true
      && withFieldState.uEnabled === true && withFieldState.samples > 2
      && JSON.stringify(withFieldState.dims) === JSON.stringify([24, 24, 24])
      && Math.abs(withFieldState.iso - 0.5) < 1e-6,
    JSON.stringify(withFieldState));
  const tracerField = await H.shotCanvas(page, 'field-tracer-field');
  const appearDelta = changedPixelCount(tracerBaseline, tracerField);
  H.check('raytrace: the ray-marched field surface appears in the traced image',
    appearDelta > 500, JSON.stringify({ appearDelta }));

  // --- Hiding the field (clearField) restores the no-field image -------------------
  await page.evaluate(async () => {
    const { clearField, requestRender } = await import('./render/index.js');
    clearField();
    requestRender();
  });
  await waitForFieldEnabled(false);   // re-encode drops the field on the next frame
  // The re-encode HARD-flushes the accumulation (hardResetAccumulation), so
  // there is no ghost of the old field at all — but early frames are still
  // Monte-Carlo noisy, so converge before the pixel comparison.
  await waitForSamples(CONVERGED);
  const clearedState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { enabled: app.pipeline?._encoder?.fieldEnabled, u: app.pipeline?._uniforms?.uFieldEnabled?.value };
  });
  const tracerCleared = await H.shotCanvas(page, 'field-tracer-cleared');
  const removeDelta = changedPixelCount(tracerField, tracerCleared);
  const restoreDelta = changedPixelCount(tracerBaseline, tracerCleared);
  H.check('clearField disables the tracer field pass',
    clearedState.enabled === false && clearedState.u === false, JSON.stringify(clearedState));
  H.check('raytrace: clearing the field removes it and restores the baseline',
    removeDelta > 500 && restoreDelta < appearDelta * 0.5,
    JSON.stringify({ appearDelta, removeDelta, restoreDelta }));

  // --- Path tracer: re-add the field and render it error-free ---------------------
  await page.evaluate(async () => {
    const { updateField, requestRender } = await import('./render/index.js');
    updateField(0.5); // groups.activeField is still set; rebuilds + re-adds to the scene
    requestRender();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  // The pipeline's blue-noise texture loads asynchronously and its onLoad
  // callback resets the accumulation once (~2 s after activation) — wait for
  // it to be loaded BEFORE requiring accumulated samples, or the reset races
  // the sample check.
  {
    const deadline = Date.now() + 120000;
    for (;;) {
      const ok = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        const p = app.pipeline;
        const noiseLoaded = !!p?._blueNoise?.image;
        return noiseLoaded && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 2;
      });
      if (ok || Date.now() > deadline) break;
      await page.waitForTimeout(1500);
    }
  }
  const ptState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return { id: app.pipeline?.id, enabled: app.pipeline?._encoder?.fieldEnabled,
      uEnabled: u?.uFieldEnabled?.value, samples: u?.uSampleCounter?.value };
  });
  const ptShot = await H.shotCanvas(page, 'field-pathtrace-field');
  H.check('pathtrace: field renders (enabled, shader compiles, accumulates)',
    ptState.id === 'pathtrace' && ptState.enabled === true && ptState.uEnabled === true
      && ptState.samples > 1 && H.nonUniformFraction(ptShot) > 0.02,
    JSON.stringify(ptState));

  // --- Cleanup --------------------------------------------------------------------
  await page.evaluate(async () => {
    const { clearField, requestRender } = await import('./render/index.js');
    clearField();
    requestRender();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
