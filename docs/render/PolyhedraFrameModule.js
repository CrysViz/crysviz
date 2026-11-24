// Polyhedra on the MD / trajectory fast path, and polyhedra coloured by a
// per-polyhedron property (Polyhedra window ▸ Colour by).
//
// WHY. Every frame with polyhedra on used to take the full path: a polyhedra
// search plus a mesh rebuild per frame — hundreds of milliseconds to seconds
// on a large cell, so playback with polyhedra was a slide show. Between two
// full rebuilds the polyhedra are the same polyhedra: the same centre atom,
// the same corner atoms, in the same periodic images. Only their positions
// change. So a full rebuild captures that TOPOLOGY (captureTopology) and a
// fast frame (fastUpdatePolyhedra, called by FastFrameModule.applyFrameFast)
// recomputes the corners from the new atom positions, keeps each
// polyhedron's triangulation while it is still convex (re-triangulating in
// place, within the range reserved for it, when it is not) and rewrites the
// shared face / edge buffers by range (render/PolyhedraMesh.js). The search
// itself — fast or advanced — runs on the full rebuilds only, so the advanced
// search costs 1/20 of itself per frame during an MD run.
//
// TOPOLOGY. Per corner: its source atom and its fractional position at the
// time the polyhedra were computed, unwrapped (vertU). A frame places the
// corner at the image of its atom nearest that reference: f = now +
// round(vertU − now). That is exact while no atom moves half a cell between
// two rebuilds (the rebuild cadence guarantees far less), and needs neither
// the wrapping's crossing counters nor a copy of the old positions — an atom
// that wraps through a cell face is still found next to its polyhedron. A
// centre atom is placed the same way against the corners' centroid (as the
// Polyhedron Inspector finds it, PolyhedraAnalysisModule.js).
//
// BOND BREAKING TOLERANCE (render/BondBreakTolerance.js). A centred
// polyhedron's corner is the bond from its centre: it follows the bonds'
// rule. Per corner the topology keeps its pair cutoff (centre element,
// corner element — the cutoff the search used, vertCutoffSq). Each fast
// frame an active corner farther than cutoff × (1 + tol) from the centre
// breaks off, an inactive one within the cutoff comes back. A row whose
// corners changed is compacted — the active corners to the front of its
// range, every per-corner array permuted alike — table.cn[i] becomes the
// active count (table.cnFull[i] keeps the reserved one), the row is
// re-triangulated over its active corners within its reserve, and the
// model polyhedron's vertices / vertexSrcList shrink or grow with it. Below
// four active corners the row draws nothing (hidden, not deleted) until
// corners return. Inactive corners are still moved every frame, so a return
// is seen. Cages are left as they are. At a full rebuild the previous
// topology is the memory: mergeToleranceHeldPolyhedra adds to the new
// (strict) search result the corners, polyhedra and cages the tolerance
// still holds, before the new table is built.
//
// COLOURING. general.polyhedraColor: 'style' (the category colours) or a
// model/polyhedraProperties.js id. The values are computed on the table's
// own corner arrays (the property-table layout, no copy) after every full
// rebuild, every style write and every fast frame, mapped through a colour
// map over general.polyhedraColorMin/Max (null = fit to the data, once — the
// range then stays put so frames stay comparable) and written as face and
// edge colours: opacity, visibility, glow and focus are the style's. A
// polyhedron the property does not apply to (tilt of a CN8, the distortion
// index of a cage) is drawn in a neutral grey (general.polyhedraColorGreyOthers,
// the default) or keeps its style colours. The edges of the coloured
// polyhedra (general.polyhedraColorEdges): a neutral grey darker than the
// grey faces ('grey', the default), the face's colour ('property') or the
// style's edge colour ('style').
//
// RANGE OVER THE TRAJECTORY. On a multi-frame structure (a trajectory,
// relaxation or MD run whose frames are in its store, in motion — not a set
// of unrelated structures) a fit of the range reads the property over the
// frames, not only the one on screen: up to RANGE_MAX_FRAMES frames evenly
// spaced over the run (first and last included). Each is evaluated on
// scratch copies of the corner and centre arrays: the captured topology's
// corners are placed at that frame's positions with the fast frame's maths,
// the property computed with the frame on screen's tilt axes — nothing drawn,
// no model, no triangulation touched. Up to RANGE_SYNC_LIMIT atoms × frames
// at once; above it in RANGE_CHUNK_MS slices on timers, the bar showing the
// frame on screen's range until the trajectory's replaces it (unless the
// limits were typed, or the property changed, meanwhile). A live run is
// fitted over the frames it has at the time, then held as before.
//
// TILT FRAME. general.polyhedraTiltFrame: 'cell' (the cell axes, the maths
// module's default), 'matrix' (the pseudo-cubic cell given as a 3×3 in terms
// of the current cell, rows = new axes, as the lattice transformation input)
// or 'auto': per polyhedron type, the mean orientation of its CN4/CN6
// members in the current frame (model/polyhedraProperties.js
// meanOrientationFrame — corner-sharing neighbours tilt in opposite senses,
// so the mean is the untilted pseudo-cubic frame in any cell setting). One
// frame per type, handed to the maths as per-row frames (frames/frameOf), so
// one batch pass covers every type. Each type's frame is seeded with its
// previous one, so its axes keep their order and sign from frame to frame
// (tiltA does not turn into tiltB between frames of a 45° setting).

import { general, groups, structureShip } from '../state/store.js';
import { pendingFramePositions } from '../model/materializeFrame.js';
import {
  convexHullTriangles, computePolyhedraProperty, computePolyhedraOrientations,
  meanOrientationFrame, alignFrameTo, cellReferenceFrame, getPolyhedraProperty,
  isSignedPolyhedraProperty, isOrientationProperty,
} from '../model/polyhedraProperties.js';
import {
  polyTriangulationValid, retriangulatePoly, updatePolyGeometry, commitPolyGeometry,
  setPolyColorRGB, uploadPolyStyles, polyPaintOverride,
} from './PolyhedraMesh.js';
import { colorMapTable, colorBin } from './ColorMapBins.js';
import { bondBreakTolerance, cutoffSignature, TOLERANCE_LENGTH_LIMIT } from './BondBreakTolerance.js';
import { requestRender } from './AnimateModule.js';
import { compactActive, cornerKey, mergeCorners, reservedCorners, cageHeld } from '../model/bondBreakTolerance.js';

// A stored triangulation is kept while every corner lies within this share
// of the polyhedron radius of every face plane (PolyhedraMesh.js
// polyTriangulationValid). What exceeds it in practice is the fold of a
// nearly flat quad (a cuboctahedron's or cube's square faces) drawn along
// the other diagonal: a non-planar quad shows a crease of about that height
// either way, concave instead of convex, so 10 % of the radius looks the
// same — and re-triangulating every cuboctahedron of a thermally moving
// cell on every frame was most of the polyhedra cost of a fast frame.
const TRIANGULATION_TOL = 0.1;

