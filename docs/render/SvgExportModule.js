// "Download → SVG Image…": the same WYSIWYG capture render/ImageExportModule.js
// produces as a PNG, written out as an SVG whose *overlays are real, editable
// objects* — every label a <text>, every colour bar a gradient plus tick text,
// each overlay its own Inkscape layer. The publication workflow this exists
// for: render the figure here, then fix the typography, move the legend, and
// recolour the annotations in Inkscape without ever re-rendering.
//
// Two ways to get the structure itself into the file:
//
//   raster (default) — the existing PNG pipeline renders it at the requested
//     resolution and it lands as ONE <image> in its own layer. Everything the
//     3D pipelines can do (tracers, fields, isosurfaces, ground plane, cel
//     outlines) survives exactly as rendered, and the overlays on top stay
//     editable. This is what a figure normally wants.
//   vector — render/SvgSceneVector.js re-derives atoms/bonds/cell/polyhedra as
//     SVG shapes (see there). Editable per atom, but the element count grows
//     with the cell and several scene features have no vector equivalent; the
//     dialog warns, and whatever was left out is named in the file's <desc>.
//
// Vector mode never renders a GL frame: it only needs the NDC -> output-pixel
// mapping, which ImageExportModule.computeExportViewMapping produces without
// touching the renderer.

import * as THREE from '../external/three/three.module.js';
import { app, general, fileBrowser, measurements } from '../state/store.js';
import { latticeDirsNorm } from './LatticeModule.js';
import { requestRender } from './AnimateModule.js';
import { crysVizFontsLoaded } from '../utils/index.js';
import { GIZMO_ORTHO_HALF_HEIGHT } from '../ui/GizmoLayout.js';
import { SvgPainter, escapeXml, num } from './exportPainters.js';
import {
  renderStructureForExport, computeExportViewMapping, isPngCaptureInProgress,
  drawMeasurementLabels, drawAxesLegend, drawFloatingColorBars, drawCompositionLegend,
  gizmoOutputRect, axesLegendOutputRect, colorToCss, ndcToOutput,
} from './ImageExportModule.js';
import { buildVectorStructure } from './SvgSceneVector.js';

export { estimateVectorPrimitiveCount } from './SvgSceneVector.js';

const AXIS_COLORS = { a: '#ff3333', b: '#33cc33', c: '#3366ff' };

/** What the last vector export could not turn into shapes, for the dialog to
 *  show. Null until a vector export has run in this session. */
let lastVectorInfo = null;

/** @returns {{counts:object, skipped:string[]} | null} */
export function lastVectorExportInfo() {
  return lastVectorInfo;
}

function structureName() {
  const raw = fileBrowser.selectedRow
    ? fileBrowser.selectedRow.querySelector('.name-inner')?.textContent
    : '';
  return String(raw || 'structure').replace(/\.[^.]+$/, '');
}

/**
 * Assemble the document. Namespaces are declared up front (inkscape/sodipodi
 * so the layer attributes are legal, xlink for the raster <image> href), and
 * the page box is width/height/viewBox in plain px so 1 SVG unit == 1 exported
 * pixel — an Inkscape document whose ruler matches the raster resolution.
 */
function svgDocument({ width, height, title, desc, defs, body }) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="${num(width)}" height="${num(height)}"
     viewBox="0 0 ${num(width)} ${num(height)}" version="1.1">
  <title id="cv-title">${escapeXml(title)}</title>
  <desc id="cv-desc">${escapeXml(desc)}</desc>
  <sodipodi:namedview inkscape:document-units="px" units="px" />
  <defs id="cv-defs">
${defs}
  </defs>
