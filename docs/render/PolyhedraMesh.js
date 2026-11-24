// All coordination polyhedra as ONE face geometry and ONE edge geometry,
// backed by a flat per-polyhedron table of typed arrays.
//
// Why: one THREE.Mesh + material + fat-line edges + depth proxy per
// polyhedron cost a shader program each (the depth-peel patch gives every
// patched material its own program cache key, DepthPeelUtils.js), ~16 draw
// calls each per frame under depth peeling, and seconds of object building
// for large cells. The goal is MD trajectories with 100 000+ atoms whose
// polyhedra are recoloured per frame, so everything per polyhedron lives in
// the table and in vertex attribute RANGES; the three.js objects are a
// handful, whatever the polyhedron count.
//
// Table (groups.polyhedraGroup.userData.polyTable, see polyhedraTable() in
// PolyhedraModule.js): row i is model polyhedron i (structure.polyhedra.
// polyhedra[i]); a row whose hull failed has faceCount 0 and is never drawn.
//   faceStart/faceCount   triangle range in the face geometry (non-indexed:
//                         vertices 3·faceStart …)
//   edgeStart/edgeCount   segment range in the edge geometry and `segments`
//   centerIndex           centre atom (source index), -1 for cages
//   center/radius         vertex centroid and bounding-sphere radius (picking)
//   kind/cn               0 centred, 1 cage / coordination number: the
//                         corners in use (during playback a centred row's
//                         corners can break off by the bond breaking
//                         tolerance, render/PolyhedraFrameModule.js; they
//                         stay in the row's range, after the cn in use)
//   cnFull                the corners the row reserves: cn at build plus
//                         the model polyhedron's reserveVertices (corners
//                         whose bond is broken, kept for their return)
//   color/edgeColor       linear RGB (THREE.Color components)
//   baseOpacity/…Edge…    authored alpha (style), never scaled
//   focus                 focus-region factor; opacity = baseOpacity·focus
//   visible               category show/hide
//   glow                  selection glow
//   key/groupKey/catKey/colorElem   plain arrays, built once
//   faceToPoly            triangle → row
//   segments              flat world-space edge segments [x1,y1,z1,x2,y2,z2,…]
//                         (the tracers' edge cylinders and the SVG export)
//
// Opaque and see-through polyhedra need different pipeline treatment (opaque
// ones write depth and skip the blend/peel passes, ForwardPipeline
// 'polyhedraFace'), and one mesh holds both. So the faces are drawn by two
// meshes sharing the geometry, and the edges likewise: an opaque one whose
// shader discards the see-through polyhedra and a transparent one that
// discards the opaque polyhedra (per-vertex alpha / per-segment alpha). Two
// materials per kind, persistent across rebuilds (MaterialStyles.js
// acquirePersistentMaterial) — the program count stays constant.
//
// Per-vertex `polyState` (unsigned byte): bit 1 glow, bit 2 hidden. Glow is
// the orange selection emissive (written by the selection code via
// setPolyGlow); hidden polyhedra are discarded by every polyhedra shader.

import * as THREE from '../external/three/three.module.js';
import { ConvexHull } from '../external/three/ConvexHull.js';
import { LineSegments2 } from '../external/three/LineSegments2.js';
import { LineSegmentsGeometry } from '../external/three/LineSegmentsGeometry.js';
import { LineMaterial } from '../external/three/LineMaterial.js';
import { app, general } from '../state/store.js';
import { CEL_OUTLINE_LAYER } from './CelOutlinePass.js';
import { acquirePersistentMaterial, addCelPolyOutline } from './MaterialStyles.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';

const EDGE_ANGLE_COS = Math.cos(THREE.MathUtils.degToRad(18)); // EdgesGeometry threshold of old
const OPAQUE_ALPHA = 0.999;
const STATE_GLOW = 1;
const STATE_HIDDEN = 2;

// Same orange as the selection glow everywhere else (SelectAndHighlightModule
// ATOM_HIGHLIGHT_COLOR, HighlightOverlay). One uniform object shared by both
// face programs.
const GLOW_UNIFORM = { value: new THREE.Color(0xFF8C00) };

let tableSerial = 0;

// ---------------------------------------------------------------- materials

// GLSL alpha tests per pass. A see-through face at alpha 0 draws nothing in
// the blend either, so it is dropped early.
const FACE_DISCARD = {
  o: 'if ( vPolyState > 1.5 || vColor.a < 0.999 ) discard;',
  t: 'if ( vPolyState > 1.5 || vColor.a >= 0.999 || vColor.a <= 0.0 ) discard;',
};
const EDGE_DISCARD = {
  o: 'if ( vPolyAlpha < 0.999 ) discard;',
  t: 'if ( vPolyAlpha >= 0.999 || vPolyAlpha <= 0.0 ) discard;',
};

// Installed BEFORE applyTransparency, so the depth-peel / WBOIT patches
// (StagedTransparencyPipeline._patchTransparentMaterial) chain this
// onBeforeCompile and compose this cache key with theirs.
function patchFaceMaterial(material, pass) {
  material.customProgramCacheKey = () => `cv-poly-face-${pass}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPolyGlowColor = GLOW_UNIFORM;
    shader.vertexShader = 'attribute float polyState;\nvarying float vPolyState;\n'
      + shader.vertexShader.replace('#include <color_vertex>', '#include <color_vertex>\n\tvPolyState = polyState;');
    // glow bit: state 1 or 3 → fract(state/2) = 0.5
    shader.fragmentShader = 'uniform vec3 uPolyGlowColor;\nvarying float vPolyState;\n'
      + shader.fragmentShader
        .replace('#include <color_fragment>', `${FACE_DISCARD[pass]}\n\t#include <color_fragment>`)
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += step( 0.25, fract( vPolyState * 0.5 ) ) * uPolyGlowColor;');
  };
}