const stats = {
  fastFrames: 0, // fast frames that moved the polyhedra
  retriangulated: 0, // polyhedra re-triangulated in place (all frames)
  cornersBroken: 0, // corners broken off by the bond breaking tolerance rule (all frames)
  cornersFormed: 0, // corners come back within the cutoff (all frames)
  captures: 0, // topologies captured (full rebuilds)
  lastBail: /** @type {string | null} */ (null),
  lastMs: 0, // geometry part of the last fast frame
  lastColorMs: 0, // property + colours part of the last frame
};

/** Counters for tests and the MD profile: how many fast frames moved the
 *  polyhedra, how many polyhedra had to be re-triangulated, why the last
 *  attempt fell back. */
export function polyhedraFastFrameStats() {
  return { ...stats };
}

/** The drawn polyhedra table (render/PolyhedraMesh.js) or null. Read
 *  directly: importing PolyhedraModule here would be a cycle. */
function currentTable() {
  return groups.polyhedraGroup?.userData?.polyTable ?? null;
}

/** Fractional positions of the frame on screen: the deferred column while a
 *  trajectory frame's physics is pending (model/materializeFrame.js), else
 *  the atoms (as FastFrameModule.positionSource). */
function framePositions(structure) {
  const col = pendingFramePositions(structure);
  return col ? { col, atoms: null } : { col: null, atoms: structure.atoms };
}

function inverse3(L) {
  const [[a, b, c], [d, e, f], [g, h, k]] = L;
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return null;
  const s = 1 / det;
  return [
    [A * s, -(b * k - c * h) * s, (b * f - c * e) * s],
    [B * s, (a * k - c * g) * s, -(a * f - c * d) * s],
    [C * s, -(a * h - b * g) * s, (a * e - b * d) * s],
  ];
}

// Last automatic frame per polyhedron type (catKey) of the structure last
// coloured, carried across full rebuilds as the seed of the new table's
// frames, so the axis naming survives a rebuild too.
let frameMemory = new Map();
let frameMemoryStructure = null;
let rangeStructure = null;

/**
 * Record what a fast frame needs to move the polyhedra of `table` (built
 * from `model` for `structure`). Called by renderPolyhedra after every full
 * build. O(corners); strings only per polyhedron type.
 * @param {any} table render/PolyhedraMesh.js table
 * @param {any} structure
 * @param {any} model structure.polyhedra (model/Polyhedra.js); its
 *   srcLattice, when set, is the cell the corners were computed in
 * @param {{cutoffOf?: (e1: string, e2: string) => number}} [opts] cutoffOf:
 *   the pair cutoff (Å) the search used (BondsFracUpdateModule
 *   getBondLengthCutoff) — the corners' bond breaking tolerance rule; without
 *   it corners never break off
 */
export function captureTopology(table, structure, model, { cutoffOf } = {}) {
  const n = table.n;
  const totalV = table.vertXYZ.length / 3;
  const polys = model?.polyhedra ?? [];
  const L = model?.srcLattice ?? structure?.lattice;
  const inv = L ? inverse3(L) : null;
  const topo = {
    structure, model,
    // the atom count captured, and the fast frames that moved this topology:
    // the bond breaking tolerance memory is a playback memory only
    nAtoms: structure?.elements?.length ?? 0,
    movedFrames: 0,
    noFast: !inv,
    failed: false,
    vertSrc: new Int32Array(totalV),
    vertU: new Float64Array(3 * totalV),
    // per corner: the pair cutoff² (centre–corner; 0 = never breaks off) and
    // its model vertex ([x, y, z], written in place each frame), permuted
    // with the corners when a row is compacted
    vertCutoffSq: new Float64Array(totalV),
    vertObj: /** @type {any[]} */ (new Array(totalV)),
    hidden: new Uint8Array(n), // fewer than 4 active corners (or flat): nothing drawn
    restyleMark: new Uint8Array(n),
    keep: new Uint8Array(0),
    // cages: their hull edges at build (local corner pairs), kept while all
    // stay within cutoff × (1 + tol) at a rebuild
    cageEdgeStart: new Int32Array(n + 1),
    cageEdges: new Uint16Array(0),
    centerU: new Float64Array(3 * n),
    centerXYZ: new Float64Array(3 * n),
    centerIsCentroid: new Uint8Array(n),
    skip: new Uint8Array(n), // no hull at build: never drawn, never moved
    restyle: new Int32Array(n),
    values: new Float32Array(n),
    styleColor: new Float32Array(3 * n),
    styleEdgeColor: new Float32Array(3 * n),
    // corners / centres / values of another frame (the range over the
    // trajectory), allocated on its first use
    rangeScratch: /** @type {any} */ (null),
    // automatic tilt frame: rows grouped by type, one frame per type
    typeKeys: /** @type {string[]} */ ([]),
    typeLabels: /** @type {string[]} */ ([]),
    typeStart: new Int32Array(0),
    typeRows: new Int32Array(0),
    frames: new Float64Array(0),
    framesValid: new Uint8Array(0),
    frameOf: new Int32Array(n).fill(-1),
    propTable: /** @type {any} */ (null),
  };
  table.topo = topo;
  stats.captures++;
  if (!inv) return topo;
  const xyz = table.vertXYZ;
  const elements = structure?.elements ?? [];
  let maxCn = 0, cageEdgeTotal = 0;
  for (let i = 0; i < n; i++) {
    if (table.cnFull[i] > maxCn) maxCn = table.cnFull[i];
    if (table.centerIndex[i] < 0 && table.faceCount[i]) cageEdgeTotal += table.hullEdgeCount[i];
  }
  topo.keep = new Uint8Array(maxCn);
  topo.cageEdges = new Uint16Array(2 * cageEdgeTotal);
  let ce = 0;
  for (let i = 0; i < n; i++) {
    const nv = table.cn[i], full = table.cnFull[i];
    const vs = table.vertStart[i];
    const poly = polys[i];
    // the corners in use, then those kept for return (reserve*)
    const srcOf = (k) => (k < nv ? poly?.vertexSrcList?.[k] : poly?.reserveSrcList?.[k - nv]);
    if (!table.faceCount[i]) topo.skip[i] = 1;
    const c = table.centerIndex[i];
    const centerElem = c >= 0 ? elements[c] : null;
    for (let k = 0; k < full; k++) {
      const v = vs + k;
      topo.vertObj[v] = (k < nv ? poly?.vertices?.[k] : poly?.reserveVertices?.[k - nv]) ?? null;
      const s = srcOf(k);
      if (cutoffOf && centerElem && Number.isInteger(s) && s >= 0) {
        const cut = cutoffOf(centerElem, elements[s]);
        topo.vertCutoffSq[v] = cut > 1e-3 ? cut * cut : 0;
      }
    }
    topo.cageEdgeStart[i] = ce;
    if (c < 0 && table.faceCount[i]) {
      const he0 = 4 * table.edgeStart[i];
      for (let e = 0; e < table.hullEdgeCount[i]; e++) {
        topo.cageEdges[2 * ce] = table.hullE[he0 + 4 * e];
        topo.cageEdges[2 * ce + 1] = table.hullE[he0 + 4 * e + 1];
        ce++;
      }
    }
    let ux = 0, uy = 0, uz = 0;
    for (let k = 0; k < full; k++) {
      const v = vs + k;
      const s = srcOf(k);
      if (!Number.isInteger(s) || s < 0) { topo.noFast = true; topo.vertSrc[v] = 0; } else topo.vertSrc[v] = s;
      const x = xyz[3 * v], y = xyz[3 * v + 1], z = xyz[3 * v + 2];
      for (let c = 0; c < 3; c++) {
        const f = x * inv[0][c] + y * inv[1][c] + z * inv[2][c];
        topo.vertU[3 * v + c] = f;
        // the centre's reference: the centroid of the corners in use
        if (k >= nv) continue;
        if (c === 0) ux += f; else if (c === 1) uy += f; else uz += f;
      }
    }
    if (nv) { ux /= nv; uy /= nv; uz /= nv; }
    topo.centerU[3 * i] = ux; topo.centerU[3 * i + 1] = uy; topo.centerU[3 * i + 2] = uz;
  }
  // Polyhedron types with members that have an orientation (CN4 / CN6).
  const typeOf = new Map();
  const typeIdx = new Int32Array(n).fill(-1);
  const counts = [];
  for (let i = 0; i < n; i++) {
    if (topo.skip[i] || (table.cn[i] !== 4 && table.cn[i] !== 6)) continue;
    const key = table.catKey[i] || `cn${table.cn[i]}`;
    let t = typeOf.get(key);
    if (t === undefined) {
      t = counts.length;
      typeOf.set(key, t);
      counts.push(0);
      topo.typeKeys.push(key);
      topo.typeLabels.push(polys[i]?.catLabel || key);
    }
    typeIdx[i] = t;
    counts[t]++;
  }
  const nt = counts.length;
  topo.typeStart = new Int32Array(nt + 1);
  for (let t = 0; t < nt; t++) topo.typeStart[t + 1] = topo.typeStart[t] + counts[t];
  topo.typeRows = new Int32Array(topo.typeStart[nt]);
  const fill = topo.typeStart.slice(0, nt);
  topo.cageEdgeStart[n] = ce;
  for (let i = 0; i < n; i++) if (typeIdx[i] >= 0) topo.typeRows[fill[typeIdx[i]]++] = i;
  topo.frames = new Float64Array(9 * nt).fill(NaN);
  topo.framesValid = new Uint8Array(nt);
  if (frameMemoryStructure !== structure) { frameMemory = new Map(); frameMemoryStructure = structure; }
  topo.propTable = {
    count: n,
    vertStart: table.vertStart, vertCount: table.cn, vertXYZ: table.vertXYZ,
    centerXYZ: topo.centerXYZ, centerIsCentroid: topo.centerIsCentroid,
    lattice: structure.lattice,
    frames: topo.frames, frameOf: topo.frameOf,
  };
  placeCenters(table, topo, framePositions(structure), structure.lattice);
  return topo;
}

