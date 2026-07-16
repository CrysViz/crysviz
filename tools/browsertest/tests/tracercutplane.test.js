// Atom cut planes are honored by the ray/path tracers: the SceneEncoder drops
// whole atoms by their world center at encode time, matching the raster
// shader's per-instance discard. Drives the same update path CutPlanePanel's
// syncCutPlanes uses (updateAtomCutPlaneState + updateVisualization), asserts
// the raster (depthpeel) image loses atoms, then switches to raytrace and
// asserts the TRACED image gains background when the cut plane is enabled.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // Offset for an x-normal cut plane placed at the median atom x-center, so
  // ~half the atoms fall on the cut side (left = along +normal, mask +1:
  // discard where dot(center, n) - r > 0, i.e. x > r).
  const cutOffset = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const m = groups.atomsMesh.instanceMatrix.array;
    const xs = [];
    for (let i = 0; i < groups.atomsMesh.count; i++) {
      const o = i * 16;
      if (m[o] > 0) xs.push(m[o + 12]); // visible instance world-center x
    }
    xs.sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
  });
  H.check('found a median atom x-offset for the cut plane',
    Number.isFinite(cutOffset), JSON.stringify({ cutOffset }));

  // Helpers that mirror CutPlanePanel.syncCutPlanes exactly.
  const applyCutPlanes = () => page.evaluate(async () => {
    const { updateAtomCutPlaneState } = await import('./render/index.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    updateAtomCutPlaneState();
    updateVisualization({
      atomsUpdate: false, bondsUpdate: false, reRenderAtoms: false,
      reRenderBonds: false, reRenderLattice: false, reRenderOther: false,
      reRenderComposition: false,
    });
  });
  const setCutPlane = (enabled) => page.evaluate(async ({ enabled, r }) => {
    const { general } = await import('./state/store.js');
    general.atomCutPlanes = enabled
      ? [{ enabled: true, x: 1, y: 0, z: 0, r, side: 'left' }]
      : [];
  }, { enabled, r: cutOffset });

  // --- Raster (depthpeel default): a cut plane removes atoms from the frame ------
  await setCutPlane(false);
  await applyCutPlanes();
  await page.waitForTimeout(600);
  const rasterNoCut = H.nonUniformFraction(await H.shotCanvas(page, 'cutplane-raster-nocut'));

  await setCutPlane(true);
  await applyCutPlanes();
  await page.waitForTimeout(600);
  const rasterCut = H.nonUniformFraction(await H.shotCanvas(page, 'cutplane-raster-cut'));

  H.check('raster (depthpeel): cut plane removes atoms (less drawn content)',
    rasterCut < rasterNoCut && (rasterNoCut - rasterCut) / rasterNoCut > 0.1,
    JSON.stringify({ rasterNoCut, rasterCut }));

  // --- Ray tracer: the same cut plane must gain background in the TRACED image ---
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame (no depth-peel preview stalling RAF assertions)
  });

  // Baseline traced image with NO cut plane.
  await setCutPlane(false);
  await applyCutPlanes();
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(4000); // shader compile + accumulation
  const tracerNoCut = H.nonUniformFraction(await H.shotCanvas(page, 'cutplane-tracer-nocut'));

  // Enable the cut plane: the encoder fingerprint picks it up, re-encodes and
  // resets the accumulation.
  await setCutPlane(true);
  await page.evaluate(async () => {
    const { updateAtomCutPlaneState, requestRender } = await import('./render/index.js');
    updateAtomCutPlaneState();
    requestRender();
  });
  await page.waitForTimeout(4000);
  const encoded = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    return { id: app.pipeline?.id, samples: app.pipeline?._uniforms?.uSampleCounter?.value };
  });
  const tracerCut = H.nonUniformFraction(await H.shotCanvas(page, 'cutplane-tracer-cut'));

  H.check('raytrace re-encoded + resumed accumulating after the cut-plane edit',
    encoded.id === 'raytrace' && encoded.samples > 2, JSON.stringify(encoded));
  H.check('raytrace: cut-plane image shows more background than the uncut image',
    tracerCut < tracerNoCut && (tracerNoCut - tracerCut) / tracerNoCut > 0.1,
    JSON.stringify({ tracerNoCut, tracerCut }));

  // Cleanup: drop the cut plane and return to the default pipeline.
  await setCutPlane(false);
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await applyCutPlanes();

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