function patchEdgeMaterial(material, pass) {
  material.customProgramCacheKey = () => `cv-poly-edge-${pass}`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float instancePolyAlpha;\nvarying float vPolyAlpha;\n'
      + shader.vertexShader.replace('void main() {', 'void main() {\n\tvPolyAlpha = instancePolyAlpha;');
    shader.fragmentShader = 'varying float vPolyAlpha;\n'
      + shader.fragmentShader.replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        `${EDGE_DISCARD[pass]}\n\tgl_FragColor = vec4( diffuseColor.rgb, alpha * vPolyAlpha );`);
  };
}

function faceMaterial(pass) {
  return acquirePersistentMaterial(`polyhedraFace-${pass}`, 'v1', () => {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.0, roughness: 1.0, side: THREE.DoubleSide,
    });
    patchFaceMaterial(material, pass);
    return material;
  });
}

function edgeMaterial(pass) {
  return acquirePersistentMaterial(`polyhedraEdge-${pass}`, 'v1', () => {
    // WORLD units (worldUnits) so the edges scale with the structure when
    // zooming; polyEdgeWidth 1 = the unit-cell line thickness (0.03 Å
    // diameter), matching the tracers' edge cylinders (0.015 radius).
    const material = new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: 0.03 });
    patchEdgeMaterial(material, pass);
    return material;
  });
}

// Depth proxy for the screen-space cel outline pass: the see-through faces
// write no depth, so an opaque copy on the outline-only layer gives the
// silhouettes there. Hidden polyhedra are discarded.
function depthProxyMaterial() {
  return acquirePersistentMaterial('polyhedraDepthProxy', 'v1', () => {
    const material = new THREE.MeshBasicMaterial();
    material.customProgramCacheKey = () => 'cv-poly-depth-proxy';
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float polyState;\nvarying float vPolyState;\n'
        + shader.vertexShader.replace('void main() {', 'void main() {\n\tvPolyState = polyState;');
      shader.fragmentShader = 'varying float vPolyState;\n'
        + shader.fragmentShader.replace('void main() {', 'void main() {\n\tif ( vPolyState > 1.5 ) discard;');
    };
    return material;
  });
}

// ---------------------------------------------------------------- building

/**
 * Triangulate every model polyhedron into one table + shared buffers. O(N):
 * one ConvexHull per polyhedron (as before — the triangulation), its points
 * from a reused Vector3 pool, everything else into preallocated typed arrays.
 *
 * Every row RESERVES the convex-hull bounds for its vertex count (2V−4
 * triangles, 3V−6 edges: faceCap/edgeCap) rather than packing its actual
 * counts, and keeps its triangulation as local vertex indices (triV) and its
 * hull edges with their two faces (hullE). That is what lets an MD or
 * trajectory frame move the polyhedra in place (updatePolyGeometry, driven
 * by render/PolyhedraFrameModule.js): new corner positions, the same
 * triangles — re-triangulated within the reserved range when the old ones
 * stop being convex — and only the GPU ranges rewritten. Unused reserved
 * slots are degenerate (all three corners at the centre, alpha 0), so they
 * draw nothing; every reader goes by faceStart/faceCount, edgeStart/
 * edgeCount.
 * @param {{polyhedra: any[]}} model
 * @param {{outlineDirs?: boolean}} [options] outlineDirs: also bake the cel
 *   hull's per-vertex push directions (3D-hull outline mode only)
 */