/** Every corner at the image of its atom nearest its reference (see the
 *  header), from the positions `src`, in the cell `L`, into `out`. */
function moveCorners(topo, src, L, out) {
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = L;
  const { col, atoms } = src;
  const vertSrc = topo.vertSrc, vertU = topo.vertU;
  const nVert = vertSrc.length;
  for (let v = 0; v < nVert; v++) {
    const s = vertSrc[v];
    let p0, p1, p2;
    if (col) { p0 = col[3 * s]; p1 = col[3 * s + 1]; p2 = col[3 * s + 2]; } else {
      const p = atoms[s].position;
      p0 = p[0]; p1 = p[1]; p2 = p[2];
    }
    const o = 3 * v;
    const f0 = p0 + Math.round(vertU[o] - p0);
    const f1 = p1 + Math.round(vertU[o + 1] - p1);
    const f2 = p2 + Math.round(vertU[o + 2] - p2);
    out[o] = f0 * ax + f1 * bx + f2 * cx;
    out[o + 1] = f0 * ay + f1 * by + f2 * cy;
    out[o + 2] = f0 * az + f1 * bz + f2 * cz;
  }
}

/** Centres for the property table: a centre atom at its image nearest the
 *  corners' centroid; a cage's stand-in is the corners' centroid (of the
 *  corners in `xyz`). Written to `out`. */
function placeCenters(table, topo, src, L, xyz = table.vertXYZ, out = topo.centerXYZ) {
  const { col, atoms } = src;
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = L;
  const cU = topo.centerU;
  for (let i = 0; i < table.n; i++) {
    const c = table.centerIndex[i];
    if (c >= 0) {
      let p0, p1, p2;
      if (col) { p0 = col[3 * c]; p1 = col[3 * c + 1]; p2 = col[3 * c + 2]; } else {
        const p = atoms[c]?.position;
        if (!p) { out[3 * i] = NaN; continue; }
        p0 = p[0]; p1 = p[1]; p2 = p[2];
      }
      const f0 = p0 + Math.round(cU[3 * i] - p0);
      const f1 = p1 + Math.round(cU[3 * i + 1] - p1);
      const f2 = p2 + Math.round(cU[3 * i + 2] - p2);
      out[3 * i] = f0 * ax + f1 * bx + f2 * cx;
      out[3 * i + 1] = f0 * ay + f1 * by + f2 * cy;
      out[3 * i + 2] = f0 * az + f1 * bz + f2 * cz;
      topo.centerIsCentroid[i] = 0;
    } else {
      const nv = table.cn[i], vs = 3 * table.vertStart[i];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < nv; k++) { x += xyz[vs + 3 * k]; y += xyz[vs + 3 * k + 1]; z += xyz[vs + 3 * k + 2]; }
      out[3 * i] = nv ? x / nv : NaN; out[3 * i + 1] = nv ? y / nv : NaN; out[3 * i + 2] = nv ? z / nv : NaN;
      topo.centerIsCentroid[i] = 1;
    }
  }
}

/**
 * Move the drawn polyhedra to the frame's atom positions (see the header).
 * Called by FastFrameModule.applyFrameFast after its compatibility checks
 * and BEFORE it writes any atom or bond, so a fallback leaves the meshes
 * untouched. No allocation per polyhedron.
 * @param {any} structure
 * @returns {true | string} true when applied (or nothing to move), else why
 *   the frame must take the full path
 */
