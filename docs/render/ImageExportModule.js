// High-resolution PNG export of the 3D scene, WYSIWYG: whatever the user has
// on screen right now — atoms/bonds/polyhedra/fields, the axis gizmo and its
// legend wherever they've been dragged, any color bars floated onto the
// scene, the Composition Display legend, measurement lines and labels — at
// the position it's actually showing at, cropped to a rectangle the user picks
// interactively
// (ui/CropOverlay.js, an iOS-Photos-style draggable/resizable crop window
// over the live view) rather than auto-framed to content or auto-placed in
// a corner. Docked (non-floating) color bars live in the side panel, not
// over the 3D view, so — like the panel itself — they're never part of this
// capture; only what's actually layered on #view is.
//
// Strategy: render #view's full viewport at a resolution high enough that
// the user's chosen crop rectangle maps to good pixel density, read the
// pixels synchronously in the same tick (the renderer has no
// preserveDrawingBuffer, so nothing may `await` between render() and the
// read), then crop+scale that render to exactly fill the requested output
// size (the crop rectangle's on-screen aspect always matches the output's,
// so this never needs to letterbox). The gizmo (a separate small renderer),
// its legend, floating color bars, and the CSS2D measurement labels are
// each redrawn in 2D afterward at their own true on-screen position, mapped
// through the same crop.
//
// alpha:true on the main renderer (WindowAndSceneControls.initRenderer) lets us
// render with scene.background = null and fill the requested background
// colour under the composited content only when transparency isn't requested.
//
// Progressive tracer pipelines (raytrace/pathtrace) are driven to convergence
// with PACED tiled rendering that follows the general.rtTiledRender UI setting:
// one pipeline.render() per animation frame (one scissored tile when tiling is
// on, one full sample when off), the pipeline in externally-paced mode so its
// resize boost never bursts synchronously, and the animate loop held off the
// renderer (app.offscreenRenderHold) so the export is the single render driver
// and uSampleCounter advances monotonically. An optional AbortSignal (opts.signal)
// cancels the export cleanly at any loop iteration — the same finally restores
// the live view, then an AbortError is thrown.

import * as THREE from '../external/three/three.module.js';
import { app, general, measurements } from '../state/store.js';
import { latticeDirsNorm } from './LatticeModule.js';
import { requestRender } from './AnimateModule.js';
import { colorsFor, computeTicks, formatTick, currentContrastColor } from '../ui/ColorBarWidget.js';
import { listActiveColorBars } from '../ui/ColorBarRegistry.js';
import { repaintSwatchesForExport } from '../ui/CompositionLegendWidget.js';
import { drawLegendRichText, legendPlainText, crysVizFontsLoaded } from '../utils/index.js';
import { configureGizmoCameraProjection } from '../ui/GizmoLayout.js';
import { getPanelPref } from '../ui/panels/PanelManager.js';

/** The GPU memory the export may allocate for its render surface, from the
 *  Settings > Graphics "Allocated GPU memory" slider. WebGL cannot query the
 *  real GPU memory, so this is a user-asserted budget; the default is safe
 *  for integrated GPUs. Clamped so a corrupted pref can't disable the guard. */
function renderMemoryBudgetBytes() {
  const gib = Number(getPanelPref('exportGpuMemoryGiB'));
  return Math.min(8, Math.max(0.25, Number.isFinite(gib) && gib > 0 ? gib : 1)) * (1 << 30);
}

/** @returns {HTMLElement} the #view container */
function getViewEl() {
  return /** @type {HTMLElement} */ (document.getElementById('view'));
}

/** One animation-frame yield (paces the export so the browser stays responsive
 *  and can repaint the button/progress between renders). */
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}

/** Throw a recognizable AbortError if the caller's AbortSignal has fired.
 *  captureSceneToPng's finally still runs (restoring the live view), then this
 *  propagates to doDownload, which swallows it (no alert) and leaves the modal
 *  open. */
function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('Export aborted.');
    err.name = 'AbortError';
    throw err;
  }
}

// Allocate a 2D canvas and PROVE its backing store exists before it is relied
// on: browsers cap both canvas dimensions and total area, and an over-limit
// canvas does not throw anywhere — getContext still succeeds, drawing
// silently no-ops, and toBlob returns null or a blank image. That was
// exactly the "export produced an empty PNG" failure at big requested
// resolutions. Probing a real pixel write+read at the far corner surfaces
// the failure as a clear error instead (and doing it for the OUTPUT canvas
// before any rendering starts means a doomed export fails fast, not after
// minutes of tracer convergence).
function createVerifiedCanvas(width, height, what) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = /** @type {CanvasRenderingContext2D | null} */ (canvas.getContext('2d'));
  let ok = false;
  try {
    if (ctx) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(width - 1, height - 1, 1, 1);
      ok = ctx.getImageData(width - 1, height - 1, 1, 1).data[3] !== 0;
      ctx.clearRect(0, 0, width, height);
    }
  } catch {
    ok = false;
  }
  if (!ok || !ctx) {
    throw new Error(`This browser cannot allocate the ${width}×${height} ${what}. `
      + 'Reduce the export resolution and try again.');
  }
  return { canvas, ctx };
}

/** Drain the GL error queue (bounded — a lost context can report endlessly)
 *  and say whether OUT_OF_MEMORY was among them. Called once with the result
 *  ignored before the export renders (so stale errors from earlier app work
 *  aren't blamed on it), then checked right after the first frame — the
 *  render that forces the pipeline's full-size target allocations, where a
 *  driver that reports OOM properly (instead of crashing) surfaces it. */
function sawGlOutOfMemory(gl) {
  let oom = false;
  for (let i = 0; i < 8; i++) {
    const err = gl.getError();
    if (err === gl.NO_ERROR) break;
    if (err === gl.OUT_OF_MEMORY) oom = true;
  }
  return oom;
}

/** Throw a clear error if the WebGL context has been lost — the usual way a
 *  too-large export dies (GPU memory), and otherwise a SILENT one: renders
 *  no-op, the tracer's sample counter stops advancing (so the convergence
 *  loop would spin forever), and the readback comes out empty. */