export function buildPolyhedraTable(model, { outlineDirs = false } = {}) {
  const polys = model?.polyhedra ?? [];
  const n = polys.length;
  let maxTris = 0, maxSegs = 0, maxVerts = 0, totalVerts = 0;
  for (const p of polys) {
    const v = (p.vertices?.length ?? 0) + (p.reserveVertices?.length ?? 0);
    if (v >= 4) { maxTris += 2 * v - 4; maxSegs += 3 * v - 6; }
    if (v > maxVerts) maxVerts = v;
    totalVerts += v;
  }
  const positions = new Float32Array(maxTris * 9);
  const normals = new Float32Array(maxTris * 9);
  const dirs = outlineDirs ? new Float32Array(maxTris * 9) : null;
  const segments = new Float32Array(maxSegs * 6);
  const faceToPolyAll = new Uint32Array(maxTris);

  const table = {
    serial: ++tableSerial,
    n,
    faceStart: new Uint32Array(n), faceCount: new Uint32Array(n),
    edgeStart: new Uint32Array(n), edgeCount: new Uint32Array(n),
    faceCap: new Uint32Array(n), edgeCap: new Uint32Array(n),
    centerIndex: new Int32Array(n),
    center: new Float32Array(3 * n), radius: new Float32Array(n),
    kind: new Uint8Array(n), cn: new Uint16Array(n), cnFull: new Uint16Array(n),
    color: new Float32Array(3 * n), edgeColor: new Float32Array(3 * n),
    baseOpacity: new Float32Array(n), baseEdgeOpacity: new Float32Array(n),
    focus: new Float32Array(n).fill(1),
    opacity: new Float32Array(n), edgeOpacity: new Float32Array(n),
    visible: new Uint8Array(n), glow: new Uint8Array(n),
    /** @type {string[]} */ key: new Array(n),
    /** @type {string[]} */ groupKey: new Array(n),
    /** @type {string[]} */ catKey: new Array(n),
    /** @type {string[]} */ colorElem: new Array(n),
    faceToPoly: faceToPolyAll,
    positions, normals, segments, outlineDirs: dirs,
    // Corners (Float64, Cartesian Å), the polyhedraProperties table layout:
    // row i's are vertXYZ[3·vertStart[i] …], cn[i] of them, in model order.
    vertStart: new Uint32Array(n), vertXYZ: new Float64Array(3 * totalVerts),
    // Triangulation (local corner indices, 3 per reserved triangle) and hull
    // edges (corner a, corner b, face left, face right; 4 per reserved edge).
    triV: new Uint16Array(maxTris * 3), hullE: new Uint16Array(maxSegs * 4),
    hullEdgeCount: new Uint32Array(n),
    triangleCount: 0, segmentCount: 0,
    styleVersion: 0,
    // Bumped by every in-place geometry update (updatePolyGeometry): the
    // tracers' scene signature and the highlight ghosts follow it.
    geomVersion: 0,
    /** @type {any[]|null} tracer plane cache (SceneEncoder._polyPlanes) */ rtPlanes: null,
    /** @type {any} */ faceGeometry: null,
    /** @type {any} */ edgeGeometry: null,
    /** @type {any} */ objects: null,
    /** @type {any} per-frame topology, render/PolyhedraFrameModule.js */ topo: null,
    /** @type {Map<string, number>|null} */ _keyIndex: null,
    /** @type {Map<string, number[]>|null} */ _groupIndex: null,
  };

  const pool = [];
  for (let k = 0; k < maxVerts; k++) {
    const v = new THREE.Vector3();
    v.cvIndex = k; // the hull hands back these objects: their corner index
    pool.push(v);
  }
  const hull = new ConvexHull();
  let tri = 0, seg = 0, vtx = 0;
  const xyz = table.vertXYZ;
  for (let i = 0; i < n; i++) {
    const poly = polys[i];
    const verts = poly.vertices ?? [];
    table.key[i] = poly.key ?? '';
    table.groupKey[i] = poly.groupKey ?? '';
    table.catKey[i] = poly.catKey ?? '';
    table.colorElem[i] = poly.colorElem ?? '';
    table.centerIndex[i] = (poly.type === 'centered' && Number.isInteger(poly.centerIndex)) ? poly.centerIndex : -1;
    table.kind[i] = poly.type === 'centered' ? 0 : 1;
    const nv = verts.length;
    const reserve = poly.reserveVertices ?? [];
    const full = nv + reserve.length;
    table.cn[i] = nv;
    table.cnFull[i] = full;
    table.vertStart[i] = vtx;
    for (let k = 0; k < full; k++) {
      const o = 3 * (vtx + k);
      const p = k < nv ? verts[k] : reserve[k - nv];
      xyz[o] = p[0]; xyz[o + 1] = p[1]; xyz[o + 2] = p[2];
    }
    vtx += full;
    table.faceStart[i] = tri;
    table.edgeStart[i] = seg;
    // reserved for every corner, those kept for return included
    const fcap = full >= 4 ? 2 * full - 4 : 0, ecap = full >= 4 ? 3 * full - 6 : 0;
    table.faceCap[i] = fcap;
    table.edgeCap[i] = ecap;
    faceToPolyAll.fill(i, tri, tri + fcap);
    tri += fcap;
    seg += ecap;
    if (nv >= 4) {
      const points = pool.length === nv ? pool : pool.slice(0, nv);
      for (let k = 0; k < nv; k++) points[k].set(verts[k][0], verts[k][1], verts[k][2]);
      let ok = true;
      try { hull.setFromPoints(points); } catch { ok = false; }
      if (ok) ok = readHullTopology(table, i, hull.faces);
      if (!ok) { table.faceCount[i] = 0; table.hullEdgeCount[i] = 0; }
    }
    updatePolyGeometry(table, i);
  }
  table.triangleCount = tri;
  table.segmentCount = seg;

  // GPU buffers (the style arrays are filled by the caller, then uploaded)
  if (tri) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(table.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(table.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tri * 12), 4));
    g.setAttribute('polyState', new THREE.BufferAttribute(new Uint8Array(tri * 3), 1, false));
    if (dirs) g.setAttribute('outlineDir', new THREE.BufferAttribute(dirs, 3));
    g.computeBoundingSphere();
    table.faceGeometry = g;
  }
  if (seg) {
    const eg = new LineSegmentsGeometry().setPositions(table.segments);
    eg.setColors(new Float32Array(seg * 6));
    eg.setAttribute('instancePolyAlpha', new THREE.InstancedBufferAttribute(new Float32Array(seg), 1));
    table.edgeGeometry = eg;
  }
  return table;
}

/**
 * Copy a three.js ConvexHull's faces into row i's triangulation (triV) and
 * hull edges (hullE), as local corner indices (the pool points' cvIndex).
 * @returns {boolean} false when the hull does not fit the row's reserve or
 *   is not a closed triangulation (then nothing is drawn for the row)
 */
function readHullTopology(table, i, faces) {
  const fcap = table.faceCap[i], ecap = table.edgeCap[i];
  if (faces.length < 4 || faces.length > fcap) return false;
  const t0 = table.faceStart[i] * 3, e0 = table.edgeStart[i] * 4;
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    face.cvIndex = f;
    let e = face.edge, k = 0;
    do {
      if (k < 3) table.triV[t0 + 3 * f + k] = e.head().point.cvIndex;
      k++;
      e = e.next;
    } while (e !== face.edge);
    if (k !== 3) return false;
  }
  let ne = 0;
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    let e = face.edge;
    do {
      const other = e.twin?.face;
      if (other && other.cvIndex > f) {
        if (ne >= ecap) return false;
        const o = e0 + 4 * ne;
        table.hullE[o] = e.tail().point.cvIndex;
        table.hullE[o + 1] = e.head().point.cvIndex;
        table.hullE[o + 2] = f;
        table.hullE[o + 3] = other.cvIndex;
        ne++;
      }
      e = e.next;
    } while (e !== face.edge);
  }
  table.faceCount[i] = faces.length;
  table.hullEdgeCount[i] = ne;
  return true;
}

