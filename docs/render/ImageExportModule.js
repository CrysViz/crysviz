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
import { app, general, groups, measurements } from '../state/store.js';
import { latticeDirsNorm } from './LatticeModule.js';
import { markerColorFor } from './MeasurementModule.js';
import { requestRender } from './AnimateModule.js';
import { colorsFor, computeTicks, formatTick, currentContrastColor } from '../ui/ColorBarWidget.js';
import { listActiveColorBars } from '../ui/ColorBarRegistry.js';
import { repaintSwatchesForExport } from '../ui/CompositionLegendWidget.js';
import { legendPlainText, crysVizFontsLoaded } from '../utils/index.js';
import { CanvasPainter } from './exportPainters.js';
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

/** True when the render window is the camera's own full frame (or omitted). */
function isIdentityWindow(win) {
  return !win || (win.x0 === 0 && win.y0 === 0 && win.x1 === 1 && win.y1 === 1);
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
/** Tile origin positions covering [0, total) with 2*ov guard overlap between
 *  neighbours (edge tiles clamp inward), so every composited pixel has >= ov
 *  valid neighbour pixels inside its own tile for the smoothing filter. */
function tilePositions(total, tile, ov) {
  if (tile >= total) return [0];
  const step = tile - 2 * ov;
  const pos = [];
  for (let p = 0; ; p += step) {
    if (p + tile >= total) { pos.push(total - tile); break; }
    pos.push(p);
  }
  return pos;
}

async function renderMainTiled(srcW, srcH, tileW, tileH, onProgress, signal, win, composeTile) {
  const w0 = isIdentityWindow(win) ? 0 : win.x0;
  const h0 = isIdentityWindow(win) ? 0 : win.y0;
  const wW = isIdentityWindow(win) ? 1 : win.x1 - win.x0;
  const wH = isIdentityWindow(win) ? 1 : win.y1 - win.y0;
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
  // Guard overlap so the compositor's smoothing filter never reads past a
  // tile's own pixels at an interior seam (see tilePositions/composeTile).
  const OV = 8;
  const posX = tilePositions(srcW, tileW, OV);
  const posY = tilePositions(srcH, tileH, OV);
  // Disjoint per-tile ownership cuts: tile i owns [cut[i], cut[i+1]).
  const cutsX = [0, ...posX.slice(1).map((p) => p + OV), srcW];
  const cutsY = [0, ...posY.slice(1).map((p) => p + OV), srcH];
  const nx = posX.length;
  const ny = posY.length;
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
      const tx = posX[i];
      const ty = posY[j];
      // Tile rect composed through the render window, all in fractions of
      // the live camera's own frame (makeTileCamera is ratio-based).
      const tile = makeTileCamera(app.camera, 1, 1,
        w0 + (tx / srcW) * wW, h0 + (ty / srcH) * wH,
        (tileW / srcW) * wW, (tileH / srcH) * wH, isTracer);
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
      // The tile is composited STRAIGHT into the output canvas — a full
      // srcW x srcH intermediate would be the one remaining allocation that
      // grows with export size (a ~300 MB canvas at 7000x7000 outputs, on
      // top of the output itself: exactly the Firefox-killing spike).
      composeTile(app.renderer.domElement, tx, ty,
        cutsX[i], cutsX[i + 1], cutsY[j], cutsY[j + 1]);
    }
  }
}

// Like renderMainToCanvas, but for progressive tracer pipelines: keeps
// accumulating in small batches — yielding to the browser between them so the
// on-screen progress bar (render/TracerProgressModule.js, driven from
// pipeline.render()) stays live — until the pipeline reports convergence.
// Non-tracer pipelines (no isConverged) capture after the single frame.
async function renderMainToCanvasConverged(w, h, onProgress, signal, win) {
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
  // A non-identity window (scene-border margin, or a crop reaching outside
  // the view) renders through a widened/offset camera; identity keeps the
  // live camera untouched.
  const isTracer = !!app.pipeline?.isConverged;
  const cam = isIdentityWindow(win)
    ? { camera: app.camera, restore: () => {} }
    : makeTileCamera(app.camera, 1, 1, win.x0, win.y0, win.x1 - win.x0, win.y1 - win.y0, isTracer);
  const renderCtx = { renderer: app.renderer, scene: app.scene, camera: cam.camera };
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
  try {
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
        await nextFrame();          // yield first: the button/progress repaints
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
    // No await between the last render and this read (no preserveDrawingBuffer).
    ctx.drawImage(app.renderer.domElement, 0, 0, w, h);
    return canvas;
  } finally {
    cam.restore();
  }
}

