// High-resolution PNG export of the 3D scene, without any floating UI.
//
// The exported image contains exactly what is "drawn on the scene": atoms,
// bonds, polyhedra, fields, the cel outline, the measurement lines AND their
// labels, and the axis gizmo. It deliberately excludes the panel Windows, the
// dock, the dock/menu button and the background-selection circle (those are
// separate DOM siblings of #view, so they are never part of a WebGL capture).
//
// Strategy (see the plan): render the main scene at a multiple of the current
// #view size (same aspect, so the camera projection is untouched), read the
// pixels synchronously in the same tick (the renderer has no
// preserveDrawingBuffer, so nothing may `await` between render() and the read),
// crop to the non-background content, and rescale that crop to fit the chosen
// output canvas with margins. The gizmo (a separate small renderer) and the
// CSS2D measurement labels are composited on afterwards in 2D.
//
// alpha:true on the main renderer (WindowAndSceneControls.initRenderer) lets us
// render with scene.background = null so content detection is a clean alpha
// test; an opaque output is produced by filling the scene background colour
// under the composited content.

import * as THREE from '../external/three/three.module.js';
import { app, general, measurements } from '../state/store.js';
import { renderCelOutlinePass } from './CelOutlinePass.js';
import { latticeDirsNorm } from './LatticeModule.js';
import { requestRender } from './AnimateModule.js';

const ALPHA_THRESHOLD = 12; // 0..255; a pixel counts as content above this

/** @returns {HTMLElement} the #view container */
function getViewEl() {
  return /** @type {HTMLElement} */ (document.getElementById('view'));
}

// Render the main scene + cel outline into an offscreen 2D canvas of exactly
// w x h device pixels. Caller must have set pixelRatio 1, scene.background and
// clearAlpha for a transparent capture. Reads the drawing buffer synchronously.
function renderMainToCanvas(w, h) {
  app.renderer.setSize(w, h, false);
  if (app.wboitPass) app.wboitPass.setSize(w, h);
  app.renderer.render(app.scene, app.camera);
  renderCelOutlinePass(app.renderer, app.scene, app.camera);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.drawImage(app.renderer.domElement, 0, 0, w, h);
  return canvas;
}

// Bounding box of pixels with alpha > threshold. Returns null if fully empty.
function contentBBox(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1 };
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

// Render the axis gizmo at high resolution and place it in the output's
// bottom-left corner (matching #axesGizmo's on-screen position), sized
// proportionally to the output. Returns the previous gizmo pixel ratio so the
// caller can restore it.
function drawGizmo(octx, width, height, margin) {
  const gizmoDiv = document.getElementById('axesGizmo');
  if (!app.gizmoRenderer || !app.gizmoScene || !app.gizmoCamera) return null;
  if (gizmoDiv && gizmoDiv.style.display === 'none') return null;

  const prevGizmoPR = app.gizmoRenderer.getPixelRatio();
  const gsize = Math.max(24, Math.round(Math.min(width, height) * 0.14));
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

  octx.drawImage(app.gizmoRenderer.domElement, margin, height - gsize - margin, gsize, gsize);
  return prevGizmoPR;
}

/**
 * Capture the current scene to a high-resolution PNG Blob.
 * @param {{width:number, height:number, margin?:number, transparent?:boolean}} opts
 * @returns {Promise<Blob>}
 */