// Face normals of one row (unit, 3 per face), grown with the largest reserve.
let FN = new Float64Array(0);
function faceNormalScratch(fcap) {
  if (FN.length < 3 * fcap) FN = new Float64Array(Math.max(3 * fcap, 96));
  return FN;
}

/**
 * Write row i's triangles, normals (and cel push directions), feature-edge
 * segments, centre and radius from its corners (vertXYZ) and stored
 * triangulation — CPU arrays only; commitPolyGeometry flags the upload.
 * Reserved slots past the row's counts are made degenerate at the centre.
 * No allocation (one shared normal scratch). Feature edges: a hull edge
 * whose two faces meet at more than 18° (coplanar triangles of one face are
 * not outlined), as the EdgesGeometry of old.
 * @param {any} table
 * @param {number} i
 * @returns {boolean} whether the feature-edge count changed (the caller
 *   re-sends the row's edge colours then)
 */
export function updatePolyGeometry(table, i) {
  const xyz = table.vertXYZ, vs = 3 * table.vertStart[i], nv = table.cn[i];
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < nv; k++) { cx += xyz[vs + 3 * k]; cy += xyz[vs + 3 * k + 1]; cz += xyz[vs + 3 * k + 2]; }
  if (nv) { cx /= nv; cy /= nv; cz /= nv; }
  let r2 = 0;
  for (let k = 0; k < nv; k++) {
    const dx = xyz[vs + 3 * k] - cx, dy = xyz[vs + 3 * k + 1] - cy, dz = xyz[vs + 3 * k + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  table.center[3 * i] = cx; table.center[3 * i + 1] = cy; table.center[3 * i + 2] = cz;
  table.radius[i] = Math.sqrt(r2);

  const positions = table.positions, normals = table.normals, dirs = table.outlineDirs;
  const triV = table.triV, f0 = table.faceStart[i], nf = table.faceCount[i], fcap = table.faceCap[i];
  const fn = faceNormalScratch(fcap);
  for (let f = 0; f < nf; f++) {
    const t = 3 * (f0 + f);
    const a = vs + 3 * triV[t], b = vs + 3 * triV[t + 1], c = vs + 3 * triV[t + 2];
    const ux = xyz[b] - xyz[a], uy = xyz[b + 1] - xyz[a + 1], uz = xyz[b + 2] - xyz[a + 2];
    const wx = xyz[c] - xyz[a], wy = xyz[c + 1] - xyz[a + 1], wz = xyz[c + 2] - xyz[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    fn[3 * f] = nx; fn[3 * f + 1] = ny; fn[3 * f + 2] = nz;
    let o = (f0 + f) * 9;
    for (let k = 0; k < 3; k++, o += 3) {
      const p = vs + 3 * triV[t + k];
      const px = xyz[p], py = xyz[p + 1], pz = xyz[p + 2];
      positions[o] = px; positions[o + 1] = py; positions[o + 2] = pz;
      normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
      if (dirs) {
        // radial from the centre: duplicated flat-shaded vertices at the
        // same corner get the same direction, so the hull stays watertight
        let dx = px - cx, dy = py - cy, dz = pz - cz;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 0) { dx /= len; dy /= len; dz /= len; }
        dirs[o] = dx; dirs[o + 1] = dy; dirs[o + 2] = dz;
      }
    }
  }
  for (let o = (f0 + nf) * 9, end = (f0 + fcap) * 9; o < end; o += 3) {
    positions[o] = cx; positions[o + 1] = cy; positions[o + 2] = cz;
    normals[o] = 0; normals[o + 1] = 0; normals[o + 2] = 0;
    if (dirs) { dirs[o] = 0; dirs[o + 1] = 0; dirs[o + 2] = 0; }
  }

  const segments = table.segments, hullE = table.hullE;
  const e0 = table.edgeStart[i], he0 = 4 * e0, ne = table.hullEdgeCount[i], ecap = table.edgeCap[i];
  let seg = 0;
  for (let e = 0; e < ne; e++) {
    const h = he0 + 4 * e;
    const fa = 3 * hullE[h + 2], fb = 3 * hullE[h + 3];
    if (fn[fa] * fn[fb] + fn[fa + 1] * fn[fb + 1] + fn[fa + 2] * fn[fb + 2] > EDGE_ANGLE_COS) continue;
    const a = vs + 3 * hullE[h], b = vs + 3 * hullE[h + 1];
    const s = (e0 + seg) * 6;
    segments[s] = xyz[a]; segments[s + 1] = xyz[a + 1]; segments[s + 2] = xyz[a + 2];
    segments[s + 3] = xyz[b]; segments[s + 4] = xyz[b + 1]; segments[s + 5] = xyz[b + 2];
    seg++;
  }
  for (let s = (e0 + seg) * 6, end = (e0 + ecap) * 6; s < end; s += 3) {
    segments[s] = cx; segments[s + 1] = cy; segments[s + 2] = cz;
  }
  const changed = seg !== table.edgeCount[i];
  table.edgeCount[i] = seg;
  return changed;
}

/**
 * Is row i's stored triangulation still the convex hull of its (moved)
 * corners? Every corner must lie on or below every face plane, within
 * `relTol` × the row's radius. The tolerance accepts the fold of a nearly
 * flat quad (a cube face) drawn along the "wrong" diagonal — a few
 * hundredths of an ångström, invisible — instead of re-triangulating such a
 * polyhedron on every frame. No allocation.
 * @param {any} table @param {number} i @param {number} relTol
 */
export function polyTriangulationValid(table, i, relTol) {
  const nf = table.faceCount[i];
  if (!nf) return false;
  const xyz = table.vertXYZ, vs = 3 * table.vertStart[i], nv = table.cn[i];
  const triV = table.triV, t0 = 3 * table.faceStart[i];
  // radius from the corners themselves (center/radius are last frame's)
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < nv; k++) { cx += xyz[vs + 3 * k]; cy += xyz[vs + 3 * k + 1]; cz += xyz[vs + 3 * k + 2]; }
  cx /= nv; cy /= nv; cz /= nv;
  let r2 = 0;
  for (let k = 0; k < nv; k++) {
    const dx = xyz[vs + 3 * k] - cx, dy = xyz[vs + 3 * k + 1] - cy, dz = xyz[vs + 3 * k + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  const tol = relTol * Math.sqrt(r2);
  for (let f = 0; f < nf; f++) {
    const t = t0 + 3 * f;
    const ia = triV[t], ib = triV[t + 1], ic = triV[t + 2];
    const a = vs + 3 * ia, b = vs + 3 * ib, c = vs + 3 * ic;
    const ux = xyz[b] - xyz[a], uy = xyz[b + 1] - xyz[a + 1], uz = xyz[b + 2] - xyz[a + 2];
    const wx = xyz[c] - xyz[a], wy = xyz[c + 1] - xyz[a + 1], wz = xyz[c + 2] - xyz[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 1e-12 * r2)) return false; // a sliver: let the hull decide
    const lim = tol * l;
    for (let k = 0; k < nv; k++) {
      if (k === ia || k === ib || k === ic) continue;
      const q = vs + 3 * k;
      if ((xyz[q] - xyz[a]) * nx + (xyz[q + 1] - xyz[a + 1]) * ny + (xyz[q + 2] - xyz[a + 2]) * nz > lim) return false;
    }
  }
  return true;
}

/**
 * Re-triangulate row i from its current corners into its reserved range
 * (the allocation-free hull of model/polyhedraProperties.js), and rebuild
 * its hull-edge list from the new triangles.
 * @param {any} table @param {number} i
 * @param {(xyz: any, start: number, n: number, relTol: number, out: any, outOffset: number) => number} hullTriangles
 *   model/polyhedraProperties.js convexHullTriangles (passed in: this module
 *   stays free of model imports)
 * @returns {boolean} false when the corners are degenerate (flat) — the
 *   caller then falls back to a full rebuild
 */
export function retriangulatePoly(table, i, hullTriangles) {
  const nv = table.cn[i], fcap = table.faceCap[i];
  if (nv < 4) return false;
  const t0 = 3 * table.faceStart[i];
  const nf = hullTriangles(table.vertXYZ, table.vertStart[i], nv, 1e-6, table.triV, t0);
  if (nf < 4 || nf > fcap) return false;
  // Edges: each directed edge (a,b) of face f meets the face holding (b,a);
  // record it once, from the lower face. O(F²) on ≤ 2V−4 faces — rare path.
  const triV = table.triV, hullE = table.hullE, he0 = 4 * table.edgeStart[i], ecap = table.edgeCap[i];
  let ne = 0;
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = triV[t0 + 3 * f + k], b = triV[t0 + 3 * f + (k + 1) % 3];
      for (let g = f + 1; g < nf; g++) {
        const g0 = triV[t0 + 3 * g], g1 = triV[t0 + 3 * g + 1], g2 = triV[t0 + 3 * g + 2];
        if ((g0 === b && g1 === a) || (g1 === b && g2 === a) || (g2 === b && g0 === a)) {
          if (ne >= ecap) return false;
          const o = he0 + 4 * ne;
          hullE[o] = a; hullE[o + 1] = b; hullE[o + 2] = f; hullE[o + 3] = g;
          ne++;
          break;
        }
      }
    }
  }
  table.faceCount[i] = nf;
  table.hullEdgeCount[i] = ne;
  return true;
}