// A DOM element's on-screen rect expressed as fractions (0..1, can extend
// outside that range) of #view's own rect — the common coordinate space
// every overlay (gizmo, legend, floating color bars) gets mapped through.
export function viewFraction(rect, viewRect) {
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
export function cropToOutputRect(viewFrac, crop, width, height) {
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

/** NDC of the LIVE view camera -> output pixels, through this export's crop.
 *  (The source spans map.win, which is wider than the view when a scene-border
 *  margin expanded it.) */
export function ndcToOutput(map, ndc) {
  const srcX = (((ndc.x * 0.5 + 0.5) - map.win.x0) / (map.win.x1 - map.win.x0)) * map.srcW;
  const srcY = (((1 - (ndc.y * 0.5 + 0.5)) - map.win.y0) / (map.win.y1 - map.win.y0)) * map.srcH;
  return {
    x: map.dx + (srcX - map.cropX) * map.scale,
    y: map.dy + (srcY - map.cropY) * map.scale,
  };
}

// The measurement value pills, redrawn as a rounded rect plus real text.
//
// These are THREE.Sprites in the scene (MeasurementModule.js made them so the
// depth buffer can clip them against atoms), which means the PNG export gets
// them for free — they are simply part of the render. Only a VECTOR export
// needs this: there the pill has to become an editable <text>, and the caller
// hides the sprites for the structure render so the value isn't printed twice.
//
// The geometry mirrors measureLabelTexture()'s canvas: a 64px bold face inside
// 0.2em vertical padding and a 0.11em border, i.e. fixed fractions of the
// pill's own height, which is what survives the world -> screen projection.
export function drawMeasurementLabels(painter, map) {
  const labels = measurements.measureLabels || [];
  if (!labels.length) return;
  const camUp = new THREE.Vector3();
  app.camera.matrixWorld.extractBasis(new THREE.Vector3(), camUp, new THREE.Vector3());
  camUp.normalize();

  for (const label of labels) {
    if (!label || label.visible === false) continue;
    const text = label.userData?.labelText;
    if (!text) continue;

    const ndc = label.position.clone().project(app.camera);
    if (ndc.z < -1 || ndc.z > 1) continue; // outside the near/far frustum
    const centre = ndcToOutput(map, ndc);
    // A sprite always faces the camera, so one world-height along the camera's
    // own up vector is exactly the pill's on-screen height.
    const topNdc = label.position.clone().addScaledVector(camUp, label.scale.y)
      .project(app.camera);
    const boxH = Math.abs(ndcToOutput(map, topNdc).y - centre.y);
    if (!(boxH > 0.5)) continue;
    const boxW = boxH * (label.userData.labelAspect || 2);
    const stroke = boxH * (0.11 * 64 / 104);
    const fontPx = boxH * (64 / 104);
    const border = markerColorFor(label.userData.type);

    // The texture strokes INSIDE the pill (roundRect inset by stroke/2), so
    // inset here too or the outline would grow the box.
    painter.roundRect(centre.x - boxW / 2 + stroke / 2, centre.y - boxH / 2 + stroke / 2,
      boxW - stroke, boxH - stroke, boxH * 0.3, {
        fill: '#ffffff', stroke: border, lineWidth: stroke, label: `${text} pill`,
      });
    painter.text(text, centre.x, centre.y + fontPx * 0.04, {
      fontPx, weight: 700, family: 'sans-serif',
      align: 'center', baseline: 'middle', fill: '#111111', label: text,
    });
  }
}

// Renders the gizmo (and, unless the labels are integrated onto its arrows,
// its separate a/b/c legend) at its own true on-screen position, mapped
// through the crop — wherever ui/GizmoDrag.js has it sitting right now.
// Skipped entirely if the gizmo is hidden, or dragged fully outside the
// chosen crop. Returns true when the gizmo renderer was resized, so the
// caller knows it has to be put back.
export function drawGizmoAndLegend(painter, width, height, crop, viewRect) {
  const outRect = gizmoOutputRect(width, height, crop, viewRect);
  if (!outRect) return false;
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
  painter.image(app.gizmoRenderer.domElement, outRect.x, outRect.y, outRect.width, outRect.height,
    { label: 'Axis gizmo' });

  // The a/b/c letters are already baked into that render when integrated
  // onto the arrows (general.gizmoLabelsOnArrows, ui/GizmoDrag.js) — the
  // separate legend box is only needed as the alternative to that.
  const legendOut = axesLegendOutputRect(width, height, crop, viewRect);
  if (legendOut) drawAxesLegend(painter, legendOut);
  return true;
}

/** The gizmo's output-pixel rect, or null when it is hidden or fully outside
 *  the crop. Split out of drawGizmoAndLegend so the SVG exporter — which
 *  draws vector arrows instead of blitting the gizmo renderer — can lay them
 *  out in exactly the same box. */
export function gizmoOutputRect(width, height, crop, viewRect) {
  const gizmoDiv = document.getElementById('axesGizmo');
  if (!app.gizmoRenderer || !app.gizmoScene || !app.gizmoCamera || !gizmoDiv) return null;
  if (!general.showAxes) return null;
  if (gizmoDiv.style.display === 'none') return null;
  return cropToOutputRect(viewFraction(gizmoDiv.getBoundingClientRect(), viewRect),
    crop, width, height);
}

/** Same, for the separate a/b/c legend box (only shown when the letters are
 *  not integrated onto the arrows). */
export function axesLegendOutputRect(width, height, crop, viewRect) {
  if (general.gizmoLabelsOnArrows) return null;
  const legendDiv = document.getElementById('axesLegend');
  if (!legendDiv || legendDiv.style.display === 'none') return null;
  return cropToOutputRect(viewFraction(legendDiv.getBoundingClientRect(), viewRect),
    crop, width, height);
}

// The a/b/c legend box (mirrors #axesLegend), filling the exact output rect
// its on-screen counterpart maps to. Colours match the gizmo arrows /
// .dot-a/b/c CSS.
export function drawAxesLegend(painter, rect) {
  const rows = [['a', '#ff3333'], ['b', '#33cc33'], ['c', '#3366ff']];
  const font = Math.max(7, rect.height * 0.15);
  const dot = font * 0.85;
  const padX = font * 0.6;
  const gap = font * 0.5;
  const rowH = rect.height / rows.length;

  painter.roundRect(rect.x, rect.y, rect.width, rect.height, font * 0.5, {
    fill: 'rgba(0,0,0,0.8)',
    stroke: 'rgba(255,255,255,0.2)',
    lineWidth: Math.max(1, font * 0.06),
    label: 'Axes legend box',
  });

  for (let i = 0; i < rows.length; i++) {
    const [ch, color] = rows[i];
    const cy = rect.y + rowH * (i + 0.5);
    painter.circle(rect.x + padX + dot / 2, cy, dot / 2, {
      fill: color,
      stroke: 'rgba(255,255,255,0.4)',
      lineWidth: Math.max(1, dot * 0.08),
      label: `${ch} dot`,
    });
    painter.text(ch, rect.x + padX + dot + gap, cy, {
      fontPx: font, weight: 600, align: 'left', baseline: 'middle', fill: '#fff', label: ch,
    });
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
function drawColorBar(painter, settings, x, y, w, h, tickFont, legendFont, inputFont, pxScale = 1) {
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
  const step = Math.max(1, Math.floor(colors.length / 20));
  const stops = [];
  for (let i = 0; i < colors.length; i += step) {
    stops.push({ offset: i / colors.length, color: `#${colors[i].getHexString()}` });
  }
  // Matches the live bar exactly: a CSS border-radius:4px on the <canvas>
  // (ColorBarWidget.js) and NO border/stroke at all. This used to be a
  // plain fillRect+strokeRect — sharp corners plus a white outline the live
  // widget never actually has — so the export looked like a different,
  // boxier bar instead of a redraw of the one on screen.
  painter.gradientRect(x, y, w, h, 4 * pxScale, {
    stops, horizontal, label: 'Colour bar gradient',
  });

  const validRange = isFinite(min) && isFinite(max) && min < max;
  const ticks = validRange ? computeTicks(min, max, scale) : [];

  // Same text color the live floating widget itself uses (ColorBarWidget.js's
  // tickContrast/currentContrastColor) — no outline or shadow, just the
  // plain, contrast-safe color the on-screen bar is actually showing right
  // now, so the export matches instead of inventing its own look.
  const inkColor = currentContrastColor() || '#fff';

  // These mirror ColorBarWidget.js's TICK_LABEL_GAP, TICK_LABEL_SPAN_H and
  // LEGEND_GAP. They are screen-CSS-pixel layout constants, so pxScale maps
  // them into the export canvas just like the independently scaled fonts.
  const tickGap = 6 * pxScale;
  const legendGap = tickFont * (5 / 16);
  const horizontalLegendOffset = (6 + 22 + 5) * pxScale;
  const tickSpanV = () => {
    let widest = 34 * pxScale;
    for (const t of ticks) {
      widest = Math.max(widest, painter.measureText(t.label, { fontPx: tickFont }).width);
    }
    return widest;
  };
  const legendHalfHeight = () => {
    // The string's own ink box, not the font box: this centres the rotated
    // legend on the glyphs actually drawn (what the live widget does).
    const m = painter.measureText(legendPlainText(legend) || 'Click to add legend',
      { fontPx: legendFont });
    return (m.inkAscent + m.inkDescent) / 2;
  };
  const drawText = (fontPx, text, tx, ty, align, baseline) => {
    if (!text) return;
    painter.text(text, tx, ty, { fontPx, align, baseline, fill: inkColor, label: text });
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
      // drawText's plain single run — matches whatever formatting the live
      // widget's legend (click-to-edit, ColorBarWidget.js) is showing.
      painter.richText(legend, x + w / 2, legendY,
        { fontPx: legendFont, align: 'center', baseline: tickBaseline, fill: inkColor });
    }
  } else {
    const tickX = flipSide ? x - tickGap : x + w + tickGap;
    const tickAlign = flipSide ? 'right' : 'left';
    drawText(inputFont, validRange ? maxLabel : '', tickX, y, tickAlign, 'top');
    drawText(inputFont, validRange ? minLabel : '', tickX, y + h, tickAlign, 'bottom');
    for (const t of ticks) drawText(tickFont, t.label, tickX, y + h - t.frac * h, tickAlign, 'middle');
    if (legend) {
      const verticalLegendOffset = tickSpanV() + legendGap + legendHalfHeight();
      painter.richText(
        legend,
        flipSide ? tickX - verticalLegendOffset : tickX + verticalLegendOffset,
        y + h / 2,
        { fontPx: legendFont, align: 'center', baseline: 'middle', fill: inkColor, rotateDeg: -90 },
      );
    }
  }
}

// Draws every color bar that's currently floated onto the scene (never a
// docked one — that lives in the side panel, not over #view, so it's no
// more "in the scene" than the panel itself) at its own true on-screen
// position, mapped through the crop.
export function drawFloatingColorBars(painter, width, height, crop, viewRect) {
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
    // One sublayer per bar, so a figure with several of them can be
    // rearranged bar by bar in Inkscape (a no-op on the canvas painter).
    painter.beginGroup(`Colour bar: ${bar.label || bar.id}`, `layer-colorbar-${bar.id}`);
    drawColorBar(painter, settings, barOut.x, barOut.y, barOut.width, barOut.height,
      tickFont, legendFont, inputFont, pxScale);
    painter.endGroup();
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
export function drawCompositionLegend(painter, width, height, crop, viewRect) {
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
    painter.roundRect(bodyOut.x, bodyOut.y, bodyOut.width, bodyOut.height,
      (parseFloat(bodyStyle.borderRadius) || 0) * pxScale,
      { fill: surface, label: 'Composition legend panel' });
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
        if (out) painter.image(canvas, out.x, out.y, out.width, out.height, { label: 'Swatch' });
      }
      for (const el of row.querySelectorAll('.comp-legend-label, .comp-legend-sub')) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        const out = cropToOutputRect(viewFraction(el.getBoundingClientRect(), viewRect), crop, width, height);
        if (!out) continue;
        const cs = window.getComputedStyle(el);
        // The occupancy sub-line is dimmed by opacity, not by its colour.
        const alpha = parseFloat(cs.opacity);
        painter.text(text, out.x, out.y + out.height / 2, {
          fontPx: (parseFloat(cs.fontSize) || 12) * pxScale,
          weight: cs.fontWeight,
          family: cs.fontFamily,
          align: 'left',
          baseline: 'middle',
          fill: cs.color,
          alpha: Number.isFinite(alpha) ? alpha : 1,
          label: text,
        });
      }
    }
  } finally {
    restoreSwatches();
  }
}