function throwIfContextLost(gl) {
  if (gl.isContextLost()) {
    throw new Error('The WebGL context was lost during the export — usually the requested '
      + 'resolution exhausted GPU memory. Reduce the export resolution and try again '
      + '(if the 3D view stays blank, save your work and then reload the page).');
  }
}

// A camera that renders exactly one tile (a sub-window) of the full srcW x
// srcH frame, plus how to undo it. Raster pipelines read the projection
// matrix, so three's own setViewOffset on the LIVE camera is the exact
// mechanism (restored per tile). The tracer pipelines never read the
// projection matrix — they build rays from matrixWorld plus SYMMETRIC ortho
// half-extents (uULen/uVLen, RayTracingPipeline's camera uniforms) — so a
// view offset can't reach them; for an orthographic camera the same
// sub-window is expressed exactly by translating a CLONE in its own
// right/up plane to the tile's centre and shrinking the extents to the
// tile (an asymmetric window is impossible with symmetric extents, hence
// the translation; a perspective tracer camera cannot be tiled this way at
// all — the caller falls back to capping instead).
export function makeTileCamera(camera, srcW, srcH, tx, ty, tw, th, isTracer) {
  if (!isTracer) {
    camera.setViewOffset(srcW, srcH, tx, ty, tw, th);
    return { camera, restore: () => camera.clearViewOffset() };
  }
  const cam = camera.clone();
  const zoom = camera.zoom ?? 1;
  const halfW = ((camera.right - camera.left) / 2) / zoom;
  const halfH = ((camera.top - camera.bottom) / 2) / zoom;
  const e = camera.matrixWorld.elements;
  const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const cx = (tx + tw / 2) / srcW;  // tile centre, fractions of the full frame
  const cy = (ty + th / 2) / srcH;
  cam.position.setFromMatrixPosition(camera.matrixWorld)
    .addScaledVector(right, (cx - 0.5) * 2 * halfW)
    .addScaledVector(up, (0.5 - cy) * 2 * halfH);
  cam.quaternion.setFromRotationMatrix(camera.matrixWorld);
  // Bake the tile's half-extents so the tracer's ((right-left)/2)/zoom
  // arrives at exactly halfW * tw/srcW (and likewise vertically).
  cam.left = -halfW * (tw / srcW) * zoom;
  cam.right = halfW * (tw / srcW) * zoom;
  cam.top = halfH * (th / srcH) * zoom;
  cam.bottom = -halfH * (th / srcH) * zoom;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return { camera: cam, restore: () => {} };
}

// Render the full srcW x srcH frame as a grid of tileW x tileH GL surfaces,
// composited into a (CPU-side) 2D canvas — GPU memory stays bounded by the
// TILE size no matter how large the requested export is, which is what makes
// resolutions beyond the render-memory budget possible at all instead of
// crashing the driver. Edge tiles are shifted inward (full-size, overlapping
// already-rendered area) so the GL surface never reallocates mid-export; the
// overlap region is cleared before each draw so transparent pixels don't
// double-composite. Tracer tiles each run their own full convergence
// (total work ~ samples x pixels, the same as an untiled render).
async function renderMainTiled(srcW, srcH, tileW, tileH, onProgress, signal) {
  const { canvas: srcCanvas, ctx: sctx } = createVerifiedCanvas(srcW, srcH, 'render capture');
  app.renderer.setSize(tileW, tileH, false);
  const gl = app.renderer.getContext();
  throwIfContextLost(gl);
  if (gl.drawingBufferWidth < tileW || gl.drawingBufferHeight < tileH) {
    throw new Error(`WebGL could not allocate a ${tileW}×${tileH} render surface `
      + `(got ${gl.drawingBufferWidth}×${gl.drawingBufferHeight}). `
      + 'Reduce the export resolution and try again.');
  }
  app.pipeline?.setSize(tileW, tileH);
  sawGlOutOfMemory(gl); // drain stale errors so the post-frame check is honest
  const isTracer = !!app.pipeline?.isConverged;
  const nx = Math.ceil(srcW / tileW);
  const ny = Math.ceil(srcH / tileH);
  const perTileTarget = app.pipeline?._cfg?.targetSamples ?? 0;
  let firstFrameChecked = false;
  const checkFirstFrame = () => {
    if (firstFrameChecked) return;
    firstFrameChecked = true;
    if (sawGlOutOfMemory(gl)) {
      throw new Error(`WebGL ran out of memory rendering the export at ${tileW}×${tileH} `
        + 'per tile. Reduce the export resolution or the Allocated GPU memory setting '
        + 'and try again.');
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const tx = Math.min(i * tileW, srcW - tileW);
      const ty = Math.min(j * tileH, srcH - tileH);
      const tile = makeTileCamera(app.camera, srcW, srcH, tx, ty, tileW, tileH, isTracer);
      const renderCtx = { renderer: app.renderer, scene: app.scene, camera: tile.camera };
      try {
        if (isTracer) {
          app.pipeline.resetAccumulation?.();
          const base = (j * nx + i) * perTileTarget;
          const reportTile = () => {
            if (typeof onProgress !== 'function' || !(perTileTarget > 0)) return;
            const current = app.pipeline?._uniforms?.uSampleCounter?.value ?? 0;
            onProgress({ current: base + current, target: perTileTarget * nx * ny });
          };
          reportTile();
          while (!app.pipeline.isConverged()) {
            throwIfAborted(signal);
            await nextFrame();
            throwIfAborted(signal);
            throwIfContextLost(gl);
            app.pipeline.render(renderCtx);
            checkFirstFrame();
            reportTile();
          }
          reportTile();
        } else {
          app.pipeline?.render(renderCtx);
          checkFirstFrame();
        }
        throwIfContextLost(gl); // a lost context reads back as an empty image
      } finally {
        tile.restore();
      }
      // No await between the last render and this read (no preserveDrawingBuffer).
      // clearRect first: edge tiles overlap, and source-over would double-
      // composite semi-transparent pixels.
      sctx.clearRect(tx, ty, tileW, tileH);
      sctx.drawImage(app.renderer.domElement, tx, ty);
    }
  }
  return srcCanvas;
}

