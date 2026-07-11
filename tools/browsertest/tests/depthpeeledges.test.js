// Depth-peeling ordering for transparent polyhedra EDGES (fat lines).
//
// Bug: under 'depthpeel', poly edges with alpha < 1 rendered IN FRONT of
// fully-opaque atoms/faces. Root cause: DepthPeelUtils.patch merged its discard
// uniforms into the material with `Object.assign(shader.uniforms, uniforms)`,
// and for a ShaderMaterial `shader.uniforms === material.uniforms` — so the
// unprefixed `resolution` uniform OVERWROTE LineMaterial's OWN `resolution`
// (its vertex shader reads it for screen-space line width). That coupled the
// fat line's width-resolution and the opaque-depth discard's UV-resolution into
// one value, so the discard could sample the wrong opaque-depth texel (reading
// background depth -> never discarding -> the edge draws in front). The fix
// dp-prefixes every injected uniform (dpResolution, dpOpaqueDepth, ...), so the
// material keeps its own resolution and the discard gets a private one.
//
// Assertions:
//  1. STRUCTURAL (deterministic, GPU-independent — the fail-before check): a
//     transparent poly edge's LineMaterial keeps its OWN `resolution` uniform
//     after the depth-peel patch, and the discard shader uses `dpResolution` /
//     `dpOpaqueDepth` (not the clobber-prone bare names).
//  2. PIXEL guard: an opaque atom placed in front of a polyhedron occludes its
//     transparent edges (no black edge bleed over the atom disk), and the edges
//     still render where unoccluded.
//  3. Companion (working case must not regress): a slightly-transparent
//     (alpha 0.9) occluder still orders correctly (stays atom-dominant).
'use strict';
const fs = require('fs');
const H = require('../harness');
const { PNG } = require('pngjs');

/** Average RGB over a disk of radius R around (x, y). */
function sampleDisk(file, x, y, R) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dy * dy > R * R) continue;
    const px = Math.round(x + dx), py = Math.round(y + dy);
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
    const o = (py * png.width + px) * 4;
    sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
  }
  return { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n), n };
}

/** Fraction of near-black pixels (edge color) inside a disk. */
function darkFractionInDisk(file, x, y, R, thr = 55) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let dark = 0, n = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dy * dy > R * R) continue;
    const px = Math.round(x + dx), py = Math.round(y + dy);
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
    const o = (py * png.width + px) * 4; n++;
    if (png.data[o] < thr && png.data[o + 1] < thr && png.data[o + 2] < thr) dark++;
  }
  return n ? dark / n : 0;
}