export function fastUpdatePolyhedra(structure) {
  const table = currentTable();
  // Nothing drawn (no polyhedra, or the first compute still in flight).
  if (!table || !table.n) return true;
  const topo = table.topo;
  if (!topo) return fail('polyhedra topology missing');
  if (topo.structure !== structure) return fail('polyhedra of another structure');
  if (topo.noFast) return fail('polyhedra corners without source atoms');
  // A polyhedron already failed on this table: its rebuild was requested
  // (the full path ran) and is computing — keep the last geometry meanwhile
  // instead of sending every frame down the full path again.
  if (topo.failed) return true;
  const t0 = performance.now();
  const L = structure.lattice;
  const src = framePositions(structure);
  const xyz = table.vertXYZ;
  moveCorners(topo, src, L, xyz);
  // Centres for the new corners (the corner rule measures from them, the
  // property maths read them).
  placeCenters(table, topo, src, L);
  const restyle = topo.restyle, mark = topo.restyleMark;
  let nr = 0;
  const addRestyle = (i) => { if (!mark[i]) { mark[i] = 1; restyle[nr++] = i; } };
  // Corners that break off or come back (bond breaking tolerance, see the
  // header): rows whose corners changed are compacted and re-triangulated.
  const f = 1 + bondBreakTolerance();
  const holdSq = f * f;
  let shapeChanged = false;
  for (let i = 0; i < table.n; i++) {
    if (topo.skip[i] || table.centerIndex[i] < 0) continue;
    if (updateActiveCorners(table, topo, i, holdSq)) { addRestyle(i); shapeChanged = true; }
  }
  // Triangulations (the only step that can fail), geometry after.
  for (let i = 0; i < table.n; i++) {
    if (topo.skip[i] || topo.hidden[i] || polyTriangulationValid(table, i, TRIANGULATION_TOL)) continue;
    const before = table.faceCount[i];
    if (!retriangulatePoly(table, i, convexHullTriangles)) {
      topo.failed = true;
      for (let k = 0; k < nr; k++) mark[restyle[k]] = 0;
      return fail('a polyhedron hull failed on the new positions');
    }
    stats.retriangulated++;
    if (table.faceCount[i] !== before) addRestyle(i);
  }
  for (let i = 0; i < table.n; i++) {
    if (topo.skip[i]) continue;
    if (updatePolyGeometry(table, i)) addRestyle(i);
  }
  commitPolyGeometry(table, nr ? restyle.subarray(0, nr) : null);
  for (let k = 0; k < nr; k++) mark[restyle[k]] = 0;
  if (shapeChanged) {
    // the key / group maps index drawn rows only
    table._keyIndex = null;
    table._groupIndex = null;
  }
  // The model follows (Polyhedron Inspector, focus regions, exports read
  // poly.vertices): written in place, no new arrays. A trajectory frame
  // switch drops structure.polyhedra as derived state of the previous frame
  // (model/materializeFrame.js); the moved model IS this frame's, so it goes
  // back on the structure.
  if (topo.model && structure.polyhedra !== topo.model) structure.polyhedra = topo.model;
  const polys = topo.model?.polyhedra;
  if (polys) {
    for (let i = 0; i < table.n; i++) {
      const poly = polys[i];
      const verts = poly?.vertices;
      if (!verts) continue;
      if (verts.length !== table.cn[i] || (poly.reserveSrcList?.length ?? 0) !== table.cnFull[i] - table.cn[i]) {
        syncModelCorners(table, topo, i, poly);
      }
      const vs = 3 * table.vertStart[i];
      for (let k = 0; k < verts.length; k++) {
        const v = verts[k];
        v[0] = xyz[vs + 3 * k]; v[1] = xyz[vs + 3 * k + 1]; v[2] = xyz[vs + 3 * k + 2];
      }
    }
  }
  topo.propTable.lattice = L;
  stats.lastMs = performance.now() - t0;
  stats.fastFrames++;
  topo.movedFrames++;
  stats.lastBail = null;
  applyPolyhedraPropertyColors(table);
  return true;
}

function fail(reason) {
  stats.lastBail = reason;
  return reason;
}

/**
 * The bond breaking tolerance rule on row i's corners (moved already, centre
 * placed): an active corner (k < cn) breaks off beyond cutoff² × holdSq, an
 * inactive one (cn ≤ k < cnFull) returns within cutoff². When any changed,
 * compacts the row (active corners first), sets cn and re-triangulates it
 * over them — or hides it below four corners (or when they are flat).
 * No allocation (scratch grown at capture).
 * @returns {boolean} whether the row's corners changed
 */