const _box = new THREE.Box3();
const _bc = new THREE.Vector3();

/**
 * Flag the GPU upload after updatePolyGeometry rewrote rows in place: one
 * upload of the position/normal (and cel direction) buffers and the edge
 * segments, bounds from the rows' centres and radii (O(rows), no buffer
 * walk), the tracers' plane cache dropped and geomVersion bumped. `restyle`
 * rows (face or feature-edge counts changed) get their colour ranges
 * re-sent; their stale reserved edge slots go to alpha 0 first.
 * @param {any} table
 * @param {ArrayLike<number>|null} restyle
 */
export function commitPolyGeometry(table, restyle = null) {
  const fg = table.faceGeometry, eg = table.edgeGeometry;
  _box.makeEmpty();
  let maxR = 0;
  for (let i = 0; i < table.n; i++) {
    if (!table.faceCount[i]) continue;
    _bc.set(table.center[3 * i], table.center[3 * i + 1], table.center[3 * i + 2]);
    _box.expandByPoint(_bc);
    if (table.radius[i] > maxR) maxR = table.radius[i];
  }
  if (!_box.isEmpty()) _box.expandByScalar(maxR);
  if (fg) {
    fg.getAttribute('position').needsUpdate = true;
    fg.getAttribute('normal').needsUpdate = true;
    const od = fg.getAttribute('outlineDir');
    if (od) od.needsUpdate = true;
    if (!_box.isEmpty()) {
      fg.boundingBox ??= new THREE.Box3();
      fg.boundingBox.copy(_box);
      fg.boundingSphere ??= new THREE.Sphere();
      _box.getBoundingSphere(fg.boundingSphere);
    }
  }
  if (eg) {
    const start = eg.getAttribute('instanceStart');
    if (start?.data) start.data.needsUpdate = true;
    if (!_box.isEmpty()) {
      eg.boundingBox ??= new THREE.Box3();
      eg.boundingBox.copy(_box);
      eg.boundingSphere ??= new THREE.Sphere();
      _box.getBoundingSphere(eg.boundingSphere);
    }
  }
  if (restyle?.length) {
    const alpha = eg?.getAttribute('instancePolyAlpha');
    if (alpha) {
      for (let k = 0; k < restyle.length; k++) {
        const i = restyle[k];
        const e0 = table.edgeStart[i];
        alpha.array.fill(0, e0 + table.edgeCount[i], e0 + table.edgeCap[i]);
        alpha.addUpdateRange(e0, table.edgeCap[i]);
      }
    }
    const color = fg?.getAttribute('color');
    if (color) {
      for (let k = 0; k < restyle.length; k++) {
        const i = restyle[k];
        const f0 = table.faceStart[i] * 3;
        // faces past a shrunk count keep their old colour but are degenerate
        color.array.fill(0, (f0 + table.faceCount[i] * 3) * 4, (f0 + table.faceCap[i] * 3) * 4);
        color.addUpdateRange(f0 * 4, table.faceCap[i] * 12);
      }
    }
    uploadPolyStyles(table, restyle);
  }
  table.rtPlanes = null;
  table.geomVersion++;
}