/**
 * The on-screen bounding box of everything a figure-style export would want
 * framed: the structure content (atoms/bonds/polyhedra/cell, forces/spins,
 * fields/isosurfaces, structure overlays — NOT the ground plane, a scene
 * fixture that spans the whole frame) projected through the live camera,
 * united with the visible floating overlays' DOM rects (gizmo + its legend,
 * floating color bars, the Composition Display legend). In #view CSS pixels.
 * Used by the export dialog to seed the crop overlay's starting selection.
 * @returns {{left:number, top:number, width:number, height:number} | null}
 *   null when there is no content or no scene yet.
 */
export function computeContentScreenBox({ structureOnly = false } = {}) {
  if (!app.renderer || !app.scene || !app.camera) return null;
  const viewEl = getViewEl();
  if (!viewEl) return null;
  const viewRect = viewEl.getBoundingClientRect();
  const vw = Math.max(1, viewEl.clientWidth || window.innerWidth);
  const vh = Math.max(1, viewEl.clientHeight || window.innerHeight);

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const include = (x0, y0, x1, y1) => {
    minX = Math.min(minX, x0); minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
  };

  // --- structure content: world boxes projected through the live camera ---
  const objects = [
    groups.atomsMesh, groups.ghostAtomsMesh, groups.bondsMesh,
    groups.polyhedraGroup, groups.latticeGroup,
    groups.forcesShaftMesh, groups.forcesTipMesh,
    groups.spinShaftMesh, groups.spinTipMesh,
    groups.fieldGroup, groups.isosurfaceGroup,
  ];
  for (const entry of groups.overlayMeshes.values()) {
    objects.push(entry?.atomsMesh, entry?.bondsMesh);
  }
  const worldBox = new THREE.Box3();
  const objBox = new THREE.Box3();
  for (const obj of objects) {
    if (!obj || obj.visible === false) continue;
    // InstancedMesh caches its bounding box; recompute so moved atoms count.
    obj.traverse?.((child) => { if (child.isInstancedMesh) child.computeBoundingBox(); });
    objBox.setFromObject(obj);
    if (!objBox.isEmpty()) worldBox.union(objBox);
  }
  if (!worldBox.isEmpty()) {
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? worldBox.max.x : worldBox.min.x,
        i & 2 ? worldBox.max.y : worldBox.min.y,
        i & 4 ? worldBox.max.z : worldBox.min.z,
      ).project(app.camera);
      const x = (corner.x * 0.5 + 0.5) * vw;
      const y = (1 - (corner.y * 0.5 + 0.5)) * vh;
      include(x, y, x, y);
    }
  }

  // --- visible floating overlays: their true on-screen DOM rects
  //     (skipped for a structure-only framing) ---
  const domRect = (el) => {
    if (structureOnly) return;
    if (!el || el.style?.display === 'none') return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return;
    include(r.left - viewRect.left, r.top - viewRect.top,
      r.right - viewRect.left, r.bottom - viewRect.top);
  };
  if (general.showAxes) {
    domRect(document.getElementById('axesGizmo'));
    if (!general.gizmoLabelsOnArrows) domRect(document.getElementById('axesLegend'));
  }
  for (const bar of listActiveColorBars()) {
    if (!structureOnly && bar.instance.isFloating()) {
      const r = bar.instance.getVisualRect();
      include(r.left - viewRect.left, r.top - viewRect.top,
        r.right - viewRect.left, r.bottom - viewRect.top);
    }
  }
  domRect(document.querySelector('.comp-legend-widget.cv-colorbar-floating'));

  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

