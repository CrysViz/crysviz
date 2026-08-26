// Vector (Inkscape-editable) rendering of the live crystal scene for the SVG
// export. Decodes the same live three.js objects the ray-tracing SceneEncoder
// reads — the atoms/bonds InstancedMeshes, the lattice cylinder group,
// polyhedra faces and their fat-line edges, force/spin arrow meshes,
// measurement dashes — but emits SVG primitives instead of GPU data textures,
// so every atom and bond survives the export as an individually selectable
// object.
//
// The caller owns the camera: it passes `project`/`radiusPx` closures built
// from whatever camera and output rectangle the export uses. That keeps this
// module free of the PNG export's crop/margin math and makes perspective and
// orthographic cameras the same code path — all foreshortening is carried by
// evaluating radiusPx at each primitive's own world position (a perspective
// sphere's on-screen size then comes out right per atom, and a line's width is
// the mean of its two endpoint widths).
//
// Correctness over tidiness: there is ONE global painter's sort over every
// primitive kind, far to near. Per-kind Inkscape layers would be nicer to
// edit, but they would draw every bond in front of every atom.

import * as THREE from '../external/three/three.module.js';
import { app, general, groups, fileBrowser, measurements } from '../state/store.js';
import { activeAtomCutPlanes } from './pipeline/raytrace/SceneEncoder.js';
import { wedgeDataForAtom } from './WedgeAtoms.js';
import { Plane } from '../model/index.js';

const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mWorld = new THREE.Matrix4();
const _color = new THREE.Color();

// View space: +x right, +y up, +z toward the viewer (three's convention).
const DEFAULT_LIGHT = { x: -0.4, y: 0.6, z: 1 };
// Flat-shading floor for polyhedra faces, so a face turned away from the light
// reads as "dark blue", not as a black hole in the figure.
const FACE_AMBIENT = 0.38;
// Faces are stroked with their own fill colour to hide the hairline
// background seams SVG anti-aliasing leaves between adjacent triangles.
const FACE_SEAM_STROKE = 0.5;
// A segment carries ONE depth into the painter's sort, so a segment that runs
// away from the camera is drawn wholly in front of or wholly behind every
// sphere it actually passes through — which is how a unit-cell edge ends up
// laid over the whole structure. Long segments are cut into pieces short
// enough in depth for the sort to be right; this caps the pieces so a huge
// supercell cannot turn twelve cell edges into thousands of elements.
const MAX_SEGMENT_PIECES = 64;
// Bonds get a tighter budget: they are the one segment kind whose count grows
// with the structure, and a bond half is at most an atom or two long, so a few
// pieces already put the residual sort error well under an atom radius.
const MAX_BOND_PIECES = 4;
/** @typedef {{x:number, y:number, depth:number}} ProjectedPoint */
/**
 * @typedef {{
 *   project: (x:number, y:number, z:number) => ProjectedPoint|null,
 *   radiusPx: (x:number, y:number, z:number, r:number) => number,
 *   width: number,
 *   height: number,
 *   lightDir?: {x:number, y:number, z:number},
 *   idPrefix?: string,
 * }} VectorCtx
 */

/** ≤2 decimals; keeps the document a fraction of the size with no visible
 *  difference at any sane export resolution. */
function fmt(value) {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;' : '&apos;'));
}

/** Working-space rgb (what instanceColor holds) -> sRGB hex, via three's own
 *  colour management, so the exported hex is the colour the user picked. */
function hexFromRgb(r, g, b) {
  return `#${_color.setRGB(r, g, b).getHexString()}`;
}

function hexFromColor(color) {
  return `#${_color.copy(color).getHexString()}`;
}

/** Blend `hex` toward white (t > 0) or black (t < 0) in sRGB. */
function mixHex(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const target = t > 0 ? 255 : 0;
  const amount = Math.abs(t);
  const ch = (shift) => {
    const v = (n >> shift) & 255;
    return Math.round(v + (target - v) * amount);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Multiply `hex` by a shading factor (Lambert term for polyhedra faces). */
function scaleHex(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * factor)));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Per-colour sphere shading. One <radialGradient> per distinct atom colour
 *  (Inkscape shows them as reusable swatches, and the file stays small even
 *  for a 50k-atom supercell). 'cel' gets no gradient at all — flat fill plus a
 *  dark outline, matching the raster cel style. */