export async function captureSceneToPng(opts) {
  if (!app.renderer || !app.scene || !app.camera) {
    throw new Error('Scene is not ready.');
  }
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const margin = Math.max(0, Math.round(opts.margin || 0));
  const transparent = !!opts.transparent;

  const viewEl = getViewEl();
  const vw = Math.max(1, (viewEl && viewEl.clientWidth) || window.innerWidth);
  const vh = Math.max(1, (viewEl && viewEl.clientHeight) || window.innerHeight);
  const aspect = vw / vh;

  // Save live-view state so we can restore exactly (camera projection is never
  // touched: every internal render keeps the #view aspect).
  const prevPixelRatio = app.renderer.getPixelRatio();
  const prevBackground = app.scene.background;
  const prevClearAlpha = app.renderer.getClearAlpha();
  const bgCss = colorToCss(prevBackground);

  let prevGizmoPR = null;

  try {
    app.renderer.setPixelRatio(1);
    app.scene.background = null;
    app.renderer.setClearAlpha(0);

    // --- Probe pass: find the content fraction of the view at low cost. ---
    const probeLong = 1024;
    const probeW = aspect >= 1 ? probeLong : Math.max(1, Math.round(probeLong * aspect));
    const probeH = aspect >= 1 ? Math.max(1, Math.round(probeLong / aspect)) : probeLong;
    const probeCanvas = renderMainToCanvas(probeW, probeH);
    const probeBox = contentBBox(probeCanvas);
    if (!probeBox) {
      throw new Error('Nothing is visible to export.');
    }
    // Normalised content rect (fractions of the view).
    const nx0 = probeBox.x0 / probeW;
    const ny0 = probeBox.y0 / probeH;
    const nx1 = (probeBox.x1 + 1) / probeW;
    const ny1 = (probeBox.y1 + 1) / probeH;
    const fracW = nx1 - nx0;
    const fracH = ny1 - ny0;

    // --- Choose the source render size so the content maps ~1:1 (slightly
    //     super-sampled for AA) to the target content box, clamped to GPU limits.
    const targetW = Math.max(1, width - 2 * margin);
    const targetH = Math.max(1, height - 2 * margin);
    const SS = 1.25;
    const scaleToFillW = targetW / Math.max(fracW, 1e-3);
    const scaleToFillH = targetH / Math.max(fracH, 1e-3);
    let srcW = Math.ceil(Math.max(scaleToFillW, scaleToFillH * aspect) * SS);
    let srcH = Math.ceil(srcW / aspect);

    const gl = app.renderer.getContext();
    const maxDim = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
      8192,
    );
    let clamped = false;
    if (srcW > maxDim || srcH > maxDim) {
      const k = maxDim / Math.max(srcW, srcH);
      srcW = Math.max(1, Math.floor(srcW * k));
      srcH = Math.max(1, Math.floor(srcH * k));
      clamped = true;
    }
    if (clamped) {
      console.warn(`[png-export] source render clamped to ${srcW}x${srcH}; content may upscale.`);
    }

    // --- Final high-res pass. ---
    const srcCanvas = renderMainToCanvas(srcW, srcH);

    // Crop rect in source pixels, from the (accurate enough) probe fractions.
    const cropX = Math.max(0, Math.floor(nx0 * srcW));
    const cropY = Math.max(0, Math.floor(ny0 * srcH));
    const cropW = Math.max(1, Math.min(srcW - cropX, Math.ceil(fracW * srcW)));
    const cropH = Math.max(1, Math.min(srcH - cropY, Math.ceil(fracH * srcH)));

    // Contain-fit the crop into the target box, centred within the margins.
    const scale = Math.min(targetW / cropW, targetH / cropH);
    const drawW = cropW * scale;
    const drawH = cropH * scale;
    const dx = margin + (targetW - drawW) / 2;
    const dy = margin + (targetH - drawH) / 2;

    // --- Compose the output. ---
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
    octx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, dx, dy, drawW, drawH);

    // Overlays: labels track content; the gizmo goes in the output corner.
    const map = {
      srcW, srcH, cropX, cropY, dx, dy, scale,
      // font/label size relative to the on-screen view (content px on screen
      // = frac * view px; content px in output = crop px * scale).
      fontScale: (cropH * scale) / Math.max(1, fracH * vh),
    };
    drawMeasurementLabels(octx, map);
    prevGizmoPR = drawGizmo(octx, width, height, margin);

    return await new Promise((resolve, reject) => {
      out.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode PNG.'));
      }, 'image/png');
    });
  } finally {
    // Restore the live view. Camera projection was never changed.
    app.scene.background = prevBackground;
    app.renderer.setClearAlpha(prevClearAlpha);
    app.renderer.setPixelRatio(prevPixelRatio);
    app.renderer.setSize(vw, vh, false);
    if (app.wboitPass) app.wboitPass.setSize(vw, vh);

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
