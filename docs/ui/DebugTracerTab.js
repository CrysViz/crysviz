/**
 * Debug window, "Tracer" tab: the tracers' noise, old vs new, on the current
 * scene and in this browser (its GPU), with the active tracer: see-through
 * objects and their shadows, and (ray tracer) soft shadows, frost and
 * roughness, which now take stratified directions instead of white noise.
 *
 * A ray used to pass a surface with opacity below 1 (non-glass) by a coin
 * flip, so see-through polyhedra, atoms and bonds — and their shadows — were
 * an average of all-or-nothing samples and stayed grainy at the 64 samples a
 * render, and each PNG-export tile, stops at. Now a shadow ray keeps
 * (1 - opacity) of the light and a camera ray blends the surface with what
 * lies behind it exactly (raytrace/sceneFragment.js,
 * pathtrace/ptSceneFragment.js). The tab renders the view both ways at the
 * same sample count through the pipeline's debug switch
 * (RayTracingPipeline._legacyNoise), side by side; optionally also a
 * reference at 8× the samples (new way: both converge to it), and each
 * image's mean error against it on the scene's pixels. Each caption gives the
 * render time too: the exact way traces every see-through layer per sample,
 * so it costs more per sample and needs far fewer.
 */

import { app, general } from '../state/store.js';
import { requestRender } from '../render/index.js';

const TRACERS = new Set(['raytrace', 'pathtrace']);

/** One macrotask, so the progress line paints between the renders. */
const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * Accumulate the active tracer to `n` samples at the current camera, the old
 * or the new way, and return the canvas as a PNG data URL. Synchronous after
 * the reset, so the app's own frames cannot add samples in between.
 */
function renderSamples(pipeline, n, coinFlip) {
  const ctx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
  pipeline._legacyNoise = coinFlip;
  pipeline.render(ctx);
  pipeline.hardResetAccumulation(app.renderer);
  const guard = n * 256 + 500; // tiled renders take several calls per sample
  let calls = 0;
  const t0 = performance.now();
  while (pipeline._uniforms.uSampleCounter.value < n && calls++ < guard) pipeline.render(ctx);
  // Reading the canvas waits for the GPU, so the time includes the tracing.
  const url = app.renderer.domElement.toDataURL('image/png');
  return { url, samples: pipeline._uniforms.uSampleCounter.value, ms: performance.now() - t0 };
}

async function pixelsOf(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, canvas.width, canvas.height).data;
}

/**
 * Mean absolute difference (0–255) to the reference over the scene's pixels:
 * those the reference does not show as the plain background (its corner
 * colour), so an empty margin does not dilute the figure.
 */
function sceneError(data, ref) {
  const bg = [ref[0], ref[1], ref[2]];
  let sum = 0;
  let n = 0;
  for (let o = 0; o < ref.length; o += 4) {
    if (Math.abs(ref[o] - bg[0]) + Math.abs(ref[o + 1] - bg[1]) + Math.abs(ref[o + 2] - bg[2]) < 4) continue;
    sum += Math.abs(data[o] - ref[o]) + Math.abs(data[o + 1] - ref[o + 1]) + Math.abs(data[o + 2] - ref[o + 2]);
    n += 3;
  }
  return n ? sum / n : NaN;
}

function figure(title, shot, error) {
  const fig = document.createElement('figure');
  fig.className = 'dbgTracerShot';
  const link = document.createElement('a');
  link.href = shot.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Open at full size in a new tab';
  link.download = `${title.split(':')[0].trim().toLowerCase()}-${shot.samples}-samples.png`;
  const img = document.createElement('img');
  img.src = shot.url;
  img.alt = title;
  link.appendChild(img);
  const caption = document.createElement('figcaption');
  caption.textContent = `${title} · ${shot.samples} samples · ${(shot.ms / 1000).toFixed(1)} s`
    + `${Number.isFinite(error) ? ` · error ${error.toFixed(2)}` : ''}`;
  fig.append(link, caption);
  return fig;
}

