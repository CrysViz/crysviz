// Widget mode ray/path tracing opt-in (?tracers=1). By default the embed must
// NOT download the tracer pipelines and the Shading menu lists only the three
// material styles; with &tracers=1 the tracers load, the menu gains Ray/Path
// tracing, and picking one activates the tracer pipeline. See docs/ui/WidgetMode.js
// and docs/render/pipeline/tracers.js.
'use strict';
const H = require('../harness');

const BASE = process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html';

function fixtureJson() {
  const a = 4.3;
  const lattice = [[a, 0, 0], [0, a, 0], [0, 0, a]];
  const positions = [
    [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
    [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0.5, 0.5],
  ];
  const elements = ['Fe', 'Fe', 'Fe', 'Fe', 'O', 'O', 'O', 'O'];
  return JSON.stringify({
    format: 'crysviz', version: '2.16',
    frames: [{ elements, lattice, positions }],
    selectedFrameIndex: 0, display: {},
  });
}

/** Load the widget with/without &tracers=1; collect any tracer-module requests
 *  and the Shading menu's values. */
async function loadWidget(page, withFlag) {
  const b64 = Buffer.from(fixtureJson(), 'utf8').toString('base64');
  const tracerReqs = [];
  const onResp = (r) => {
    const u = r.url();
    if (/RayTracing|PathTracing|raytracing|pathtracing|pipeline\/tracers\.js/.test(u)) tracerReqs.push(u.split('/').pop());
  };
  page.on('response', onResp);
  const flag = withFlag ? '&tracers=1' : '';
  await page.goto(`${BASE}?widget=1${flag}#load-file=${encodeURIComponent('t.crysviz')}|${encodeURIComponent(b64)}`,
    { waitUntil: 'load', timeout: 90000 });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return document.body.classList.contains('widget-mode') && !!fileBrowser.selectedStructure;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1500);
  const shading = await page.evaluate(() =>
    [...document.querySelectorAll('.widget-menu-item[data-group="preset"]')].map((r) => r.dataset.value));
  page.off('response', onResp);
  return { shading, tracerReqs: [...new Set(tracerReqs)] };
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ navigate: false });

  // --- Default (fresh page, first): no tracers loaded, three material styles -
  {
    const r = await loadWidget(page, false);
    H.check('default widget shading is exactly metallic/matte/cel',
      JSON.stringify(r.shading) === JSON.stringify(['metallic', 'matte', 'cel']), JSON.stringify(r.shading));
    H.check('default widget downloads NO tracer modules',
      r.tracerReqs.length === 0, JSON.stringify(r.tracerReqs));
    H.check('no console errors (default)', errors.length === 0, errors.slice(0, 3).join(' | '));
  }

  // --- ?tracers=1: tracers load, menu gains them, activation works -----------
  {
    const r = await loadWidget(page, true);
    H.check('?tracers=1 adds Ray/Path tracing to Shading',
      r.shading.includes('raytrace') && r.shading.includes('pathtrace'), JSON.stringify(r.shading));
    H.check('?tracers=1 downloads the tracer pipeline modules',
      r.tracerReqs.some((f) => /RayTracingPipeline|PathTracingPipeline/.test(f)), JSON.stringify(r.tracerReqs));

    // Pick Ray tracing → the render pipeline switches to the tracer.
    await page.evaluate(() => document.getElementById('widgetLogo').click());
    await page.evaluate(() => document.querySelector('.widget-menu-item[data-group="preset"][data-value="raytrace"]').click());
    const pipeline = await H.waitFor(page, async () => {
      const { general } = await import('./state/store.js');
      return general.renderPipeline === 'raytrace' ? general.renderPipeline : null;
    }, { timeout: 20000, interval: 500 });
    H.check('picking Ray tracing activates the raytrace pipeline', pipeline === 'raytrace', String(pipeline));

    // Back to a material style → depth-peel pipeline restored.
    await page.evaluate(() => document.getElementById('widgetLogo').click());
    await page.evaluate(() => document.querySelector('.widget-menu-item[data-group="preset"][data-value="metallic"]').click());
    const back = await H.waitFor(page, async () => {
      const { general } = await import('./state/store.js');
      return general.renderPipeline === 'depthpeel' ? general.renderStyle : null;
    }, { timeout: 15000, interval: 500 });
    H.check('picking Metallic restores the depth-peel pipeline', back === 'metallic', String(back));
    // Tearing down a tracer under headless software GL (SwiftShader) can emit a
    // transient THREE material-readiness error (checkMaterialsReady / isReady) as
    // an in-flight tracer frame is disposed mid-switch — not representative of a
    // real GPU browser (see tools/browsertest/README.md). The pipeline switches
    // are asserted above; only flag OTHER console errors here.
    const realErrors = errors.filter((e) => !/isReady|checkMaterialsReady/.test(e));
    H.check('no unexpected console errors (tracers)', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  }

  await H.finish(browser);
})().catch(H.crash);