function updateActiveCorners(table, topo, i, holdSq) {
  const vs = table.vertStart[i], full = table.cnFull[i], na = table.cn[i];
  const cx = topo.centerXYZ[3 * i], cy = topo.centerXYZ[3 * i + 1], cz = topo.centerXYZ[3 * i + 2];
  if (!(cx === cx)) return false; // no centre position (NaN)
  const xyz = table.vertXYZ, cutSq = topo.vertCutoffSq, keep = topo.keep;
  let changed = false, count = 0;
  for (let k = 0; k < full; k++) {
    const v = vs + k, o = 3 * v;
    const dx = xyz[o] - cx, dy = xyz[o + 1] - cy, dz = xyz[o + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const cs = cutSq[v];
    const active = k < na;
    // no cutoff known: the corner stays as it is
    const on = cs > 0 ? d2 <= (active ? cs * holdSq : cs) : active;
    keep[k] = on ? 1 : 0;
    if (on) count++;
    if (on !== active) {
      changed = true;
      if (active) stats.cornersBroken++; else stats.cornersFormed++;
    }
  }
  if (!changed) return false;
  compactActive(keep, vs, full, [
    { data: xyz, stride: 3 }, { data: topo.vertSrc }, { data: topo.vertU, stride: 3 },
    { data: cutSq }, { data: topo.vertObj },
  ]);
  table.cn[i] = count;
  if (count >= 4 && retriangulatePoly(table, i, convexHullTriangles)) {
    topo.hidden[i] = 0;
    stats.retriangulated++;
  } else {
    topo.hidden[i] = 1;
    table.faceCount[i] = 0;
    table.hullEdgeCount[i] = 0;
  }
  return true;
}

/** The model polyhedron of row i follows its active corners: vertices and
 *  vertexSrcList hold the first cn[i], reserveVertices / reserveSrcList the
 *  broken-off rest (in place; an array grows only when corners move to it). */
function syncModelCorners(table, topo, i, poly) {
  const vs = table.vertStart[i], na = table.cn[i], full = table.cnFull[i];
  const fill = (key, from, to, fromObj) => {
    if (!Array.isArray(poly[key])) poly[key] = Array.from(poly[key] ?? []);
    const arr = poly[key];
    arr.length = to - from;
    for (let k = from; k < to; k++) arr[k - from] = fromObj ? (topo.vertObj[vs + k] ?? [0, 0, 0]) : topo.vertSrc[vs + k];
  };
  fill('vertices', 0, na, true);
  fill('vertexSrcList', 0, na, false);
  fill('reserveVertices', na, full, true);
  fill('reserveSrcList', na, full, false);
}

/**
 * Before a new polyhedra table is built: add to the new, strictly searched
 * `model` what the bond breaking tolerance still holds of the polyhedra drawn
 * now (the previous table's topology, moved to the current frame):
 *  (a) a centre in both: the new corners ∪ the previously active corners
 *      within cutoff × (1 + tol), one per source atom and periodic image;
 *  (b) a centre only drawn before: kept with those corners, if four remain;
 *  in both, the previous corners whose bond is broken now (beyond the
 *  cutoff, within cutoff + TOLERANCE_LENGTH_LIMIT) stay reserved
 *  (reserveVertices) for their return within the cutoff — as between
 *  rebuilds, where a broken-off corner keeps its slot;
 *  (c) a centre only in the new model: as searched;
 *  (d) a cage only drawn before: kept while every hull edge it had at build
 *      is within its pair cutoff × (1 + tol).
 * Only after playback: the drawn topology was moved by fast frames (or was
 * itself built with corners held this way). Nothing on another structure,
 * after its atoms changed (a supercell), at tol 0, or when the cutoffs or the
 * search settings changed since (`model.toleranceSig` differs from the drawn
 * one's) — a recompute of a still structure is the search's result as is.
 * Keys are left to the caller (assignPolyhedraKeys, as for searched ones).
 * @param {any} structure
 * @param {any} model the new model (model/Polyhedra.js), keys assigned
 * @param {{cutoffOf: (e1: string, e2: string) => number,
 *   keyOf: (poly: any) => string,
 *   makePolyhedron: (opts: any) => any}} hooks
 *   cutoffOf: pair cutoff (Å); keyOf: a polyhedron's stable key in the
 *   current frame; makePolyhedron: a model/Polyhedron
 * @returns {number} how many polyhedra gained corners or were kept
 */
export function mergeToleranceHeldPolyhedra(structure, model, { cutoffOf, keyOf, makePolyhedron }) {
  const table = currentTable();
  const topo = table?.topo;
  if (!topo || topo.structure !== structure || topo.noFast || !topo.model || !model?.polyhedra) return 0;
  if (!topo.model.toleranceSig || topo.model.toleranceSig !== model.toleranceSig) return 0;
  if (!(topo.movedFrames > 0 || topo.model.toleranceCarry)) return 0;
  if ((structure.elements?.length ?? 0) !== topo.nAtoms) return 0;
  const tol = bondBreakTolerance();
  if (!(tol > 0)) return 0;
  const holdSq = (1 + tol) * (1 + tol);
  const L = structure.lattice;
  const inv = L ? inverse3(L) : null;
  if (!inv) return 0;
  const { col, atoms } = framePositions(structure);
  const posOf = (s, k) => (col ? col[3 * s + k] : (atoms[s]?.position?.[k] ?? 0));
  const elements = structure.elements ?? [];
  const toFrac = (x, y, z, out) => {
    for (let c = 0; c < 3; c++) out[c] = x * inv[0][c] + y * inv[1][c] + z * inv[2][c];
    return out;
  };
  const fr = [0, 0, 0];
  // A point near an image of atom s: that image now — its cell and position.
  const placeNear = (s, x, y, z) => {
    toFrac(x, y, z, fr);
    const img = [0, 1, 2].map((k) => Math.round(fr[k] - posOf(s, k)));
    const f = [0, 1, 2].map((k) => posOf(s, k) + img[k]);
    const cart = [0, 1, 2].map((c) => f[0] * L[0][c] + f[1] * L[1][c] + f[2] * L[2][c]);
    return { img, cart };
  };
  const newByKey = new Map();
  model.polyhedra.forEach((p, j) => { if (p.key) newByKey.set(p.key, j); });
  const oldPolys = topo.model.polyhedra;
  const xyz = table.vertXYZ;
  const added = [];
  let changed = 0;
  for (let i = 0; i < table.n; i++) {
    if (topo.skip[i]) continue;
    const old = oldPolys[i];
    const vs = table.vertStart[i];
    const c = table.centerIndex[i];
    if (c >= 0) {
      // centre image now, from where it was drawn
      const cp = topo.centerXYZ;
      if (!(cp[3 * i] === cp[3 * i])) continue;
      const centre = placeNear(c, cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
      const held = [], all = [];
      for (let k = 0; k < table.cnFull[i]; k++) {
        const v = vs + k, s = topo.vertSrc[v];
        const p = placeNear(s, xyz[3 * v], xyz[3 * v + 1], xyz[3 * v + 2]);
        const d = [0, 1, 2].map((q) => p.cart[q] - centre.cart[q]);
        const cutSq = topo.vertCutoffSq[v];
        const reach = cutSq > 0 ? Math.sqrt(cutSq) + TOLERANCE_LENGTH_LIMIT : 0;
        const corner = {
          key: cornerKey(s, p.img[0], p.img[1], p.img[2]), src: s, cart: p.cart,
          distSq: d[0] * d[0] + d[1] * d[1] + d[2] * d[2], cutSq, reachSq: reach * reach,
        };
        all.push(corner);
        if (k < table.cn[i]) held.push(corner);
      }
      const reserveOf = (merged) => reservedCorners(merged.map((m) => m.key), all);
      const key = `c:${c}:${centre.img.join(',')}`;
      const j = newByKey.get(key);
      if (j !== undefined) {
        // (a) union with the new corners
        const p = model.polyhedra[j];
        const fresh = (p.vertexSrcList ?? []).map((s, k) => {
          const v = p.vertices[k];
          const q = placeNear(s, v[0], v[1], v[2]);
          return { key: cornerKey(s, q.img[0], q.img[1], q.img[2]), src: s, cart: [v[0], v[1], v[2]] };
        });
        const merged = mergeCorners(fresh, held, holdSq);
        const reserve = reserveOf(merged);
        if (merged.length > fresh.length || reserve.length) {
          p.vertices = merged.map((m) => m.cart);
          p.vertexSrcList = merged.map((m) => m.src);
          p.reserveVertices = reserve.map((m) => m.cart);
          p.reserveSrcList = reserve.map((m) => m.src);
          changed++;
        }
      } else {
        // (b) only drawn before: kept while four corners hold
        const kept = mergeCorners([], held, holdSq);
        if (kept.length < 4) continue;
        const reserve = reserveOf(kept);
        added.push(makePolyhedron({
          name: old?.name ?? '', type: 'centered', centerIndex: c,
          centerElement: old?.centerElement ?? elements[c] ?? null,
          colorElem: old?.colorElem ?? elements[c] ?? null,
          vertices: kept.map((m) => m.cart), vertexSrcList: kept.map((m) => m.src),
          reserveVertices: reserve.map((m) => m.cart), reserveSrcList: reserve.map((m) => m.src),
        }));
        changed++;
      }
    } else {
      // (d) a cage: its corners now, the same cage when the new model has it
      const corners = [];
      const srcs = [];
      for (let k = 0; k < table.cn[i]; k++) {
        const v = vs + k, s = topo.vertSrc[v];
        corners.push(placeNear(s, xyz[3 * v], xyz[3 * v + 1], xyz[3 * v + 2]).cart);
        srcs.push(s);
      }
      const cage = makePolyhedron({
        name: old?.name ?? '', type: 'cage', centerIndex: null, centerElement: null,
        colorElem: old?.colorElem ?? null, vertices: corners, vertexSrcList: srcs,
      });
      if (newByKey.has(keyOf(cage))) continue;
      const e0 = topo.cageEdgeStart[i], e1 = topo.cageEdgeStart[i + 1];
      const dist = new Float64Array(e1 - e0), cut = new Float64Array(e1 - e0);
      for (let e = e0; e < e1; e++) {
        const a = topo.cageEdges[2 * e], b = topo.cageEdges[2 * e + 1];
        const pa = corners[a], pb = corners[b];
        dist[e - e0] = (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2;
        const cc = cutoffOf(elements[srcs[a]], elements[srcs[b]]);
        cut[e - e0] = cc > 1e-3 ? cc * cc : 0;
      }
      if (!cageHeld(dist, cut, holdSq)) continue;
      added.push(cage);
      changed++;
    }
  }
  for (const p of added) model.polyhedra.push(p);
  // corners now partly in the current cell: read back against it
  if (changed) model.srcLattice = L.map((row) => [...row]);
  // a rebuild right after this one (no frame between) keeps what was held
  model.toleranceCarry = changed > 0;
  return changed;
}

/** Signature of what decides the polyhedra besides the positions: the bond
 *  cutoffs and the search settings. A memory made under others is dropped.
 * @param {string} searchSettings the search mode and settings, as a string */
export function polyhedraToleranceSignature(searchSettings) {
  return `${cutoffSignature()}|${searchSettings}`;
}

// ---------------------------------------------------------------- colouring

/** Is a property colouring active (not the style colours)? */
export function polyhedraPropertyColorActive() {
  const id = general.polyhedraColor;
  return !!id && id !== 'style' && !!getPolyhedraProperty(id);
}

/** The colour map in use for the active property: the chosen one, or a
 *  diverging map for the signed tilt columns and a sequential one else. */
export function polyhedraColorMapName(id = general.polyhedraColor) {
  const chosen = general.polyhedraColorMap;
  if (chosen && chosen !== 'auto') return chosen;
  return isSignedPolyhedraProperty(id) ? 'managua' : 'viridis';
}

const _cellFrame = new Float64Array(9);
const _seed = new Float64Array(9);

/** Per-type mean frames into topo.frames / frameOf (see the header). */
function computeAutoFrames(topo, pt, lattice) {
  const nt = topo.typeKeys.length;
  const haveCell = cellReferenceFrame(lattice, _cellFrame);
  topo.frameOf.fill(-1);
  for (let t = 0; t < nt; t++) {
    const start = topo.typeStart[t], count = topo.typeStart[t + 1] - start;
    let seed = null;
    if (topo.framesValid[t]) {
      for (let k = 0; k < 9; k++) _seed[k] = topo.frames[9 * t + k];
      seed = _seed;
    } else {
      const mem = frameMemory.get(topo.typeKeys[t]);
      if (mem) { _seed.set(mem); seed = _seed; }
    }
    const used = meanOrientationFrame(pt, topo.typeRows, start, count, seed, topo.frames, 9 * t);
    if (!used) { topo.framesValid[t] = 0; continue; }
    // First frame of this type: name the axes after the cell axes they lie
    // nearest (the seeded result keeps the previous order by itself).
    if (!seed && haveCell) alignFrameTo(topo.frames, 9 * t, _cellFrame);
    topo.framesValid[t] = 1;
    let mem = frameMemory.get(topo.typeKeys[t]);
    if (!mem) frameMemory.set(topo.typeKeys[t], mem = new Float64Array(9));
    for (let k = 0; k < 9; k++) mem[k] = topo.frames[9 * t + k];
    const rows = topo.typeRows;
    for (let r = start; r < start + count; r++) topo.frameOf[rows[r]] = t;
  }
}

/** The reference "lattice" for the tilt frame: the cell, or the matrix's
 *  pseudo-cubic axes (rows of M in terms of a, b, c). */
function tiltLattice(lattice) {
  if (general.polyhedraTiltFrame !== 'matrix') return lattice;
  const M = general.polyhedraTiltMatrix;
  if (!Array.isArray(M) || M.length !== 3) return lattice;
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) {
      out[r][k] = (Number(M[r]?.[0]) || 0) * lattice[0][k] + (Number(M[r]?.[1]) || 0) * lattice[1][k]
        + (Number(M[r]?.[2]) || 0) * lattice[2][k];
    }
  }
  return out;
}

/** Fill topo.values with the active property. */
function computeValues(topo, id) {
  const pt = topo.propTable;
  const lattice = pt.lattice;
  if (isOrientationProperty(id)) {
    if (general.polyhedraTiltFrame === 'auto') {
      pt.lattice = lattice;
      computeAutoFrames(topo, pt, lattice);
    } else {
      topo.frameOf.fill(-1);
      pt.lattice = tiltLattice(lattice);
    }
    const v = topo.values;
    computePolyhedraOrientations(pt,
      id === 'tiltA' ? v : null, id === 'tiltB' ? v : null, id === 'tiltC' ? v : null, id === 'rotation' ? v : null);
    pt.lattice = lattice;
  } else {
    computePolyhedraProperty(id, pt, topo.values);
  }
  // rows hidden by broken-off corners show nothing
  for (let i = 0; i < topo.hidden.length; i++) if (topo.hidden[i]) topo.values[i] = NaN;
}

/** Widen `span` ({lo, hi}) by the finite values of the drawn rows. */
function extendSpan(table, topo, values, span) {
  for (let i = 0; i < table.n; i++) {
    if (topo.skip[i] || topo.hidden[i]) continue;
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    if (x < span.lo) span.lo = x;
    if (x > span.hi) span.hi = x;
  }
}

/** The colour range of a data span; signed columns get a range symmetric
 *  about 0, a single value a small pad. Null when the span is empty. */
function rangeOfSpan(lo, hi, id) {
  if (!(hi >= lo)) return null;
  if (isSignedPolyhedraProperty(id)) {
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    return { min: -m, max: m };
  }
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) {
    const pad = Math.max(Math.abs(hi) * 0.05, 1e-6);
    return { min: lo - pad, max: hi + pad };
  }
  return { min: lo, max: hi };
}