// Like renderMainToCanvas, but for progressive tracer pipelines: keeps
// accumulating in small batches — yielding to the browser between them so the
// on-screen progress bar (render/TracerProgressModule.js, driven from
// pipeline.render()) stays live — until the pipeline reports convergence.
// Non-tracer pipelines (no isConverged) capture after the single frame.
async function renderMainToCanvasConverged(w, h, onProgress, signal) {
  app.renderer.setSize(w, h, false);
  // The WebGL spec allows the drawing buffer to come up SMALLER than asked
  // for when the allocation fails — no exception, no context loss, just a
  // shrunken (or dead) surface that would export as a blank/garbled image.
  // Refuse loudly instead.
  const gl = app.renderer.getContext();
  throwIfContextLost(gl);
  if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) {
    throw new Error(`WebGL could not allocate a ${w}×${h} render surface `
      + `(got ${gl.drawingBufferWidth}×${gl.drawingBufferHeight}). `
      + 'Reduce the export resolution and try again.');
  }
  app.pipeline?.setSize(w, h);
  sawGlOutOfMemory(gl); // drain stale errors so the post-frame check is honest
  let checkFirstFrame = true;
  const checkAfterFrame = () => {
    if (!checkFirstFrame) return;
    checkFirstFrame = false;
    if (sawGlOutOfMemory(gl)) {
      throw new Error(`WebGL ran out of memory rendering the export at ${w}×${h}. `
        + 'Reduce the export resolution and try again.');
    }
  };
  const renderCtx = { renderer: app.renderer, scene: app.scene, camera: app.camera };
  // Report accumulation progress on the export button (tracer pipelines only).
  // Reads the same counters the on-screen progress strip uses; guarded so raster
  // pipelines (no uSampleCounter / targetSamples) never emit a bogus 0/0.
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    const current = app.pipeline?._uniforms?.uSampleCounter?.value ?? 0;
    const target = app.pipeline?._cfg?.targetSamples ?? 0;
    if (Number.isFinite(current) && Number.isFinite(target) && target > 0) {
      onProgress({ current, target });
    }
  };
  if (app.pipeline?.isConverged) {
    // The live view's accumulation belongs to the on-screen size and RT
    // resolution scale, so it cannot be carried into the export: render()'s own
    // resize reset would zero it on the very first paced frame, after the
    // starting count had already been reported (progress running BACKWARDS,
    // e.g. "Rendering… 16 / 64" then "1 / 64") — and a live view that had
    // already reached the target would satisfy isConverged() before a single
    // export frame was traced, capturing a canvas that was resized but never
    // rendered into. Start the export from a known-empty accumulation instead.
    app.pipeline.resetAccumulation?.();
    reportProgress(); // show the starting count before the first paced frame
    while (!app.pipeline.isConverged()) {
      throwIfAborted(signal);
      await nextFrame();            // yield first: the button/progress repaints
      throwIfAborted(signal);
      // A context lost mid-accumulation stops the sample counter, so without
      // this check the convergence loop would spin forever ("Rendering…"
      // stuck) instead of reporting what actually happened.
      throwIfContextLost(gl);
      app.pipeline.render(renderCtx); // one paced sample (one tile when tiling)
      checkAfterFrame();
      reportProgress();
    }
    reportProgress(); // final (converged) count
  } else {
    app.pipeline?.render(renderCtx); // raster: single frame, capture immediately
    checkAfterFrame();
  }
  throwIfContextLost(gl); // a lost context reads back as an empty image

  const { canvas, ctx } = createVerifiedCanvas(w, h, 'render capture');
  ctx.drawImage(app.renderer.domElement, 0, 0, w, h);
  return canvas;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// A DOM element's on-screen rect expressed as fractions (0..1, can extend
// outside that range) of #view's own rect — the common coordinate space
// every overlay (gizmo, legend, floating color bars) gets mapped through.
function viewFraction(rect, viewRect) {
  return {
    x0: (rect.left - viewRect.left) / viewRect.width,
    y0: (rect.top - viewRect.top) / viewRect.height,
    x1: (rect.right - viewRect.left) / viewRect.width,
    y1: (rect.bottom - viewRect.top) / viewRect.height,
  };
}