function makeGradientPool(idPrefix, style, light) {
  const defs = [];
  const ids = new Map();
  // Highlight toward the light. SVG y grows downward, so the view-space up
  // component flips sign.
  const off = style === 'matte' ? 0.2 : 0.3;
  const cx = 0.5 + off * light.x;
  const cy = 0.5 - off * light.y;
  const ref = (hex) => {
    let id = ids.get(hex);
    if (id) return `url(#${id})`;
    id = `${idPrefix}sph-${hex.slice(1)}`;
    ids.set(hex, id);
    const list = style === 'matte'
      ? [[0, mixHex(hex, 0.3)], [0.55, hex], [1, mixHex(hex, -0.32)]]
      : [[0, mixHex(hex, 0.82)], [0.26, mixHex(hex, 0.3)], [0.62, hex], [1, mixHex(hex, -0.55)]];
    const body = list
      .map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`)
      .join('');
    defs.push(`<radialGradient id="${id}" gradientUnits="objectBoundingBox"`
      + ` cx="${fmt(cx)}" cy="${fmt(cy)}" r="0.9">${body}</radialGradient>`);
    return `url(#${id})`;
  };
  return { defs, ref };
}

/** Visible, non-cut atom instances of one InstancedMesh as plain records.
 *  Mirrors SceneEncoder._encodeAtoms: uniform scale in m[0] (0 = hidden),
 *  centre in m[12..14], per-instance colour/opacity, whole-atom cut-plane
 *  removal by world centre with the per-atom "Keep" immunity honoured. */
function atomInstances(mesh, cutPlanes) {
  /** @type {any[]} */
  const out = [];
  if (!mesh || !mesh.visible || !mesh.count) return out;
  const matrices = mesh.instanceMatrix?.array;
  if (!matrices) return out;
  const colors = mesh.instanceColor?.array;
  const opacities = mesh.geometry?.attributes?.instanceOpacity?.array;
  const immune = mesh.geometry?.attributes?.instanceCutPlaneImmune?.array;
  const baseOpacity = mesh.material?.opacity ?? 1;
  const names = mesh.userData?.elementNames;
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16;
    const r = matrices[o];
    if (!(r > 0)) continue;
    const x = matrices[o + 12], y = matrices[o + 13], z = matrices[o + 14];
    if (cutPlanes.length && !(immune && immune[i] >= 0.5)) {
      let cut = false;
      for (const p of cutPlanes) {
        if ((x * p.nx + y * p.ny + z * p.nz - p.w) * p.sign > 0) { cut = true; break; }
      }
      if (cut) continue;
    }
    const alpha = (opacities ? opacities[i] : 1) * baseOpacity;
    if (!(alpha > 0.004)) continue;
    out.push({
      i, x, y, z, r, alpha,
      hex: colors ? hexFromRgb(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]) : '#cccccc',
      element: names?.[i] ?? null,
    });
  }
  return out;
}

/** Point -> containing atom lookup over a uniform spatial hash. Bond halves
 *  start 20% INSIDE their end atom (Bond's r1/r2 clipping), so "which atom
 *  does this half grow out of" is answered by "which sphere contains its
 *  atom-side endpoint" — which also answers "is that atom hidden or cut away"
 *  (it is simply absent from the list, and the half is dropped with it). */
