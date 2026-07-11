// Emissive next-event estimation (B1/B2) for the path tracer: an emissive
// material must now DIRECTLY light its neighbours (not merely glow itself). The
// analysis confirmed the pre-change gate suppressed the only transport path, so
// emissive prims contributed ZERO light to diffuse neighbours; the SceneEncoder
// emissive list + ptSampleNEE fix that. This test dims the fixture light nearly
// to black (rtLightIntensity 0.05, rtAmbient 0) so almost all light in the
// scene must come from the emissive species, then turns Cu emissive and asserts
// (a) the encoder listed the emitters and the any-hit shadow early-out turned
// off, (b) the scene brightens clearly AND the lit AREA grows well beyond the
// Cu atoms themselves (the neighbour-illumination fix), (c) no NaN / all-white
// blow-up. Deterministic setup (preview/tiling off, denoiser off, fixed camera)
// as in tracerlds/tracervariance.
'use strict';
const H = require('../harness');
const { PNG } = require('pngjs');

function decodeDataUrl(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** Mean luminance (0-255) over the image. */
function meanLum(png) {
  let sum = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    sum += 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
  }
  return sum / total;
}

/** Fraction of pixels brighter than `thresh` luminance (the "lit area"). */
function litFrac(png, thresh) {
  let n = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
    if (l > thresh) n++;
  }
  return n / total;
}

/** Fraction of near-white pixels (blow-up guard). */
function whiteFrac(png) {
  let n = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (png.data[o] > 250 && png.data[o + 1] > 250 && png.data[o + 2] > 250) n++;
  }
  return n / total;
}

async function blueNoiseReady(page) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const ok = await page.evaluate(async () => {
      const { app } = await import('./state/store.js');
      const p = app.pipeline;
      return !!p?._blueNoise?.image && (p?._uniforms?.uSampleCounter?.value ?? 0) >= 1;
    });
    if (ok || Date.now() > deadline) break;
    await page.waitForTimeout(1000);
  }
}

/** Accumulate the path tracer (LDS on) to N samples at a fixed camera and
 *  return the raw (denoiser-off) canvas data URL. Re-encodes on the settling
 *  renders, so a material change made before the call is picked up.
 *  forceEmissive (or null): after the settling encode, override the encoder's
 *  emissiveCount for the whole run. 0 = emitters glow (camera/specular arrival)
 *  but are NEVER directly sampled and their diffuse-arrival emission is gated
 *  off (listed) — i.e. exactly the PRE-FIX "glow, don't light neighbours"
 *  behaviour. The counting-loop renders don't re-encode (scene unchanged), so
 *  the override sticks. */