// Maps a view-fraction rect through the user's chosen crop into output
// canvas pixels. Returns null when the rect falls entirely outside either
// the crop or the output — same as a real screenshot, something dragged out
// of frame simply isn't in the picture.
function cropToOutputRect(viewFrac, crop, width, height) {
  const cw = crop.x1 - crop.x0;
  const ch = crop.y1 - crop.y0;
  if (cw <= 0 || ch <= 0) return null;
  const x0 = ((viewFrac.x0 - crop.x0) / cw) * width;
  const y0 = ((viewFrac.y0 - crop.y0) / ch) * height;
  const x1 = ((viewFrac.x1 - crop.x0) / cw) * width;
  const y1 = ((viewFrac.y1 - crop.y0) / ch) * height;
  if (x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= height) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Draw the measurement labels (CSS2D divs anchored at 3D points) onto the
// output, projected with the same camera and transformed by the same
// crop->output mapping as the content, so they track their atoms and scale
// with the molecule.
function drawMeasurementLabels(octx, map) {
  const labels = measurements.measureLabels || [];
  if (!labels.length) return;
  for (const label of labels) {
    if (!label || label.visible === false || !label.element) continue;
    const text = (label.element.textContent || '').trim();
    if (!text) continue;

    const ndc = label.position.clone().project(app.camera);
    if (ndc.z < -1 || ndc.z > 1) continue; // outside the near/far frustum
    // NDC -> source pixels -> output pixels
    const srcX = (ndc.x * 0.5 + 0.5) * map.srcW;
    const srcY = (1 - (ndc.y * 0.5 + 0.5)) * map.srcH;
    const ox = map.dx + (srcX - map.cropX) * map.scale;
    const oy = map.dy + (srcY - map.cropY) * map.scale;

    const cs = window.getComputedStyle(label.element);
    const k = map.fontScale;
    const fontPx = (parseFloat(cs.fontSize) || 14) * k;
    const padX = (parseFloat(cs.paddingLeft) || 6) * k;
    const padY = (parseFloat(cs.paddingTop) || 2) * k;
    const border = (parseFloat(cs.borderTopWidth) || 0) * k;
    const radius = (parseFloat(cs.borderRadius) || 4) * k;

    octx.font = `${cs.fontWeight || '700'} ${fontPx}px ${cs.fontFamily || "'CrysViz Sans', 'CrysViz Sans Math', sans-serif"}`;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    const textW = octx.measureText(text).width;
    const boxW = textW + 2 * padX;
    const boxH = fontPx + 2 * padY;

    // CSS2DObject centres the element on its anchor point.
    const bx = ox - boxW / 2;
    const by = oy - boxH / 2;
    roundRectPath(octx, bx, by, boxW, boxH, radius);
    octx.fillStyle = cs.backgroundColor || 'rgba(255,255,255,0.95)';
    octx.fill();
    if (border > 0) {
      octx.lineWidth = border;
      octx.strokeStyle = cs.borderTopColor || '#000';
      octx.stroke();
    }
    octx.fillStyle = cs.color || '#000';
    octx.fillText(text, ox, oy + 0.5 * k);
  }
}

// Renders the gizmo (and, unless the labels are integrated onto its arrows,
// its separate a/b/c legend) at its own true on-screen position, mapped
// through the crop — wherever ui/GizmoDrag.js has it sitting right now.
// Skipped entirely if the gizmo is hidden, or dragged fully outside the
// chosen crop. Returns the previous gizmo pixel ratio so the caller can
// restore it (null if skipped).
function drawGizmoAndLegend(octx, width, height, crop, viewRect) {
  const gizmoDiv = document.getElementById('axesGizmo');
  if (!app.gizmoRenderer || !app.gizmoScene || !app.gizmoCamera || !gizmoDiv) return null;
  if (!general.showAxes) return null;
  if (gizmoDiv.style.display === 'none') return null;

  const outRect = cropToOutputRect(viewFraction(gizmoDiv.getBoundingClientRect(), viewRect), crop, width, height);
  if (!outRect) return null;

  const prevGizmoPR = app.gizmoRenderer.getPixelRatio();
  const gsize = Math.max(16, Math.round(Math.max(outRect.width, outRect.height)));
  app.gizmoRenderer.setPixelRatio(1);
  app.gizmoRenderer.setSize(gsize, gsize, false);
  configureGizmoCameraProjection(app.gizmoCamera, 1);

  const invCamQ = app.camera.quaternion.clone().invert();
  const { a, b, c } = latticeDirsNorm();
  app.gizmoScene.userData.aArrow.setDirection(a.clone().applyQuaternion(invCamQ));
  app.gizmoScene.userData.bArrow.setDirection(b.clone().applyQuaternion(invCamQ));
  app.gizmoScene.userData.cArrow.setDirection(c.clone().applyQuaternion(invCamQ));
  app.gizmoRenderer.render(app.gizmoScene, app.gizmoCamera);
  octx.drawImage(app.gizmoRenderer.domElement, outRect.x, outRect.y, outRect.width, outRect.height);

  // The a/b/c letters are already baked into that render when integrated
  // onto the arrows (general.gizmoLabelsOnArrows, ui/GizmoDrag.js) — the
  // separate legend box is only needed as the alternative to that.
  if (!general.gizmoLabelsOnArrows) {
    const legendDiv = document.getElementById('axesLegend');
    if (legendDiv && legendDiv.style.display !== 'none') {
      const legendOut = cropToOutputRect(viewFraction(legendDiv.getBoundingClientRect(), viewRect), crop, width, height);
      if (legendOut) drawAxesLegend(octx, legendOut);
    }
  }
  return prevGizmoPR;
}

// The a/b/c legend box (mirrors #axesLegend), filling the exact output rect
// its on-screen counterpart maps to. Colours match the gizmo arrows /
// .dot-a/b/c CSS.
function drawAxesLegend(ictx, rect) {
  const rows = [['a', '#ff3333'], ['b', '#33cc33'], ['c', '#3366ff']];
  const font = Math.max(7, rect.height * 0.15);
  const dot = font * 0.85;
  const padX = font * 0.6;
  const gap = font * 0.5;
  const rowH = rect.height / rows.length;

  roundRectPath(ictx, rect.x, rect.y, rect.width, rect.height, font * 0.5);
  ictx.fillStyle = 'rgba(0,0,0,0.8)';
  ictx.fill();
  ictx.lineWidth = Math.max(1, font * 0.06);
  ictx.strokeStyle = 'rgba(255,255,255,0.2)';
  ictx.stroke();

  ictx.font = `600 ${font}px 'CrysViz Sans', sans-serif`;
  ictx.textBaseline = 'middle';
  ictx.textAlign = 'left';

  for (let i = 0; i < rows.length; i++) {
    const [ch, color] = rows[i];
    const cy = rect.y + rowH * (i + 0.5);
    ictx.beginPath();
    ictx.arc(rect.x + padX + dot / 2, cy, dot / 2, 0, Math.PI * 2);
    ictx.fillStyle = color;
    ictx.fill();
    ictx.lineWidth = Math.max(1, dot * 0.08);
    ictx.strokeStyle = 'rgba(255,255,255,0.4)';
    ictx.stroke();
    ictx.fillStyle = '#fff';
    ictx.fillText(ch, rect.x + padX + dot + gap, cy);
  }
}

// Redraws one color bar's gradient + ticks + legend onto the export canvas —
// not a rasterization of the live DOM widget, but a from-scratch Canvas 2D
// draw using the exact same color stops (ColorBarWidget.colorsFor) and tick
// math (ColorBarWidget.computeTicks) the on-screen widget itself uses, so
// the printed numbers and gradient match exactly. (x,y,w,h) is the bar's own
// gradient strip mapped into output pixels — ticks/legend render below
// (horizontal) or to the right (vertical) of it, same as the live widget's
// default (non-flipped) layout.
function drawColorBar(octx, settings, x, y, w, h, tickFont, legendFont, inputFont, pxScale = 1) {
  const { colormap, min, max, minText, maxText, scale, legend, flipSide } = settings;
  const horizontal = w >= h;
  // The live bar shows Min/Max as the exact text in those input fields, not
  // formatTick(min)/formatTick(max) — the same rounding its OWN inner ticks
  // use (2 decimal places, or 0 once |v| >= 100) is far coarser than what's
  // actually typed/set there (a longer decimal like "0.0599" from Auto
  // Range would print as "0.06"), and reformatting also throws away
  // notation the user typed directly (scientific notation stays as-is in
  // the input; parseFloat back through min/max loses it). Falls back to
  // formatTick only if a caller's settings don't carry the raw text (older
  // shape, or minText/maxText genuinely empty).
  const minLabel = minText || formatTick(min);
  const maxLabel = maxText || formatTick(max);

  const colors = colorsFor(colormap);
  const grad = horizontal
    ? octx.createLinearGradient(x, 0, x + w, 0)
    : octx.createLinearGradient(0, y + h, 0, y); // bottom (min) -> top (max)
  const step = Math.max(1, Math.floor(colors.length / 20));
  for (let i = 0; i < colors.length; i += step) {
    grad.addColorStop(i / colors.length, `#${colors[i].getHexString()}`);
  }
  // Matches the live bar exactly: a CSS border-radius:4px on the <canvas>
  // (ColorBarWidget.js) and NO border/stroke at all. This used to be a
  // plain fillRect+strokeRect — sharp corners plus a white outline the live
  // widget never actually has — so the export looked like a different,
  // boxier bar instead of a redraw of the one on screen.
  octx.fillStyle = grad;
  roundRectPath(octx, x, y, w, h, 4 * pxScale);
  octx.fill();

  const validRange = isFinite(min) && isFinite(max) && min < max;
  const ticks = validRange ? computeTicks(min, max, scale) : [];

  // Same text color the live floating widget itself uses (ColorBarWidget.js's
  // tickContrast/currentContrastColor) — no outline or shadow, just the
  // plain, contrast-safe color the on-screen bar is actually showing right
  // now, so the export matches instead of inventing its own look.
  octx.fillStyle = currentContrastColor() || '#fff';

  function drawLabel(text, tx, ty, align, baseline) {
    if (!text) return;
    octx.textAlign = align;
    octx.textBaseline = baseline;
    octx.fillText(text, tx, ty);
  }

  // These mirror ColorBarWidget.js's TICK_LABEL_GAP, TICK_LABEL_SPAN_H and
  // LEGEND_GAP. They are screen-CSS-pixel layout constants, so pxScale maps
  // them into the export canvas just like the independently scaled fonts.
  const tickGap = 6 * pxScale;
  const legendGap = tickFont * (5 / 16);
  const horizontalLegendOffset = (6 + 22 + 5) * pxScale;
  const tickSpanV = () => {
    const savedFont = octx.font;
    octx.font = `${tickFont}px 'CrysViz Sans', sans-serif`;
    let widest = 34 * pxScale;
    for (const t of ticks) widest = Math.max(widest, octx.measureText(t.label).width);
    octx.font = savedFont;
    return widest;
  };
  const legendHalfHeight = () => {
    const savedFont = octx.font;
    octx.font = `${legendFont}px 'CrysViz Sans', sans-serif`;
    const m = octx.measureText(legendPlainText(legend) || 'Click to add legend');
    const ascent = m.actualBoundingBoxAscent || legendFont * 0.8;
    const descent = m.actualBoundingBoxDescent || legendFont * 0.2;
    octx.font = savedFont;
    return (ascent + descent) / 2;
  };
  const drawText = (fontPx, text, tx, ty, align, baseline) => {
    if (!text) return;
    octx.font = `${fontPx}px 'CrysViz Sans', sans-serif`;
    drawLabel(text, tx, ty, align, baseline);
  };
  // flipSide (ColorBarWidget.js's own flip toggle, carried through in
  // getSettings()) moves ticks/legend to the opposite side of the bar —
  // above instead of below in horizontal mode, left instead of right in
  // vertical — same as the live widget. This used to always draw the
  // default (non-flipped) side regardless of the widget's actual state, so
  // a flipped bar exported with its labels back on the default side.
  if (horizontal) {
    const tickY = flipSide ? y - tickGap : y + h + tickGap;
    const tickBaseline = flipSide ? 'bottom' : 'top';
    drawText(inputFont, validRange ? minLabel : '', x, tickY, 'left', tickBaseline);
    drawText(inputFont, validRange ? maxLabel : '', x + w, tickY, 'right', tickBaseline);
    for (const t of ticks) drawText(tickFont, t.label, x + t.frac * w, tickY, 'center', tickBaseline);
    if (legend) {
      const legendY = flipSide
        ? y - horizontalLegendOffset
        : y + h + horizontalLegendOffset;
      // Rich-text draw (bold/italic/sup/sub via utils/LegendRichText.js), not
      // drawLabel's plain fillText — matches whatever formatting the live
      // widget's legend (click-to-edit, ColorBarWidget.js) is showing.
      drawLegendRichText(octx, legend, x + w / 2, legendY, { fontPx: legendFont, align: 'center', baseline: tickBaseline });
    }
  } else {
    const tickX = flipSide ? x - tickGap : x + w + tickGap;
    const tickAlign = flipSide ? 'right' : 'left';
    drawText(inputFont, validRange ? maxLabel : '', tickX, y, tickAlign, 'top');
    drawText(inputFont, validRange ? minLabel : '', tickX, y + h, tickAlign, 'bottom');
    for (const t of ticks) drawText(tickFont, t.label, tickX, y + h - t.frac * h, tickAlign, 'middle');
    if (legend) {
      octx.save();
      const verticalLegendOffset = tickSpanV() + legendGap + legendHalfHeight();
      octx.translate(
        flipSide ? tickX - verticalLegendOffset : tickX + verticalLegendOffset,
        y + h / 2,
      );
      octx.rotate(-Math.PI / 2);
      drawLegendRichText(octx, legend, 0, 0, { fontPx: legendFont, align: 'center', baseline: 'middle' });
      octx.restore();
    }
  }
}

// Draws every color bar that's currently floated onto the scene (never a
// docked one — that lives in the side panel, not over #view, so it's no
// more "in the scene" than the panel itself) at its own true on-screen
// position, mapped through the crop.
function drawFloatingColorBars(octx, width, height, crop, viewRect) {
  const bars = listActiveColorBars().filter((bar) => bar.instance.isFloating());
  for (const bar of bars) {
    const visualRect = bar.instance.getVisualRect();
    const outRect = cropToOutputRect(viewFraction(visualRect, viewRect), crop, width, height);
    if (!outRect) continue; // dragged fully outside the chosen crop

    // The gradient strip itself, not the wrapper (which is a plain flex row
    // — controlsBar+valueRow side by side in horizontal mode) and not the
    // visual union (which also includes the tick labels/legend below/beside
    // it) — drawColorBar needs just the bar's own box to lay ticks out from.
    const barRect = bar.instance.getBarRect();
    const barOut = cropToOutputRect(viewFraction(barRect, viewRect), crop, width, height);
    if (!barOut) continue;

    const settings = bar.instance.getSettings();
    // barOut/barRect describe the exact same box in output vs. screen
    // pixels — their ratio is the uniform screen->output scale this whole
    // export is drawn at (crop + output resolution), so scaling the bar's
    // OWN live font sizes (already reflecting fontScale()) by that same ratio keeps exported text proportional to
    // what's on screen, instead of a size derived independently from
    // barOut's pixel box (which used to drift: THICKNESS never scales with
    // barLength for a horizontal bar, and the ratio changes with whatever
    // crop/output resolution the user picked, neither of which has
    // anything to do with the widget's own font scaling).
    const pxScale = barRect.width > 0 ? barOut.width / barRect.width : 1;
    const tickFont = Math.max(7, settings.tickFontPx * pxScale);
    const legendFont = Math.max(7, settings.legendFontPx * pxScale);
    const inputFont = Math.max(7, settings.inputFontPx * pxScale);
    drawColorBar(octx, settings, barOut.x, barOut.y, barOut.width, barOut.height,
      tickFont, legendFont, inputFont, pxScale);
  }
}

// The Composition Display legend (ui/CompositionLegendWidget.js): a widget
// whose entire purpose is to sit beside the structure in a figure, so it
// belongs in the capture. Same rule (and same floating class) as the color
// bars — only while it's actually over the scene.
//
// Drawn from the live DOM's own rects (swatch canvas blitted, text redrawn
// with its computed font), not the widget: the long-press menu and resize
// handle are chrome for operating the thing, not legend content. The body
// surface is filled only when the user hasn't stripped it via the long-press
// menu's Transparent option; otherwise the widget background is included.
function drawCompositionLegend(octx, width, height, crop, viewRect) {
  const widget = document.querySelector('.comp-legend-widget.cv-colorbar-floating');
  const body = /** @type {HTMLElement | null} */ (widget?.querySelector('.comp-legend-body'));
  if (!body) return;
  const rows = body.querySelectorAll('.comp-legend-row');
  if (!rows.length) return; // collapsed, or no structure ("No structure loaded.")

  const bodyRect = body.getBoundingClientRect();
  const bodyOut = cropToOutputRect(viewFraction(bodyRect, viewRect), crop, width, height);
  if (!bodyOut) return; // dragged fully outside the chosen crop
  const pxScale = bodyRect.width > 0 ? bodyOut.width / bodyRect.width : 1;

  const bodyStyle = window.getComputedStyle(body);
  const surface = bodyStyle.backgroundColor;
  if (surface && surface !== 'transparent' && !surface.startsWith('rgba(0, 0, 0, 0)')) {
    // Flat fill only — a 2D canvas has no backdrop-filter, so a blurred
    // panel prints as its own colour rather than as the scene behind it.
    roundRectPath(octx, bodyOut.x, bodyOut.y, bodyOut.width, bodyOut.height,
      (parseFloat(bodyStyle.borderRadius) || 0) * pxScale);
    octx.fillStyle = surface;
    octx.fill();
  }

  // The swatches are 30-CSS-px spheres; at export scale their on-screen
  // backing store would upscale into mush, so have the legend repaint them at
  // the size they're actually being drawn at.
  const swatchPx = Math.max(...[...rows].map((row) => {
    const canvas = row.querySelector('canvas');
    return canvas ? canvas.getBoundingClientRect().width * pxScale : 0;
  }));
  const restoreSwatches = repaintSwatchesForExport(swatchPx);
  try {
    for (const row of rows) {
      const canvas = /** @type {HTMLCanvasElement | null} */ (row.querySelector('canvas'));
      if (canvas) {
        const out = cropToOutputRect(viewFraction(canvas.getBoundingClientRect(), viewRect), crop, width, height);
        if (out) octx.drawImage(canvas, out.x, out.y, out.width, out.height);
      }
      for (const el of row.querySelectorAll('.comp-legend-label, .comp-legend-sub')) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        const out = cropToOutputRect(viewFraction(el.getBoundingClientRect(), viewRect), crop, width, height);
        if (!out) continue;
        const cs = window.getComputedStyle(el);
        octx.font = `${cs.fontWeight} ${(parseFloat(cs.fontSize) || 12) * pxScale}px ${cs.fontFamily}`;
        octx.fillStyle = cs.color;
        octx.textAlign = 'left';
        octx.textBaseline = 'middle';
        // The occupancy sub-line is dimmed by opacity, not by its colour.
        const alpha = parseFloat(cs.opacity);
        octx.globalAlpha = Number.isFinite(alpha) ? alpha : 1;
        octx.fillText(text, out.x, out.y + out.height / 2);
        octx.globalAlpha = 1;
      }
    }
  } finally {
    restoreSwatches();
  }
}