/**
 * The three.js objects drawing a table, added to `group` (the polyhedra
 * group); the table is stamped on group.userData.polyTable.
 * @param {any} table from buildPolyhedraTable (styles written)
 * @param {any} group THREE.Group
 */
export function addPolyhedraObjects(table, group) {
  group.userData.polyTable = table;
  const objects = { faceO: null, faceT: null, edgeO: null, edgeT: null, proxy: null, hull: null };
  table.objects = objects;
  if (table.faceGeometry) {
    const faceO = new THREE.Mesh(table.faceGeometry, faceMaterial('o'));
    applyTransparency(faceO.material, { kind: 'polyhedraFace', opacity: 1, mesh: faceO });
    faceO.userData.type = 'polyhedra-faces';
    // Picking: per-polyhedron bounding spheres, then only those triangles
    // (render/pickVisible.js, the label/badge occlusion rays). One mesh
    // answers for both face meshes.
    faceO.raycast = (raycaster, intersects) => raycastPolyhedra(table, faceO, raycaster, intersects);
    const faceT = new THREE.Mesh(table.faceGeometry, faceMaterial('t'));
    applyTransparency(faceT.material, { kind: 'polyhedraFace', opacity: 1, needsTransparency: true, mesh: faceT });
    faceT.userData.type = 'polyhedra-faces';
    faceT.raycast = () => {};
    const proxy = new THREE.Mesh(table.faceGeometry, depthProxyMaterial());
    proxy.layers.set(CEL_OUTLINE_LAYER); // outline pass only
    proxy.raycast = () => {};
    group.add(faceO, faceT, proxy);
    Object.assign(objects, { faceO, faceT, proxy });
    if (table.faceGeometry.getAttribute('outlineDir')) {
      objects.hull = addCelPolyOutline(group, table.faceGeometry);
    }
  }
  if (table.edgeGeometry) {
    const size = app.renderer ? app.renderer.getSize(new THREE.Vector2()) : null;
    const make = (pass) => {
      const material = edgeMaterial(pass);
      material.linewidth = Math.max(0.03 * (general.polyEdgeWidth ?? 1), 1e-5);
      if (size) material.resolution.set(size.x, size.y);
      const lines = new LineSegments2(table.edgeGeometry, material);
      applyTransparency(material, { kind: 'polyhedraEdge', opacity: 1, needsTransparency: pass === 't', mesh: lines });
      lines.raycast = () => {}; // never intercept picking
      lines.userData.type = 'polyhedra-edges';
      group.add(lines);
      return lines;
    };
    objects.edgeO = make('o');
    objects.edgeT = make('t');
  }
  syncPolyhedraVisibility(table);
}

// ---------------------------------------------------------------- styles

const _c = new THREE.Color();

/**
 * Write one row's style into the table (CPU only; call uploadPolyStyles).
 * @param {any} table
 * @param {number} i
 * @param {any} color face colour (anything THREE.Color.set takes)
 * @param {number} opacity authored face alpha
 * @param {any} edgeColor
 * @param {number} edgeOpacity authored edge alpha
 * @param {boolean} visible category show/hide
 */
export function setPolyStyle(table, i, color, opacity, edgeColor, edgeOpacity, visible) {
  _c.set(color);
  table.color[3 * i] = _c.r; table.color[3 * i + 1] = _c.g; table.color[3 * i + 2] = _c.b;
  _c.set(edgeColor);
  table.edgeColor[3 * i] = _c.r; table.edgeColor[3 * i + 1] = _c.g; table.edgeColor[3 * i + 2] = _c.b;
  table.baseOpacity[i] = opacity;
  table.baseEdgeOpacity[i] = edgeOpacity;
  table.visible[i] = visible ? 1 : 0;
  table.opacity[i] = opacity * table.focus[i];
  table.edgeOpacity[i] = edgeOpacity * table.focus[i];
}

/** Focus-region factor of one row (scales both authored alphas). */
export function setPolyFocus(table, i, focus) {
  table.focus[i] = focus;
  table.opacity[i] = table.baseOpacity[i] * focus;
  table.edgeOpacity[i] = table.baseEdgeOpacity[i] * focus;
}

