// Crystallographic lattice planes in the ray/path tracers. Planes are added to
// the selected structure the same way PlanesPanel does (push a def to
// structure.planes + syncPlanesForSelectedStructure, which builds the Plane
// meshes into app.scene). The SceneEncoder discovers them by traversing the
// scene, encodes them into a data texture, and the shaders trace them
// analytically with exact cell clipping. Asserts:
//  - a 'None'-mode plane appears in the raster (depthpeel) AND the converged
//    ray-traced image (pixel delta vs the plane-less baselines),
//  - switching the plane to a synthetic Gaussian-blob Field colormap changes
//    the traced image (colormapped vs flat grey),
//  - removing the plane restores the plane-less baseline (exercises the hard
//    accumulation reset — restoreDelta ~ 0), and
//  - path tracing renders the plane error-free with non-uniform pixels.
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

  // Poll the tracer accumulation until it reaches n samples.
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

  // Poll until the encoder's plane pass reaches the wanted count (the re-encode
  // happens on a render frame, which races a plain sample-count wait).
  async function waitForPlaneCount(want, timeout = 60000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const c = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        return app.pipeline?._uniforms?.uPlaneCount?.value ?? -1;
      });
      if (c === want || Date.now() > deadline) return c;
      await page.waitForTimeout(1000);
    }
  }

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame (no depth-peel preview stalling RAF assertions)
  });

  const CONVERGED = 64;

  // --- Raster baseline (depthpeel, no plane) --------------------------------------
  await page.waitForTimeout(600);
  const rasterBaseline = await H.shotCanvas(page, 'planes-raster-noplane');

  // --- Ray-traced baseline (no plane) at convergence ------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitForSamples(CONVERGED);
  const baseState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { count: app.pipeline?._uniforms?.uPlaneCount?.value };
  });
  H.check('no plane: tracer plane pass empty (uPlaneCount 0)', baseState.count === 0,
    JSON.stringify(baseState));
  const tracerBaseline = await H.shotCanvas(page, 'planes-tracer-noplane');

  // --- Add a 'None'-mode plane cutting through the cell center ---------------------
  // uvwd normal (0,0,1) at the cell-center z, so it slices the full a-b cross
  // section through the structure (translucent grey + purple border).
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { syncPlanesForSelectedStructure } = await import('./ui/PlanesPanel.js');
    const { requestRender } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const lat = s.lattice;
    const cz = (lat[0][2] + lat[1][2] + lat[2][2]) / 2; // cell-center z
    if (!Array.isArray(s.planes)) s.planes = [];
    s.planes.push({
      enabled: true,
      params: { type: 'uvwd', u: 0, v: 0, w: 1, d: cz },
      label: 'test-plane',
      visualization: 'None',
      cutMode: 'None',
      colormap: 'jet',
      colormapMin: 0, colormapMax: 100,
      field: null,
    });
    syncPlanesForSelectedStructure();
    requestRender();
  });

  // --- Raster: the plane appears (depthpeel) --------------------------------------
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(800);
  const rasterPlane = await H.shotCanvas(page, 'planes-raster-none');
  const rasterDelta = changedPixelCount(rasterBaseline, rasterPlane);
  H.check('raster (depthpeel): the None-mode plane is drawn',
    rasterDelta > 500, JSON.stringify({ rasterDelta }));

  // --- Ray tracer: the None-mode plane appears in the converged image -------------
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitForPlaneCount(1);
  await waitForSamples(CONVERGED);
  const noneState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return { id: app.pipeline?.id, count: u?.uPlaneCount?.value, samples: u?.uSampleCounter?.value };
  });
  H.check('raytrace: plane encoded + uniforms wired (uPlaneCount 1)',
    noneState.id === 'raytrace' && noneState.count === 1 && noneState.samples > 2,
    JSON.stringify(noneState));
  const tracerNone = await H.shotCanvas(page, 'planes-tracer-none');
  const noneDelta = changedPixelCount(tracerBaseline, tracerNone);
  H.check('raytrace: the None-mode plane appears in the traced image',
    noneDelta > 500, JSON.stringify({ noneDelta }));

  // --- Switch the plane to Field mode (synthetic Gaussian blob) --------------------
  await page.evaluate(async () => {
    const { Field } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { syncPlanesForSelectedStructure } = await import('./ui/PlanesPanel.js');
    const { requestRender } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const lat = s.lattice;
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
    const field = new Field({ nx, ny, nz, origin: [0, 0, 0], voxel, values,
      minValue: 0, maxValue: maxV, isoValue: 0.5, useAbsoluteIsoValue: false, label: 'blob' });
    const plane = s.planes[s.planes.length - 1];
    plane.visualization = 'Field';
    plane.field = field;
    plane.colormap = 'jet';
    plane.colormapMin = 0;
    plane.colormapMax = maxV;
    syncPlanesForSelectedStructure();
    requestRender();
  });
  await waitForPlaneCount(1);
  await waitForSamples(CONVERGED);
  const fieldState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const enc = app.pipeline?._encoder;
    return { count: app.pipeline?._uniforms?.uPlaneCount?.value,
      atlas: enc?.planeAtlasTexture?.image?.width };
  });
  H.check('raytrace: Field-mode plane encoded with a baked colormap atlas',
    fieldState.count === 1 && fieldState.atlas >= 256, JSON.stringify(fieldState));
  const tracerField = await H.shotCanvas(page, 'planes-tracer-field');
  const fieldDelta = changedPixelCount(tracerNone, tracerField);
  H.check('raytrace: Field colormap changes the traced plane vs None mode',
    fieldDelta > 300, JSON.stringify({ fieldDelta }));

  // --- Remove the plane: the converged image returns to the baseline --------------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { syncPlanesForSelectedStructure } = await import('./ui/PlanesPanel.js');
    const { requestRender } = await import('./render/index.js');
    fileBrowser.selectedStructure.planes = [];
    syncPlanesForSelectedStructure();
    requestRender();
  });
  await waitForPlaneCount(0);
  await waitForSamples(CONVERGED);
  const tracerCleared = await H.shotCanvas(page, 'planes-tracer-cleared');
  const removeDelta = changedPixelCount(tracerField, tracerCleared);
  const restoreDelta = changedPixelCount(tracerBaseline, tracerCleared);
  H.check('raytrace: removing the plane restores the plane-less baseline',
    removeDelta > 500 && restoreDelta < noneDelta * 0.5,
    JSON.stringify({ noneDelta, removeDelta, restoreDelta }));

  // --- Path tracer: re-add the plane and render it error-free ---------------------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { syncPlanesForSelectedStructure } = await import('./ui/PlanesPanel.js');
    const { requestRender } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const lat = s.lattice;
    const cz = (lat[0][2] + lat[1][2] + lat[2][2]) / 2;
    s.planes = [{
      enabled: true,
      params: { type: 'uvwd', u: 0, v: 0, w: 1, d: cz },
      label: 'test-plane', visualization: 'None', cutMode: 'None',
      colormap: 'jet', colormapMin: 0, colormapMax: 100, field: null,
    }];
    syncPlanesForSelectedStructure();
    requestRender();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  // The pipeline's blue-noise texture loads asynchronously; wait for it before
  // requiring accumulated samples (its onLoad resets the accumulation once).
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
    return { id: app.pipeline?.id, count: u?.uPlaneCount?.value, samples: u?.uSampleCounter?.value };
  });
  const ptShot = await H.shotCanvas(page, 'planes-pathtrace-none');
  H.check('pathtrace: plane renders (enabled, shader compiles, accumulates)',
    ptState.id === 'pathtrace' && ptState.count === 1 && ptState.samples > 1
      && H.nonUniformFraction(ptShot) > 0.02,
    JSON.stringify(ptState));

  // --- Cleanup --------------------------------------------------------------------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { syncPlanesForSelectedStructure } = await import('./ui/PlanesPanel.js');
    fileBrowser.selectedStructure.planes = [];
    syncPlanesForSelectedStructure();
  });
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
