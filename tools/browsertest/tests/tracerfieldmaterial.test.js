// Tracer material for the volumetric field isosurface. A synthetic Gaussian
// blob field is attached to the default structure and driven through the REAL
// field path (setActiveField + updateField). The per-structure
// `structure.fieldMaterial` drives the ray/path-traced field surface (all
// tracer material types EXCEPT glass) — encoded by SceneEncoder into the
// uFieldMaterial texel and consumed by fieldChunk / scene shaders. Asserts:
//   (1) metal material re-encodes the texel + visibly changes the traced image;
//   (2) emissive sets hasEmissive but is NOT NEE-listed (no _emissiveList
//       entry) and disables path-tracer shadow-any-hit;
//   (3) a field-material edit routes through the TRACER-MATERIAL fingerprint
//       (lastChangeWasCoreScene === false) and restarts the accumulation;
//   (4) the Field window hosts a glass-free MaterialEditor, hidden under raster
//       and shown under a tracer;
//   (5) the material persists through captureState/applySharedState at v2.12;
//   (6) the default field-material texel is [0,0,0.6,-1] (DEFAULT_MATERIAL_TEXEL).
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

const CONVERGED = 56; // pixel shots are taken at convergence (Monte-Carlo averages)

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  async function waitForSamples(n, timeout = 90000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const s = await page.evaluate(async () => {
        const { app } = await import('./state/store.js');
        return app.pipeline?._uniforms?.uSampleCounter?.value ?? 0;
      });
      if (s >= n || Date.now() > deadline) return s;
      await page.waitForTimeout(1200);
    }
  }

  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.rtResolutionScale = 0.25; // software-GL speed
    general.rtRasterPreview = false; // trace every frame (no depth-peel preview)
  });

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
    return { maxV, posVerts: iso?.meshes?.positive?.geometry?.attributes?.position?.count ?? 0,
      inScene: !!iso?.parent, activeField: !!groups.activeField };
  });
  H.check('marching cubes produced an isosurface mesh for the blob',
    fieldInfo.posVerts > 0 && fieldInfo.inScene && fieldInfo.activeField && fieldInfo.maxV > 0.9,
    JSON.stringify(fieldInfo));

  // --- (6) Default parity: field material texel = DEFAULT_MATERIAL_TEXEL -----------
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await waitForSamples(CONVERGED);
  const defState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const u = app.pipeline?._uniforms;
    return {
      enabled: app.pipeline?._encoder?.fieldEnabled,
      texel: app.pipeline?._encoder?.fieldMaterialTexel,
      uMat: u?.uFieldMaterial?.value?.toArray?.(),
    };
  });
  H.check('default field material texel is [0,0,0.6,-1] and the uniform matches',
    defState.enabled === true
      && JSON.stringify(defState.texel) === JSON.stringify([0, 0, 0.6, -1])
      && JSON.stringify(defState.uMat) === JSON.stringify([0, 0, 0.6, -1]),
    JSON.stringify(defState));
  const stdShot = await H.shotCanvas(page, 'fieldmat-standard');

  // --- (3) Fingerprint routing + accumulation restart on a field-material edit -----
  // Modelled on tracerpreview: an atomic evaluate renders twice, zeroes the
  // interaction clock, sets the field material, renders one INTERACTIVE frame
  // and reads the routing flags — a tracer-only look edit must not trip the
  // raster preview and must record lastChangeWasCoreScene === false.
  const routing = await page.evaluate(async () => {
    const { app, fileBrowser } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    p.render(ctx); p.render(ctx);
    const samplesBefore = p._uniforms.uSampleCounter.value;
    p._lastInteractionAt = 0;
    fileBrowser.selectedStructure.fieldMaterial = { type: 'metal', roughness: 0.1 };
    p.render({ ...ctx, interactive: true });
    return {
      previewActive: p._previewActive,
      lastCore: p._encoder.lastChangeWasCoreScene,
      samplesBefore, samplesAfter: p._uniforms.uSampleCounter.value,
    };
  });
  H.check('a field-material edit routes through the tracer-material fingerprint (no preview) and restarts accumulation',
    routing.previewActive === false && routing.lastCore === false
      && routing.samplesBefore > 1 && routing.samplesAfter < routing.samplesBefore,
    JSON.stringify(routing));

  // --- (1) Metal: texel re-encoded + traced image visibly changes ------------------
  await page.evaluate(async () => {
    const { requestRender } = await import('./render/index.js');
    requestRender();
  });
  await waitForSamples(CONVERGED);
  const metalState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const t = app.pipeline?._encoder?.fieldMaterialTexel;
    const u = app.pipeline?._uniforms?.uFieldMaterial?.value?.toArray?.();
    const approx = (arr, want) => arr && arr.length === 4
      && arr.every((v, i) => Math.abs(v - want[i]) < 1e-6);
    return { texel: t, uMat: u, ok: approx(t, [1, 0.1, 0, -1]) && approx(u, [1, 0.1, 0, -1]) };
  });
  H.check('metal field material encodes texel [1,0.1,0,-1] into uFieldMaterial',
    metalState.ok, JSON.stringify(metalState));
  const metalShot = await H.shotCanvas(page, 'fieldmat-metal');
  const metalDelta = changedPixelCount(stdShot, metalShot);
  H.check('metal field material visibly changes the traced field surface',
    metalDelta > 250, JSON.stringify({ metalDelta }));

  // --- (2) Emissive: hasEmissive but NOT NEE-listed (no _emissiveList entry) --------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    fileBrowser.selectedStructure.fieldMaterial = { type: 'emissive', intensity: 14 };
    requestRender();
  });
  await waitForSamples(CONVERGED);
  const emiState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const enc = app.pipeline?._encoder;
    return {
      texel: enc?.fieldMaterialTexel,
      hasEmissive: enc?.hasEmissive,
      emissiveCount: enc?.emissiveCount,
      emissiveListLen: enc?._emissiveList?.length,
    };
  });
  H.check('emissive field sets hasEmissive but is not added to the NEE emissive list',
    emiState.hasEmissive === true && emiState.emissiveCount === 0
      && emiState.emissiveListLen === 0
      && emiState.texel?.[0] === 3 && emiState.texel?.[3] === 0, // texel = [3,0,intensity,0]
    JSON.stringify(emiState));
  const emiShot = await H.shotCanvas(page, 'fieldmat-emissive');
  const emiDelta = changedPixelCount(stdShot, emiShot);
  H.check('emissive field material visibly brightens/changes the traced image',
    emiDelta > 250, JSON.stringify({ emiDelta }));

  // --- (2b) Path tracer: emissive field disables shadow-any-hit --------------------
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  {
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
  const ptState = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return { id: p?.id, hasEmissive: p?._encoder?.hasEmissive,
      shadowAnyHit: p?._uniforms?.uShadowAnyHit?.value,
      listLen: p?._encoder?._emissiveList?.length };
  });
  H.check('pathtrace: emissive field keeps shadow-any-hit off, still not NEE-listed',
    ptState.id === 'pathtrace' && ptState.hasEmissive === true
      && ptState.shadowAnyHit === false && ptState.listLen === 0,
    JSON.stringify(ptState));

  // --- (4) GUI: glass-free MaterialEditor in the Field window, raster-gated ---------
  const gui = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { Field, FieldContainer } = await import('./model/index.js');
    const { addFieldPanel, fieldBrowser } = await import('./ui/FieldPanel.js');
    const structure = fileBrowser.selectedStructure;
    // Attach a volumetricFields container (the source addFieldPanel reads) so the
    // Field window can be populated exactly as a CHGCAR/cube load would.
    const lat = structure.lattice;
    const nx = 8, ny = 8, nz = 8;
    const values = new Float32Array(nx * ny * nz).fill(0.5);
    const voxel = [
      [lat[0][0] / nx, lat[0][1] / nx, lat[0][2] / nx],
      [lat[1][0] / ny, lat[1][1] / ny, lat[1][2] / ny],
      [lat[2][0] / nz, lat[2][1] / nz, lat[2][2] / nz],
    ];
    const field = new Field({ nx, ny, nz, origin: [0, 0, 0], voxel, values,
      label: 'test', isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false });
    structure.volumetricFields = new FieldContainer({
      fileName: 'test', source: 'Cube', fields: [field], fieldCount: 1 });
    fieldBrowser.setAvailableFields([field]);
    fieldBrowser.setSelectedField(0);
    // Ensure a panel-body container exists, then build the Field panel into it.
    let body = document.getElementById('cvPanelBody-field');
    if (!body) {
      body = document.createElement('div');
      body.id = 'cvPanelBody-field';
      document.body.appendChild(body);
    }
    addFieldPanel('cvPanelBody-field');
    const editor = body.querySelector('.material-editor');
    const select = editor?.querySelector('.material-type-select');
    const options = select ? Array.from(select.options).map((o) => o.value) : [];
    const isoSlider = body.querySelector('#isoSlider');
    return {
      hasEditor: !!editor,
      nextToIsoSlider: !!isoSlider && !!editor,
      optionCount: options.length,
      hasGlass: options.includes('glass'),
      options,
    };
  });
  H.check('Field window hosts a glass-free MaterialEditor next to the iso slider',
    gui.hasEditor && gui.nextToIsoSlider && gui.optionCount === 4 && gui.hasGlass === false,
    JSON.stringify(gui));

  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(400);
  const rasterVis = await page.evaluate(() => {
    const ed = document.querySelector('#cvPanelBody-field .material-editor');
    return { hidden: ed ? getComputedStyle(ed).display === 'none' : null,
      tracerClass: document.body.classList.contains('tracer-pipeline') };
  });
  await H.setSelect(page, 'renderPipelineMenu', 'raytrace');
  await page.waitForTimeout(400);
  const tracerVis = await page.evaluate(() => {
    const ed = document.querySelector('#cvPanelBody-field .material-editor');
    return { visible: ed ? getComputedStyle(ed).display !== 'none' : null,
      tracerClass: document.body.classList.contains('tracer-pipeline') };
  });
  H.check('field MaterialEditor is hidden under raster and shown under a tracer',
    rasterVis.hidden === true && rasterVis.tracerClass === false
      && tracerVis.visible === true && tracerVis.tracerClass === true,
    JSON.stringify({ rasterVis, tracerVis }));

  // --- (4b) Live iso-slider updates: dragging rebuilds the surface (no 'change') ---
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(400);
  const liveDrag = await page.evaluate(async () => {
    const { groups, fileBrowser } = await import('./state/store.js');
    const { Field, FieldContainer } = await import('./model/index.js');
    const { addFieldPanel, fieldBrowser } = await import('./ui/FieldPanel.js');
    const { setActiveField, updateField } = await import('./render/index.js');
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const verts = () => groups.isosurfaceGroup?.meshes?.positive?.geometry?.attributes?.position?.count ?? 0;
    // Self-contained baseline: the GUI section's field is a CONSTANT (no
    // isosurface at any level), so build a Gaussian blob field, select it, and
    // REBUILD the panel so #isoSlider's handlers are bound to it.
    const structure = fileBrowser.selectedStructure;
    const lat = structure.lattice;
    const nx = 16, ny = 16, nz = 16;
    const values = new Float32Array(nx * ny * nz);
    const c = (nx - 1) / 2, sigma = 3.5;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const d2 = (i - c) ** 2 + (j - c) ** 2 + (k - c) ** 2;
          values[i + nx * (j + ny * k)] = Math.exp(-d2 / (2 * sigma * sigma));
        }
    const voxel = [
      [lat[0][0] / nx, lat[0][1] / nx, lat[0][2] / nx],
      [lat[1][0] / ny, lat[1][1] / ny, lat[1][2] / ny],
      [lat[2][0] / nz, lat[2][1] / nz, lat[2][2] / nz],
    ];
    const blob = new Field({ nx, ny, nz, origin: [0, 0, 0], voxel, values,
      label: 'liveblob', isoValue: 0.5, minValue: 0, maxValue: 1, useAbsoluteIsoValue: false });
    blob.isVisible = true;
    structure.volumetricFields = new FieldContainer({
      fileName: 'liveblob', source: 'Cube', fields: [blob], fieldCount: 1 });
    fieldBrowser.setAvailableFields([blob]);
    fieldBrowser.setSelectedField(0);
    addFieldPanel('cvPanelBody-field'); // rebuild so the slider drives THIS field
    const slider = /** @type {HTMLInputElement} */ (document.querySelector('#cvPanelBody-field #isoSlider'));
    setActiveField(blob, false);
    updateField(0.5);
    blob.isoValue = 0.5;
    await nextFrame();
    const before = { verts: verts(), iso: fieldBrowser.selectedField?.isoValue };
    // Rapid drag: three 'input' events, NO 'change'. The coalesced RAF handler
    // must rebuild at the LATEST value only.
    for (const v of ['70', '60', '30']) {
      slider.value = v;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextFrame();
    await nextFrame();
    const after = { verts: verts(), iso: fieldBrowser.selectedField?.isoValue };
    const readout = document.querySelector('#cvPanelBody-field #isoValue')?.textContent;
    // Release: 'change' at the same value must not error (skip-if-built path).
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await nextFrame();
    return { before, after, readout, finalVerts: verts(),
      structureOk: !!fileBrowser.selectedStructure?.volumetricFields };
  });
  H.check('dragging the iso slider live-rebuilds the isosurface without a change event',
    liveDrag.structureOk && liveDrag.after.verts > 0
      && liveDrag.after.verts !== liveDrag.before.verts
      && liveDrag.after.iso !== liveDrag.before.iso,
    JSON.stringify(liveDrag));
  H.check('live rebuild lands on the LATEST drag value and release is a no-op re-build',
    liveDrag.readout === liveDrag.after.iso?.toExponential(3)
      && liveDrag.finalVerts === liveDrag.after.verts,
    JSON.stringify({ readout: liveDrag.readout, iso: liveDrag.after.iso, finalVerts: liveDrag.finalVerts }));

  // --- (5) Persistence: fieldMaterial round-trips through capture/apply at 2.12 -----
  const persist = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { captureState, applySharedState } = await import('./ui/ShareModule.js');
    fileBrowser.selectedStructure.fieldMaterial = { type: 'metal', roughness: 0.3 };
    const state = captureState();
    const captured = state.colors?.fieldMaterial;
    applySharedState(JSON.parse(JSON.stringify(state)), 'roundtrip.vasp');
    const restored = fileBrowser.selectedStructure?.fieldMaterial;
    return { version: state.version, captured, restored };
  });
  H.check('captureState/applySharedState round-trips fieldMaterial at v2.12',
    persist.version === '2.12'
      && persist.captured?.type === 'metal' && Math.abs(persist.captured?.roughness - 0.3) < 1e-9
      && persist.restored?.type === 'metal' && Math.abs(persist.restored?.roughness - 0.3) < 1e-9,
    JSON.stringify(persist));

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
