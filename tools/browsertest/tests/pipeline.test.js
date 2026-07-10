// Rendering-pipeline API: the app boots on the forward pipeline, transparency
// intents route through pipeline.applyTransparency (stamped as
// material.userData.transparencySpec), the GUI dropdown lists the registry,
// switching pipelines re-applies policy over the live scene without touching
// the flags, and the pipeline id round-trips through captureState.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  // --- Bootstrap: forward pipeline active, dropdown built from the registry ------
  const boot = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const { getActivePipeline, listPipelines } = await import('./render/index.js');
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    return {
      activeId: getActivePipeline()?.id,
      appPipelineMatches: app.pipeline === getActivePipeline(),
      generalId: general.renderPipeline,
      registry: listPipelines(),
      menuOptions: select ? [...select.options].map((o) => o.value) : null,
      menuValue: select?.value,
    };
  });
  H.check('depthpeel pipeline active after boot (app.pipeline + general in sync)',
    boot.activeId === 'depthpeel' && boot.appPipelineMatches && boot.generalId === 'depthpeel',
    JSON.stringify(boot));
  H.check('rendering-pipeline dropdown lists the registry',
    Array.isArray(boot.menuOptions) && boot.menuOptions.join(',') === boot.registry.map((p) => p.id).join(',')
      && boot.menuValue === 'depthpeel',
    JSON.stringify({ menu: boot.menuOptions, registry: boot.registry }));
  // --- Opaque-scene fast path (default depthpeel renders like forward) -----------
  const fastPath = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    app.pipeline.render(ctx);
    const opaque = app.pipeline._pass?.lastFrameFastPath;
    general.mainOpacity = 0.5; // transparency appears -> peeling engages next frame
    updateVisualization({ atomsUpdate: true, bondsUpdate: true });
    app.pipeline.render(ctx);
    const transp = app.pipeline._pass?.lastFrameFastPath;
    general.mainOpacity = 1.0;
    updateVisualization({ atomsUpdate: true, bondsUpdate: true });
    requestRender();
    return { opaque, transp };
  });
  H.check('depthpeel fast path: plain single pass when nothing is transparent',
    fastPath.opaque === true && fastPath.transp === false, JSON.stringify(fastPath));

  H.check('registry holds the seven pipelines',
    boot.registry.map((p) => p.id).join(',') === 'forward,split-atoms,sorted-atoms,wboit,depthpeel,raytrace,pathtrace',
    JSON.stringify(boot.registry));

  // --- Depth-peel "Peel layers" slider follows the dropdown ----------------------
  const slider = await page.evaluate(() => {
    const block = document.getElementById('depthPeelLayersSlider')?.parentElement;
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    // Boot default is depthpeel now — establish the forward baseline explicitly.
    select.value = 'forward';
    select.dispatchEvent(new Event('change'));
    const hiddenUnderForward = block ? getComputedStyle(block).display === 'none' : null;
    select.value = 'depthpeel';
    select.dispatchEvent(new Event('change'));
    const shownUnderDepthPeel = getComputedStyle(block).display !== 'none';
    select.value = 'forward';
    select.dispatchEvent(new Event('change'));
    const hiddenAgain = getComputedStyle(block).display === 'none';
    return { hiddenUnderForward, shownUnderDepthPeel, hiddenAgain };
  });
  H.check('peel-layers slider only shows for the depthpeel pipeline',
    slider.hiddenUnderForward === true && slider.shownUnderDepthPeel && slider.hiddenAgain,
    JSON.stringify(slider));

  // --- Ray-tracing sliders follow the dropdown the same way ----------------------
  const rtSliders = await page.evaluate(() => {
    const block = document.getElementById('rtResolutionScale')?.parentElement?.parentElement;
    const hasBoth = !!document.getElementById('rtResolutionScale') && !!document.getElementById('rtReflectivity');
    const hiddenUnderForward = block ? getComputedStyle(block).display === 'none' : null;
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    select.value = 'raytrace';
    select.dispatchEvent(new Event('change'));
    const shownUnderRaytrace = getComputedStyle(block).display !== 'none';
    select.value = 'forward';
    select.dispatchEvent(new Event('change'));
    const hiddenAgain = getComputedStyle(block).display === 'none';
    return { hasBoth, hiddenUnderForward, shownUnderRaytrace, hiddenAgain };
  });
  H.check('RT sliders only show for the raytrace pipeline',
    rtSliders.hasBoth && rtSliders.hiddenUnderForward === true
      && rtSliders.shownUnderRaytrace && rtSliders.hiddenAgain,
    JSON.stringify(rtSliders));

  // --- Path-tracing controls: shared tracer block + Advanced section ----------------
  // Light softness/DoF/ground live directly in the SHARED tracer block (both
  // tracers); the tiled/preview/denoiser toggles live in a collapsible
  // "Advanced" section inside that block (collapsed by default). Only the
  // Denoiser ROW stays pathtrace-only (row-level display, not a separate block).
  const ptControls = await page.evaluate(() => {
    const rtBlock = document.getElementById('rtResolutionScale')?.parentElement?.parentElement;
    const advanced = document.getElementById('ptDenoiseToggle')?.closest('details.eos-collapsible');
    const denoiseRow = document.getElementById('ptDenoiseToggle')?.closest('.control-row');
    const softnessInRtBlock = document.getElementById('ptLightSoftness')?.parentElement?.parentElement === rtBlock;
    const dofInRtBlock = document.getElementById('rtDofAperture')?.parentElement?.parentElement === rtBlock
      && document.getElementById('rtDofFocus')?.parentElement?.parentElement === rtBlock
      && document.getElementById('rtGroundToggle')?.parentElement?.parentElement === rtBlock;
    // Advanced section: exists inside the shared tracer block, collapsed by default.
    const advancedExists = !!advanced && rtBlock?.contains(advanced) === true;
    const advancedCollapsedByDefault = advanced?.open === false;
    const tiledInAdvanced = advanced?.contains(document.getElementById('rtTiledToggle')) === true;
    const previewInAdvanced = advanced?.contains(document.getElementById('rtPreviewToggle')) === true;
    const denoiseInAdvanced = advanced?.contains(document.getElementById('ptDenoiseToggle')) === true;
    const tiledDefaultChecked = /** @type {HTMLInputElement} */ (
      document.getElementById('rtTiledToggle'))?.checked === true;
    const previewDefaultChecked = /** @type {HTMLInputElement} */ (
      document.getElementById('rtPreviewToggle'))?.checked === true;
    // Expand the section so computed-visibility checks below see the rows.
    if (advanced) advanced.open = true;
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    select.value = 'pathtrace';
    select.dispatchEvent(new Event('change'));
    const rtSharedUnderPathtrace = getComputedStyle(rtBlock).display !== 'none';
    const denoiseShownUnderPathtrace = getComputedStyle(denoiseRow).display !== 'none';
    select.value = 'raytrace';
    select.dispatchEvent(new Event('change'));
    const denoiseHiddenUnderRaytrace = getComputedStyle(denoiseRow).display === 'none';
    const sharedShownUnderRaytrace = getComputedStyle(rtBlock).display !== 'none';
    select.value = 'forward';
    select.dispatchEvent(new Event('change'));
    const allHiddenUnderForward = getComputedStyle(rtBlock).display === 'none';
    return { softnessInRtBlock, dofInRtBlock, advancedExists, advancedCollapsedByDefault,
      tiledInAdvanced, previewInAdvanced, denoiseInAdvanced, tiledDefaultChecked, previewDefaultChecked,
      rtSharedUnderPathtrace, denoiseShownUnderPathtrace,
      denoiseHiddenUnderRaytrace, sharedShownUnderRaytrace, allHiddenUnderForward };
  });
  H.check('shared tracer controls (softness/DoF/ground) show for both tracers; PT-only denoiser ROW follows the dropdown',
    ptControls.softnessInRtBlock && ptControls.dofInRtBlock && ptControls.rtSharedUnderPathtrace
      && ptControls.denoiseShownUnderPathtrace && ptControls.denoiseHiddenUnderRaytrace
      && ptControls.sharedShownUnderRaytrace && ptControls.allHiddenUnderForward,
    JSON.stringify(ptControls));
  H.check('Advanced section exists in the shared tracer block, collapsed by default, holds tiled/preview/denoiser',
    ptControls.advancedExists && ptControls.advancedCollapsedByDefault
      && ptControls.tiledInAdvanced && ptControls.previewInAdvanced && ptControls.denoiseInAdvanced,
    JSON.stringify(ptControls));
  H.check('Tiled-rendering toggle defaults ON', ptControls.tiledDefaultChecked, JSON.stringify(ptControls));
  H.check('Interactive raster preview toggle defaults ON', ptControls.previewDefaultChecked, JSON.stringify(ptControls));

  // --- Dependency tree: Render Style (and cel outlines) only for raster pipelines --
  const styleTree = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const styleRow = document.getElementById('renderStyleMenu')?.closest('.control-row');
    const outlineBlock = document.getElementById('celOutlineModeMenu')?.closest('.control-row')?.parentElement;
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    const styleSelect = /** @type {HTMLSelectElement} */ (document.getElementById('renderStyleMenu'));
    const shownUnderForward = getComputedStyle(styleRow).display !== 'none';
    styleSelect.value = 'cel';
    styleSelect.dispatchEvent(new Event('change'));
    const outlineShownForwardCel = getComputedStyle(outlineBlock).display !== 'none';
    select.value = 'raytrace';
    select.dispatchEvent(new Event('change'));
    const hiddenUnderRaytrace = getComputedStyle(styleRow).display === 'none';
    const outlineHiddenUnderRaytrace = getComputedStyle(outlineBlock).display === 'none';
    select.value = 'forward';
    select.dispatchEvent(new Event('change'));
    const outlineBackUnderForward = getComputedStyle(outlineBlock).display !== 'none';
    styleSelect.value = 'metallic';
    styleSelect.dispatchEvent(new Event('change'));
    const pipelineFirst = document.getElementById('renderPipelineMenu').closest('.control-row')
      .compareDocumentPosition(styleRow) & Node.DOCUMENT_POSITION_FOLLOWING;
    return { generalStyle: general.renderStyle, shownUnderForward, outlineShownForwardCel,
      hiddenUnderRaytrace, outlineHiddenUnderRaytrace, outlineBackUnderForward, pipelineFirst: !!pipelineFirst };
  });
  H.check('Render Style + cel outlines only show for raster pipelines; pipeline row first',
    styleTree.shownUnderForward && styleTree.outlineShownForwardCel
      && styleTree.hiddenUnderRaytrace && styleTree.outlineHiddenUnderRaytrace
      && styleTree.outlineBackUnderForward && styleTree.pipelineFirst,
    JSON.stringify(styleTree));

  // --- "Reset rendering settings" button ------------------------------------------
  const reset = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    // scramble a representative spread of rendering settings
    const pipeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('renderPipelineMenu'));
    pipeSelect.value = 'raytrace';
    pipeSelect.dispatchEvent(new Event('change'));
    general.rtReflectivity = 0.9;
    general.rtAmbient = 0.9;
    general.rtGroundPlane = true;
    general.rtTiledRender = false;
    general.rtRasterPreview = false;
    general.depthPeelLayers = 9;
    general.celHullWidth = 0.1;
    document.getElementById('resetRenderingBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    const styleRow = document.getElementById('renderStyleMenu')?.closest('.control-row');
    const previewToggle = /** @type {HTMLInputElement} */ (document.getElementById('rtPreviewToggle'));
    return {
      pipeline: general.renderPipeline,
      style: general.renderStyle,
      reflectivity: general.rtReflectivity,
      ambient: general.rtAmbient,
      ground: general.rtGroundPlane,
      tiled: general.rtTiledRender,
      preview: general.rtRasterPreview,
      previewToggleChecked: previewToggle?.checked === true,
      peel: general.depthPeelLayers,
      hull: general.celHullWidth,
      menuValue: pipeSelect.value,
      styleRowVisible: getComputedStyle(styleRow).display !== 'none',
    };
  });
  H.check('Reset rendering settings restores every default (pipeline back to depthpeel)',
    reset.pipeline === 'depthpeel' && reset.style === 'metallic'
      && Math.abs(reset.reflectivity - 0.15) < 1e-9 && Math.abs(reset.ambient - 0.3) < 1e-9
      && reset.ground === false && reset.tiled === true && reset.peel === 5
      && reset.preview === true && reset.previewToggleChecked
      && Math.abs(reset.hull - 0.025) < 1e-9
      && reset.menuValue === 'depthpeel' && reset.styleRowVisible,
    JSON.stringify(reset));
  H.check('pipeline dropdown lives in the Visual window', await page.evaluate(() =>
    !!document.getElementById('renderPipelineMenu')?.closest('#cvPanelBody-visual')));

  // --- Transparency intents are stamped and applied by the pipeline --------------
  // Fade the main structure the way the ComparisonPanel crossfade slider does
  // (the slider itself only exists once the comparison panel is built).
  const transparent = await page.evaluate(async () => {
    const { groups, general } = await import('./state/store.js');
    const { updateAtoms, updateBonds } = await import('./render/index.js');
    general.mainOpacity = 0.5;
    updateAtoms(0.5);
    await updateBonds(0.5);
    const m = groups.atomsMesh.material;
    return {
      mainOpacity: general.mainOpacity,
      transparent: m.transparent,
      depthWrite: m.depthWrite,
      spec: m.userData.transparencySpec,
      bondsSpec: groups.bondsMesh?.material?.userData?.transparencySpec ?? null,
    };
  });
  H.check('transparent atoms get forward flags via the pipeline policy',
    transparent.mainOpacity < 1 && transparent.transparent === true && transparent.depthWrite === false
      && transparent.spec?.kind === 'atoms' && transparent.spec?.needsTransparency === true,
    JSON.stringify(transparent));
  H.check('bonds carry their own stamped transparency spec',
    transparent.bondsSpec?.kind === 'bonds', JSON.stringify(transparent.bondsSpec));

  // --- Pipeline switch re-applies policy across the live scene -------------------
  const reapplied = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    const { setActivePipeline, getActivePipeline } = await import('./render/index.js');
    // Deliberately corrupt a flag, then re-activate: the traverse/re-apply
    // must restore the pipeline's policy from the stamped specs.
    groups.atomsMesh.material.depthWrite = true;
    const before = getActivePipeline();
    setActivePipeline('forward');
    return {
      newInstance: getActivePipeline() !== before,
      transparent: groups.atomsMesh.material.transparent,
      depthWrite: groups.atomsMesh.material.depthWrite,
    };
  });
  H.check('setActivePipeline re-applies transparency policy from stamped specs',
    reapplied.newInstance && reapplied.transparent === true && reapplied.depthWrite === false,
    JSON.stringify(reapplied));

  // --- Unknown pipeline id falls back to forward ----------------------------------
  const fallback = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { setActivePipeline, getActivePipeline } = await import('./render/index.js');
    setActivePipeline('does-not-exist');
    return { id: getActivePipeline()?.id, generalId: general.renderPipeline };
  });
  H.check('unknown pipeline id falls back to forward',
    fallback.id === 'forward' && fallback.generalId === 'forward', JSON.stringify(fallback));

  // --- Frame still renders through the pipeline (pixels) --------------------------
  const shot = await H.shotCanvas(page, 'pipeline-forward');
  H.check('pipeline renders a non-empty frame', H.nonUniformFraction(shot) > 0.02,
    `nonUniform=${H.nonUniformFraction(shot).toFixed(4)}`);

  // --- WBOIT + depth peeling: render and export through their target passes ------
  const offscreenExport = async (id) => page.evaluate(async (id) => {
    const { setActivePipeline, captureSceneToPng } = await import('./render/index.js');
    setActivePipeline(id);
    const blob = await captureSceneToPng({ width: 512, height: 512, margin: 10, transparent: true });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let transparentPx = 0, contentPx = 0;
    for (let i = 0; i < d.length; i += 4 * 331) {
      if (d[i + 3] === 0) transparentPx++;
      if (d[i + 3] > 128) contentPx++;
    }
    setActivePipeline('forward');
    return { type: blob.type, w: bmp.width, transparentPx, contentPx };
  }, id);
  for (const id of ['wboit', 'depthpeel']) {
    const res = await offscreenExport(id);
    H.check(`${id} pipeline exports a transparent PNG with content`,
      res.type === 'image/png' && res.w === 512 && res.transparentPx > 0 && res.contentPx > 0,
      JSON.stringify(res));
  }
  await page.waitForTimeout(500);
  const roundTripShot = await H.shotCanvas(page, 'pipeline-after-offscreen');
  H.check('forward still renders after offscreen-pipeline round-trips',
    H.nonUniformFraction(roundTripShot) > 0.02, `nonUniform=${H.nonUniformFraction(roundTripShot).toFixed(4)}`);

  // --- Persistence round-trip ------------------------------------------------------
  const persisted = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState();
    return {
      version: state.version,
      renderPipeline: state.style.renderPipeline,
      depthPeelLayers: state.style.depthPeelLayers,
      rtResolutionScale: state.style.rtResolutionScale,
      rtReflectivity: state.style.rtReflectivity,
      ptDenoise: state.style.ptDenoise,
      ptLightSoftness: state.style.ptLightSoftness,
      rtTiledRender: state.style.rtTiledRender,
      rtRasterPreview: state.style.rtRasterPreview,
      // rtPreviewRestDelay is a hidden config-only setting and is no longer persisted.
      hasPreviewRestDelay: 'rtPreviewRestDelay' in state.style,
    };
  });
  H.check('captureState persists the pipeline id + per-pipeline knobs (v2.11), not the hidden rest delay',
    persisted.version === '2.11' && persisted.renderPipeline === 'forward'
      && typeof persisted.depthPeelLayers === 'number'
      && typeof persisted.rtResolutionScale === 'number'
      && typeof persisted.rtReflectivity === 'number'
      && typeof persisted.ptDenoise === 'boolean'
      && typeof persisted.ptLightSoftness === 'number'
      && typeof persisted.rtTiledRender === 'boolean'
      && typeof persisted.rtRasterPreview === 'boolean'
      && persisted.hasPreviewRestDelay === false, JSON.stringify(persisted));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