let captureInProgress = false;

/** Read-only ownership query for render-domain callers that can replace the
 * active pipeline. renderStructureForExport sets this before any asynchronous
 * work begins and clears it in its outer finally — so an SVG export that
 * renders the structure owns the renderer on exactly the same terms a PNG
 * export does. */
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
 * @param {{width:number, height:number, margin?:number, transparent?:boolean,
 *   structureOnly?: boolean,
 *   crop?: {x0:number, y0:number, x1:number, y1:number},
 *   onProgress?:(p:{current:number, target:number})=>void,
 *   signal?:AbortSignal}} opts
 *   structureOnly: omit the axes gizmo/legend, floating color bars, and the
 *   composition legend from the capture — just the structure (measurement
 *   labels stay).
 *   margin: pixels of SCENE border added inside the width x height output —
 *   the capture window widens so the band shows the scene continuing beyond
 *   the captured area (the content itself occupies the central
 *   (width-2*margin) x (height-2*margin) box). A perspective-camera tracer
 *   cannot widen its ray window; there the band falls back to blank
 *   background/transparency.
 *   crop: the chosen area, as fractions (0..1) of #view's own box — from
 *   ui/CropOverlay.js. Its on-screen aspect ratio must match width/height's
 *   (the crop tool enforces this), so the crop always fills the output
 *   exactly with no letterboxing. Omit it for a direct/programmatic capture
 *   of the full #view (no crop step) — same as passing the full-frame
 *   {x0:0, y0:0, x1:1, y1:1}.
 * @returns {Promise<Blob>}
 */