/** Raw linear RGB face colour of one row (the disco ball's random paint). */
// A paint override (ui/DiscoModule.js): while set, every polyhedron's face
// and edge colour comes from this picker instead of the styles, and the
// style writers (a rebuild, updatePolyhedraColors, the per-frame property
// colouring) repaint through it, so a full rebuild during playback does not
// undo the paint. null = normal styling.
/** @type {((i: number) => string) | null} */
let paintOverride = null;
/** @param {((i: number) => string) | null} pick CSS colour per table row, or null */
export function setPolyPaintOverride(pick) { paintOverride = pick; }
export function polyPaintOverride() { return paintOverride; }

export function setPolyColorRGB(table, i, r, g, b, edge = true) {
  table.color[3 * i] = r; table.color[3 * i + 1] = g; table.color[3 * i + 2] = b;
  if (edge) { table.edgeColor[3 * i] = r; table.edgeColor[3 * i + 1] = g; table.edgeColor[3 * i + 2] = b; }
}

function writeRow(table, i, colorArr, stateArr, edgeColorArr, edgeAlphaArr) {
  const f0 = table.faceStart[i] * 3, f1 = f0 + table.faceCount[i] * 3;
  if (colorArr && f1 > f0) {
    const r = table.color[3 * i], g = table.color[3 * i + 1], b = table.color[3 * i + 2], a = table.opacity[i];
    for (let v = f0; v < f1; v++) {
      const o = v * 4;
      colorArr[o] = r; colorArr[o + 1] = g; colorArr[o + 2] = b; colorArr[o + 3] = a;
    }
    stateArr.fill((table.visible[i] ? 0 : STATE_HIDDEN) | (table.glow[i] ? STATE_GLOW : 0), f0, f1);
  }
  const e0 = table.edgeStart[i], e1 = e0 + table.edgeCount[i];
  if (edgeColorArr && e1 > e0) {
    const r = table.edgeColor[3 * i], g = table.edgeColor[3 * i + 1], b = table.edgeColor[3 * i + 2];
    for (let s = e0; s < e1; s++) {
      const o = s * 6;
      edgeColorArr[o] = r; edgeColorArr[o + 1] = g; edgeColorArr[o + 2] = b;
      edgeColorArr[o + 3] = r; edgeColorArr[o + 4] = g; edgeColorArr[o + 5] = b;
    }
    edgeAlphaArr.fill(table.visible[i] ? table.edgeOpacity[i] : 0, e0, e1);
  }
}

function attrs(table) {
  const fg = table.faceGeometry, eg = table.edgeGeometry;
  return {
    color: fg?.getAttribute('color') ?? null,
    state: fg?.getAttribute('polyState') ?? null,
    edgeColor: eg?.getAttribute('instanceColorStart')?.data ?? null, // interleaved rgb,rgb
    edgeAlpha: eg?.getAttribute('instancePolyAlpha') ?? null,
  };
}

/**
 * Upload the table's styles to the GPU buffers: every row, or only `rows`
 * (then only their ranges are re-sent). Bumps styleVersion (the tracers'
 * scene signature) and re-syncs which of the opaque / see-through meshes
 * have anything to draw.
 * @param {any} table
 * @param {ArrayLike<number>|null} [rows]
 */
export function uploadPolyStyles(table, rows = null) {
  if (!table) return;
  const a = attrs(table);
  const cArr = a.color?.array, sArr = a.state?.array, ecArr = a.edgeColor?.array, eaArr = a.edgeAlpha?.array;
  if (rows) {
    for (let k = 0; k < rows.length; k++) {
      const i = rows[k];
      if (!(i >= 0 && i < table.n)) continue;
      writeRow(table, i, cArr, sArr, ecArr, eaArr);
      const f0 = table.faceStart[i] * 3, fc = table.faceCount[i] * 3;
      if (fc && a.color) { a.color.addUpdateRange(f0 * 4, fc * 4); a.state.addUpdateRange(f0, fc); }
      const e0 = table.edgeStart[i], ec = table.edgeCount[i];
      if (ec && a.edgeColor) { a.edgeColor.addUpdateRange(e0 * 6, ec * 6); a.edgeAlpha.addUpdateRange(e0, ec); }
    }
  } else {
    for (let i = 0; i < table.n; i++) writeRow(table, i, cArr, sArr, ecArr, eaArr);
    // A pending range (an earlier single-row or glow write this frame) would
    // limit the upload to that range: send the whole buffers instead.
    for (const attr of [a.color, a.state, a.edgeColor, a.edgeAlpha]) attr?.clearUpdateRanges();
  }
  if (a.color) { a.color.needsUpdate = true; a.state.needsUpdate = true; }
  if (a.edgeColor) { a.edgeColor.needsUpdate = true; a.edgeAlpha.needsUpdate = true; }
  table.styleVersion++;
  syncPolyhedraVisibility(table);
}

/**
 * Show only the meshes that have something to draw: the opaque face mesh
 * when any shown polyhedron is opaque, the see-through one when any is
 * see-through (a mesh with nothing to draw would still cost its passes), the
 * edges at a non-zero width, the cel hull when any polyhedron is opaque (the
 * hull shader drops the see-through ones — an opaque shell would black out
 * what lies behind them).
 */
