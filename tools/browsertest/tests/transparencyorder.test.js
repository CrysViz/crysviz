// Per-atom transparency draw order across the three rendering pipelines:
// - 'forward'       legacy single blended pass (order-dependent; not asserted
//                   on pixels — only that its state is legacy and no overlay
//                   exists)
// - 'split-atoms'   opaque/transparent two-pass split: a semi-transparent atom
//                   in front of an opaque atom stays in front (blends over it)
//                   instead of vanishing behind it
// - 'sorted-atoms'  additionally sorts transparent instances back-to-front, so
//                   transparent-over-transparent atom overlap blends correctly
// Also exercises pipeline switching mid-scene: dispose must remove the
// overlay and reset uAlphaPass; re-activation must rebuild from stamped specs.
//
// Setup: stage a small red sphere (low instance index) directly in front of a
// big blue sphere (higher instance index — the order that triggered the bug)
// on the camera->target axis, zero-scale all other atoms, hide bonds/lattice,
// and average the pixels over the front sphere's disk. Red vs blue keeps the
// channels separable under the white key light (a green sphere picks up too
// much red from lighting to give clean margins).
'use strict';
const fs = require('fs');
const H = require('../harness');
const { PNG } = require('pngjs');

/** Average RGB over a disk of radius R around (x, y) of a page screenshot. */
function sampleDisk(file, x, y, R) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const px = Math.round(x + dx), py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      const o = (py * png.width + px) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
    }
  }
  return { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
}

/** Centroid + count of strongly red pixels — locates the front sphere. Scans
 *  only the pure-3D-canvas region (harness CANVAS_CLIP) so red/orange UI
 *  elements (toolbar buttons, logo) cannot pull the centroid off the sphere. */