// ------------------------------------------------- range over the trajectory

/** Frames read for a range over the trajectory (evenly spaced, first and
 *  last included). */
const RANGE_MAX_FRAMES = 25;
/** Atoms × frames evaluated at once (about a second at ~1.5 µs per atom and
 *  frame); a larger fit runs in timer slices. */
const RANGE_SYNC_DEFAULT = 600000;
let RANGE_SYNC_LIMIT = RANGE_SYNC_DEFAULT;
const RANGE_CHUNK_MS = 30;

/** Tests: the atoms × frames read at once (the sliced fit above it);
 *  no argument restores the default. @param {number} [limit] */
export function setPolyhedraRangeSyncLimit(limit = RANGE_SYNC_DEFAULT) {
  RANGE_SYNC_LIMIT = limit;
}

// Bumped by every fit: a sliced fit still running for an older one stops.
let rangeJob = 0;
// The last fitted range (min, max) and where it came from: `frames` frames
// read of the `of` the structure has (1 of 1 for a single structure);
// pending while a sliced fit over the trajectory runs.
let rangeInfo = { frames: 1, of: 1, pending: false, min: NaN, max: NaN };

/** Where the fitted range came from (the Colour section's note, tests). */
export function polyhedraColorRangeInfo() {
  return { ...rangeInfo };
}