let captureInProgress = false;

/** Read-only ownership query for render-domain callers that can replace the
 * active pipeline. The capture wrapper sets this before any asynchronous work
 * begins and clears it in its outer finally. */
export function isPngCaptureInProgress() {
  return captureInProgress;
}

/**
 * Capture the current scene to a high-resolution PNG Blob.
 *
 * Tracer pipelines are driven to convergence one animation frame at a time
 * (paced tiled rendering that follows the general.rtTiledRender UI setting),
 * with the animate loop held off the renderer so the export is the single
 * render driver. Pass opts.signal (an AbortController's signal) to allow a
 * clean mid-export cancel: on abort the live view is fully restored (the same
 * finally as a normal completion) and an AbortError is thrown.
 *
 * @param {{width:number, height:number, transparent?:boolean,
 *   crop?: {x0:number, y0:number, x1:number, y1:number},
 *   onProgress?:(p:{current:number, target:number})=>void,
 *   signal?:AbortSignal}} opts
 *   crop: the chosen area, as fractions (0..1) of #view's own box — from
 *   ui/CropOverlay.js. Its on-screen aspect ratio must match width/height's
 *   (the crop tool enforces this), so the crop always fills the output
 *   exactly with no letterboxing. Omit it for a direct/programmatic capture
 *   of the full #view (no crop step) — same as passing the full-frame
 *   {x0:0, y0:0, x1:1, y1:1}.
 * @returns {Promise<Blob>}
 */
