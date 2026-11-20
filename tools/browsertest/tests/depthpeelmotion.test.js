// Depth peeling while the camera moves (render/pipeline/DepthPeelPipeline.js
// _layerCountFor): an interactive frame with a camera that moved since the
// last one peels only general.depthPeelMotionLayers (default 4) and requests
// one more frame; the next frame, camera at rest, peels the full
// general.depthPeelLayers again. Non-interactive renders (PNG export) always
// peel the full count. The Visual window has the "Peel layers while moving"
// slider under Peel layers; share links carry it (baseline 6, key dm).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO
  await H.setSelect(page, 'renderPipelineMenu', 'depthpeel');
  await page.waitForTimeout(500);

  const r = await page.evaluate(async () => {
    const { app, general } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    general.depthPeelLayers = 15;
    general.depthPeelMotionLayers = 4;
    const layers = () => p._pass.layerCount;
    p.render({ ...ctx, interactive: true }); p.render({ ...ctx, interactive: true }); // settle
    const atRest = layers();
    app.camera.position.x += 1; app.camera.updateMatrixWorld();
    p.render({ ...ctx, interactive: true });
    const moving = { layers: layers(), motionFrame: p._motionFrame };
    p.render({ ...ctx, interactive: true }); // same pose: the settle frame
    const settled = { layers: layers(), motionFrame: p._motionFrame };
    app.camera.position.x += 1; app.camera.updateMatrixWorld();
    p.render(ctx); // non-interactive (export): full count although the camera moved
    const exportFrame = { layers: layers(), motionFrame: p._motionFrame };
    general.depthPeelMotionLayers = 15; // = full: nothing to reduce
    app.camera.position.x += 1; app.camera.updateMatrixWorld();
    p.render({ ...ctx, interactive: true });
    const noReduction = layers();
    general.depthPeelMotionLayers = 4;
    const slider = /** @type {HTMLInputElement|null} */ (document.getElementById('depthPeelMotionLayersSlider'));
    const block = slider?.parentElement;
    const label = block?.querySelector('label')?.textContent;
    return { atRest, moving, settled, exportFrame, noReduction, slider: !!slider, label, shown: block?.style.display !== 'none' };
  });
  H.check('at rest the full count is peeled', r.atRest === 15, JSON.stringify(r));
  H.check('a moved camera in an interactive frame peels the motion count', r.moving.layers === 4 && r.moving.motionFrame, JSON.stringify(r.moving));
  H.check('the next frame at the same pose peels the full count again', r.settled.layers === 15 && !r.settled.motionFrame, JSON.stringify(r.settled));
  H.check('a non-interactive render peels the full count even after a move', r.exportFrame.layers === 15 && !r.exportFrame.motionFrame, JSON.stringify(r.exportFrame));
  H.check('motion layers equal to the full count: no reduction', r.noReduction === 15, String(r.noReduction));
  H.check('the "Peel layers while moving" slider sits under the depth-peel pipeline', r.slider && r.shown && /while moving: 4/.test(r.label ?? ''), JSON.stringify({ label: r.label, shown: r.shown }));

  // the slider drives the setting; the share link carries it
  await H.setSlider(page, 'depthPeelMotionLayersSlider', 6);
  const share = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { captureState } = await import('./ui/ShareModule.js');
    const { encodeCompact, expandCompact } = await import('./io/share/shareCodec.js');
    const state = captureState();
    const obj = encodeCompact(JSON.parse(JSON.stringify(state)));
    const back = expandCompact(JSON.parse(JSON.stringify(obj)));
    return { setting: general.depthPeelMotionLayers, key: obj.o?.dm, back: back.style.depthPeelMotionLayers };
  });
  H.check('the slider sets it and the compact link carries it under dm', share.setting === 6 && share.key === 6 && share.back === 6, JSON.stringify(share));
  await H.setSlider(page, 'depthPeelMotionLayersSlider', 4);

  // hidden under another pipeline
  await H.setSelect(page, 'renderPipelineMenu', 'forward');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => document.getElementById('depthPeelMotionLayersSlider')?.parentElement?.style.display === 'none');
  H.check('hidden under the forward pipeline', hidden);

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