function makeAtomLookup(atoms) {
  let maxR = 0;
  for (const a of atoms) if (a.r > maxR) maxR = a.r;
  const cell = Math.max(maxR * 2, 1e-3);
  /** @type {Map<string, any[]>} */
  const buckets = new Map();
  for (const a of atoms) {
    const key = `${Math.floor(a.x / cell)},${Math.floor(a.y / cell)},${Math.floor(a.z / cell)}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(a);
  }
  return (x, y, z) => {
    const bi = Math.floor(x / cell), bj = Math.floor(y / cell), bk = Math.floor(z / cell);
    let best = null;
    let bestD = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          const list = buckets.get(`${bi + di},${bj + dj},${bk + dk}`);
          if (!list) continue;
          for (const a of list) {
            const d = Math.hypot(a.x - x, a.y - y, a.z - z);
            if (d < a.r && d < bestD) { bestD = d; best = a; }
          }
        }
      }
    }
    return best;
  };
}

/** Bond halves of one bonds InstancedMesh. Each instance is a height-1
 *  cylinder scaled to (radius, halfLen, radius): world half-extent along the
 *  axis is |col1|/2 and the axis always points p1 -> p2, so the even instance
 *  of a bond grows from atom 1 and the odd one back from atom 2
 *  (BondsFracUpdateModule.updateSingleBondPosition). */
function bondHalves(mesh) {
  /** @type {any[]} */
  const out = [];
  if (!mesh || !mesh.visible || !mesh.count) return out;
  const matrices = mesh.instanceMatrix?.array;
  if (!matrices) return out;
  const colors = mesh.instanceColor?.array;
  const opacities = mesh.geometry?.attributes?.instanceOpacity?.array;
  const baseOpacity = mesh.material?.opacity ?? 1;
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16;
    if (matrices[o] === 0 && matrices[o + 5] === 0) continue; // culled bond
    const hx = matrices[o + 4], hy = matrices[o + 5], hz = matrices[o + 6];
    const len = Math.hypot(hx, hy, hz);
    if (!(len > 1e-8)) continue;
    const radius = Math.hypot(matrices[o], matrices[o + 1], matrices[o + 2]);
    if (!(radius > 0)) continue;
    const alpha = (opacities ? opacities[i] : 1) * baseOpacity;
    if (!(alpha > 0.004)) continue;
    const half = len / 2;
    const ux = hx / len, uy = hy / len, uz = hz / len;
    const cx = matrices[o + 12], cy = matrices[o + 13], cz = matrices[o + 14];
    const sgn = (i % 2 === 0) ? -1 : 1; // which end sits in the atom
    out.push({
      i, alpha, radius,
      ax: cx + ux * half * sgn, ay: cy + uy * half * sgn, az: cz + uz * half * sgn,
      mx: cx - ux * half * sgn, my: cy - uy * half * sgn, mz: cz - uz * half * sgn,
      hex: colors ? hexFromRgb(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]) : '#999999',
    });
  }
  return out;
}

/** Smallest visible atom radius in world units, over every atom mesh the
 *  export draws (the instance matrix's x scale IS the radius). This is the
 *  size of the smallest thing a segment has to sort against, so it sets how
 *  finely segments must be cut for the painter's sort to come out right.
 *  0 when the scene has no atoms at all — nothing to interleave with. */
function smallestAtomRadius() {
  let min = Infinity;
  const scan = (mesh) => {
    if (!mesh?.visible || !mesh.count) return;
    const matrices = mesh.instanceMatrix?.array;
    if (!matrices) return;
    for (let i = 0; i < mesh.count; i++) {
      const r = matrices[i * 16];
      if (r > 0 && r < min) min = r;
    }
  };
  scan(groups.atomsMesh);
  scan(groups.ghostAtomsMesh);
  for (const entry of (groups.overlayMeshes ?? new Map()).values()) scan(entry?.atomsMesh);
  return Number.isFinite(min) ? min : 0;
}

/** World endpoints + radius of every unit-cell edge. The lattice group's
 *  children are CylinderGeometry meshes sharing one MeshBasicMaterial
 *  (LatticeModule.createLatticeLines). */
function latticeEdges() {
  /** @type {any[]} */
  const out = [];
  const group = groups.latticeGroup;
  if (!general.showLattice || !group || !group.visible) return out;
  for (const mesh of group.children ?? []) {
    if (!mesh.visible || !mesh.geometry?.parameters) continue;
    mesh.updateWorldMatrix(true, false);
    mesh.matrixWorld.decompose(_v, _quat, _scale);
    const params = mesh.geometry.parameters;
    const len = (params.height ?? 1) * Math.abs(_scale.y);
    const radius = (params.radiusTop ?? 0.015)
      * Math.max(Math.abs(_scale.x), Math.abs(_scale.z));
    if (!(len > 1e-6) || !(radius > 0)) continue;
    _axis.set(0, 1, 0).applyQuaternion(_quat).normalize().multiplyScalar(len / 2);
    out.push({
      x1: _v.x - _axis.x, y1: _v.y - _axis.y, z1: _v.z - _axis.z,
      x2: _v.x + _axis.x, y2: _v.y + _axis.y, z2: _v.z + _axis.z,
      radius,
      hex: hexFromColor(mesh.material.color),
      alpha: mesh.material.transparent ? (mesh.material.opacity ?? 1) : 1,
    });
  }
  return out;
}

/** Visible polyhedron meshes with their world-space face triangles, plus the
 *  fat-line edge segments cached on the edge child by PolyhedraModule. */
function polyhedronParts() {
  /** @type {any[]} */
  const faces = [];
  /** @type {any[]} */
  const edges = [];
  const group = groups.polyhedraGroup;
  if (!group || !group.visible) return { faces, edges };
  const edgeWidth = general.polyEdgeWidth ?? 1;
  let polyIndex = -1;
  for (const mesh of group.children ?? []) {
    if (mesh.userData?.type !== 'polyhedron' || !mesh.visible) continue;
    polyIndex++;
    const alpha = mesh.material?.opacity ?? 1;
    const position = mesh.geometry?.attributes?.position;
    if (position && alpha > 0.01) {
      mesh.updateWorldMatrix(true, false);
      _mWorld.copy(mesh.matrixWorld);
      const index = mesh.geometry.index;
      const triCount = (index ? index.count : position.count) / 3;
      const hex = hexFromColor(mesh.material.color);
      const tris = [];
      for (let t = 0; t < triCount; t++) {
        const verts = [];
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
          _v.fromBufferAttribute(position, vi).applyMatrix4(_mWorld);
          verts.push([_v.x, _v.y, _v.z]);
        }
        tris.push(verts);
      }
      faces.push({ polyIndex, hex, alpha, tris });
    }
    if (!(edgeWidth > 0)) continue;
    const edgeLines = mesh.children?.find((c) => c.userData?.type === 'polyhedron-edges');
    const segments = edgeLines?.userData?.segments;
    if (!edgeLines?.visible || !segments) continue;
    const edgeAlpha = edgeLines.material?.opacity ?? 1;
    if (edgeAlpha <= 0.01) continue;
    // LineMaterial.linewidth is worldUnits here and means the line DIAMETER.
    const radius = (edgeLines.material?.linewidth ?? 0.03) / 2;
    const hex = hexFromColor(edgeLines.material.color);
    for (let s = 0; s + 5 < segments.length; s += 6) {
      edges.push({
        x1: segments[s], y1: segments[s + 1], z1: segments[s + 2],
        x2: segments[s + 3], y2: segments[s + 4], z2: segments[s + 5],
        radius, hex, alpha: edgeAlpha, polyIndex,
      });
    }
  }
  return { faces, edges };
}

/** Force/spin arrows as world shaft + head geometry. Reads the same live
 *  InstancedMeshes as SceneEncoder._arrowFrustumEntries: the raster shaft is
 *  two contiguous half cylinders (merged here into one segment) and the tip is
 *  a cone whose apex sits at +y of its own instance matrix. */
function arrowEntries() {
  /** @type {any[]} */
  const out = [];
  const addMesh = (shaft, tip, kind) => {
    if (!shaft?.visible || !tip?.visible || shaft.count < 2 || tip.count < 1) return;
    const shaftColors = shaft.instanceColor?.array;
    const tipColors = tip.instanceColor?.array;
    if (!shaftColors || !tipColors) return;
    shaft.updateWorldMatrix(true, false);
    tip.updateWorldMatrix(true, false);
    const count = Math.min(tip.count, Math.floor(shaft.count / 2));
    for (let i = 0; i < count; i++) {
      shaft.getMatrixAt(i * 2, _m);
      _mWorld.multiplyMatrices(shaft.matrixWorld, _m);
      const a = _mWorld.elements.slice();
      shaft.getMatrixAt(i * 2 + 1, _m);
      _mWorld.multiplyMatrices(shaft.matrixWorld, _m);
      const b = _mWorld.elements;
      // merged shaft: centre between the two halves, half-extent = |col1|
      const shaftHalf = Math.hypot(a[4], a[5], a[6]);
      const shaftRadius = Math.hypot(a[0], a[1], a[2]);
      if (!(shaftHalf > 1e-8) || !(shaftRadius > 0)) continue;
      const scx = (a[12] + b[12]) / 2, scy = (a[13] + b[13]) / 2, scz = (a[14] + b[14]) / 2;
      tip.getMatrixAt(i, _m);
      _mWorld.multiplyMatrices(tip.matrixWorld, _m);
      const t = _mWorld.elements;
      const tipHalf = Math.hypot(t[4], t[5], t[6]) / 2;
      const tipRadius = Math.hypot(t[0], t[1], t[2]);
      if (!(tipHalf > 1e-8) || !(tipRadius > 0)) continue;
      let ux = a[4] / shaftHalf, uy = a[5] / shaftHalf, uz = a[6] / shaftHalf;
      // orient shaft -> tip (the instance matrix's +y may point either way)
      if ((t[12] - scx) * ux + (t[13] - scy) * uy + (t[14] - scz) * uz < 0) {
        ux = -ux; uy = -uy; uz = -uz;
      }
      const tux = t[4] / (tipHalf * 2), tuy = t[5] / (tipHalf * 2), tuz = t[6] / (tipHalf * 2);
      const flip = (tux * ux + tuy * uy + tuz * uz) < 0 ? -1 : 1;
      out.push({
        kind,
        index: i,
        sx: scx - ux * shaftHalf, sy: scy - uy * shaftHalf, sz: scz - uz * shaftHalf,
        bx: t[12] - tux * tipHalf * flip,
        by: t[13] - tuy * tipHalf * flip,
        bz: t[14] - tuz * tipHalf * flip,
        tx: t[12] + tux * tipHalf * flip,
        ty: t[13] + tuy * tipHalf * flip,
        tz: t[14] + tuz * tipHalf * flip,
        shaftRadius,
        tipRadius,
        shaftHex: hexFromRgb(shaftColors[i * 6], shaftColors[i * 6 + 1], shaftColors[i * 6 + 2]),
        tipHex: hexFromRgb(tipColors[i * 3], tipColors[i * 3 + 1], tipColors[i * 3 + 2]),
        alpha: Math.min(shaft.material?.opacity ?? 1, tip.material?.opacity ?? 1),
      });
    }
  };
  addMesh(groups.forcesShaftMesh, groups.forcesTipMesh, 'force');
  addMesh(groups.spinShaftMesh, groups.spinTipMesh, 'spin');
  return out;
}

/** Visible measurement dash segments ('distance'/'angle' groups). Each dash is
 *  a CylinderGeometry mesh placed along its own +y (SceneEncoder does the same
 *  decode for the tracers). */
function measurementDashes() {
  /** @type {any[]} */
  const out = [];
  const lines = measurements?.measureLines;
  if (!Array.isArray(lines)) return out;
  for (const group of lines) {
    const type = group?.userData?.type;
    if (type !== 'distance' && type !== 'angle') continue;
    if (group.visible === false) continue;
    for (const dash of group.children ?? []) {
      if (dash.visible === false || !dash.geometry?.parameters) continue;
      dash.updateWorldMatrix(true, false);
      dash.matrixWorld.decompose(_v, _quat, _scale);
      const params = dash.geometry.parameters;
      const len = (params.height ?? 1) * Math.abs(_scale.y);
      const radius = (params.radiusTop ?? 0.08)
        * Math.max(Math.abs(_scale.x), Math.abs(_scale.z));
      if (!(len > 1e-6) || !(radius > 0)) continue;
      _axis.set(0, 1, 0).applyQuaternion(_quat).normalize().multiplyScalar(len / 2);
      out.push({
        type,
        x1: _v.x - _axis.x, y1: _v.y - _axis.y, z1: _v.z - _axis.z,
        x2: _v.x + _axis.x, y2: _v.y + _axis.y, z2: _v.z + _axis.z,
        radius,
        hex: hexFromColor(dash.material.color),
        alpha: dash.material.opacity ?? 1,
      });
    }
  }
  return out;
}

/** Visible scene content this module cannot turn into vector shapes. Only
 *  things that are actually on screen right now are reported, so the dialog's
 *  note stays truthful instead of listing every unsupported feature. */
function skippedContent() {
  const skipped = [];
  const field = groups.fieldGroup;
  const iso = groups.isosurfaceGroup;
  const fieldVisible = !!(field?.visible && field.children?.length)
    || !!(iso?.visible && iso.parent && iso.children?.length)
    || !!groups.fieldMeshPos?.visible || !!groups.fieldMeshNeg?.visible;
  if (fieldVisible) skipped.push('volumetric field / isosurface');
  if (groups.groundMesh?.visible) skipped.push('ground plane');
  const planes = (app.scene?.children ?? []).filter((o) => o instanceof Plane && o.visible);
  if (planes.length) skipped.push(`${planes.length} lattice plane${planes.length > 1 ? 's' : ''}`);
  const atoms = fileBrowser.selectedStructure?.atoms;
  if (Array.isArray(atoms) && atoms.some((a) => wedgeDataForAtom(a))) {
    skipped.push('fractional-occupancy wedges (atoms keep their base colour)');
  }
  const markers = (measurements?.measureLines ?? []).some((g) => {
    const type = g?.userData?.type;
    return (type === 'distanceMarker' || type === 'angleMarker') && g.visible !== false;
  });
  if (markers) skipped.push('measurement shell markers');
  return skipped;
}

/**
 * Build the vector body of the SVG structure layer.
 *
 * @param {VectorCtx} ctx
 * @returns {{
 *   defs: string,
 *   body: string,
 *   counts: { atoms:number, bondHalves:number, cellEdges:number, polyFaces:number,
 *             polyEdges:number, arrows:number, measurementLines:number },
 *   skipped: string[],
 * }}
 */
export function buildVectorStructure(ctx) {
  const { project, radiusPx, width, height } = ctx;
  const prefix = ctx.idPrefix ?? '';
  const style = general.renderStyle ?? 'metallic';
  const cel = style === 'cel';
  const lightRaw = ctx.lightDir ?? DEFAULT_LIGHT;
  const lightLen = Math.hypot(lightRaw.x, lightRaw.y, lightRaw.z) || 1;
  const light = { x: lightRaw.x / lightLen, y: lightRaw.y / lightLen, z: lightRaw.z / lightLen };
  const pool = makeGradientPool(prefix, style, light);

  /** @type {{depth:number, svg:string}[]} */
  const prims = [];
  const counts = {
    atoms: 0, bondHalves: 0, cellEdges: 0, polyFaces: 0,
    polyEdges: 0, arrows: 0, measurementLines: 0,
  };

  const onPage = (minX, minY, maxX, maxY) =>
    maxX >= 0 && minX <= width && maxY >= 0 && minY <= height;

  // The finest depth difference the one global sort has to resolve: half the
  // smallest visible atom radius, so a mis-sorted piece can never stick out
  // from behind the sphere that should hide it. 0 (no atoms) disables
  // splitting — there is nothing for a segment to interleave with.
  const grain = smallestAtomRadius() * 0.5;

  /** How many pieces a segment spanning `d1`..`d2` in depth must be cut into
   *  for the painter's sort to place each piece correctly. */
  const splitCount = (d1, d2, cap) => {
    if (!(grain > 0)) return 1;
    const span = Math.abs(d1 - d2);
    if (!(span > grain)) return 1;
    return Math.min(cap, Math.ceil(span / grain));
  };

  /** One world segment -> one <line>, or a run of depth-sorted pieces when it
   *  spans too much depth to sort as a unit (see MAX_SEGMENT_PIECES). Pieces
   *  keep the class and the Inkscape label and only differ in id. An opaque
   *  run overlaps its pieces by a fraction of a pixel so no seam shows at the
   *  joins; a translucent one must not (the overlap would blend twice and band
   *  the line), so it abuts butt-capped pieces exactly instead. Each piece
   *  takes its width from its own endpoints, so a long edge under a
   *  perspective camera also tapers the way the raster render draws it. */
  const pushSegment = (seg, id, cls, label, linecap, cap = MAX_SEGMENT_PIECES) => {
    const p1 = project(seg.x1, seg.y1, seg.z1);
    const p2 = project(seg.x2, seg.y2, seg.z2);
    if (!p1 || !p2) return false;
    const w1 = radiusPx(seg.x1, seg.y1, seg.z1, seg.radius);
    const w2 = radiusPx(seg.x2, seg.y2, seg.z2, seg.radius);
    const w = w1 + w2;
    if (!(w > 0.05)) return false;
    if (!onPage(Math.min(p1.x, p2.x) - w, Math.min(p1.y, p2.y) - w,
      Math.max(p1.x, p2.x) + w, Math.max(p1.y, p2.y) + w)) return false;
    const translucent = seg.alpha < 0.999;
    const owner = seg.ownerAtomId
      ? ` data-owner-atom="${esc(seg.ownerAtomId)}"` : '';
    const alpha = (translucent ? ` stroke-opacity="${fmt(seg.alpha)}"` : '') + owner;
    const line = (a, b, wa, wb, pieceId, cap2) => {
      const x1 = fmt(a.x), y1 = fmt(a.y), x2 = fmt(b.x), y2 = fmt(b.y);
      const widthPx = wa + wb;
      const outline = cel && cls === 'bond'
        ? `<line class="bond-outline" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`
          + ` stroke="${mixHex(seg.hex, -0.72)}" stroke-width="${fmt(widthPx * 1.18)}"`
          + ` stroke-linecap="${cap2}"${alpha}/>` : '';
      prims.push({
        depth: Math.max((a.depth + b.depth) / 2, seg.depthFloor ?? -Infinity),
        svg: outline + `<line id="${pieceId}" class="${cls}" inkscape:label="${esc(label)}"`
          + ` x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`
          + ` stroke="${seg.hex}" stroke-width="${fmt(widthPx)}"`
          + ` stroke-linecap="${cap2}"${alpha}/>`,
      });
    };
    const pieces = splitCount(p1.depth, p2.depth, cap);
    if (pieces === 1) {
      line(p1, p2, w1, w2, id, linecap);
      return true;
    }
    const pieceCap = translucent ? 'butt' : linecap;
    const lenPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const overlapPx = cls === 'bond' ? 2 : 0.75;
    const pad = (!translucent && lenPx > 1)
      ? Math.min(overlapPx / lenPx, 0.25 / pieces) : 0;
    const at = (t) => {
      const x = seg.x1 + (seg.x2 - seg.x1) * t;
      const y = seg.y1 + (seg.y2 - seg.y1) * t;
      const z = seg.z1 + (seg.z2 - seg.z1) * t;
      return { p: project(x, y, z), w: radiusPx(x, y, z, seg.radius) };
    };
    let drew = false;
    for (let i = 0; i < pieces; i++) {
      const a = at(Math.max(0, i / pieces - pad));
      const b = at(Math.min(1, (i + 1) / pieces + pad));
      if (!a.p || !b.p) continue;
      line(a.p, b.p, a.w, b.w, `${id}-s${i}`, pieceCap);
      drew = true;
    }
    return drew;
  };

  const emitAtoms = (mesh, cutPlanes, idKind, labelPrefix) => {
    const atoms = atomInstances(mesh, cutPlanes);
    for (const a of atoms) {
      const p = project(a.x, a.y, a.z);
      if (!p) continue;
      const r = radiusPx(a.x, a.y, a.z, a.r);
      if (!(r > 0.05)) continue;
      if (!onPage(p.x - r, p.y - r, p.x + r, p.y + r)) continue;
      const label = `${labelPrefix}${a.element ? `${a.element} #${a.i}` : `atom #${a.i}`}`;
      const cls = a.element ? `atom el-${a.element}` : 'atom';
      const paint = cel
        ? ` fill="${a.hex}" stroke="${mixHex(a.hex, -0.62)}"`
          + ` stroke-width="${fmt(Math.max(0.5, r * 0.09))}"`
        : ` fill="${pool.ref(a.hex)}"`;
      const alpha = a.alpha < 0.999
        ? ` fill-opacity="${fmt(a.alpha)}"${cel ? ` stroke-opacity="${fmt(a.alpha)}"` : ''}`
        : '';
      prims.push({
        depth: p.depth,
        svg: `<circle id="${prefix}${idKind}-${a.i}" class="${esc(cls)}"`
          + ` inkscape:label="${esc(label)}"`
          + ` cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(r)}"${paint}${alpha}/>`,
      });
      counts.atoms++;
    }
    return atoms;
  };

  const emitBonds = (mesh, atoms, idKind, bondModel, labelPrefix) => {
    const halves = bondHalves(mesh);
    if (halves.length === 0) return;
    const lookup = makeAtomLookup(atoms);
    for (const h of halves) {
      const atom = lookup(h.ax, h.ay, h.az);
      if (!atom) continue; // its atom is hidden or cut away
      let dx = h.mx - atom.x, dy = h.my - atom.y, dz = h.mz - atom.z;
      const d = Math.hypot(dx, dy, dz);
      if (!(d > atom.r)) continue; // the sphere swallows the whole half
      const centre = project(atom.x, atom.y, atom.z);
      if (!centre) continue;
      dx /= d; dy /= d; dz /= d;
      const sx = atom.x + dx * atom.r, sy = atom.y + dy * atom.r, sz = atom.z + dz * atom.r;
      const bond = bondModel?.[Math.floor(h.i / 2)];
      const pair = bond?.elements?.length >= 2
        ? `${bond.elements[0]}–${bond.elements[1]}` : (atom.element ?? '');
      const label = `${labelPrefix}${pair ? `${pair} ` : ''}bond`;
      const id = `${prefix}${idKind}-${Math.floor(h.i / 2)}${h.i % 2 === 0 ? 'a' : 'b'}`;
      const seg = {
        x1: sx, y1: sy, z1: sz, x2: h.mx, y2: h.my, z2: h.mz,
        radius: h.radius, hex: h.hex, alpha: h.alpha,
        ownerAtomId: `${prefix}${idKind.replace(/bond$/, 'atom')}-${atom.i}`,
        // SVG circles have no depth buffer. Keep the connected atom above its
        // whole half-bond so the deliberately buried butt cap stays hidden.
        depthFloor: centre.depth + 1e-6,
      };
      if (pushSegment(seg, id, 'bond', label, 'butt', MAX_BOND_PIECES)) counts.bondHalves++;
    }
  };

  /** Round-capped world segment -> <line>. Shared by cell edges, polyhedra
   *  edges and measurement dashes: identical geometry, different labels. */
  const emitSegment = (seg, id, cls, label) => pushSegment(seg, id, cls, label, 'round');

  // ---- atoms + bonds (main structure, then overlays, then hide-mode ghosts)
  const cutPlanes = activeAtomCutPlanes();
  const mainAtoms = emitAtoms(groups.atomsMesh, cutPlanes, 'atom', '');
  emitBonds(groups.bondsMesh, mainAtoms, 'bond',
    fileBrowser.selectedStructure?.bonds, '');
  let overlayIndex = -1;
  for (const [key, entry] of groups.overlayMeshes ?? []) {
    overlayIndex++;
    const tag = `ov${overlayIndex}`;
    const name = `overlay ${key}: `;
    const atoms = emitAtoms(entry?.atomsMesh, cutPlanes, `${tag}-atom`, name);
    emitBonds(entry?.bondsMesh, atoms, `${tag}-bond`, null, name);
  }
  emitAtoms(groups.ghostAtomsMesh, cutPlanes, 'ghost-atom', 'ghost ');

  // ---- unit cell
  latticeEdges().forEach((edge, i) => {
    if (emitSegment(edge, `${prefix}cell-${i}`, 'cell-edge', 'cell edge')) counts.cellEdges++;
  });

  // ---- polyhedra: flat-shaded face triangles + their edges
  const { faces, edges } = polyhedronParts();
  for (const poly of faces) {
    poly.tris.forEach((tri, t) => {
      const p0 = project(tri[0][0], tri[0][1], tri[0][2]);
      const p1 = project(tri[1][0], tri[1][1], tri[1][2]);
      const p2 = project(tri[2][0], tri[2][1], tri[2][2]);
      if (!p0 || !p1 || !p2) return;
      const minX = Math.min(p0.x, p1.x, p2.x), maxX = Math.max(p0.x, p1.x, p2.x);
      const minY = Math.min(p0.y, p1.y, p2.y), maxY = Math.max(p0.y, p1.y, p2.y);
      if (!onPage(minX, minY, maxX, maxY)) return;
      const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
      const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
      const cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
      // Lambert term without a camera matrix: for an orthographic camera
      // (px.x, -px.y, -depth * pixelsPerUnit) is view space up to one uniform
      // scale + translation, so the face normal comes out exactly right; for a
      // perspective camera it is right to within the triangle's own depth
      // spread, which is all flat shading needs.
      const s = radiusPx(cx, cy, cz, 1) || 1;
      const ax = p1.x - p0.x, ay = -(p1.y - p0.y), az = -(p1.depth - p0.depth) * s;
      const bx = p2.x - p0.x, by = -(p2.y - p0.y), bz = -(p2.depth - p0.depth) * s;
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nlen = Math.hypot(nx, ny, nz);
      const lambert = nlen > 1e-9
        ? Math.abs((nx * light.x + ny * light.y + nz * light.z) / nlen) : 1;
      const hex = scaleHex(poly.hex, FACE_AMBIENT + (1 - FACE_AMBIENT) * lambert);
      const alpha = poly.alpha < 0.999
        ? ` fill-opacity="${fmt(poly.alpha)}" stroke-opacity="${fmt(poly.alpha)}"` : '';
      prims.push({
        depth: (p0.depth + p1.depth + p2.depth) / 3,
        svg: `<polygon id="${prefix}poly-${poly.polyIndex}-f${t}" class="poly-face"`
          + ` inkscape:label="${esc(`polyhedron ${poly.polyIndex} face`)}"`
          + ` points="${fmt(p0.x)},${fmt(p0.y)} ${fmt(p1.x)},${fmt(p1.y)}`
          + ` ${fmt(p2.x)},${fmt(p2.y)}" fill="${hex}" stroke="${hex}"`
          + ` stroke-width="${FACE_SEAM_STROKE}" stroke-linejoin="round"${alpha}/>`,
      });
      counts.polyFaces++;
    });
  }
  edges.forEach((edge, i) => {
    if (emitSegment(edge, `${prefix}pedge-${i}`, 'poly-edge',
      `polyhedron ${edge.polyIndex} edge`)) counts.polyEdges++;
  });

  // ---- force / spin arrows: shaft line + triangular head
  arrowEntries().forEach((arrow, i) => {
    const tail = project(arrow.sx, arrow.sy, arrow.sz);
    const base = project(arrow.bx, arrow.by, arrow.bz);
    const apex = project(arrow.tx, arrow.ty, arrow.tz);
    if (!tail || !base || !apex) return;
    const hw = radiusPx(arrow.bx, arrow.by, arrow.bz, arrow.tipRadius);
    const shaftW = radiusPx(arrow.sx, arrow.sy, arrow.sz, arrow.shaftRadius)
      + radiusPx(arrow.bx, arrow.by, arrow.bz, arrow.shaftRadius);
    const minX = Math.min(tail.x, base.x, apex.x) - hw;
    const maxX = Math.max(tail.x, base.x, apex.x) + hw;
    const minY = Math.min(tail.y, base.y, apex.y) - hw;
    const maxY = Math.max(tail.y, base.y, apex.y) + hw;
    if (!onPage(minX, minY, maxX, maxY)) return;
    const dx = apex.x - base.x, dy = apex.y - base.y;
    const dlen = Math.hypot(dx, dy) || 1;
    const px = -dy / dlen, py = dx / dlen;
    const alpha = arrow.alpha < 0.999
      ? ` stroke-opacity="${fmt(arrow.alpha)}" fill-opacity="${fmt(arrow.alpha)}"` : '';
    const id = `${prefix}arrow-${i}`;
    const label = `${arrow.kind} arrow #${arrow.index}`;
    prims.push({
      depth: (tail.depth + base.depth + apex.depth) / 3,
      svg: `<g id="${id}" class="arrow ${arrow.kind}" inkscape:label="${esc(label)}">`
        + `<line id="${id}-shaft" x1="${fmt(tail.x)}" y1="${fmt(tail.y)}"`
        + ` x2="${fmt(base.x)}" y2="${fmt(base.y)}" stroke="${arrow.shaftHex}"`
        + ` stroke-width="${fmt(shaftW)}" stroke-linecap="butt"${alpha}/>`
        + `<polygon id="${id}-head" points="${fmt(base.x + px * hw)},${fmt(base.y + py * hw)}`
        + ` ${fmt(apex.x)},${fmt(apex.y)}`
        + ` ${fmt(base.x - px * hw)},${fmt(base.y - py * hw)}"`
        + ` fill="${arrow.tipHex}"${alpha}/>`
        + '</g>',
    });
    counts.arrows++;
  });

  // ---- measurement dashes
  measurementDashes().forEach((dash, i) => {
    if (emitSegment(dash, `${prefix}meas-${i}`, 'measurement',
      `${dash.type} measurement`)) counts.measurementLines++;
  });

  // ONE painter's sort over every kind at once: bigger depth = farther, so
  // descending depth puts near primitives last (on top).
  prims.sort((a, b) => b.depth - a.depth);

  return {
    defs: pool.defs.join('\n'),
    body: prims.map((p) => p.svg).join('\n'),
    counts,
    skipped: skippedContent(),
  };
}