function redCentroid(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let X = 0, Y = 0, n = 0;
  for (let y = 120; y < Math.min(780, png.height); y++) {
    for (let x = 460; x < Math.min(1380, png.width); x++) {
      const o = (y * png.width + x) * 4;
      if (png.data[o] > 120 && png.data[o] > png.data[o + 1] + 60 && png.data[o] > png.data[o + 2] + 60) {
        X += x; Y += y; n++;
      }
    }
  }
  return n ? { x: X / n, y: Y / n, count: n } : null;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- Stage the scene; returns the two staged source-atom indices ---------------
  const src = await page.evaluate(async () => {
    const { app, groups, fileBrowser } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const { requestRender } = await import('./render/index.js');
    const mesh = groups.atomsMesh;
    const srcIndex = fileBrowser.selectedStructure.periodic.wrapped.srcIndex;
    const srcOf = (i) => (srcIndex ? srcIndex[i] : i);
    // Front = instance 0; back = first LATER instance of a DIFFERENT source atom
    // (periodic copies share their source atom's opacity, so the pair must not
    // be two copies of the same atom).
    const iF = 0;
    let iB = 1;
    while (iB < mesh.count && srcOf(iB) === srcOf(iF)) iB++;

    const cam = app.camera;
    const target = app.controls.target.clone();
    const dir = target.clone().sub(cam.position).normalize();
    const backPos = target;                                             // big blue sphere
    const frontPos = target.clone().sub(dir.clone().multiplyScalar(5)); // small red sphere, 5 units nearer
    const a = mesh.instanceMatrix.array;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      const s = i === iF ? 1.2 : i === iB ? 3.5 : 0.0; // zero-scale = hidden
      a[o] = s; a[o + 5] = s; a[o + 10] = s;
      const p = i === iF ? frontPos : backPos;
      a[o + 12] = p.x; a[o + 13] = p.y; a[o + 14] = p.z;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.setColorAt(iF, new THREE.Color(0xff0000));
    mesh.setColorAt(iB, new THREE.Color(0x0000ff));
    mesh.instanceColor.needsUpdate = true;
    if (groups.bondsMesh) groups.bondsMesh.visible = false;
    if (groups.latticeGroup) groups.latticeGroup.visible = false;
    if (groups.polyhedraGroup) groups.polyhedraGroup.visible = false;
    requestRender();
    return { front: srcOf(iF), back: srcOf(iB) };
  });
  await page.waitForTimeout(500);

  const shootFile = async (name) => {
    const file = `${__dirname}/../artifacts/${name}.png`;
    await page.screenshot({ path: file });
    return file;
  };

  // Locate the front (red) sphere in the opaque baseline; average over ~55% of
  // its disk (the same fixed region in every later shot) so the small white
  // specular hotspot at its centre cannot dominate a point sample.
  const baselineFile = await shootFile('transparencyorder-opaque');
  const spot = redCentroid(baselineFile);
  H.check('staging: front red atom visible over the back blue atom',
    !!spot && spot.count > 500 && src.front !== src.back, JSON.stringify({ spot, src }));
  if (!spot) { H.check('no page errors', errors.length === 0, errors.join(' | ')); await H.finish(browser); return; }
  const R = Math.max(3, Math.floor(0.55 * Math.sqrt(spot.count / Math.PI)));

  const shoot = async (name) => sampleDisk(await shootFile(name), spot.x, spot.y, R);

  /** Set one source atom's opacity the way the UI editors do (model + mesh). */
  const setOpacity = (srcIdx, value) => page.evaluate(async ({ srcIdx, value }) => {
    const { fileBrowser } = await import('./state/store.js');
    const { updateSingleAtomOpacity, requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    structure.atoms[srcIdx].setOpacity(value);
    structure.atomImages[srcIdx]?.forEach((imageIndex) => updateSingleAtomOpacity(imageIndex, value));
    requestRender();
  }, { srcIdx, value });

  const setPipeline = (id) => page.evaluate(async (id) => {
    const { setActivePipeline } = await import('./render/index.js');
    setActivePipeline(id);
  }, id);

  const atomsState = () => page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const mesh = groups.atomsMesh;
    const overlay = mesh.userData.transparentOverlay;
    return {
      mainTransparent: mesh.material.transparent,
      mainDepthWrite: mesh.material.depthWrite,
      alphaPass: mesh.material.userData.alphaPass ?? 0,
      hasOverlay: !!overlay,
      overlayVisible: !!overlay?.visible,
      overlayOwnBuffers: !!overlay && overlay.instanceMatrix !== mesh.instanceMatrix,
    };
  });

  const s1 = sampleDisk(baselineFile, spot.x, spot.y, R);
  H.check('opaque baseline: front red atom covers the back blue atom',
    s1.r > s1.b + 50, JSON.stringify(s1));

  // ============================ split-atoms pipeline ============================
  await setPipeline('split-atoms');

  // Transparent front atom must BLEND over the opaque back atom (under forward
  // the later-indexed blue instance overpainted it -> pure blue disk).
  await setOpacity(src.front, 0.5);
  await page.waitForTimeout(500);
  const s2 = await shoot('transparencyorder-split-front');
  H.check('split: transparent front atom lets the back atom show through (blue rises)',
    s2.b > s1.b + 30, JSON.stringify({ s1, s2 }));
  H.check('split: transparent front atom stays in front (red persists in the blend)',
    s2.r > s2.b - 15 && s2.r > s1.b + 30, JSON.stringify({ s1, s2 }));

  const splitState = await atomsState();
  H.check('split: main pass stays opaque with depth writes, shared-buffer overlay visible',
    !splitState.mainTransparent && splitState.mainDepthWrite && splitState.alphaPass === 1
      && splitState.overlayVisible && !splitState.overlayOwnBuffers,
    JSON.stringify(splitState));

  // Opaque front over transparent back: front must fully cover again.
  await setOpacity(src.front, 1.0);
  await setOpacity(src.back, 0.5);
  await page.waitForTimeout(500);
  const s3 = await shoot('transparencyorder-split-back');
  H.check('split: opaque front atom fully covers a transparent back atom',
    s3.r > s3.b + 50 && s3.b < s1.b + 25, JSON.stringify({ s1, s3 }));

  // ============================ sorted-atoms pipeline ===========================
  // BOTH transparent: the front red atom has the lower instance index, so
  // unsorted drawing blends blue OVER red; the depth-sorted overlay draws the
  // back atom first and blends red last. Measured disk averages: sorted
  // r-b ~ +89, unsorted ~ +14 — threshold 50 sits comfortably between.
  await setPipeline('sorted-atoms');
  await setOpacity(src.front, 0.5);
  await page.waitForTimeout(500);
  const s4 = await shoot('transparencyorder-sorted-both');
  H.check('sorted: two transparent atoms blend back-to-front (front red dominates)',
    s4.r > s4.b + 50, JSON.stringify({ s1, s4 }));
  H.check('sorted: back atom shows through the front one',
    s4.b > s1.b + 20, JSON.stringify({ s1, s4 }));

  const sortedState = await atomsState();
  H.check('sorted: overlay uses private (sorted) instance buffers',
    sortedState.overlayVisible && sortedState.overlayOwnBuffers && sortedState.alphaPass === 1,
    JSON.stringify(sortedState));

  // ============================ wboit pipeline ==================================
  // Order-independent weighted blending (vendored three-wboit). Both atoms are
  // still transparent from the sorted section.
  await setPipeline('wboit');
  await page.waitForTimeout(500);
  const s5File = await shootFile('transparencyorder-wboit-both');
  const s5 = sampleDisk(s5File, spot.x, spot.y, R);
  const s5bg = sampleDisk(s5File, 700, 170, 5); // empty background reference
  // WBOIT is a weighted average, not compositing: with this scene's shallow
  // ortho depth range the depth weights saturate, so the honest property is
  // that BOTH atoms contribute order-independently. Measured ~(254,206,255)
  // over beige bg. Failure modes excluded: front-red vanished -> blue-dominant
  // (~156,128,246, r-b=-90); content invisible/washed -> ~= background;
  // back-blue missing -> baseline red (b~48).
  const s5DistFromBg = Math.hypot(s5.r - s5bg.r, s5.g - s5bg.g, s5.b - s5bg.b);
  H.check('wboit: two transparent atoms both contribute to the blend',
    s5.r > s5.b - 30 && s5.b > s1.b + 100 && s5DistFromBg > 25,
    JSON.stringify({ s1, s5, s5bg, dist: Math.round(s5DistFromBg) }));

  const wboitState = await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const { getActivePipeline } = await import('./render/index.js');
    const mesh = groups.atomsMesh;
    const overlay = mesh.userData.transparentOverlay;
    return {
      mainTransparent: mesh.material.transparent,
      mainDepthWrite: mesh.material.depthWrite,
      alphaPass: mesh.material.userData.alphaPass ?? 0,
      overlayVisible: !!overlay?.visible,
      overlayInScene: overlay?.parent === app.scene,
      overlayPatched: overlay?.material?.wboitEnabled === true,
      needsCpuTriangleSort: getActivePipeline().needsCpuTriangleSort,
    };
  });
  H.check('wboit: split main pass opaque, WBOIT-patched overlay parented to the scene',
    !wboitState.mainTransparent && wboitState.mainDepthWrite && wboitState.alphaPass === 1
      && wboitState.overlayVisible && wboitState.overlayInScene && wboitState.overlayPatched
      && wboitState.needsCpuTriangleSort === false,
    JSON.stringify(wboitState));

  // Transparent front over opaque back: red persists, blue shows through.
  await setOpacity(src.back, 1.0);
  await page.waitForTimeout(500);
  const s6 = await shoot('transparencyorder-wboit-front');
  H.check('wboit: transparent front atom blends over the opaque back atom',
    s6.r > s6.b && s6.b > s1.b + 20, JSON.stringify({ s1, s6 }));

  // Opaque front over transparent back: opaque pass covers fully.
  await setOpacity(src.front, 1.0);
  await setOpacity(src.back, 0.5);
  await page.waitForTimeout(500);
  const s7 = await shoot('transparencyorder-wboit-back');
  H.check('wboit: opaque front atom fully covers a transparent back atom',
    s7.r > s7.b + 50 && s7.b < s1.b + 25, JSON.stringify({ s1, s7 }));

  // Transparent BONDS get the same split treatment under wboit. The staging
  // hid the bonds mesh — unhide it, since the overlay's visibility follows it.
  const bondState = await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updateSingleBondOpacity, requestRender } = await import('./render/index.js');
    if (groups.bondsMesh) groups.bondsMesh.visible = true;
    const bond = fileBrowser.selectedStructure.bonds.find((b) => b.visibleLen > 1e-3);
    const index = fileBrowser.selectedStructure.bonds.indexOf(bond);
    bond.alpha = 0.5;
    updateSingleBondOpacity(index * 2, 0.5);
    updateSingleBondOpacity(index * 2 + 1, 0.5);
    requestRender();
    const mesh = groups.bondsMesh;
    const overlay = mesh.userData.transparentOverlay;
    return {
      index,
      mainTransparent: mesh.material.transparent,
      mainDepthWrite: mesh.material.depthWrite,
      alphaPass: mesh.material.userData.alphaPass ?? 0,
      overlayVisible: !!overlay?.visible,
      overlayPatched: overlay?.material?.wboitEnabled === true,
    };
  });
  H.check('wboit: transparent bond splits the bonds mesh with a patched overlay',
    !bondState.mainTransparent && bondState.mainDepthWrite && bondState.alphaPass === 1
      && bondState.overlayVisible && bondState.overlayPatched,
    JSON.stringify(bondState));
  await page.waitForTimeout(300);
  await page.evaluate(() => {}); // flush a frame with the bond overlay drawn
  H.check('wboit: no page errors after bond overlay render', errors.length === 0, errors.join(' | '));

  // Reset the bond and re-enter the both-transparent atom state for the
  // forward hand-off below.
  await page.evaluate(async (index) => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updateSingleBondOpacity, requestRender } = await import('./render/index.js');
    fileBrowser.selectedStructure.bonds[index].alpha = 1;
    updateSingleBondOpacity(index * 2, 1);
    updateSingleBondOpacity(index * 2 + 1, 1);
    if (groups.bondsMesh) groups.bondsMesh.visible = false; // re-hide (staging)
    requestRender();
  }, bondState.index);
  await setOpacity(src.front, 0.5);

  // ============================ depthpeel pipeline ==============================
  // Exact per-pixel compositing (adapted gkjohnson demo) — must meet the same
  // STRICT expectations as the sorted pipeline, since peeling composites truly
  // back-to-front. Entering with both atoms transparent.
  await setPipeline('depthpeel');
  await page.waitForTimeout(500);
  const s8 = await shoot('transparencyorder-depthpeel-both');
  H.check('depthpeel: two transparent atoms composite back-to-front exactly (red dominates)',
    s8.r > s8.b + 50 && s8.b > s1.b + 20, JSON.stringify({ s1, s8 }));

  const peelState = await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const { getActivePipeline } = await import('./render/index.js');
    const mesh = groups.atomsMesh;
    const overlay = mesh.userData.transparentOverlay;
    return {
      alphaPass: mesh.material.userData.alphaPass ?? 0,
      overlayVisible: !!overlay?.visible,
      overlayInScene: overlay?.parent === app.scene,
      overlayPeelPatched: overlay?.material?.depthPeelEnabled === true,
      needsCpuTriangleSort: getActivePipeline().needsCpuTriangleSort,
    };
  });
  H.check('depthpeel: split main pass with a peel-patched scene-root overlay',
    peelState.alphaPass === 1 && peelState.overlayVisible && peelState.overlayInScene
      && peelState.overlayPeelPatched && peelState.needsCpuTriangleSort === false,
    JSON.stringify(peelState));

  // Transparent front over opaque back — expect the exact split-pipeline blend.
  await setOpacity(src.back, 1.0);
  await page.waitForTimeout(500);
  const s9 = await shoot('transparencyorder-depthpeel-front');
  H.check('depthpeel: transparent front atom blends over the opaque back atom (blue rises)',
    s9.b > s1.b + 30, JSON.stringify({ s1, s9 }));
  H.check('depthpeel: transparent front atom stays in front (red persists)',
    s9.r > s9.b - 15 && s9.r > s1.b + 30, JSON.stringify({ s1, s9 }));

  // Opaque front over transparent back: covered exactly.
  await setOpacity(src.front, 1.0);
  await setOpacity(src.back, 0.5);
  await page.waitForTimeout(500);
  const s10 = await shoot('transparencyorder-depthpeel-back');
  H.check('depthpeel: opaque front atom fully covers a transparent back atom',
    s10.r > s10.b + 50 && s10.b < s1.b + 25, JSON.stringify({ s1, s10 }));

  // Re-enter the both-transparent state for the forward hand-off below.
  await setOpacity(src.front, 0.5);

  // ============================ back to forward =================================
  // Dispose must remove the overlay and reset uAlphaPass; forward re-applies
  // its legacy flags from the stamped specs.
  await setPipeline('forward');
  const forwardState = await atomsState();
  H.check('forward: overlay removed and alpha pass reset on switch',
    !forwardState.hasOverlay && forwardState.alphaPass === 0
      && forwardState.mainTransparent && !forwardState.mainDepthWrite,
    JSON.stringify(forwardState));

  // All opaque again -> forward returns to plain opaque state.
  await setOpacity(src.front, 1.0);
  await setOpacity(src.back, 1.0);
  const opaqueState = await atomsState();
  H.check('forward: opaque again once no atom is transparent',
    !opaqueState.mainTransparent && opaqueState.mainDepthWrite, JSON.stringify(opaqueState));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
