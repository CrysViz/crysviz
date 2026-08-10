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
import { drawLegendRichText } from '../utils/index.js';

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

// Like renderMainToCanvas, but for progressive tracer pipelines: keeps
// accumulating in small batches — yielding to the browser between them so the
// on-screen progress bar (render/TracerProgressModule.js, driven from
// pipeline.render()) stays live — until the pipeline reports convergence.
// Non-tracer pipelines (no isConverged) capture after the single frame.
async function renderMainToCanvasConverged(w, h, onProgress, signal) {
  app.renderer.setSize(w, h, false);
  app.pipeline?.setSize(w, h);
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
      app.pipeline.render(renderCtx); // one paced sample (one tile when tiling)
      reportProgress();
    }
    reportProgress(); // final (converged) count
  } else {
    app.pipeline?.render(renderCtx); // raster: single frame, capture immediately
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
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
function cropToOutputRect(viewFrac, crop, width, height, margin) {
  const cw = crop.x1 - crop.x0;
  const ch = crop.y1 - crop.y0;
  if (cw <= 0 || ch <= 0) return null;
  const innerW = width - 2 * margin;
  const innerH = height - 2 * margin;
  const x0 = margin + ((viewFrac.x0 - crop.x0) / cw) * innerW;
  const y0 = margin + ((viewFrac.y0 - crop.y0) / ch) * innerH;
  const x1 = margin + ((viewFrac.x1 - crop.x0) / cw) * innerW;
  const y1 = margin + ((viewFrac.y1 - crop.y0) / ch) * innerH;
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

    octx.font = `${cs.fontWeight || '700'} ${fontPx}px ${cs.fontFamily || 'sans-serif'}`;
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
function drawGizmoAndLegend(octx, width, height, margin, crop, viewRect) {
  const gizmoDiv = document.getElementById('axesGizmo');
  if (!app.gizmoRenderer || !app.gizmoScene || !app.gizmoCamera || !gizmoDiv) return null;
  if (!general.showAxes) return null;
  if (gizmoDiv.style.display === 'none') return null;

  const outRect = cropToOutputRect(viewFraction(gizmoDiv.getBoundingClientRect(), viewRect), crop, width, height, margin);
  if (!outRect) return null;

  const prevGizmoPR = app.gizmoRenderer.getPixelRatio();
  const gsize = Math.max(16, Math.round(Math.max(outRect.width, outRect.height)));
  app.gizmoRenderer.setPixelRatio(1);
  app.gizmoRenderer.setSize(gsize, gsize, false);
  app.gizmoCamera.aspect = 1;
  app.gizmoCamera.updateProjectionMatrix();

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
      const legendOut = cropToOutputRect(viewFraction(legendDiv.getBoundingClientRect(), viewRect), crop, width, height, margin);
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

  ictx.font = `600 ${font}px sans-serif`;
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
function drawColorBar(octx, settings, x, y, w, h, font, pxScale = 1) {
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

  // Matches the live widget's own tick-label font exactly (normal weight,
  // the app's actual font stack) — this used to hardcode a semi-bold generic
  // "sans-serif", which browsers usually resolve to something like Arial:
  // both bolder and visibly different from the app's -apple-system/Segoe UI
  // stack, so the exported text never quite looked like the on-screen bar.
  octx.font = `${font}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
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

  const tickGap = font * 0.4;
  // flipSide (ColorBarWidget.js's own flip toggle, carried through in
  // getSettings()) moves ticks/legend to the opposite side of the bar —
  // above instead of below in horizontal mode, left instead of right in
  // vertical — same as the live widget. This used to always draw the
  // default (non-flipped) side regardless of the widget's actual state, so
  // a flipped bar exported with its labels back on the default side.
  if (horizontal) {
    const tickY = flipSide ? y - tickGap : y + h + tickGap;
    const tickBaseline = flipSide ? 'bottom' : 'top';
    drawLabel(validRange ? minLabel : '', x, tickY, 'left', tickBaseline);
    drawLabel(validRange ? maxLabel : '', x + w, tickY, 'right', tickBaseline);
    for (const t of ticks) drawLabel(t.label, x + t.frac * w, tickY, 'center', tickBaseline);
    if (legend) {
      const legendY = flipSide ? tickY - font * 1.3 : tickY + font * 1.3;
      // Rich-text draw (bold/italic/sup/sub via utils/LegendRichText.js), not
      // drawLabel's plain fillText — matches whatever formatting the live
      // widget's legend (click-to-edit, ColorBarWidget.js) is showing.
      drawLegendRichText(octx, legend, x + w / 2, legendY, { fontPx: font, align: 'center', baseline: tickBaseline });
    }
  } else {
    const tickX = flipSide ? x - tickGap : x + w + tickGap;
    const tickAlign = flipSide ? 'right' : 'left';
    drawLabel(validRange ? maxLabel : '', tickX, y, tickAlign, 'top');
    drawLabel(validRange ? minLabel : '', tickX, y + h, tickAlign, 'bottom');
    for (const t of ticks) drawLabel(t.label, tickX, y + h - t.frac * h, tickAlign, 'middle');
    if (legend) {
      octx.save();
      octx.translate(flipSide ? tickX - font * 3.4 : tickX + font * 3.4, y + h / 2);
      octx.rotate(-Math.PI / 2);
      drawLegendRichText(octx, legend, 0, 0, { fontPx: font, align: 'center', baseline: 'middle' });
      octx.restore();
    }
  }
}

// Draws every color bar that's currently floated onto the scene (never a
// docked one — that lives in the side panel, not over #view, so it's no
// more "in the scene" than the panel itself) at its own true on-screen
// position, mapped through the crop.
function drawFloatingColorBars(octx, width, height, margin, crop, viewRect) {
  const bars = listActiveColorBars().filter((bar) => bar.instance.isFloating());
  for (const bar of bars) {
    const visualRect = bar.instance.getVisualRect();
    const outRect = cropToOutputRect(viewFraction(visualRect, viewRect), crop, width, height, margin);
    if (!outRect) continue; // dragged fully outside the chosen crop

    // The gradient strip itself, not the wrapper (which is a plain flex row
    // — controlsBar+valueRow side by side in horizontal mode) and not the
    // visual union (which also includes the tick labels/legend below/beside
    // it) — drawColorBar needs just the bar's own box to lay ticks out from.
    const barRect = bar.instance.getBarRect();
    const barOut = cropToOutputRect(viewFraction(barRect, viewRect), crop, width, height, margin);
    if (!barOut) continue;

    const settings = bar.instance.getSettings();
    // barOut/barRect describe the exact same box in output vs. screen
    // pixels — their ratio is the uniform screen->output scale this whole
    // export is drawn at (crop + output resolution), so scaling the bar's
    // OWN live font size (settings.tickFontPx, already reflecting its
    // fontScale()) by that same ratio keeps exported text proportional to
    // what's on screen, instead of a size derived independently from
    // barOut's pixel box (which used to drift: THICKNESS never scales with
    // barLength for a horizontal bar, and the ratio changes with whatever
    // crop/output resolution the user picked, neither of which has
    // anything to do with the widget's own font scaling).
    const pxScale = barRect.width > 0 ? barOut.width / barRect.width : 1;
    const font = Math.max(7, settings.tickFontPx * pxScale);
    drawColorBar(octx, settings, barOut.x, barOut.y, barOut.width, barOut.height, font, pxScale);
  }
}

// The Composition Display legend (ui/CompositionLegendWidget.js): a widget
// whose entire purpose is to sit beside the structure in a figure, so it
// belongs in the capture. Same rule (and same floating class) as the color
// bars — only while it's actually over the scene.
//
// Drawn from the live DOM's own rects (swatch canvas blitted, text redrawn
// with its computed font), not the widget: the ⦀/☰ strip and the resize
// handle are chrome for operating the thing, not legend content. The body
// surface is filled only when the user hasn't stripped it via ☰ > Transparent
// background.
function drawCompositionLegend(octx, width, height, margin, crop, viewRect) {
  const widget = document.querySelector('.comp-legend-widget.cv-colorbar-floating');
  const body = /** @type {HTMLElement | null} */ (widget?.querySelector('.comp-legend-body'));
  if (!body) return;
  const rows = body.querySelectorAll('.comp-legend-row');
  if (!rows.length) return; // collapsed, or no structure ("No structure loaded.")

  const bodyRect = body.getBoundingClientRect();
  const bodyOut = cropToOutputRect(viewFraction(bodyRect, viewRect), crop, width, height, margin);
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
        const out = cropToOutputRect(viewFraction(canvas.getBoundingClientRect(), viewRect), crop, width, height, margin);
        if (out) octx.drawImage(canvas, out.x, out.y, out.width, out.height);
      }
      for (const el of row.querySelectorAll('.comp-legend-label, .comp-legend-sub')) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        const out = cropToOutputRect(viewFraction(el.getBoundingClientRect(), viewRect), crop, width, height, margin);
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
 * @param {{width:number, height:number, margin?:number, transparent?:boolean,
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
  const margin = Math.max(0, Math.round(opts.margin || 0));
  const transparent = !!opts.transparent;
  // crop is optional: omitting it (a direct/programmatic capture, no
  // ui/CropOverlay.js step) captures the full #view, same as the crop tool's
  // own full-frame default.
  const crop = opts.crop || { x0: 0, y0: 0, x1: 1, y1: 1 };
  if (crop.x1 <= crop.x0 || crop.y1 <= crop.y0) {
    throw new Error('No export area selected.');
  }

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

    const innerW = Math.max(1, width - 2 * margin);
    const innerH = Math.max(1, height - 2 * margin);
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

    const gl = app.renderer.getContext();
    const maxDim = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
      Math.ceil(Math.max(width, height) * SS),
      8192,
    );
    if (srcW > maxDim || srcH > maxDim) {
      const k = maxDim / Math.max(srcW, srcH);
      srcW = Math.max(1, Math.floor(srcW * k));
      srcH = Math.max(1, Math.floor(srcH * k));
      console.info(`[png-export] source render capped to ${srcW}x${srcH}; small selections may upscale.`);
    }

    // --- Final high-res pass (tracer pipelines render to full convergence,
    //     with the on-screen progress bar tracking the accumulation). ---
    const srcCanvas = await renderMainToCanvasConverged(srcW, srcH, opts.onProgress, signal);
    throwIfAborted(signal);

    const cropPxX = crop.x0 * srcW;
    const cropPxY = crop.y0 * srcH;
    const cropPxW = cropFracW * srcW;
    const cropPxH = cropFracH * srcH;

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const octx = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    if (!transparent) {
      octx.fillStyle = bgCss;
      octx.fillRect(0, 0, width, height);
    }
    // Contain-fit the crop into the inner box, centred within the margins. A
    // real crop-tool selection already matches the output's aspect exactly
    // (ui/CropOverlay.js enforces it), so this reduces to filling innerW x
    // innerH with no letterboxing; the no-crop fallback (arbitrary output
    // dims vs the view's own aspect) is the case this centring actually
    // guards against distortion for.
    const scale = Math.min(innerW / cropPxW, innerH / cropPxH);
    const drawW = cropPxW * scale;
    const drawH = cropPxH * scale;
    const dx = margin + (innerW - drawW) / 2;
    const dy = margin + (innerH - drawH) / 2;
    octx.drawImage(srcCanvas, cropPxX, cropPxY, cropPxW, cropPxH, dx, dy, drawW, drawH);

    const map = {
      srcW, srcH, cropX: cropPxX, cropY: cropPxY, dx, dy, scale,
      // output px per on-screen CSS px, for scaling label font/padding sizes.
      fontScale: (cropPxH * scale) / Math.max(1, cropFracH * vh),
    };
    drawMeasurementLabels(octx, map);
    prevGizmoPR = drawGizmoAndLegend(octx, width, height, margin, crop, viewRect);
    drawFloatingColorBars(octx, width, height, margin, crop, viewRect);
    drawCompositionLegend(octx, width, height, margin, crop, viewRect);

    return await new Promise((resolve, reject) => {
      out.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode PNG.'));
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
        app.gizmoCamera.aspect = gw / gh;
        app.gizmoCamera.updateProjectionMatrix();
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