/** Count the SVG elements a vector export would produce, without building any
 *  of them, so the dialog can warn before a 100k-element document. Deliberately
 *  rough: no projection, no culling, no atom lookups — an over-count in that
 *  direction, and an under-count for the depth splitting buildVectorStructure
 *  applies to segments that run away from the camera (it needs the projection
 *  this deliberately skips). */
export function estimateVectorPrimitiveCount() {
  let total = 0;
  const countInstances = (mesh, stride) => {
    if (!mesh?.visible || !mesh.count) return 0;
    const matrices = mesh.instanceMatrix?.array;
    if (!matrices) return 0;
    let n = 0;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      if (stride === 'atom') { if (matrices[o] > 0) n++; }
      else if (matrices[o] !== 0 || matrices[o + 5] !== 0) n++;
    }
    return n;
  };
  total += countInstances(groups.atomsMesh, 'atom');
  total += countInstances(groups.bondsMesh, 'bond');
  total += countInstances(groups.ghostAtomsMesh, 'atom');
  for (const entry of (groups.overlayMeshes ?? new Map()).values()) {
    total += countInstances(entry?.atomsMesh, 'atom');
    total += countInstances(entry?.bondsMesh, 'bond');
  }
  if (general.showLattice && groups.latticeGroup?.visible) {
    total += (groups.latticeGroup.children ?? []).length;
  }
  const polyGroup = groups.polyhedraGroup;
  if (polyGroup?.visible) {
    const edgeWidth = general.polyEdgeWidth ?? 1;
    for (const mesh of polyGroup.children ?? []) {
      if (mesh.userData?.type !== 'polyhedron' || !mesh.visible) continue;
      const position = mesh.geometry?.attributes?.position;
      const index = mesh.geometry?.index;
      if (position) total += Math.floor((index ? index.count : position.count) / 3);
      if (!(edgeWidth > 0)) continue;
      const edgeLines = mesh.children?.find((c) => c.userData?.type === 'polyhedron-edges');
      const segments = edgeLines?.visible ? edgeLines.userData?.segments : null;
      if (segments) total += Math.floor(segments.length / 6);
    }
  }
  const arrowPairs = (shaft, tip) => (shaft?.visible && tip?.visible
    ? Math.min(tip.count ?? 0, Math.floor((shaft.count ?? 0) / 2)) : 0);
  total += arrowPairs(groups.forcesShaftMesh, groups.forcesTipMesh);
  total += arrowPairs(groups.spinShaftMesh, groups.spinTipMesh);
  for (const group of measurements?.measureLines ?? []) {
    const type = group?.userData?.type;
    if (type !== 'distance' && type !== 'angle') continue;
    if (group.visible === false) continue;
    total += (group.children ?? []).filter((d) => d.visible !== false).length;
  }
  return total;
}