/**
 * `count` frames sampled at most `max` times, evenly spaced, the first and
 * the last always included.
 * @param {number} count @param {number} [max]
 * @returns {number[]}
 */
export function sampleFrameSteps(count, max = RANGE_MAX_FRAMES) {
  if (!(count > 0)) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out = [];
  for (let k = 0; k < max; k++) {
    const step = Math.round(k * (count - 1) / (max - 1));
    if (out[out.length - 1] !== step) out.push(step);
  }
  return out;
}

/** The frames a fit reads besides the one on screen: the trajectory that
 *  shows `structure` (2+ frames, one system in motion), or null. */
function trajectoryRangePlan(topo) {
  if (topo.noFast) return null;
  const structure = topo.structure;
  const container = structureShip.container.find((c) => c?.store && c.ownsStructure?.(structure));
  if (!container || !(container.frameCount > 1)) return null;
  if (container.motionProfile?.().kind !== 'trajectory') return null;
  return { container, steps: sampleFrameSteps(container.frameCount), total: container.frameCount };
}

/** Scratch corner / centre / value arrays for another frame, and a property
 *  table over them (its corner counts and tilt axes are the live ones). */
function rangeScratch(table, topo) {
  let sc = topo.rangeScratch;
  if (!sc || sc.xyz.length !== table.vertXYZ.length || sc.values.length !== table.n) {
    const xyz = new Float64Array(table.vertXYZ.length), center = new Float64Array(3 * table.n);
    sc = {
      xyz, center, values: new Float32Array(table.n),
      pt: { ...topo.propTable, vertXYZ: xyz, centerXYZ: center },
    };
    topo.rangeScratch = sc;
  }
  return sc;
}

/**
 * Widen `span` by the property's values in frame `ph` (a trajectory store
 * record): the corners and centres placed on the scratch arrays, the values
 * computed there with the frame on screen's tilt axes. Draws nothing.
 * @returns {boolean} whether the frame could be read
 */
function frameSpan(table, topo, id, ph, span) {
  if (!ph || typeof ph.then === 'function' || !ph.positions || !ph.lattice
      || ph.positions.length !== 3 * topo.nAtoms) return false;
  const sc = rangeScratch(table, topo);
  const src = { col: ph.positions, atoms: null };
  const L = ph.lattice;
  moveCorners(topo, src, L, sc.xyz);
  placeCenters(table, topo, src, L, sc.xyz, sc.center);
  const pt = sc.pt, out = sc.values;
  if (isOrientationProperty(id)) {
    // the axes as computeValues left them for the frame on screen (frames /
    // frameOf are the live arrays)
    pt.lattice = general.polyhedraTiltFrame === 'auto' ? L : tiltLattice(L);
    computePolyhedraOrientations(pt,
      id === 'tiltA' ? out : null, id === 'tiltB' ? out : null, id === 'tiltC' ? out : null, id === 'rotation' ? out : null);
  } else {
    pt.lattice = L;
    computePolyhedraProperty(id, pt, out);
  }
  extendSpan(table, topo, out, span);
  return true;
}

/**
 * Fit the range of `id`: the frame on screen (topo.values, computed), and
 * the trajectory's frames when it has some (see the header). Sets rangeInfo.
 * @returns {{range: {min: number, max: number} | null, later: any}} later:
 *   what a sliced fit needs to finish, when the trajectory is too large to
 *   read at once
 */
function fitRange(table, topo, id) {
  rangeJob++;
  const span = { lo: Infinity, hi: -Infinity };
  extendSpan(table, topo, topo.values, span);
  const plan = trajectoryRangePlan(topo);
  let frames = 1, pending = false, later = null;
  if (plan) {
    if (topo.nAtoms * plan.steps.length <= RANGE_SYNC_LIMIT) {
      let read = 0;
      for (const step of plan.steps) if (frameSpan(table, topo, id, plan.container.store.getFramePhysics(step), span)) read++;
      frames = Math.max(1, read);
    } else {
      pending = true;
      later = { plan, span: { ...span } };
    }
  }
  rangeInfo = { frames, of: plan ? plan.total : 1, pending, min: NaN, max: NaN };
  return { range: rangeOfSpan(span.lo, span.hi, id), later };
}

/** Tell the bar (the range was fitted: min, max; or a sliced fit ended
 *  without replacing the range in use: no arguments). */
function announceRange(id, min = NaN, max = NaN) {
  if (Number.isFinite(min)) { rangeInfo.min = min; rangeInfo.max = max; }
  document.dispatchEvent(new CustomEvent('crysviz:polyhedra-color-range', {
    detail: { id, min, max, ...rangeInfo },
  }));
}

/**
 * The sliced part of a fit over a large trajectory: frames read in
 * RANGE_CHUNK_MS slices on timers; at the end the range replaces the frame
 * on screen's — only while it is still the range in use (`shown`: nothing
 * typed, no new fit, the same property and structure).
 */
function continueRangeFit(id, structure, later, shown) {
  const job = rangeJob;
  const { plan, span } = later;
  let k = 0, read = 0;
  const stillWanted = () => job === rangeJob && general.polyhedraColor === id
    && general.polyhedraColorMin === shown.min && general.polyhedraColorMax === shown.max;
  const slice = () => {
    const table = currentTable();
    const topo = table?.topo;
    if (!stillWanted() || !topo?.propTable || topo.structure !== structure || topo.noFast) {
      if (job === rangeJob) {
        rangeInfo = { ...rangeInfo, pending: false };
        announceRange(id);
      }
      return;
    }
    const t0 = performance.now();
    while (k < plan.steps.length && performance.now() - t0 < RANGE_CHUNK_MS) {
      if (frameSpan(table, topo, id, plan.container.store.getFramePhysics(plan.steps[k]), span)) read++;
      k++;
    }
    if (k < plan.steps.length) { setTimeout(slice, 0); return; }
    const r = rangeOfSpan(span.lo, span.hi, id);
    rangeInfo = { ...rangeInfo, frames: Math.max(1, read), pending: false };
    if (r) {
      general.polyhedraColorMin = r.min;
      general.polyhedraColorMax = r.max;
      announceRange(id, r.min, r.max);
    } else {
      announceRange(id);
    }
    applyPolyhedraPropertyColors(table);
    requestRender();
  };
  setTimeout(slice, 0);
}

