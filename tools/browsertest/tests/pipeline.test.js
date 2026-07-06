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
  H.check('forward pipeline active after boot (app.pipeline + general in sync)',
    boot.activeId === 'forward' && boot.appPipelineMatches && boot.generalId === 'forward',
    JSON.stringify(boot));
  H.check('rendering-pipeline dropdown lists the registry',
    Array.isArray(boot.menuOptions) && boot.menuOptions.join(',') === boot.registry.map((p) => p.id).join(',')
      && boot.menuValue === 'forward',
    JSON.stringify({ menu: boot.menuOptions, registry: boot.registry }));
  H.check('registry holds the three pipelines',
    boot.registry.map((p) => p.id).join(',') === 'forward,split-atoms,sorted-atoms',
    JSON.stringify(boot.registry));
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

  // --- Persistence round-trip ------------------------------------------------------
  const persisted = await page.evaluate(async () => {
    const { captureState } = await import('./ui/ShareModule.js');
    const state = captureState();
    return { version: state.version, renderPipeline: state.style.renderPipeline };
  });
  H.check('captureState persists the pipeline id (v2.4)',
    persisted.version === '2.4' && persisted.renderPipeline === 'forward', JSON.stringify(persisted));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