${body}
</svg>
`;
}

function svgBlob(text) {
  return new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
}

/**
 * The axis gizmo as vector arrows rather than a blit of the gizmo renderer —
 * the whole point of the SVG export is that the axes can be restyled. Geometry
 * mirrors WindowAndSceneControls' gizmo scene (arrow length 1, head 0.35 long
 * and 0.22 wide, shaft radius general.axesLineWidth, all inside the gizmo
 * camera's symmetric ortho half-extent) so the arrows land where the on-screen
 * gizmo has them.
 */
function drawVectorGizmo(painter, rect) {
  const ARROW_LEN = 1.0;
  const HEAD_LEN = 0.35;
  const HEAD_WIDTH = 0.22;
  const H = GIZMO_ORTHO_HALF_HEIGHT;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const sx = (rect.width / 2) / H;
  const sy = (rect.height / 2) / H;
  // Same orientation the gizmo renderer applies: the lattice directions taken
  // into camera space, then read off orthographically (x right, y up).
  const invCamQ = app.camera.quaternion.clone().invert();
  const dirs = latticeDirsNorm();
  const arrows = ['a', 'b', 'c'].map((key) => {
    const d = dirs[key].clone().applyQuaternion(invCamQ).normalize();
    return { key, d };
  });
  // Painter's order: an arrow pointing away from the camera goes under one
  // pointing towards it, exactly as the depth-tested render would show them.
  arrows.sort((p, q) => p.d.z - q.d.z);

  const shaftLen = ARROW_LEN - HEAD_LEN;
  for (const { key, d } of arrows) {
    const color = AXIS_COLORS[key];
    const tipX = cx + d.x * ARROW_LEN * sx;
    const tipY = cy - d.y * ARROW_LEN * sy;
    const baseX = cx + d.x * shaftLen * sx;
    const baseY = cy - d.y * shaftLen * sy;
    painter.line(cx, cy, baseX, baseY, {
      stroke: color,
      lineWidth: Math.max(0.75, 2 * general.axesLineWidth * Math.min(sx, sy)),
      cap: 'butt',
      label: `${key} axis shaft`,
    });
    // Head as a triangle across the arrow's own axis: the screen-space
    // perpendicular of (dx, -dy) is (dy, dx).
    const px = d.y * (HEAD_WIDTH / 2) * sx;
    const py = d.x * (HEAD_WIDTH / 2) * sy;
    painter.polygon([
      { x: tipX, y: tipY },
      { x: baseX + px, y: baseY + py },
      { x: baseX - px, y: baseY - py },
    ], { fill: color, label: `${key} axis head` });
    if (general.gizmoLabelsOnArrows) {
      // Sprite letters sit just past the tip in the live gizmo; same here.
      painter.text(key, cx + d.x * (ARROW_LEN + 0.22) * sx, cy - d.y * (ARROW_LEN + 0.22) * sy, {
        fontPx: Math.max(6, rect.height * 0.1),
        weight: 'bold',
        align: 'center',
        baseline: 'middle',
        fill: color,
        label: `${key} axis label`,
      });
    }
  }
}

/** world -> output px, plus the world-radius -> output-px helper, both built
 *  from the live camera and the export's own crop mapping. */
function makeSceneProjector(map) {
  const cam = app.camera;
  cam.updateMatrixWorld();
  const viewMatrix = cam.matrixWorld.clone().invert();
  // The camera's world-space right vector: a sphere's screen radius is the
  // distance its centre moves when pushed one radius along it.
  const right = new THREE.Vector3();
  cam.matrixWorld.extractBasis(right, new THREE.Vector3(), new THREE.Vector3());
  right.normalize();
  const p = new THREE.Vector3();
  const inView = new THREE.Vector3();

  const project = (x, y, z) => {
    p.set(x, y, z);
    const viewZ = inView.set(x, y, z).applyMatrix4(viewMatrix).z;
    p.project(cam);
    if (p.z < -1 || p.z > 1) return null;
    const out = ndcToOutput(map, p);
    // view space looks down -z, so this grows with distance from the camera
    return { x: out.x, y: out.y, depth: -viewZ };
  };

  const radiusPx = (x, y, z, r) => {
    const c = project(x, y, z);
    const edge = project(x + right.x * r, y + right.y * r, z + right.z * r);
    if (!c || !edge) return 0;
    return Math.hypot(edge.x - c.x, edge.y - c.y);
  };

  return { project, radiusPx };
}

/** Overlay layers, shared by both structure modes. */
function drawOverlayLayers(painter, ex, opts) {
  painter.beginGroup('Measurements', 'layer-measurements');
  drawMeasurementLabels(painter, ex.map);
  painter.endGroup();

  if (opts.structureOnly) return;

  const gizmoRect = gizmoOutputRect(ex.width, ex.height, ex.crop, ex.viewRect);
  const legendRect = axesLegendOutputRect(ex.width, ex.height, ex.crop, ex.viewRect);
  if (gizmoRect || legendRect) {
    painter.beginGroup('Axes', 'layer-axes');
    if (gizmoRect) drawVectorGizmo(painter, gizmoRect);
    if (legendRect) drawAxesLegend(painter, legendRect);
    painter.endGroup();
  }

  painter.beginGroup('Color bars', 'layer-colorbars');
  drawFloatingColorBars(painter, ex.width, ex.height, ex.crop, ex.viewRect);
  painter.endGroup();

  painter.beginGroup('Composition legend', 'layer-composition');
  drawCompositionLegend(painter, ex.width, ex.height, ex.crop, ex.viewRect);
  painter.endGroup();
}

function drawBackgroundLayer(painter, width, height, bgCss, transparent) {
  if (transparent) return;
  painter.beginGroup('Background', 'layer-background');
  painter.roundRect(0, 0, width, height, 0, { fill: bgCss, label: 'Page background' });
  painter.endGroup();
}

/**
 * Capture the current scene to an SVG Blob.
 *
 * @param {{width:number, height:number, margin?:number, transparent?:boolean,
 *   structureOnly?:boolean, structure?:'raster'|'vector',
 *   crop?:{x0:number, y0:number, x1:number, y1:number},
 *   onProgress?:(p:{current:number, target:number})=>void,
 *   signal?:AbortSignal}} opts
 *   Everything captureSceneToPng takes, plus `structure`: 'raster' (default)
 *   embeds the rendered structure as one <image>; 'vector' emits shapes.
 * @returns {Promise<Blob>}
 */
export async function captureSceneToSvg(opts) {
  return opts.structure === 'vector'
    ? captureVectorSvg(opts)
    : captureRasterSvg(opts);
}

/**
 * Take the measurement value pills out of the RENDER for its duration. They
 * are scene sprites, so they would be baked into the bitmap and re-emitted as
 * editable <text> in the Measurements layer — printed twice.
 *
 * Culling by layer mask, not by `.visible`: the overlay pass runs while the
 * capture still owns the renderer and reads `.visible` itself to decide which
 * pills to draw, so that flag has to keep meaning what it means on screen.
 */
function cullMeasurementSpritesFromRender() {
  const saved = [];
  for (const label of measurements.measureLabels || []) {
    if (!label?.layers) continue;
    saved.push([label, label.layers.mask]);
    label.layers.mask = 0; // no layer in common with any camera -> culled
  }
  return () => {
    for (const [label, mask] of saved) label.layers.mask = mask;
    if (saved.length) requestRender();
  };
}

async function captureRasterSvg(opts) {
  const restoreSprites = cullMeasurementSpritesFromRender();
  try {
    return await captureRasterSvgImpl(opts);
  } finally {
    restoreSprites();
  }
}

function captureRasterSvgImpl(opts) {
  // The structure image is captured WITHOUT the background so the SVG can
  // carry its own background rect — an editable layer instead of a colour
  // baked into the bitmap.
  return renderStructureForExport({ ...opts, transparent: true }, async (ex) => {
    const painter = new SvgPainter({ width: ex.width, height: ex.height, idPrefix: 'cv' });
    drawBackgroundLayer(painter, ex.width, ex.height, ex.bgCss, !!opts.transparent);
    painter.beginGroup('Structure (raster)', 'layer-structure');
    painter.image(ex.canvas, 0, 0, ex.width, ex.height, { label: 'Rendered structure' });
    painter.endGroup();
    drawOverlayLayers(painter, ex, opts);
    return svgBlob(svgDocument({
      width: ex.width,
      height: ex.height,
      title: structureName(),
      desc: `CrysViz export of ${structureName()} — structure embedded as a `
        + `${ex.width}x${ex.height} raster image; overlays are editable vector layers.`,
      defs: painter.defs(),
      body: painter.body(),
    }));
  });
}

async function captureVectorSvg(opts) {
  await crysVizFontsLoaded();
  if (!app.scene || !app.camera) throw new Error('Scene is not ready.');
  // No GL frame is rendered here, but a capture in flight has the live camera
  // windowed/offset for its own tiles — projecting through it would be wrong.
  if (isPngCaptureInProgress()) throw new Error('A PNG capture is already in progress.');

  const { map, crop, viewRect, width, height } = computeExportViewMapping(opts);
  const painter = new SvgPainter({ width, height, idPrefix: 'cv' });
  drawBackgroundLayer(painter, width, height, colorToCss(app.scene.background), !!opts.transparent);

  const { project, radiusPx } = makeSceneProjector(map);
  const vector = buildVectorStructure({ project, radiusPx, width, height, idPrefix: 'st' });
  painter.beginGroup('Structure (vector)', 'layer-structure');
  painter.raw(vector.body, vector.defs);
  painter.endGroup();
  lastVectorInfo = { counts: vector.counts, skipped: vector.skipped || [] };

  drawOverlayLayers(painter, { map, crop, viewRect, width, height }, opts);

  const skipped = lastVectorInfo.skipped;
  return svgBlob(svgDocument({
    width,
    height,
    title: structureName(),
    desc: `CrysViz export of ${structureName()} — structure as vector shapes `
      + `(${Object.entries(vector.counts).map(([k, v]) => `${k}: ${v}`).join(', ')}).`
      + (skipped.length ? ` Not vectorised: ${skipped.join('; ')}.` : ''),
    defs: painter.defs(),
    body: painter.body(),
  }));
}
