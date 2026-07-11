// Tracer high-face-count polyhedra: a convex polyhedron whose hull exceeds the
// old 20-plane fixed-array limit now traces its FILLED body (not just its edge
// cage) under both the raytrace and pathtrace pipelines. The shaders stream
// face planes straight from the poly data texture (raytrace/convexChunk.js ->
// ConvexPolyStreamIntersect, a byte-equivalent re-expression of the vendored
// ConvexPolyhedronIntersect), so the encoder no longer skips >20-face polys.
//
// A deterministic synthetic 24-point fibonacci-sphere polyhedron (~44 unique
// hull planes) is injected through the REAL model + mesh + encoder path (a
// Polyhedron pushed onto structure.polyhedra.polyhedra + a ConvexGeometry mesh
// in groups.polyhedraGroup), so it exercises the exact production pipeline. The
// standard YBCO coordination polyhedra (<= 20 faces) stay in the scene as the
// regression guard, and the synthetic poly's glass variant exercises the
// origin-inside / exit-normal branch that closed-shape refraction depends on.
'use strict';
const H = require('../harness');
const fs = require('fs');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

/** Count of pixels differing substantially between two screenshots. */
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
  try {
    H.check('webgl available', await H.webglAvailable(page));
    await H.loadDefaultStructure(page); // YBCO

    // Software-GL speed + trace every frame (no depth-peel preview stalling RAF).
    await page.evaluate(async () => {
      const { general } = await import('./state/store.js');
      general.rtResolutionScale = 0.25;
      general.rtRasterPreview = false;
    });

    // Enable the real YBCO coordination polyhedra (the <= 20-face regression set).
    await H.clickById(page, 'showPolyhedra');
    await page.waitForTimeout(2500);

    await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
    await page.waitForTimeout(3500);

    // --- Regression guard: the ordinary (<= 20-plane) YBCO polyhedra still trace
    const realPolys = await page.evaluate(async () => {
      const { app, groups } = await import('./state/store.js');
      const enc = app.pipeline._encoder;
      enc.encode(); // deterministic re-encode
      let maxPlanes = 0, unsupported = 0, meshes = 0;
      for (const m of groups.polyhedraGroup.children) {
        if (m.userData?.type !== 'polyhedron') continue;
        meshes++;
        if (m.userData.rtPlanesUnsupported) unsupported++;
        else if (m.userData.rtPlanes) maxPlanes = Math.max(maxPlanes, m.userData.rtPlanes.length);
      }
      return { polyCount: enc.polyCount, meshes, unsupported, maxPlanes };
    });
    H.check('standard YBCO polyhedra (<= 20 faces) still encode + trace',
      realPolys.polyCount > 0 && realPolys.meshes > 0 && realPolys.unsupported === 0
        && realPolys.maxPlanes > 0 && realPolys.maxPlanes <= 20,
      JSON.stringify(realPolys));

    // --- Inject a synthetic >20-plane polyhedron through the real model+mesh path
    const inject = await page.evaluate(async () => {
      const THREE = await import('./external/three/three.module.js');
      const { ConvexGeometry } = await import('./external/three/ConvexGeometry.js');
      const { Polyhedron } = await import('./model/Polyhedron.js');
      const { fileBrowser, groups } = await import('./state/store.js');
      const structure = fileBrowser.selectedStructure;
      if (!structure.polyhedra) {
        const { Polyhedra } = await import('./model/Polyhedra.js');
        structure.polyhedra = new Polyhedra({ polyhedra: [] });
      }
      // cell-centre in Cartesian (0.5 * (a + b + c)); YBCO origin at 0
      const L = structure.lattice;
      const cx = 0.5 * (L[0][0] + L[1][0] + L[2][0]);
      const cy = 0.5 * (L[0][1] + L[1][1] + L[2][1]);
      const cz = 0.5 * (L[0][2] + L[1][2] + L[2][2]);
      // 24-point fibonacci sphere (radius 1.5 A) -> ~44 unique triangular planes
      const N = 24, radius = 1.5, ga = Math.PI * (3 - Math.sqrt(5));
      const vertices = [], points = [];
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const th = ga * i;
        const x = cx + radius * Math.cos(th) * r;
        const yy = cy + radius * y;
        const z = cz + radius * Math.sin(th) * r;
        vertices.push([x, yy, z]);
        points.push(new THREE.Vector3(x, yy, z));
      }
      const poly = new Polyhedron({ vertices, name: 'synthTest' });
      poly.key = 'synthTest'; // stamped so the glass style store can target it
      const idx = structure.polyhedra.polyhedra.length;
      structure.polyhedra.polyhedra.push(poly);

      const material = new THREE.MeshBasicMaterial({ color: 0xff2020 });
      const mesh = new THREE.Mesh(new ConvexGeometry(points), material);
      mesh.userData.type = 'polyhedron';
      mesh.userData.polyIndex = idx;
      mesh.visible = true;
      groups.polyhedraGroup.add(mesh);
      structure.__synthMeshId = mesh.id;
      structure.__synthIdx = idx;
      return { idx, verts: vertices.length, center: [cx, cy, cz] };
    });

    // Force a deterministic re-encode and read back the encoded plane count.
    const encoded = await page.evaluate(async () => {
      const { app, groups, fileBrowser } = await import('./state/store.js');
      const enc = app.pipeline._encoder;
      enc.encode();
      const structure = fileBrowser.selectedStructure;
      const mesh = groups.polyhedraGroup.children.find((m) => m.id === structure.__synthMeshId);
      // encoded index of the synthetic poly among the passing meshes (group order)
      let p = 0;
      for (const m of groups.polyhedraGroup.children) {
        if (m.userData?.type !== 'polyhedron' || !m.visible || !m.userData.rtPlanes) continue;
        if (m.id === structure.__synthMeshId) break;
        p++;
      }
      const data = enc.polyTexture.image.data;
      const headerPlaneCount = data[p * 16 + 1];
      const headerMatCode = data[p * 16 + 2];
      return {
        polyCount: enc.polyCount,
        rtPlanes: mesh.userData.rtPlanes ? mesh.userData.rtPlanes.length : 0,
        unsupported: mesh.userData.rtPlanesUnsupported === true,
        headerPlaneCount, headerMatCode, p,
      };
    });
    // CHECK 1: encoder includes it, no skip warning fired, > 20 planes
    H.check('synthetic >20-face poly encoded (not skipped), rtPlanes > 20',
      !encoded.unsupported && encoded.rtPlanes > 20 && encoded.polyCount === realPolys.polyCount + 1,
      JSON.stringify(encoded));
    // CHECK 2: header texel's planeCount > 20
    H.check('encoded header texel planeCount > 20',
      encoded.headerPlaneCount > 20, JSON.stringify({ headerPlaneCount: encoded.headerPlaneCount }));

    // CHECK 3: the synthetic poly BODY renders (visible vs hidden pixel delta)
    await page.evaluate(async () => {
      const { requestRender } = await import('./render/index.js');
      requestRender();
    });
    await page.waitForTimeout(3500);
    const shotVisible = await H.shotCanvas(page, 'tracerpolyfaces-visible');

    await page.evaluate(async () => {
      const { app, groups, fileBrowser } = await import('./state/store.js');
      const { requestRender } = await import('./render/index.js');
      const structure = fileBrowser.selectedStructure;
      groups.polyhedraGroup.children.find((m) => m.id === structure.__synthMeshId).visible = false;
      app.pipeline._encoder.encode();
      requestRender();
    });
    await page.waitForTimeout(3500);
    const shotHidden = await H.shotCanvas(page, 'tracerpolyfaces-hidden');
    const bodyDelta = changedPixelCount(shotVisible, shotHidden);
    H.check('synthetic poly renders a FILLED body under raytrace (visible vs hidden)',
      bodyDelta > 800, JSON.stringify({ bodyDelta }));

    // restore visibility
    await page.evaluate(async () => {
      const { app, groups, fileBrowser } = await import('./state/store.js');
      const { requestRender } = await import('./render/index.js');
      const structure = fileBrowser.selectedStructure;
      groups.polyhedraGroup.children.find((m) => m.id === structure.__synthMeshId).visible = true;
      app.pipeline._encoder.encode();
      requestRender();
    });
    await page.waitForTimeout(3000);

    // CHECK 6: glass variant (origin-inside / exit-normal path) — no NaN, differs
    const glassEnc = await page.evaluate(async () => {
      const { app, groups, fileBrowser } = await import('./state/store.js');
      const { requestRender } = await import('./render/index.js');
      const structure = fileBrowser.selectedStructure;
      structure.polyhedraUserStyles = structure.polyhedraUserStyles ?? {};
      structure.polyhedraUserStyles['synthTest'] = { material: { type: 'glass', ior: 1.6 } };
      const enc = app.pipeline._encoder;
      enc.encode();
      // find the synthetic poly's encoded matCode texel
      let p = 0;
      for (const m of groups.polyhedraGroup.children) {
        if (m.userData?.type !== 'polyhedron' || !m.visible || !m.userData.rtPlanes) continue;
        if (m.id === structure.__synthMeshId) break;
        p++;
      }
      requestRender();
      return { matCode: enc.polyTexture.image.data[p * 16 + 2] };
    });
    await page.waitForTimeout(4000);
    const shotGlass = await H.shotCanvas(page, 'tracerpolyfaces-glass');
    const glassDelta = changedPixelCount(shotVisible, shotGlass);
    const glassNonUniform = H.nonUniformFraction(shotGlass);
    H.check('glass poly (code 2) traces the closed-shape refraction path: differs, no blowup',
      glassEnc.matCode === 2 && glassDelta > 300 && glassNonUniform > 0.02 && glassNonUniform < 0.98,
      JSON.stringify({ matCode: glassEnc.matCode, glassDelta, glassNonUniform }));

    // CHECK 4: pathtrace smoke — the same scene accumulates, shader compiles
    await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
    await page.waitForTimeout(10000); // PT + polys is slow under software GL
    const pt = await page.evaluate(async () => {
      const { app } = await import('./state/store.js');
      return { id: app.pipeline.id, samples: app.pipeline._uniforms.uSampleCounter.value };
    });
    const shotPt = await H.shotCanvas(page, 'tracerpolyfaces-pathtrace');
    H.check('synthetic >20-face poly path-traces (shader compiles + accumulates)',
      pt.id === 'pathtrace' && pt.samples > 1 && H.nonUniformFraction(shotPt) > 0.02,
      JSON.stringify(pt));

    // page-error guard (NaN / shader-compile failures surface here)
    H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    H.crash(e);
  }
  await H.finish(browser);
})();