export async function captureSceneToPng(opts) {
  const margin = Math.max(0, Math.round(opts.margin || 0));
  const perspectiveTracer = !!app.pipeline?.isConverged
    && app.camera?.isOrthographicCamera !== true;
  if (margin > 0 && perspectiveTracer) {
    // The tracers build rays from symmetric extents a view offset can't
    // reach (see makeTileCamera), and only an orthographic camera can be
    // widened by translation — so a perspective tracer gets the margin as
    // a blank band instead of surrounding scene: capture at the inner
    // size, then pad.
    const width = Math.max(1, Math.round(opts.width));
    const height = Math.max(1, Math.round(opts.height));
    if (margin * 2 >= width || margin * 2 >= height) {
      throw new Error('Margin is too large for the requested output size.');
    }
    console.info('[png-export] perspective tracer cannot widen its camera window; '
      + 'margin rendered as a blank band.');
    return await captureSceneToPngImpl(
      { ...opts, margin: 0, width: width - 2 * margin, height: height - 2 * margin },
      async (inner) => {
        const { canvas, ctx } = createVerifiedCanvas(width, height, 'output image');
        if (!opts.transparent) {
          ctx.fillStyle = colorToCss(app.scene.background);
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(inner, margin, margin);
        return encodePng(canvas);
      });
  }
  return await captureSceneToPngImpl(opts);
}

function encodePng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else {
        reject(new Error(`Failed to encode the ${canvas.width}×${canvas.height} PNG — likely `
          + 'too large for this browser. Reduce the export resolution and try again.'));
      }
    }, 'image/png');
  });
}