export async function captureSceneToPng(opts) {
  await crysVizFontsLoaded();
  if (captureInProgress) throw new Error('A PNG capture is already in progress.');
  captureInProgress = true;
  try {
    return await captureSceneToPngImpl(opts);
  } finally {
    captureInProgress = false;
  }
}

async function captureSceneToPngImpl(opts) {
  if (!app.renderer || !app.scene || !app.camera) {
    throw new Error('Scene is not ready.');
  }
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const transparent = !!opts.transparent;
  // crop is optional: omitting it (a direct/programmatic capture, no
  // ui/CropOverlay.js step) captures the full #view, same as the crop tool's
  // own full-frame default.
  const crop = opts.crop || { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (crop.x1 <= crop.x0 || crop.y1 <= crop.y0) {
    throw new Error('No export area selected.');
  }

  // Allocate (and PROVE) the output canvas up front, before any live-view
  // state is touched or a long tracer convergence starts: an over-limit
  // request fails here with a clear message instead of silently producing an
  // empty PNG at the end (see createVerifiedCanvas).
  const { canvas: out, ctx: octx } = createVerifiedCanvas(width, height, 'output image');

  const viewEl = getViewEl();
  const viewRect = viewEl.getBoundingClientRect();
  const vw = Math.max(1, viewEl.clientWidth || window.innerWidth);
  const vh = Math.max(1, viewEl.clientHeight || window.innerHeight);
  const aspect = vw / vh;

  // Save live-view state so we can restore exactly (camera projection is never
  // touched: every internal render keeps the #view aspect).
  const prevPixelRatio = app.renderer.getPixelRatio();
  const prevBackground = app.scene.background;
  const prevClearAlpha = app.renderer.getClearAlpha();
  const bgCss = colorToCss(prevBackground);

  let prevGizmoPR = null;
  // Exports always trace at 100% internal resolution regardless of the
  // interactive "RT resolution" setting.
  const prevRtScale = general.rtResolutionScale;
  const prevPaced = app.pipeline?._pacedExternally;
  const signal = opts.signal;

  try {
    // Take over rendering: hold the animate loop off the renderer (single
    // driver) and put tracer pipelines in externally-paced mode (one sample /
    // one tile per render call — no synchronous multi-sample resize freeze).
    app.offscreenRenderHold = true;
    app.pipeline?.beginPacedRender?.();
    app.renderer.setPixelRatio(1);
    app.scene.background = null;
    app.renderer.setClearAlpha(0);
    general.rtResolutionScale = 1;

    const innerW = width;
    const innerH = height;
    const cropFracW = crop.x1 - crop.x0;
    const cropFracH = crop.y1 - crop.y0;

    // --- Choose the source render size so the cropped region maps ~1:1
    //     (slightly super-sampled for AA) to the inner output box, capped by
    //     both the GPU limits and the requested output size (memory guard —
    //     escalating the source render unboundedly, plus the tracers' float
    //     accumulation targets, OOM-crashed Firefox on ~4K exports). Take the
    //     MAX of the two fill candidates (matching #view's own aspect ratio)
    //     so the render is big enough in BOTH dimensions regardless of how
    //     the crop's aspect compares to the output's — for a crop-tool
    //     selection the two already match (CropOverlay.js enforces it), so
    //     this reduces to the exact same size either way; for the no-crop
    //     fallback (full view, output aspect unconstrained) it avoids
    //     under-sizing one axis. Tracers skip the supersample: their AA comes
    //     from the accumulation jitter.
    const SS = app.pipeline?.isConverged ? 1.0 : 1.25;
    const scaleToFillW = innerW / Math.max(cropFracW, 1e-3);
    const scaleToFillH = innerH / Math.max(cropFracH, 1e-3);
    let srcW = Math.ceil(Math.max(scaleToFillW, scaleToFillH * aspect) * SS);
    let srcH = Math.ceil(srcW / aspect);

    // CPU-side sanity: the source is composited on a 2D canvas, so cap by
    // the requested output (no point rendering beyond output x SS) and an
    // absolute dimension guard (createVerifiedCanvas still proves whatever
    // survives this cap actually allocates).
    const srcCap = Math.min(Math.ceil(Math.max(width, height) * SS), 16384);
    if (srcW > srcCap || srcH > srcCap) {
      const k = srcCap / Math.max(srcW, srcH);
      srcW = Math.max(1, Math.floor(srcW * k));
      srcH = Math.max(1, Math.floor(srcH * k));
    }

    // GPU-side limits. Dimensions come from the driver; MEMORY does not —
    // the driver-reported MAX_TEXTURE_SIZE says nothing about it, and
    // over-memory allocations tend not to fail cleanly: they crash the
    // driver/GPU process, and Chromium answers repeated GPU crashes by
    // disabling WebGL for the whole browser session until restart. WebGL
    // cannot query real GPU memory, so the area budget comes from the
    // Settings > Graphics slider (user-asserted, defaults safe for
    // integrated GPUs). Tracers in export (paced) mode hold TWO full-size
    // RGBA32F targets (the display snapshot is shrunk for the export —
    // RayTracingPipeline's beginPacedRender) plus the drawing buffer;
    // raster pipelines just the buffer.
    const gl = app.renderer.getContext();
    const glMaxDim = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
      8192,
    );
    const isTracer = !!app.pipeline?.isConverged;
    const bytesPerPixel = isTracer ? 48 : 16;
    const maxPixels = renderMemoryBudgetBytes() / bytesPerPixel;

    // --- Final high-res pass (tracer pipelines render to full convergence,
    //     with the on-screen progress bar tracking the accumulation). A
    //     source too large for ONE GL surface renders TILED (bounded GPU
    //     memory at any size) whenever the pipeline/camera combination can
    //     express a sub-window — everything except a perspective-camera
    //     tracer, which instead caps the source and upscales (see
    //     makeTileCamera). ---
    let srcCanvas;
    if (srcW <= glMaxDim && srcH <= glMaxDim && srcW * srcH <= maxPixels) {
      srcCanvas = await renderMainToCanvasConverged(srcW, srcH, opts.onProgress, signal);
    } else if (!isTracer || app.camera.isOrthographicCamera === true) {
      let tileW = Math.min(srcW, glMaxDim);
      let tileH = Math.min(srcH, glMaxDim);
      if (tileW * tileH > maxPixels) {
        const k = Math.sqrt(maxPixels / (tileW * tileH));
        tileW = Math.max(64, Math.floor(tileW * k));
        tileH = Math.max(64, Math.floor(tileH * k));
      }
      console.info(`[png-export] rendering ${srcW}x${srcH} in `
        + `${Math.ceil(srcW / tileW)}x${Math.ceil(srcH / tileH)} tiles of ${tileW}x${tileH}.`);
      srcCanvas = await renderMainTiled(srcW, srcH, tileW, tileH, opts.onProgress, signal);
    } else {
      const capDim = Math.min(glMaxDim, Math.floor(Math.sqrt(maxPixels)));
      const k = Math.min(1, capDim / Math.max(srcW, srcH),
        Math.sqrt(maxPixels / (srcW * srcH)));
      srcW = Math.max(1, Math.floor(srcW * k));
      srcH = Math.max(1, Math.floor(srcH * k));
      console.info(`[png-export] perspective tracer cannot render tiled; source `
        + `capped to ${srcW}x${srcH} (the output upscales from it).`);
      srcCanvas = await renderMainToCanvasConverged(srcW, srcH, opts.onProgress, signal);
    }
    throwIfAborted(signal);

    const cropPxX = crop.x0 * srcW;
    const cropPxY = crop.y0 * srcH;
    const cropPxW = cropFracW * srcW;
    const cropPxH = cropFracH * srcH;

    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    if (!transparent) {
      octx.fillStyle = bgCss;
      octx.fillRect(0, 0, width, height);
    }
    // Contain-fit the crop into the output box, centred. A
    // real crop-tool selection already matches the output's aspect exactly
    // (ui/CropOverlay.js enforces it), so this reduces to filling innerW x
    // innerH with no letterboxing; the no-crop fallback (arbitrary output
    // dims vs the view's own aspect) is the case this centring actually
    // guards against distortion for.
    const scale = Math.min(innerW / cropPxW, innerH / cropPxH);
    const drawW = cropPxW * scale;
    const drawH = cropPxH * scale;
    const dx = (innerW - drawW) / 2;
    const dy = (innerH - drawH) / 2;
    octx.drawImage(srcCanvas, cropPxX, cropPxY, cropPxW, cropPxH, dx, dy, drawW, drawH);

    const map = {
      srcW, srcH, cropX: cropPxX, cropY: cropPxY, dx, dy, scale,
      // output px per on-screen CSS px, for scaling label font/padding sizes.
      fontScale: (cropPxH * scale) / Math.max(1, cropFracH * vh),
    };
    drawMeasurementLabels(octx, map);
    prevGizmoPR = drawGizmoAndLegend(octx, width, height, crop, viewRect);
    drawFloatingColorBars(octx, width, height, crop, viewRect);
    drawCompositionLegend(octx, width, height, crop, viewRect);

    return await new Promise((resolve, reject) => {
      out.toBlob((blob) => {
        if (blob) resolve(blob);
        else {
          reject(new Error(`Failed to encode the ${width}×${height} PNG — likely too `
            + 'large for this browser. Reduce the export resolution and try again.'));
        }
      }, 'image/png');
    });
  } finally {
    // Restore the live view. Camera projection was never changed. Runs on
    // normal completion AND on abort, so the view is always intact afterwards.
    app.pipeline?.endPacedRender?.();
    if (prevPaced) app.pipeline?.beginPacedRender?.();
    app.offscreenRenderHold = false;
    general.rtResolutionScale = prevRtScale;
    app.scene.background = prevBackground;
    app.renderer.setClearAlpha(prevClearAlpha);
    app.renderer.setPixelRatio(prevPixelRatio);
    const currentView = getViewEl();
    const currentW = Math.max(1, currentView.clientWidth || window.innerWidth);
    const currentH = Math.max(1, currentView.clientHeight || window.innerHeight);
    app.renderer.setSize(currentW, currentH, false);
    app.pipeline?.setSize(currentW, currentH);

    const gizmoDiv = document.getElementById('axesGizmo');
    if (app.gizmoRenderer && prevGizmoPR != null) {
      app.gizmoRenderer.setPixelRatio(prevGizmoPR);
      const gw = (gizmoDiv && gizmoDiv.clientWidth) || 110;
      const gh = (gizmoDiv && gizmoDiv.clientHeight) || 110;
      app.gizmoRenderer.setSize(gw, gh);
      if (app.gizmoCamera) {
        configureGizmoCameraProjection(app.gizmoCamera, gw / gh);
      }
    }
    requestRender();
  }
}

function colorToCss(bg) {
  if (bg && bg.isColor) return `#${bg.getHexString()}`;
  if (typeof general.defaultBackgroundColor === 'number') {
    return `#${new THREE.Color(general.defaultBackgroundColor).getHexString()}`;
  }
  return '#000000';
}