export function syncPolyhedraVisibility(table) {
  const objects = table?.objects;
  if (!objects) return;
  let opaque = false, clear = false, anyShown = false, edgeOpaque = false, edgeClear = false;
  for (let i = 0; i < table.n; i++) {
    if (!table.visible[i]) continue;
    if (table.faceCount[i]) {
      anyShown = true;
      if (table.opacity[i] >= OPAQUE_ALPHA) opaque = true; else if (table.opacity[i] > 0) clear = true;
    }
    if (table.edgeCount[i]) {
      if (table.edgeOpacity[i] >= OPAQUE_ALPHA) edgeOpaque = true; else if (table.edgeOpacity[i] > 0) edgeClear = true;
    }
  }
  const edgesOn = (general.polyEdgeWidth ?? 1) > 0;
  if (objects.faceO) objects.faceO.visible = opaque;
  if (objects.faceT) objects.faceT.visible = clear;
  if (objects.proxy) objects.proxy.visible = anyShown;
  if (objects.edgeO) objects.edgeO.visible = edgesOn && edgeOpaque;
  if (objects.edgeT) objects.edgeT.visible = edgesOn && edgeClear;
  if (objects.hull) {
    objects.hull.userData.anyOpaque = opaque;
    objects.hull.visible = general.celHullPolyWidth > 0 && opaque;
  }
}

/**
 * Switch the orange selection glow of `rows` on or off. Rows outside the
 * table (a stale selection after a rebuild) are ignored. Only the touched
 * ranges are re-sent; the tracers' signature is left alone (their highlight
 * is the ghost overlay, so a selection never restarts accumulation).
 * @param {any} table
 * @param {ArrayLike<number>} rows
 * @param {boolean} on
 */
export function setPolyGlow(table, rows, on) {
  if (!table || !rows?.length) return;
  const state = table.faceGeometry?.getAttribute('polyState');
  const v = on ? 1 : 0;
  for (let k = 0; k < rows.length; k++) {
    const i = rows[k];
    if (!(i >= 0 && i < table.n) || table.glow[i] === v) continue;
    table.glow[i] = v;
    if (!state) continue;
    const f0 = table.faceStart[i] * 3, fc = table.faceCount[i] * 3;
    if (!fc) continue;
    state.array.fill((table.visible[i] ? 0 : STATE_HIDDEN) | (v ? STATE_GLOW : 0), f0, f0 + fc);
    state.addUpdateRange(f0, fc);
    state.needsUpdate = true;
  }
}

/** Clear every glow of the table (one pass). */
export function clearPolyGlow(table) {
  if (!table) return;
  const rows = [];
  for (let i = 0; i < table.n; i++) if (table.glow[i]) rows.push(i);
  setPolyGlow(table, rows, false);
}

/** Live edge width on the shared edge materials (0 hides the edges). */
export function setPolyEdgeLinewidth(table, width) {
  for (const pass of ['o', 't']) edgeMaterial(pass).linewidth = Math.max(0.03 * width, 1e-5);
  syncPolyhedraVisibility(table);
}

/** '#rrggbb' of a row's face (or edge) colour. */
export function polyColorHex(table, i, edge = false) {
  const arr = edge ? table.edgeColor : table.color;
  return `#${_c.setRGB(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]).getHexString()}`;
}

/** Row of a stable key, or -1 (a key → row map built once per table). */
export function polyIndexOfKey(table, key) {
  if (!table) return -1;
  if (!table._keyIndex) {
    table._keyIndex = new Map();
    for (let i = 0; i < table.n; i++) if (table.faceCount[i]) table._keyIndex.set(table.key[i], i);
  }
  return table._keyIndex.get(key) ?? -1;
}

/** Drawn rows of a periodic-copy group (built once per table). */
export function polyIndicesOfGroup(table, groupKey) {
  if (!table) return [];
  if (!table._groupIndex) {
    table._groupIndex = new Map();
    for (let i = 0; i < table.n; i++) {
      if (!table.faceCount[i]) continue;
      const g = table.groupKey[i];
      const list = table._groupIndex.get(g);
      if (list) list.push(i); else table._groupIndex.set(g, [i]);
    }
  }
  return table._groupIndex.get(groupKey) ?? [];
}

// ---------------------------------------------------------------- picking

const _inv = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _sphere = new THREE.Sphere();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _hit = new THREE.Vector3(), _hitWorld = new THREE.Vector3(), _best = new THREE.Vector3();

/**
 * Raycast against the shown polyhedra: a bounding-sphere test per row, then
 * only that row's triangles (both sides). One intersection per polyhedron,
 * its nearest; the hit carries `polyIndex` (the table row) and `faceIndex`
 * (the triangle). Hidden polyhedra are skipped; alpha is left to the caller.
 */
function raycastPolyhedra(table, mesh, raycaster, intersects) {
  const pos = table.positions;
  _inv.copy(mesh.matrixWorld).invert();
  _ray.copy(raycaster.ray).applyMatrix4(_inv);
  const origin = raycaster.ray.origin;
  for (let i = 0; i < table.n; i++) {
    const fc = table.faceCount[i];
    if (!fc || !table.visible[i]) continue;
    _sphere.center.set(table.center[3 * i], table.center[3 * i + 1], table.center[3 * i + 2]);
    _sphere.radius = table.radius[i];
    if (!_ray.intersectsSphere(_sphere)) continue;
    let best = Infinity, bestTri = -1;
    const t0 = table.faceStart[i];
    for (let t = t0; t < t0 + fc; t++) {
      const o = t * 9;
      _va.set(pos[o], pos[o + 1], pos[o + 2]);
      _vb.set(pos[o + 3], pos[o + 4], pos[o + 5]);
      _vc.set(pos[o + 6], pos[o + 7], pos[o + 8]);
      if (!_ray.intersectTriangle(_va, _vb, _vc, false, _hit)) continue;
      _hitWorld.copy(_hit).applyMatrix4(mesh.matrixWorld);
      const d = origin.distanceTo(_hitWorld);
      if (d < raycaster.near || d > raycaster.far || d >= best) continue;
      best = d; bestTri = t; _best.copy(_hitWorld);
    }
    if (bestTri >= 0) {
      intersects.push({ distance: best, point: _best.clone(), object: mesh, faceIndex: bestTri, polyIndex: i, face: null });
    }
  }
}