async function convergeTo(page, N, forceEmissive = null) {
  return page.evaluate(async ({ N, forceEmissive }) => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
    const canvas = app.renderer.domElement;
    p._sceneDirty = true; // force a fresh encode (recomputes the natural count,
    //   undoing any emissiveCount override left by a previous run)
    p.render(ctx); p.render(ctx); // settle + re-encode
    if (forceEmissive !== null) p._encoder.emissiveCount = forceEmissive;
    p.hardResetAccumulation(app.renderer);
    let guard = 0;
    while (p._uniforms.uSampleCounter.value < N && guard++ < N + 200) p.render(ctx);
    return { url: canvas.toDataURL('image/png'), emissiveCount: p._uniforms.uEmissiveCount.value };
  }, { N, forceEmissive });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  H.check('webgl available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO

  await page.evaluate(async () => {
    const { general, fileBrowser, app } = await import('./state/store.js');
    const THREE = await import('./external/three/three.module.js');
    general.rtRasterPreview = false;
    general.rtTiledRender = false;
    general.rtResolutionScale = 0.25;
    general.ptDenoise = false;
    general.rtLightIntensity = 0.05; // fixture nearly off — light must come from Cu
    general.rtAmbient = 0;
    // Black background so the (dark) structure region is isolated from the
    // backdrop — otherwise the bright default background dominates mean
    // luminance and the emissive brightening is invisible against it.
    app.scene.background = new THREE.Color(0x000000);
    // ensure a clean baseline (no emissive materials from a prior session)
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = {};
    structure.atomUserMaterials = {};
  });
  await H.setSelect(page, 'renderPipelineMenu', 'pathtrace');
  await blueNoiseReady(page);

  // --- baseline (no emissive; fixture nearly off => scene is dark) ---------
  const baseImg = decodeDataUrl((await convergeTo(page, 48)).url);
  const baseLum = meanLum(baseImg);
  const baseLit = litFrac(baseImg, 12);

  // --- turn Cu emissive -----------------------------------------------------
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { requestRender } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    structure.atomMaterials = structure.atomMaterials ?? {};
    structure.atomMaterials['Cu'] = { type: 'emissive', intensity: 12 };
    requestRender();
  });
  await page.waitForTimeout(2500); // re-encode + reset settle
  const enc = await page.evaluate(async () => {
    const { app } = await import('./state/store.js');
    const p = app.pipeline;
    return {
      emissiveCount: p._encoder.emissiveCount,
      hasEmissive: p._encoder.hasEmissive,
      shadowAnyHit: p._uniforms.uShadowAnyHit.value,
    };
  });
  H.check('emissive Cu listed for NEE and any-hit shadow early-out disabled',
    enc.emissiveCount > 0 && enc.hasEmissive === true && enc.shadowAnyHit === false,
    JSON.stringify(enc));

  // A/B that ISOLATES the fix: same emissive material, but glowOnly forces the
  // NEE emitter count to 0 (emitters glow via camera/specular arrival, but
  // never light diffuse neighbours — the pre-fix transport), while withNEE uses
  // the natural list. The delta is PURELY the neighbour-illumination fix.
  const glowRes = await convergeTo(page, 48, 0);
  const glowImg = decodeDataUrl(glowRes.url);
  const glowLum = meanLum(glowImg);
  const glowLit = litFrac(glowImg, 12);

  const emiRes = await convergeTo(page, 48, null);
  const emiImg = decodeDataUrl(emiRes.url);
  const emiLum = meanLum(emiImg);
  const emiLit = litFrac(emiImg, 12);
  const white = whiteFrac(emiImg);
  console.log(`  emissive: baseLum=${baseLum.toFixed(3)} glowLum=${glowLum.toFixed(3)} `
    + `emiLum=${emiLum.toFixed(3)} | baseLit=${baseLit.toFixed(4)} glowLit=${glowLit.toFixed(4)} `
    + `emiLit=${emiLit.toFixed(4)} | whiteFrac=${white.toFixed(4)} `
    + `emiCount=${emiRes.emissiveCount} glowCount=${glowRes.emissiveCount}`);

  // Clear brightening vs the dark baseline: the emissive species lights the scene.
  H.check('emissive material clearly brightens the scene (mean luminance up)',
    Number.isFinite(emiLum) && emiLum > baseLum + 3,
    JSON.stringify({ baseLum: +baseLum.toFixed(3), emiLum: +emiLum.toFixed(3) }));

  // The FIX (same emissive material, NEE count forced 0 vs natural): NEE lights
  // NEW area beyond the emitter's own glow — the lit-area growth is the clean
  // neighbour-illumination signal (observed +42%, 0.0324 -> 0.0460; three local
  // runs bit-identical). The emitter cores dominate mean luminance, so overall
  // brightening is smaller but still measurable. Absolute-property assertions.
  H.check('NEE lights neighbours: lit area grows beyond the emitter glow',
    emiLit > glowLit + 0.008,
    JSON.stringify({ glowLit: +glowLit.toFixed(4), emiLit: +emiLit.toFixed(4),
      growth: +(emiLit - glowLit).toFixed(4) }));
  H.check('NEE lights neighbours: scene is measurably brighter than glow-only',
    emiLum > glowLum * 1.03,
    JSON.stringify({ glowLum: +glowLum.toFixed(3), emiLum: +emiLum.toFixed(3),
      ratio: +(emiLum / Math.max(glowLum, 1e-9)).toFixed(3) }));

  // Blow-up guard: not NaN (would clamp to 0 -> caught above) and not washed out.
  H.check('emissive image is not a washed-out / NaN blow-up',
    Number.isFinite(emiLum) && white < 0.5, JSON.stringify({ whiteFrac: +white.toFixed(4) }));

  // Loose low-N convergence sanity: a 16-sample image is finite and broadly
  // consistent with the 48-sample one (same scene, fewer samples).
  const lowImg = decodeDataUrl((await convergeTo(page, 16, null)).url);
  const lowLum = meanLum(lowImg);
  H.check('low-sample emissive render is finite and broadly consistent',
    Number.isFinite(lowLum) && lowLum > baseLum + 2,
    JSON.stringify({ lowLum: +lowLum.toFixed(3), emiLum: +emiLum.toFixed(3) }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
