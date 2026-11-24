// Polyhedra drawn as ONE mesh (render/PolyhedraMesh.js): a flat per-polyhedron
// table backs one face geometry and one edge geometry with shared materials.
// Checks what that is for and what must keep working:
//   (a) the shader program count grows by a constant when polyhedra appear,
//       not with the polyhedron count (YBCO, then a 3×3×3 supercell);
//   (b) few draw calls per frame with 300+ polyhedra (default depthpeel);
//   (c) a double-click on a polyhedron selects that polyhedron (key = model);
//   (d) one polyhedron's colour edit rewrites only its vertex range;
//   (e) focus-region opacity and a category's show/hide reach the mesh;
//   (f) the SVG export draws the polyhedra faces;
//   (g) the ray tracer still draws the polyhedra.
'use strict';
const fs = require('fs');
const H = require('../harness');
const { PNG } = require(`${__dirname}/../env/node_modules/pngjs`);

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

    // --- (a) programs: YBCO, then 3×3×3 ------------------------------------
    const programs = await page.evaluate(async () => {
      const { app, general } = await import('./state/store.js');
      const P = await import('./render/PolyhedraModule.js');
      const { renderFrameNow } = await import('./render/index.js');
      const { createSupercell } = await import('./ui/SuperCellModule.js');
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));
      renderFrameNow(); renderFrameNow();
      const p0 = app.renderer.info.programs.length;
      general.showPolyhedra = true;
      await P.updatePolyhedra();
      renderFrameNow(); renderFrameNow();
      const n1 = P.polyhedraDrawnCount();
      const p1 = app.renderer.info.programs.length;
      general.showPolyhedra = false;
      await P.updatePolyhedra();
      createSupercell(3, 3, 3);
      await settle(1500);
      renderFrameNow(); renderFrameNow();
      const p2 = app.renderer.info.programs.length;
      general.showPolyhedra = true;
      await P.updatePolyhedra();
      renderFrameNow(); renderFrameNow();
      const n3 = P.polyhedraDrawnCount();
      const p3 = app.renderer.info.programs.length;
      return { n1, n3, delta1: p1 - p0, delta3: p3 - p2, p0, p1, p2, p3 };
    });
    H.check('(a) shader programs added by polyhedra do not scale with their count',
      programs.n1 > 0 && programs.n3 > 5 * programs.n1 && programs.delta1 <= 8 && programs.delta3 <= programs.delta1,
      JSON.stringify(programs));

    // --- (b) draw calls with 300+ polyhedra ----------------------------------
    const calls = await page.evaluate(async () => {
      const { app, general } = await import('./state/store.js');
      const P = await import('./render/PolyhedraModule.js');
      const { renderFrameNow } = await import('./render/index.js');
      const { createSupercell } = await import('./ui/SuperCellModule.js');
      general.showPolyhedra = false;
      await P.updatePolyhedra();
      createSupercell(4, 4, 4);
      await new Promise((r) => setTimeout(r, 1500));
      general.showPolyhedra = true;
      await P.updatePolyhedra();
      const info = app.renderer.info;
      renderFrameNow();
      info.autoReset = false;
      info.reset();
      renderFrameNow();
      const n = info.render.calls;
      info.autoReset = true;
      return { calls: n, polys: P.polyhedraDrawnCount(), pipeline: app.pipeline?.constructor?.name };
    });
    H.check('(b) draw calls per frame stay small with 300+ polyhedra (depthpeel)',
      calls.polys >= 300 && calls.calls < 60 && /DepthPeel/.test(calls.pipeline), JSON.stringify(calls));

    // back to the plain YBCO cell for the remaining checks
    await page.evaluate(async () => {
      const { createSupercell } = await import('./ui/SuperCellModule.js');
      const P = await import('./render/PolyhedraModule.js');
      createSupercell(1, 1, 1);
      await new Promise((r) => setTimeout(r, 1500));
      await P.updatePolyhedra();
    });
    await page.waitForTimeout(800);

    // --- (c) a double-click picks the right polyhedron ----------------------
    // Opaque polyhedra (alpha 1) occlude what is inside, so a click on a face
    // selects the polyhedron, never the centre atom.
    const target = await page.evaluate(async () => {
      const THREE = await import('./external/three/three.module.js');
      const { app, fileBrowser } = await import('./state/store.js');
      const { updatePolyhedraColors, polyhedraTable } = await import('./render/index.js');
      const { pickScene } = await import('./render/pickVisible.js');
      const s = fileBrowser.selectedStructure;
      s.polyhedraCategoryStyles ??= {};
      const table = polyhedraTable();
      for (const catKey of new Set(table.catKey)) s.polyhedraCategoryStyles[catKey] = { ...(s.polyhedraCategoryStyles[catKey] ?? {}), alpha: 1 };
      updatePolyhedraColors();
      const rect = app.renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      for (let i = 0; i < table.n; i++) {
        if (!table.faceCount[i]) continue;
        const c = new THREE.Vector3(table.center[3 * i], table.center[3 * i + 1], table.center[3 * i + 2]).project(app.camera);
        if (Math.abs(c.x) > 0.8 || Math.abs(c.y) > 0.8) continue;
        ray.setFromCamera(new THREE.Vector2(c.x, c.y), app.camera);
        const picked = pickScene(ray);
        if (picked?.kind !== 'polyhedron') continue;
        const x = rect.left + (c.x + 1) / 2 * rect.width, y = rect.top + (1 - c.y) / 2 * rect.height;
        if (document.elementFromPoint(x, y) !== app.renderer.domElement) continue;
        const j = picked.hit.polyIndex;
        return { x, y, polyIndex: j, modelKey: s.polyhedra.polyhedra[j].key };
      }
      return null;
    });
    H.check('(c) found a polyhedron under the cursor', !!target, JSON.stringify(target));
    if (target) {
      await page.mouse.dblclick(target.x, target.y);
      await page.waitForTimeout(500);
      const sel = await page.evaluate(async () => {
        const { highlightHover } = await import('./state/store.js');
        const { polyhedraInfo } = await import('./render/index.js');
        const { getDirectSelection } = await import('./ui/SelectAndHighlightModule.js');
        return { keys: getDirectSelection().polyKeys,
          glowing: polyhedraInfo().filter((p) => p.glow).map((p) => p.key) };
      });
      // With "Link periodic copies" (default) a pick selects the polyhedron's
      // group of copies; the picked one must be among them and glow.
      H.check('(c) the double-click selects that polyhedron (its key = the model\'s) and it glows',
        sel.keys.includes(target.modelKey) && sel.glowing.includes(target.modelKey)
          && sel.glowing.length === sel.keys.length, JSON.stringify({ sel, target }));
      await page.evaluate(async () => (await import('./ui/SelectAndHighlightModule.js')).clearAllHighlights({ reason: 'test' }));
    }

    // --- (d) one colour edit touches only its range -------------------------
    const ranged = await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      const { updatePolyhedraColors, polyhedraTable } = await import('./render/index.js');
      const s = fileBrowser.selectedStructure;
      const table = polyhedraTable();
      const color = table.faceGeometry.getAttribute('color');
      const before = color.array.slice();
      const i = table.faceCount.findIndex((c) => c > 0);
      s.polyhedraUserStyles[table.key[i]] = { ...(s.polyhedraUserStyles[table.key[i]] ?? {}), color: '#ff00ff' };
      updatePolyhedraColors();
      const lo = table.faceStart[i] * 12, hi = (table.faceStart[i] + table.faceCount[i]) * 12;
      let inside = 0, outside = 0;
      for (let k = 0; k < before.length; k++) {
        if (before[k] === color.array[k]) continue;
        if (k >= lo && k < hi) inside++; else outside++;
      }
      const magenta = color.array[lo] > 0.99 && color.array[lo + 1] < 0.01 && color.array[lo + 2] > 0.99;
      delete s.polyhedraUserStyles[table.key[i]].color;
      updatePolyhedraColors();
      return { inside, outside, magenta };
    });
    H.check('(d) a single polyhedron colour edit changes only its vertex range',
      ranged.inside > 0 && ranged.outside === 0 && ranged.magenta, JSON.stringify(ranged));

    // --- (e) focus-region opacity and category show/hide --------------------
    const focus = await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      const F = await import('./render/FocusRegionModule.js');
      const { polyhedraTable } = await import('./render/index.js');
      const s = fileBrowser.selectedStructure;
      const w = s.periodic.visibleWrapped;
      const region = F.createFocusRegion([{ sourceIndex: w.srcIndex[0], element: w.elements[0], position: w.cart[0] }]);
      region.innerRadius = 0.1;
      region.outerOpacity = 0.1;
      region.gradientEnabled = false;
      F.applyFocusRegions();
      const table = polyhedraTable();
      const color = table.faceGeometry.getAttribute('color');
      const rows = [...Array(table.n).keys()].filter((i) => table.faceCount[i]);
      const dimmed = rows.filter((i) => table.opacity[i] <= table.baseOpacity[i] * 0.1001
        && Math.abs(color.array[table.faceStart[i] * 12 + 3] - table.opacity[i]) < 1e-6);
      const transparentShown = table.objects.faceT.visible;
      F.clearFocusRegions(s);
      F.applyFocusRegions();
      const restored = rows.every((i) => Math.abs(table.opacity[i] - table.baseOpacity[i]) < 1e-6);
      return { rows: rows.length, dimmed: dimmed.length, transparentShown, restored };
    });
    H.check('(e) focus regions scale polyhedron alpha per vertex range, and restore it',
      focus.dimmed > 0 && focus.transparentShown && focus.restored, JSON.stringify(focus));

    const shown = await H.shotCanvas(page, 'polymesh-shown');
    const hide = await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      const { updatePolyhedraColors, polyhedraTable, renderFrameNow } = await import('./render/index.js');
      const s = fileBrowser.selectedStructure;
      const table = polyhedraTable();
      const state = table.faceGeometry.getAttribute('polyState');
      const cats = [...new Set(table.catKey)];
      for (const c of cats) s.polyhedraCategoryStyles[c] = { ...(s.polyhedraCategoryStyles[c] ?? {}), visible: false };
      updatePolyhedraColors();
      renderFrameNow();
      const rows = [...Array(table.n).keys()].filter((i) => table.faceCount[i]);
      const hiddenBits = rows.every((i) => (state.array[table.faceStart[i] * 3] & 2) === 2);
      return { cats: cats.length, hiddenBits, faceO: table.objects.faceO.visible, faceT: table.objects.faceT.visible };
    });
    await page.waitForTimeout(400);
    const hidden = await H.shotCanvas(page, 'polymesh-hidden');
    const hideDelta = changedPixelCount(shown, hidden);
    await page.evaluate(async () => {
      const { fileBrowser } = await import('./state/store.js');
      const { updatePolyhedraColors } = await import('./render/index.js');
      const s = fileBrowser.selectedStructure;
      for (const c of Object.keys(s.polyhedraCategoryStyles)) s.polyhedraCategoryStyles[c].visible = true;
      updatePolyhedraColors();
    });
    H.check('(e) hiding the categories hides their polyhedra (state bits, meshes, pixels)',
      hide.hiddenBits && !hide.faceO && !hide.faceT && hideDelta > 500, JSON.stringify({ ...hide, hideDelta }));

    // --- (f) SVG export -------------------------------------------------------
    const svg = await page.evaluate(async () => {
      const { captureSceneToSvg } = await import('./render/SvgExportModule.js');
      const { polyhedraTable } = await import('./render/index.js');
      const text = await (await captureSceneToSvg({ width: 640, height: 480, structure: 'vector' })).text();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const table = polyhedraTable();
      let tris = 0;
      for (let i = 0; i < table.n; i++) if (table.visible[i]) tris += table.faceCount[i];
      return { polygons: doc.querySelectorAll('polygon').length, tris };
    });
    H.check('(f) the vector SVG export draws the polyhedra faces',
      svg.polygons > 0 && svg.tris > 0, JSON.stringify(svg));

    // --- (g) ray tracer -------------------------------------------------------
    await page.evaluate(async () => {
      const { general } = await import('./state/store.js');
      general.rtResolutionScale = 0.25;
      general.rtRasterPreview = false;
    });
    await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
    await H.waitFor(page, async () => (await import('./state/store.js')).app.pipeline?._shaderState === 'ready',
      { timeout: 300000, interval: 2000 });
    const setAll = (visible) => page.evaluate(async (visible) => {
      const { app, groups } = await import('./state/store.js');
      const { requestRender } = await import('./render/index.js');
      const { uploadPolyStyles } = await import('./render/PolyhedraMesh.js');
      const table = groups.polyhedraGroup.userData.polyTable;
      table.visible.fill(visible ? 1 : 0);
      uploadPolyStyles(table);
      app.pipeline._encoder.encode();
      requestRender();
      return app.pipeline._encoder.polyCount;
    }, visible);
    const encodedOn = await setAll(true);
    await page.waitForTimeout(4000);
    const rtOn = await H.shotCanvas(page, 'polymesh-rt-on');
    const encodedOff = await setAll(false);
    await page.waitForTimeout(4000);
    const rtOff = await H.shotCanvas(page, 'polymesh-rt-off');
    await setAll(true);
    const rtDelta = changedPixelCount(rtOn, rtOff);
    H.check('(g) the ray tracer encodes and draws the polyhedra',
      encodedOn > 0 && encodedOff === 0 && rtDelta > 800, JSON.stringify({ encodedOn, encodedOff, rtDelta }));
    await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  } catch (err) {
    H.check('test ran without throwing', false, String(err?.stack ?? err));
  }
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