/** Centroid + count of strongly red pixels within the 3D canvas region. */
function redCentroid(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let X = 0, Y = 0, n = 0;
  for (let y = 120; y < Math.min(780, png.height); y++) {
    for (let x = 460; x < Math.min(1380, png.width); x++) {
      const o = (y * png.width + x) * 4;
      if (png.data[o] > 120 && png.data[o] > png.data[o + 1] + 50 && png.data[o] > png.data[o + 2] + 50) {
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
  await H.clickById(page, 'showPolyhedra');
  await H.waitFor(page, async () => {
    const { groups } = await import('./state/store.js');
    return (groups.polyhedraGroup?.children?.length ?? 0) > 0;
  });

  // --- Setup: depthpeel, thick black transparent edges, opaque faces ---------------
  await page.evaluate(async () => {
    const { groups, general, fileBrowser } = await import('./state/store.js');
    const { setActivePipeline, requestRender } = await import('./render/index.js');
    const { updatePolyhedraColors, setPolyEdgeWidth } = await import('./render/PolyhedraModule.js');
    setActivePipeline('depthpeel');
    general.depthPeelLayers = 8;
    setPolyEdgeWidth(5);
    const s = fileBrowser.selectedStructure;
    const meshes = () => groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    for (const m of meshes()) {
      const ck = m.userData.catKey;
      s.polyhedraCategoryStyles[ck] = {
        ...(s.polyhedraCategoryStyles[ck] || {}), alpha: 1, edgeColor: '#000000', edgeAlpha: 0.5,
      };
    }
    updatePolyhedraColors();
    requestRender();
  });
  await page.waitForTimeout(400);

  // --- 1) STRUCTURAL: the depth-peel patch must NOT clobber LineMaterial's own
  //        `resolution` uniform (the fail-before check) --------------------------
  const struct = await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const meshes = () => groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const edgeOf = (m) => m.children.find((c) => c.userData?.type === 'polyhedron-edges');
    const edgeMat = edgeOf(meshes()[0]).material;
    // Capture the compiled fragment source by wrapping onBeforeCompile, then
    // force a recompile via a full depth-peel frame.
    let frag = null;
    const orig = edgeMat.onBeforeCompile;
    edgeMat.onBeforeCompile = function (shader, r) {
      if (typeof orig === 'function') orig.call(this, shader, r);
      frag = shader.fragmentShader;
    };
    edgeMat.needsUpdate = true;
    app.pipeline.render({ renderer: app.renderer, scene: app.scene, camera: app.camera });
    const dp = edgeMat.userData.depthPeel || {};
    // The clobber signature: LineMaterial's own `resolution` uniform object is
    // the SAME reference the depth-peel patch installed (i.e. Object.assign
    // overwrote it). Preserved == the material's resolution is NOT any of the
    // patch's uniform objects.
    const dpVals = Object.values(dp);
    return {
      isLineMaterial: edgeMat.isLineMaterial === true,
      depthPeelEnabled: edgeMat.depthPeelEnabled === true,
      ownResolutionPreserved: !!edgeMat.uniforms.resolution
        && !dpVals.includes(edgeMat.uniforms.resolution),
      discardUsesDpResolution: !!frag && frag.includes('gl_FragCoord.xy / dpResolution'),
      discardUsesDpOpaqueDepth: !!frag && frag.includes('texture2D( dpOpaqueDepth'),
    };
  });
  H.check('transparent poly edge is a peel-patched LineMaterial',
    struct.isLineMaterial && struct.depthPeelEnabled, JSON.stringify(struct));
  H.check('depth-peel patch preserves LineMaterial\'s own resolution uniform (no clobber)',
    struct.ownResolutionPreserved, JSON.stringify(struct));
  H.check('opaque-depth discard uses the private dpResolution / dpOpaqueDepth uniforms',
    struct.discardUsesDpResolution && struct.discardUsesDpOpaqueDepth, JSON.stringify(struct));

  // Edges must actually render (no occluder yet): the canvas has black lines.
  const visFile = await H.shotCanvas(page, 'depthpeeledges-visible');
  H.check('transparent poly edges render under depthpeel',
    H.darkFraction(visFile, 55) > 0.003, JSON.stringify({ dark: H.darkFraction(visFile, 55) }));

  // --- 2) PIXEL guard: an opaque atom in front of a polyhedron occludes its
  //        transparent edges (no black bleed over the atom disk) -----------------
  await page.evaluate(async () => {
    const { app, groups } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    const { requestRender } = await import('./render/index.js');
    const meshes = groups.polyhedraGroup.children.filter((m) => m.userData?.type === 'polyhedron');
    const poly = meshes[0];
    const box = new THREE.Box3().setFromObject(poly);
    const centroid = box.getCenter(new THREE.Vector3());
    const polyR = box.getSize(new THREE.Vector3()).length() * 0.5;
    const mesh = groups.atomsMesh;
    const frontPos = app.camera.position.clone().lerp(centroid, 0.4);
    const iF = 0;
    const a = mesh.instanceMatrix.array; const o = iF * 16;
    const scl = polyR * 1.7;
    a[o] = scl; a[o + 5] = scl; a[o + 10] = scl;
    a[o + 12] = frontPos.x; a[o + 13] = frontPos.y; a[o + 14] = frontPos.z;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.setColorAt(iF, new THREE.Color(0xff0000));
    mesh.instanceColor.needsUpdate = true;
    if (groups.bondsMesh) groups.bondsMesh.visible = false;
    if (groups.latticeGroup) groups.latticeGroup.visible = false;
    requestRender();
  });
  await page.waitForTimeout(600);

  const shot = async (name) => { const f = `${__dirname}/../artifacts/${name}.png`; await page.screenshot({ path: f }); return f; };

  const withEdgesFile = await shot('depthpeeledges-occluded');
  const spot = redCentroid(withEdgesFile);
  H.check('staging: opaque red occluder atom is visible', !!spot && spot.count > 3000,
    JSON.stringify(spot));
  if (!spot) { H.check('no page errors', errors.length === 0, errors.join(' | ')); await H.finish(browser); return; }
  const R = Math.max(6, Math.floor(0.5 * Math.sqrt(spot.count / Math.PI)));
  const darkWithEdges = darkFractionInDisk(withEdgesFile, spot.x, spot.y, R);

  // Reference: edges hidden — the occluder disk with edges must match it.
  await page.evaluate(async () => {
    const { setPolyEdgeWidth } = await import('./render/PolyhedraModule.js');
    const { requestRender } = await import('./render/index.js');
    setPolyEdgeWidth(0); requestRender();
  });
  await page.waitForTimeout(500);
  const noEdgeFile = await shot('depthpeeledges-occluded-noedges');
  const darkNoEdges = darkFractionInDisk(noEdgeFile, spot.x, spot.y, R);
  H.check('transparent poly edges do NOT bleed in front of an opaque atom',
    darkWithEdges < darkNoEdges + 0.01, JSON.stringify({ darkWithEdges, darkNoEdges, R }));

  // Restore edges for the companion case.
  await page.evaluate(async () => {
    const { setPolyEdgeWidth } = await import('./render/PolyhedraModule.js');
    const { requestRender } = await import('./render/index.js');
    setPolyEdgeWidth(5); requestRender();
  });
  await page.waitForTimeout(400);

  // --- 3) Companion: alpha 0.9 occluder still orders correctly (atom dominant) ----
  await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { updateSingleAtomOpacity, requestRender } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    const srcIndex = s.periodic.wrapped.srcIndex;
    const src = srcIndex ? srcIndex[0] : 0;
    s.atoms[src].setOpacity(0.9);
    s.atomImages[src]?.forEach((imageIndex) => updateSingleAtomOpacity(imageIndex, 0.9));
    updateSingleAtomOpacity(0, 0.9);
    if (groups.atomsMesh.instanceOpacity) groups.atomsMesh.instanceOpacity.needsUpdate = true;
    requestRender();
  });
  await page.waitForTimeout(600);
  const softFile = await shot('depthpeeledges-occluded-soft');
  const softMean = sampleDisk(softFile, spot.x, spot.y, R);
  H.check('working case (alpha 0.9 occluder) still orders correctly (atom dominant)',
    softMean.r > softMean.b && softMean.r > softMean.g, JSON.stringify(softMean));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