/** @param {HTMLElement} host the tab's pane */
export function buildTracerTab(host) {
  host.innerHTML = `
    <div class="dbgBench">
      <p class="dbgBenchIntro">The tracers' noise, old and new, on the current view with the active tracer
        (Visual ▸ Render: Ray tracing or Path tracing). Old: a ray passes a surface with opacity below 1 at
        random, and the ray tracer aims its soft-shadow rays (Light softness), frost and roughness with plain
        random numbers. New: see-through surfaces are blended exactly (a shadow ray keeps 1 − opacity of the
        light), and those directions come from a stratified sequence. See-through polyhedra or atoms, the
        ground plane and a soft light show the difference best. The view must stay still while it
        renders.</p>
      <form class="dbgBenchForm" data-role="form">
        <label class="dbgBenchCheck">samples <input type="number" name="samples" value="64" min="1" max="4096" step="1" class="dbgBenchNum" /></label>
        <label class="dbgBenchCheck" title="Also render the new way at 8× the samples and give each image's mean error (0–255) against it, over the pixels that are not plain background">
          <input type="checkbox" name="reference" checked /> error against 8× samples</label>
      </form>
      <div class="trajTransport dbgTransport">
        <button type="button" class="trajBtn dbgTextBtn" data-role="run">Render old / new</button>
        <span class="dbgBenchProgress" data-role="progress"></span>
      </div>
      <div class="dbgTracerAB" data-role="out"></div>
    </div>`;
  const form = /** @type {HTMLFormElement} */ (host.querySelector('[data-role="form"]'));
  const run = /** @type {HTMLButtonElement} */ (host.querySelector('[data-role="run"]'));
  const progress = /** @type {HTMLElement} */ (host.querySelector('[data-role="progress"]'));
  const out = /** @type {HTMLElement} */ (host.querySelector('[data-role="out"]'));

  run.addEventListener('click', async () => {
    const pipeline = /** @type {any} */ (app.pipeline);
    if (!TRACERS.has(pipeline?.id)) {
      progress.textContent = 'Switch Visual ▸ Render to Ray tracing or Path tracing first.';
      return;
    }
    if (pipeline._shaderState && pipeline._shaderState !== 'ready') {
      progress.textContent = 'The tracer is still compiling its shaders — try again in a moment.';
      return;
    }
    const samplesInput = /** @type {HTMLInputElement | null} */ (form.elements.namedItem('samples'));
    const samples = Math.max(1, Math.min(4096, Math.round(Number(samplesInput?.value) || 64)));
    const withReference = !!(/** @type {HTMLInputElement} */ (form.elements.namedItem('reference'))?.checked);
    const preview = general.rtRasterPreview;
    run.disabled = true;
    out.replaceChildren();
    try {
      // Trace every frame (no raster stand-in) while measuring.
      general.rtRasterPreview = false;
      const t0 = performance.now();
      progress.textContent = `Old shadows, ${samples} samples…`;
      await yieldFrame();
      const before = renderSamples(pipeline, samples, true);
      progress.textContent = `New shadows, ${samples} samples…`;
      await yieldFrame();
      const after = renderSamples(pipeline, samples, false);
      let errors = [NaN, NaN];
      if (withReference) {
        progress.textContent = `Reference, ${samples * 8} samples…`;
        await yieldFrame();
        const ref = await pixelsOf(renderSamples(pipeline, samples * 8, false).url);
        errors = [sceneError(await pixelsOf(before.url), ref), sceneError(await pixelsOf(after.url), ref)];
      }
      out.append(figure('Old: random', before, errors[0]), figure('New: exact + stratified', after, errors[1]));
      progress.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s with ${pipeline.label ?? pipeline.id}`
        + (withReference ? ' · error = mean difference (0–255) to the reference on the scene\'s pixels' : '')
        + ' · click an image for full size';
    } catch (e) {
      progress.textContent = `Failed: ${e?.message ?? e}`;
    } finally {
      pipeline._legacyNoise = false;
      general.rtRasterPreview = preview;
      pipeline.hardResetAccumulation?.(app.renderer);
      requestRender();
      run.disabled = false;
    }
  });
}