// --- Export geometry --------------------------------------------------------
//
// Split out of the render so the SVG exporter's VECTOR mode can obtain the
// same NDC -> output-pixel mapping without rendering a single GL frame: the
// projection of the scene is done in JS there, but it still has to land in
// exactly the pixel positions the overlays are laid out in.

/** Everything about the requested output that depends only on the options and
 *  the live #view box — no renderer state, no GL limits. */
function computeExportLayout(opts) {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  // crop is optional: omitting it (a direct/programmatic capture, no
  // ui/CropOverlay.js step) captures the full #view, same as the crop tool's
  // own full-frame default.
  let crop = opts.crop || { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (crop.x1 <= crop.x0 || crop.y1 <= crop.y0) {
    throw new Error('No export area selected.');
  }
  // Scene-border margin: widen the capture window so the band shows the
  // scene continuing beyond the captured area (blank-band fallback for
  // perspective tracers is handled by the captureSceneToPng wrapper). The
  // expansion is sized so the original crop lands exactly in the central
  // (width-2*margin) x (height-2*margin) box of the output.
  const margin = Math.max(0, Math.round(opts.margin || 0));
  if (margin > 0) {
    if (margin * 2 >= width || margin * 2 >= height) {
      throw new Error('Margin is too large for the requested output size.');
    }
    const ax = (crop.x1 - crop.x0) * margin / (width - 2 * margin);
    const ay = (crop.y1 - crop.y0) * margin / (height - 2 * margin);
    crop = { x0: crop.x0 - ax, y0: crop.y0 - ay, x1: crop.x1 + ax, y1: crop.y1 + ay };
  }
  // The source render covers the WINDOW: identical to the view unless the
  // crop reaches outside it (margin expansion, or a caller-supplied crop
  // beyond the view edges) — the normal in-view case keeps its exact
  // existing path.
  const win = (crop.x0 < 0 || crop.y0 < 0 || crop.x1 > 1 || crop.y1 > 1)
    ? { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 }
    : { x0: 0, y0: 0, x1: 1, y1: 1 };

  const viewEl = getViewEl();
  const viewRect = viewEl.getBoundingClientRect();
  const vw = Math.max(1, viewEl.clientWidth || window.innerWidth);
  const vh = Math.max(1, viewEl.clientHeight || window.innerHeight);
  const winW = win.x1 - win.x0;
  const winH = win.y1 - win.y0;
  return {
    width, height, crop, margin, win, viewEl, viewRect, vw, vh,
    // Crop as fractions OF THE SOURCE WINDOW (== view fractions when the
    // window is the view), and the window's own on-screen aspect.
    cropFracW: (crop.x1 - crop.x0) / winW,
    cropFracH: (crop.y1 - crop.y0) / winH,
    srcAspect: (winW * vw) / (winH * vh),
  };
}

/**
 * Contain-fit the crop into the output box, centred: a real crop-tool
 * selection already matches the output's aspect exactly (ui/CropOverlay.js
 * enforces it), so this reduces to filling width x height with no
 * letterboxing; the no-crop fallback (arbitrary output dims vs the view's own
 * aspect) is the case the centring actually guards against distortion for.
 *
 * The resulting NDC -> output-pixel composition is INVARIANT to srcW/srcH (as
 * long as srcH keeps the window's aspect): every srcW factor cancels against
 * `scale`. That is what lets the vector path build a map from a nominal source
 * size instead of a rendered one.
 */
function buildOutputMap(layout, srcW, srcH) {
  const { width: innerW, height: innerH, crop, win, cropFracW, cropFracH } = layout;
  const winW = win.x1 - win.x0;
  const winH = win.y1 - win.y0;
  const cropX = ((crop.x0 - win.x0) / winW) * srcW;
  const cropY = ((crop.y0 - win.y0) / winH) * srcH;
  const cropPxW = cropFracW * srcW;
  const cropPxH = cropFracH * srcH;
  const scale = Math.min(innerW / cropPxW, innerH / cropPxH);
  const drawW = cropPxW * scale;
  const drawH = cropPxH * scale;
  return {
    srcW, srcH, win, cropX, cropY, cropPxW, cropPxH, drawW, drawH, scale,
    dx: (innerW - drawW) / 2,
    dy: (innerH - drawH) / 2,
  };
}

/**
 * The crop/overlay geometry for `opts` WITHOUT rendering anything — the SVG
 * exporter's vector mode projects the scene itself and only needs the mapping.
 * @param {{width:number, height:number, margin?:number,
 *   crop?:{x0:number,y0:number,x1:number,y1:number}}} opts
 */
export function computeExportViewMapping(opts) {
  const layout = computeExportLayout(opts);
  // Nominal source size at the window's aspect (see buildOutputMap: the
  // mapping does not depend on which one we pick).
  const srcW = Math.max(1, layout.width / Math.max(layout.cropFracW, 1e-3));
  const srcH = Math.max(1, srcW / layout.srcAspect);
  return { ...layout, map: buildOutputMap(layout, srcW, srcH) };
}

// --- Structure render + overlay compositing ---------------------------------

/**
 * Render the structure into an output canvas at the requested size and hand it
 * to `consume`, which composites whatever overlays it wants on top and returns
 * the finished artifact (a PNG Blob, an SVG Blob, …).
 *
 * `consume` deliberately runs INSIDE the try, before the finally restores the
 * live view: the overlays are drawn from live DOM/gizmo state, and a view
 * resized mid-encode must be restored at its size at true completion time
 * (pngexport.test.js pins this).
 *
 * @param {object} opts same shape as captureSceneToPng's
 * @param {(ex: {canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D,
 *   map:object, crop:object, viewRect:DOMRect, width:number, height:number,
 *   transparent:boolean, bgCss:string, noteGizmoResized:()=>void})
 *   => Promise<Blob>} consume
 * @returns {Promise<Blob>}
 */
export async function renderStructureForExport(opts, consume) {
  await crysVizFontsLoaded();
  if (captureInProgress) throw new Error('A PNG capture is already in progress.');
  captureInProgress = true;
  try {
    return await renderStructureForExportImpl(opts, consume);
  } finally {
    captureInProgress = false;
  }
}

async function renderStructureForExportImpl(opts, consume) {
  if (!app.renderer || !app.scene || !app.camera) {
    throw new Error('Scene is not ready.');
  }
  const layout = computeExportLayout(opts);
  const { width, height, crop, win, viewRect, cropFracW, cropFracH, srcAspect } = layout;
  const transparent = !!opts.transparent;
  if (!isIdentityWindow(win) && app.pipeline?.isConverged
      && app.camera?.isOrthographicCamera !== true) {
    throw new Error('A perspective-camera ray-traced export cannot capture outside the visible view.');
  }

  // Allocate (and PROVE) the output canvas up front, before any live-view
  // state is touched or a long tracer convergence starts: an over-limit
  // request fails here with a clear message instead of silently producing an
  // empty PNG at the end (see createVerifiedCanvas).
  const { canvas: out, ctx: octx } = createVerifiedCanvas(width, height, 'output image');

  // Save live-view state so we can restore exactly (camera projection is never
  // touched: every internal render keeps the #view aspect).
  const prevPixelRatio = app.renderer.getPixelRatio();
  const prevBackground = app.scene.background;
  const prevClearAlpha = app.renderer.getClearAlpha();
  const bgCss = colorToCss(prevBackground);

  const prevGizmoPR = app.gizmoRenderer ? app.gizmoRenderer.getPixelRatio() : null;
  let gizmoResized = false;
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
    let srcW = Math.ceil(Math.max(scaleToFillW, scaleToFillH * srcAspect) * SS);
    let srcH = Math.ceil(srcW / srcAspect);

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

    // Whether one GL surface can hold the whole source, and whether the
    // pipeline/camera combination can express tiles — everything except a
    // perspective-camera tracer, which instead caps the source and upscales
    // (see makeTileCamera).
    const single = srcW <= glMaxDim && srcH <= glMaxDim && srcW * srcH <= maxPixels;
    const canTile = !isTracer || app.camera.isOrthographicCamera === true;
    if (!single && !canTile) {
      const capDim = Math.min(glMaxDim, Math.floor(Math.sqrt(maxPixels)));
      const k = Math.min(1, capDim / Math.max(srcW, srcH),
        Math.sqrt(maxPixels / (srcW * srcH)));
      srcW = Math.max(1, Math.floor(srcW * k));
      srcH = Math.max(1, Math.floor(srcH * k));
      console.info(`[png-export] perspective tracer cannot render tiled; source `
        + `capped to ${srcW}x${srcH} (the output upscales from it).`);
    }

    // Source -> output mapping, computed BEFORE rendering so the tiled path
    // can composite each tile straight into the output canvas.
    const map = buildOutputMap(layout, srcW, srcH);
    const { cropX: cropPxX, cropY: cropPxY, cropPxW, cropPxH, scale, drawW, drawH, dx, dy } = map;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    if (!transparent) {
      octx.fillStyle = bgCss;
      octx.fillRect(0, 0, width, height);
    }

    // --- Final high-res pass (tracer pipelines render to full convergence,
    //     with the on-screen progress bar tracking the accumulation). A
    //     source too large for ONE GL surface renders TILED — bounded GPU
    //     memory at any size, and no full-size CPU intermediate either:
    //     each tile lands in the output directly, clipped to its own
    //     disjoint ownership region (so transparency never
    //     double-composites) while the whole tile is available to the
    //     smoothing filter (the guard overlap prevents seams). ---
    if (single || !canTile) {
      const srcCanvas = await renderMainToCanvasConverged(srcW, srcH, opts.onProgress, signal, win);
      throwIfAborted(signal);
      octx.drawImage(srcCanvas, cropPxX, cropPxY, cropPxW, cropPxH, dx, dy, drawW, drawH);
    } else {
      let tileW = Math.min(srcW, glMaxDim);
      let tileH = Math.min(srcH, glMaxDim);
      if (tileW * tileH > maxPixels) {
        const k = Math.sqrt(maxPixels / (tileW * tileH));
        tileW = Math.max(64, Math.floor(tileW * k));
        tileH = Math.max(64, Math.floor(tileH * k));
      }
      console.info(`[png-export] rendering ${srcW}x${srcH} in `
        + `${Math.ceil(srcW / tileW)}x${Math.ceil(srcH / tileH)} tiles of ${tileW}x${tileH}.`);
      const composeTile = (canvasEl, tx, ty, cx0, cx1, cy0, cy1) => {
        const rx0 = Math.max(dx + (cx0 - cropPxX) * scale, dx);
        const ry0 = Math.max(dy + (cy0 - cropPxY) * scale, dy);
        const rx1 = Math.min(dx + (cx1 - cropPxX) * scale, dx + drawW);
        const ry1 = Math.min(dy + (cy1 - cropPxY) * scale, dy + drawH);
        if (rx1 <= rx0 || ry1 <= ry0) return; // tile fully outside the crop
        octx.save();
        octx.beginPath();
        octx.rect(rx0, ry0, rx1 - rx0, ry1 - ry0);
        octx.clip();
        octx.drawImage(canvasEl,
          dx + (tx - cropPxX) * scale, dy + (ty - cropPxY) * scale,
          tileW * scale, tileH * scale);
        octx.restore();
      };
      await renderMainTiled(srcW, srcH, tileW, tileH, opts.onProgress, signal, win, composeTile);
      throwIfAborted(signal);
    }

    return await consume({
      canvas: out,
      ctx: octx,
      map,
      crop,
      viewRect,
      width,
      height,
      transparent,
      bgCss,
      noteGizmoResized: () => { gizmoResized = true; },
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
    if (app.gizmoRenderer && prevGizmoPR != null && gizmoResized) {
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

/**
 * The standard overlay stack, in the order the PNG export has always drawn it.
 * The painter decides whether that lands as pixels or as SVG elements.
 * @param {{isVector:boolean}} painter
 */
export function drawExportOverlays(painter, ex, opts) {
  // Measurement value pills are NOT here: they are sprites in the scene, so
  // the structure render already contains them (drawMeasurementLabels exists
  // for the vector export, which has to re-emit them as editable text).
  //
  // structureOnly: a bare figure of the structure itself — no axes gizmo/
  // legend, floating color bars, or composition legend.
  if (!opts.structureOnly) {
    if (drawGizmoAndLegend(painter, ex.width, ex.height, ex.crop, ex.viewRect)) {
      ex.noteGizmoResized();
    }
    drawFloatingColorBars(painter, ex.width, ex.height, ex.crop, ex.viewRect);
    drawCompositionLegend(painter, ex.width, ex.height, ex.crop, ex.viewRect);
  }
}

// finish(outCanvas) -> Promise<Blob> runs INSIDE renderStructureForExport's
// try, before the finally restores the live view — deliberately: a view
// resized mid-encode must be restored at its size at true completion time
// (pngexport.test.js pins this). The default just encodes; the blank-band
// margin fallback pads first.
function captureSceneToPngImpl(opts, finish = encodePng) {
  return renderStructureForExport(opts, async (ex) => {
    drawExportOverlays(new CanvasPainter(ex.ctx), ex, opts);
    return finish(ex.canvas);
  });
}

export function colorToCss(bg) {
  if (bg && bg.isColor) return `#${bg.getHexString()}`;
  if (typeof general.defaultBackgroundColor === 'number') {
    return `#${new THREE.Color(general.defaultBackgroundColor).getHexString()}`;
  }
  return '#000000';
}