// Colours of the polyhedra a property does not apply to, and of the edges
// in 'grey' (sRGB → the tables' linear RGB). The faces take the atoms'
// default grey (#808080), mid-way between the light and dark backgrounds;
// the edges a darker one (#555555), so a grey face's outline still reads.
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const NO_VALUE_GREY = srgbToLinear(0x80 / 255);
const EDGE_GREY = srgbToLinear(0x55 / 255);

/**
 * Colour the drawn polyhedra by the active property (see the header). The
 * style colours are kept per row (`saveStyle`, right after the styles were
 * written) so rows the property does not apply to can keep theirs, and the
 * 'style' edges theirs.
 * @param {any} [table]
 * @param {{upload?: boolean, saveStyle?: boolean}} [opts] upload: send the
 *   colours to the GPU (false when the caller uploads anyway)
 * @returns {boolean} whether a property colouring was applied
 */
export function applyPolyhedraPropertyColors(table = currentTable(), { upload = true, saveStyle = false } = {}) {
  if (!table?.topo) return false;
  const topo = table.topo;
  if (saveStyle) {
    topo.styleColor.set(table.color);
    topo.styleEdgeColor.set(table.edgeColor);
  }
  if (!polyhedraPropertyColorActive() || !topo.propTable) return false;
  if (polyPaintOverride()) return false; // disco mode owns the colours meanwhile
  const t0 = performance.now();
  const id = general.polyhedraColor;
  computeValues(topo, id);
  let min = Number(general.polyhedraColorMin), max = Number(general.polyhedraColorMax);
  const staleRange = rangeStructure !== topo.structure;
  if (general.polyhedraColorMin == null || general.polyhedraColorMax == null
      || !Number.isFinite(min) || !Number.isFinite(max) || !(max > min) || staleRange) {
    const { range: r, later } = fitRange(table, topo, id);
    rangeStructure = topo.structure;
    if (r) {
      min = r.min; max = r.max;
      general.polyhedraColorMin = min;
      general.polyhedraColorMax = max;
      announceRange(id, min, max);
      if (later) continueRangeFit(id, topo.structure, later, r);
    }
  }
  const cmap = colorMapTable(polyhedraColorMapName(id));
  const nb = cmap.n, rgb = cmap.rgb, values = topo.values, style = topo.styleColor, styleEdge = topo.styleEdgeColor;
  const ok = nb > 0 && max > min;
  const greyRest = general.polyhedraColorGreyOthers !== false;
  const edges = general.polyhedraColorEdges;
  const edgeMode = edges === 'property' ? 1 : edges === 'style' ? 2 : 0; // 0: grey
  const fc = table.color, ec = table.edgeColor;
  for (let i = 0; i < table.n; i++) {
    const x = values[i], o = 3 * i;
    let r, g, b;
    if (ok && Number.isFinite(x)) {
      const bin = 3 * colorBin(x, min, max, nb, false);
      r = rgb[bin]; g = rgb[bin + 1]; b = rgb[bin + 2];
    } else if (greyRest) {
      r = g = b = NO_VALUE_GREY;
    } else {
      // no value, not greyed: the row as Style draws it, edges included
      setPolyColorRGB(table, i, style[o], style[o + 1], style[o + 2], false);
      ec[o] = styleEdge[o]; ec[o + 1] = styleEdge[o + 1]; ec[o + 2] = styleEdge[o + 2];
      continue;
    }
    fc[o] = r; fc[o + 1] = g; fc[o + 2] = b;
    if (edgeMode === 1) { ec[o] = r; ec[o + 1] = g; ec[o + 2] = b; }
    else if (edgeMode === 2) { ec[o] = styleEdge[o]; ec[o + 1] = styleEdge[o + 1]; ec[o + 2] = styleEdge[o + 2]; }
    else { ec[o] = EDGE_GREY; ec[o + 1] = EDGE_GREY; ec[o + 2] = EDGE_GREY; }
  }
  if (upload) uploadPolyStyles(table);
  stats.lastColorMs = performance.now() - t0;
  return true;
}

/** The active property's value per drawn row (tests, the inspector), or
 *  null when the polyhedra are coloured by style. A live view: copy it. */
export function polyhedraPropertyValues() {
  const table = currentTable();
  return polyhedraPropertyColorActive() && table?.topo ? table.topo.values : null;
}

const AXIS_NAMES = ['a', 'b', 'c'];
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/**
 * The automatic tilt frames in use, for the Polyhedra window's read-only
 * line: per polyhedron type, its key, member count and, per frame axis, the
 * cell axis it lies nearest and the angle to it (degrees).
 * @returns {{key: string, label: string, members: number, axes: {axis: string, angle: number}[]}[]}
 */
export function polyhedraTiltFrameInfo() {
  const table = currentTable();
  const topo = table?.topo;
  if (!topo?.propTable) return [];
  const L = topo.propTable.lattice;
  const out = [];
  for (let t = 0; t < topo.typeKeys.length; t++) {
    if (!topo.framesValid[t]) continue;
    // cos of every frame axis with every cell axis, then the one-to-one
    // assignment with the largest total (a 45° setting ties a and b for
    // both in-plane axes; each still gets its own name)
    const cos = [];
    for (let k = 0; k < 3; k++) {
      const o = 9 * t + 3 * k;
      for (let j = 0; j < 3; j++) {
        const l = Math.hypot(L[j][0], L[j][1], L[j][2]) || 1;
        cos.push(Math.min(1, Math.abs(topo.frames[o] * L[j][0] + topo.frames[o + 1] * L[j][1] + topo.frames[o + 2] * L[j][2]) / l));
      }
    }
    let best = -1, bp = PERMS[0];
    for (const p of PERMS) {
      const sc = cos[p[0]] + cos[3 + p[1]] + cos[6 + p[2]];
      if (sc > best + 1e-9) { best = sc; bp = p; }
    }
    const axes = [0, 1, 2].map((k) => ({ axis: AXIS_NAMES[bp[k]], angle: Math.acos(cos[3 * k + bp[k]]) * 180 / Math.PI }));
    out.push({ key: topo.typeKeys[t], label: topo.typeLabels[t], members: topo.typeStart[t + 1] - topo.typeStart[t], axes });
  }
  return out;
}
