import * as THREE from '../external/three/three.module.js';
import { Field } from './Field.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import {
  getHeatMapColors, getBatlowColors, getHawaiiColors, getManaguaColors,
  getViridisColors, getPlasmaColors, getSpectralRColors, getJetColors,
} from '../defaults/color_texture_defaults.js';

// ---------------------------------------------------------------------------
//  Visualization modes
// ---------------------------------------------------------------------------
export const PLANE_VIS_NONE  = 'None';
export const PLANE_VIS_FIELD = 'Field';

export const CutModes = {
  NONE: "None",
  ALONGN: "AlongNormal",
  OPPOSITEN: "OppositeNormal",
};

export function normalizePlaneCutMode(cutMode) {
  if (cutMode === 'Above' || cutMode === 'Along Normal') return CutModes.ALONGN;
  if (cutMode === 'Below' || cutMode === 'Opposite Normal') return CutModes.OPPOSITEN;
  if (cutMode === CutModes.ALONGN || cutMode === CutModes.OPPOSITEN) return cutMode;
  return CutModes.NONE;
}

export function getPlaneCutModeLabel(cutMode) {
  const normalized = normalizePlaneCutMode(cutMode);
  if (normalized === CutModes.ALONGN) return 'Along Normal';
  if (normalized === CutModes.OPPOSITEN) return 'Opposite Normal';
  return 'None';
}

export function normalizeCutPlaneSide(side) {
  if (side === 'left') return CutModes.ALONGN;
  if (side === 'right') return CutModes.OPPOSITEN;
  if (side === CutModes.ALONGN || side === CutModes.OPPOSITEN) return side;
  return CutModes.ALONGN;
}

export function getCutPlaneSideLabel(side) {
  const normalized = normalizeCutPlaneSide(side);
  return normalized === CutModes.OPPOSITEN ? 'right' : 'left';
}

export function getCutPlaneMaskSign(side) {
  switch (normalizeCutPlaneSide(side)) {
    case CutModes.OPPOSITEN: return -1;
    case CutModes.ALONGN: return 1;
    default: return 0;
  }
}

// Resolution of the field colormap texture
export const DEFAULT_COLORMAP_RESOLUTION = 256;

// ---------------------------------------------------------------------------
//  Colormap helpers
// ---------------------------------------------------------------------------

const COLORMAP_LOG_EPS = 1e-6;

// Same 8 names/colors Forces/Spins/Atoms/Bonds all draw from
// (defaults/color_texture_defaults.js) — Planes used to have its own,
// separate 10-entry palette via three.js's Lut/ColorMapKeywords
// (external/three/Lut.js), so a "Viridis" or "Plasma" here was a
// same-named but independently-defined lookalike, not actually the same
// colors as everywhere else in the app.
function colorArrayFor(colormap) {
  switch (colormap) {
    case "batlow": return getBatlowColors();
    case "hawaii": return getHawaiiColors();
    case "managua": return getManaguaColors();
    case "viridis": return getViridisColors();
    case "plasma": return getPlasmaColors();
    case "spectralR": return getSpectralRColors();
    case "jet": return getJetColors();
    default: return getHeatMapColors();
  }
}

// Drop-in replacement for three.js's Lut (external/three/Lut.js) — same
// setMin/setMax/getColor(value) call shape updateColorMap() below already
// uses — but sourced from colorArrayFor() above instead of Lut.js's own
// palette set, and with log-scale support Lut.js has no concept of at all.
class ColormapLut {
  constructor(colormap = 'heatmap') {
    this.colors = colorArrayFor(colormap);
    this.minV = 0;
    this.maxV = 1;
    this.useLog = false;
  }
  setColorMap(colormap) {
    this.colors = colorArrayFor(colormap);
    return this;
  }
  setMin(min) { this.minV = min; return this; }
  setMax(max) { this.maxV = max; return this; }
  setLogScale(useLog) { this.useLog = !!useLog; return this; }
  getColor(value) {
    const n = this.colors.length;
    if (!n) return new THREE.Color(0x000000);
    let t;
    if (this.maxV === this.minV) {
      t = 0;
    } else if (this.useLog) {
      const lo = Math.log10(Math.max(this.minV, COLORMAP_LOG_EPS));
      const hi = Math.log10(Math.max(this.maxV, COLORMAP_LOG_EPS));
      const v = Math.log10(Math.max(value, COLORMAP_LOG_EPS));
      t = hi > lo ? (v - lo) / (hi - lo) : 0;
    } else {
      t = (value - this.minV) / (this.maxV - this.minV);
    }
    t = Math.min(Math.max(t, 0), 1);
    return this.colors[Math.min(Math.floor(t * n), n - 1)];
  }
}

function createPlaneLut(colormap = 'heatmap') {
  return new ColormapLut(colormap);
}

// ---------------------------------------------------------------------------
//  Cell-plane intersection helpers
// ---------------------------------------------------------------------------

/** Accept a lattice vector as [x,y,z] or THREE.Vector3, return a clone. */
function toVec3(v) {
  return v instanceof THREE.Vector3
    ? v.clone()
    : new THREE.Vector3(v[0], v[1], v[2]);
}

function millerIndsToCartesianParams(h, k, l, lattice) {
    if (!(Array.isArray(lattice) && lattice.length === 3)) {
        console.error('lattice vector provided to HKL plane definition fetching are invalid:', lattice);
        return {};
    }
    const [a1, a2, a3] = lattice.map(toVec3);

    // Fallback for zero Miller components (parallel-to-axis planes) and
    // degenerate numerics: derive Cartesian plane from reciprocal relation.
    // Plane in fractional form: h*u + k*v + l*w = 1.
    const bc = new THREE.Vector3().crossVectors(a2, a3);
    const ca = new THREE.Vector3().crossVectors(a3, a1);
    const ab = new THREE.Vector3().crossVectors(a1, a2);
    const rawNormal = bc.multiplyScalar(h).add(ca.multiplyScalar(k)).add(ab.multiplyScalar(l));

    if (rawNormal.lengthSq() <= 1e-20) {
      console.error('Invalid HKL plane definition:', { h, k, l });
      return {};
    }

    const cellVolume = Math.abs(a1.dot(new THREE.Vector3().crossVectors(a2, a3)));
    const nUnit = rawNormal.clone().normalize();
    return {
      normal: [nUnit.x, nUnit.y, nUnit.z],
      d: cellVolume / rawNormal.length(),
    };
}

function toPointVec3(point) {
  if (point instanceof THREE.Vector3) {
    return point.clone();
  }

  if (Array.isArray(point) && point.length >= 3) {
    return new THREE.Vector3(point[0], point[1], point[2]);
  }

  if (point?.position instanceof THREE.Vector3) {
    return point.position.clone();
  }

  if (
    point
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && Number.isFinite(point.z)
  ) {
    return new THREE.Vector3(point.x, point.y, point.z);
  }

  return null;
}

function getDummyPlaneFit() {
  return {
    normal: [0, 0, 1],
    d: 0,
    centroid: [0, 0, 0],
    valid: false,
  };
}

function jacobiSmallestEigenvector3x3(matrix) {
  const a = matrix.map((row) => [...row]);
  const eigenvectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  const maxIterations = 16;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let p = 0;
    let q = 1;
    let maxValue = Math.abs(a[0][1]);

    if (Math.abs(a[0][2]) > maxValue) {
      p = 0;
      q = 2;
      maxValue = Math.abs(a[0][2]);
    }
    if (Math.abs(a[1][2]) > maxValue) {
      p = 1;
      q = 2;
      maxValue = Math.abs(a[1][2]);
    }

    if (maxValue < 1e-12) {
      break;
    }

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    a[p][p] = app - t * apq;
    a[q][q] = aqq + t * apq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let r = 0; r < 3; r++) {
      if (r !== p && r !== q) {
        const arp = a[r][p];
        const arq = a[r][q];
        a[r][p] = c * arp - s * arq;
        a[p][r] = a[r][p];
        a[r][q] = c * arq + s * arp;
        a[q][r] = a[r][q];
      }

      const vrp = eigenvectors[r][p];
      const vrq = eigenvectors[r][q];
      eigenvectors[r][p] = c * vrp - s * vrq;
      eigenvectors[r][q] = c * vrq + s * vrp;
    }
  }

  const eigenvalues = [a[0][0], a[1][1], a[2][2]];
  let minIndex = 0;
  if (eigenvalues[1] < eigenvalues[minIndex]) minIndex = 1;
  if (eigenvalues[2] < eigenvalues[minIndex]) minIndex = 2;

  return new THREE.Vector3(
    eigenvectors[0][minIndex],
    eigenvectors[1][minIndex],
    eigenvectors[2][minIndex],
  );
}

export function fitPlaneToPoints(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return getDummyPlaneFit();
  }

  const vectors = points
    .map(toPointVec3)
    .filter((point) => point instanceof THREE.Vector3);

  if (vectors.length < 3) {
    return getDummyPlaneFit();
  }

  if (vectors.length === 3) {
    const v1 = new THREE.Vector3().subVectors(vectors[0], vectors[1]);
    const v2 = new THREE.Vector3().subVectors(vectors[2], vectors[1]);
    const normal = new THREE.Vector3().crossVectors(v1, v2);
    if (normal.lengthSq() < 1e-20) {
      return getDummyPlaneFit();
    }
    normal.normalize();
    return {
      normal: [normal.x, normal.y, normal.z],
      d: normal.dot(vectors[0]),
      centroid: [
        (vectors[0].x + vectors[1].x + vectors[2].x) / 3,
        (vectors[0].y + vectors[1].y + vectors[2].y) / 3,
        (vectors[0].z + vectors[1].z + vectors[2].z) / 3,
      ],
      valid: true,
    };
  }

  // Try to minimize perpendicular distane via PCA analysis
  const centroid = new THREE.Vector3();
  vectors.forEach((point) => centroid.add(point));
  centroid.divideScalar(vectors.length);

  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  vectors.forEach((point) => {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    const dz = point.z - centroid.z;
    covariance[0][0] += dx * dx;
    covariance[0][1] += dx * dy;
    covariance[0][2] += dx * dz;
    covariance[1][0] += dy * dx;
    covariance[1][1] += dy * dy;
    covariance[1][2] += dy * dz;
    covariance[2][0] += dz * dx;
    covariance[2][1] += dz * dy;
    covariance[2][2] += dz * dz;
  });

  const normal = jacobiSmallestEigenvector3x3(covariance);
  if (normal.lengthSq() < 1e-20) {
    return getDummyPlaneFit();
  }
  normal.normalize();

  return {
    normal: [normal.x, normal.y, normal.z],
    d: normal.dot(centroid),
    centroid: [centroid.x, centroid.y, centroid.z],
    valid: true,
  };
}

export function CartesianParamsToMillerInds(n, d, lattice) {
  const [a1, a2, a3] = lattice.map(toVec3);
  const a_intercept = n[0] !== 0 ? d / n[0] : 1e6;
  const b_intercept = n[1] !== 0 ? d / n[1] : 1e6;
  const c_intercept = n[2] !== 0 ? d / n[2] : 1e6;

  const h = a1.length() / a_intercept;
  const k = a2.length() / b_intercept;
  const l = a3.length() / c_intercept;

  return { h, k, l };
}

export function getPlaneDefinitionNormalAndD(planeDef, lattice) {
  const params = planeDef?.params || {};
  if (params.type === 'uvwd') {
    return {
      normal: [params.u || 0, params.v || 0, params.w || 0],
      d: params.d || 0,
    };
  }
  else if (params.type === 'hkl') {
    return millerIndsToCartesianParams(params.h, params.k, params.l, lattice);
  }
  else {
    console.error('Unknown plane definition type:', params.type);
    return {};
  }
}

/**
 * Return the 8 corner vertices of the cell parallelepiped (origin at 0,0,0).
 * @param {Array} cell - [a, b, c], each a THREE.Vector3 or [x,y,z]
 */

///////////////////////////////////////////////
//              Cubes convention             //
///////////////////////////////////////////////
//                  4_______e4_____________5
//                  /|                    /|
//                 / |                   / |
//              e7/  |                e5/  |
//               /___|______e6_________/   |
//             7|    |                 |6  |e9
//              |    |                 |   |
//              |    |e8            e10|   |
//           e11|    |                 |   |
//              |    |_________________|___|
//              |   / 0      e0        |   /1
//              |  /                   |  /
//              | /e3                  | /e1
//              |/_____________________|/
//              3         e2          2
//               ----> y
//			   /
//			  /
//           v
//			x

let edge2vertex = [
	[0,1], [1,2], [3,2], [0,3],
	[4,5], [5,6], [7,6], [4,7],
	[0,4], [1,5], [2,6], [3,7]
];

let cube_vertex_pos = [
	[0,0,0], [0,1,0], [1,1,0], [1,0,0],
	[0,0,1], [0,1,1], [1,1,1], [1,0,1]
];


/**
 * Compute the convex polygon formed by the intersection of the plane n·x = d
 * with the cell parallelepiped.  Returns a CCW-sorted array of THREE.Vector3,
 * or an empty array when there is no intersection.
 *
 * @param {THREE.Vector3} n - unit plane normal
 * @param {number}        d - plane offset (n·x = d)
 * @param {Array}         cell - lattice vectors [a, b, c]
 */
function planePolygon(n, d, cell) {
  const pts = [];

  // Intersect plane with each of the 12 edges of the cell
  // k = (d - n·v0) / (n·(v1 - v0)) gives the parametric position of the intersection along the edge
  const cellMatrix = new THREE.Matrix3().fromArray(cell.flat());
  for (const [i, j] of edge2vertex) {
    const edgeVec = (new THREE.Vector3(cube_vertex_pos[j][0] - cube_vertex_pos[i][0],
                                      cube_vertex_pos[j][1] - cube_vertex_pos[i][1],
                                      cube_vertex_pos[j][2] - cube_vertex_pos[i][2])).applyMatrix3(cellMatrix);
    const v0Vector = new THREE.Vector3(cube_vertex_pos[i][0], cube_vertex_pos[i][1], cube_vertex_pos[i][2]).applyMatrix3(cellMatrix);
    const edgeProj = n.dot(edgeVec);
    if (Math.abs(edgeProj) < 1e-10) continue; // edge parallel to plane
    const t = (d - n.dot(v0Vector)) / edgeProj;
    if (t < 0 || t > 1) continue; // outside edge span
    const p = edgeVec.multiplyScalar(t).add(v0Vector);
    pts.push(p);
  }

  if (pts.length < 3) return [];

  // Deduplicate
  const unique = [];
  for (const p of pts) {
    if (!unique.some(q => q.distanceTo(p) < 1e-8)) unique.push(p);
  }
  if (unique.length < 3) return [];

  // Sort CCW around centroid in the plane's local 2D frame
  const centroid = new THREE.Vector3();
  unique.forEach(p => centroid.add(p));
  centroid.divideScalar(unique.length);

  const uAxis = new THREE.Vector3().subVectors(unique[0], centroid).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  unique.sort((a, b) => {
    const da = a.clone().sub(centroid);
    const db = b.clone().sub(centroid);
    return Math.atan2(da.dot(vAxis), da.dot(uAxis)) -
           Math.atan2(db.dot(vAxis), db.dot(uAxis));
  });

  return unique;
}

/**
 * Build a subdivided PlaneGeometry rectangle that bounds all polygon vertices,
 * positioned and oriented in world-space Cartesian coordinates.
 *
 * Coordinate-frame construction
 * ─────────────────────────────
 *  1. centroid  = average of all polygon vertices
 *  2. uAxis     = normalize(polygon[0] − centroid)
 *  3. vAxis     = cross(n, uAxis)
 *  4. half-extents: max |u| and |v| projections of all vertices from centroid
 *  5. PlaneGeometry(2·halfU, 2·halfV) centred at the centroid, with the basis
 *     matrix mapping local X → uAxis, local Y → vAxis, local Z → n.
 *
 * The resulting rectangle is guaranteed to contain all polygon vertices and is
 * cell-clipped via material.clippingPlanes.
 *
 * @param {THREE.Vector3[]} polygon    - convex polygon vertices in Cartesian space
 * @param {THREE.Vector3}   n          - unit plane normal
 * @param {Array}           [cell]     - lattice vectors [a, b, c] for clipping planes
 * @param {number}          [resolution=DEFAULT_COLORMAP_RESOLUTION]
 * @returns {{ geometry, uAxis, vAxis, centroid, clippingPlanes }}
 */
function buildPolygonGeometry(polygon, n, cell, resolution = DEFAULT_COLORMAP_RESOLUTION) {
  // ── 1. Centroid ───────────────────────────────────────────────────────────
  const centroid = new THREE.Vector3();
  for (const p of polygon) centroid.add(p);
  centroid.divideScalar(polygon.length);

  // ── 2. Orthonormal frame centred at the centroid ──────────────────────────
  //    uAxis: direction from centroid toward the first polygon vertex
  //    vAxis: cross(n, uAxis)  (right-hand rule, lies in the plane)
  const uAxis = new THREE.Vector3().subVectors(polygon[0], centroid).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  // ── 3. Half-extents: largest |u| and |v| projections from the centroid ────
  let halfU = 0, halfV = 0;
  for (const p of polygon) {
    const delta = new THREE.Vector3().subVectors(p, centroid);
    halfU = Math.max(halfU, Math.abs(delta.dot(uAxis)));
    halfV = Math.max(halfV, Math.abs(delta.dot(vAxis)));
  }
  halfU = Math.max(halfU, 1e-6);
  halfV = Math.max(halfV, 1e-6);

  const width  = 2 * halfU;
  const height = 2 * halfV;

  // ── 4. Build PlaneGeometry centred at the centroid in world space ─────────
  //    PlaneGeometry lies in local XY; the matrix maps:
  //      local X → uAxis,  local Y → vAxis,  local Z → n,  origin → centroid
  const aspect = width / height;
  const resU = Math.max(1, Math.round(resolution * Math.min(aspect, 1)));
  const resV = Math.max(1, Math.round(resolution * Math.min(1 / aspect, 1)));
  const geometry = new THREE.PlaneGeometry(width, height, resU, resV);
  const matrix = new THREE.Matrix4().makeBasis(uAxis, vAxis, n);
  matrix.setPosition(centroid);
  geometry.applyMatrix4(matrix);

  // ── 6. Cell clipping planes (world space, inward normals) ─────────────────
  const clippingPlanes = (cell && cell.length === 3)
    ? makeCellClippingPlanes(cell)
    : [];

  return { geometry, uAxis, vAxis, centroid, clippingPlanes };
}

/**
 * Build 6 THREE.Plane objects representing the faces of the cell parallelepiped,
 * with inward-facing normals in world space.
 *
 * Assign these to `material.clippingPlanes` and set
 * `renderer.localClippingEnabled = true` for clipping to take effect.
 *
 * @param {Array} cell - lattice vectors [a, b, c]
 * @returns {THREE.Plane[]}
 */
function makeCellClippingPlanes(cell) {
  const [a, b, c] = cell.map(toVec3);
  const planes = [];

  // Iterate over each pair of spanning vectors (u, v) and their outward axis w.
  // The inward normal nr = cross(u, v), oriented so that nr·w > 0.
  for (const [u, v, w] of [[b, c, a], [c, a, b], [a, b, c]]) {
    const nr = new THREE.Vector3().crossVectors(u, v);
    if (nr.dot(w) < 0) nr.negate(); // flip to point into the cell
    nr.normalize();

    // Face at origin:  keep where  nr·x >= 0  →  THREE.Plane(nr, 0)
    planes.push(new THREE.Plane(nr.clone(), -1e-3)); // offset slightly to avoid numerical edge-clipping issues
    // Opposite face:   keep where  nr·x <= nr·w  →  THREE.Plane(-nr, nr·w)
    planes.push(new THREE.Plane(nr.clone().negate(), nr.dot(w) + 1e-3));
  }
  return planes;
}

// ---------------------------------------------------------------------------
//  Plane class
// ---------------------------------------------------------------------------

/**
 * Plane
 *
 * A Three.js Mesh that drapes over an infinite (or cell-clipped) crystallographic
 * plane. Internally it owns:
 *  - a PlaneGeometry subdivided into `resolution × resolution` segments so a
 *    texture maps cleanly over it.
 *  - a border LineSegments object (purple outline, "None" mode only).
 *  - a ShaderMaterial that is swapped when `setMode()` is called.
 *
 * Coordinate convention for field colormapping:
 *   Provide scalar values via `setFieldZValues(zValues, resolution)` — a
 *   Float32Array of length resolution² in row-major (y*res+x) order.
 *   Values are symmetrically normalised around zero so the diverging
 *   colormap midpoint (t = 0.5) always represents the zero level.
 *   Colours are written as a vertex-colour attribute on the geometry;
 *   fill in `divergingColormap()` with your preferred palette.
 *   You are responsible for computing what the Z-values represent (e.g.
 *   projection of a 3-D field onto the plane).
 */
export class Plane extends THREE.Group {
  /**
   * @param {object}               opts
   * @param {Array|THREE.Vector3}  [opts.normal]    - plane normal in Cartesian space
   * @param {number}               [opts.d=0]       - plane offset so that n·x = d (Cartesian)
   * @param {Array}                [opts.cell]      - lattice vectors [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]
   *                                                  or array of THREE.Vector3
   * @param {number}               [opts.resolution=256] - colormap texture resolution
   * @param {string}               [opts.mode]      - initial vis mode ('None' | 'Field')
  * @param {object}               [opts.field]     - initial field data for 'Field' mode
  * @param {string}               [opts.colormap]  - LUT name for field coloring
  * @param {number}               [opts.colormapMin] - LUT lower bound override
  * @param {number}               [opts.colormapMax] - LUT upper bound override
  * @param {string}               [opts.colormapScale] - 'linear' or 'log'
  */
  constructor({ normal, d = 0, cell, resolution = DEFAULT_COLORMAP_RESOLUTION, mode, field, colormap = 'heatmap', colormapMin = null, colormapMax = null, colormapScale = 'linear' } = {}) {
    // ── Normalise the plane normal ──────────────────────────────────────────
    const n = normal
      ? toVec3(normal).normalize()
      : new THREE.Vector3(0, 0, 1);

    // ── Intersect plane with cell to obtain the boundary polygon ───────────
    let polygon = [];
    if (cell && cell.length === 3) {
      polygon = planePolygon(n, d, cell);
    }

    // ── Build geometry ─────────────────────────────────────────────────────
    let geometry, uAxis, vAxis, centroid, clippingPlanes;
    if (polygon.length >= 3) {
      ({ geometry, uAxis, vAxis, centroid, clippingPlanes } =
          buildPolygonGeometry(polygon, n, cell, resolution));
    } else {
      // Fallback: make plane outside of cell bounds
      console.warn('Plane: insufficient intersection with cell; using unit-square fallback.');
      geometry       = new THREE.PlaneGeometry(1, 1, 1, 1);
      uAxis          = new THREE.Vector3(1, 0, 0);
      vAxis          = new THREE.Vector3(0, 1, 0);
      centroid       = new THREE.Vector3(0, 0, -1);
      const matrix = new THREE.Matrix4().makeBasis(uAxis, vAxis, n);
      matrix.setPosition(centroid);
      geometry.applyMatrix4(matrix);
      clippingPlanes = (cell && cell.length === 3) ? makeCellClippingPlanes(cell) : [];
    }

    super();

    /** The clipped planar surface mesh — first child of this Group. */
    // renderOrder/blending policy is owned by the rendering pipeline
    // ('plane' kind in render/pipeline/ForwardPipeline.js).
    this._planeMesh = new THREE.Mesh(geometry, Plane._makeNoneMaterial(clippingPlanes));
    this.add(this._planeMesh);

    this._resolution     = resolution;
    this._mode           = null;
    this._field          = null;
    this._colormap       = colormap;
    this._colormapMin    = Number.isFinite(colormapMin) ? Number(colormapMin) : null;
    this._colormapMax    = Number.isFinite(colormapMax) ? Number(colormapMax) : null;
    this._colormapScale  = colormapScale === 'log' ? 'log' : 'linear';
    this._lut            = createPlaneLut(colormap);
    /** THREE.Plane[] for the 6 cell faces — applied to every material. */
    this._clippingPlanes = clippingPlanes ?? [];

    /** Unit plane normal in Cartesian space. */
    this.planeNormal   = n;
    /** Plane offset (n·x = d). */
    this.planeD        = d;
    /** Sorted polygon vertices (THREE.Vector3[]) at cell boundary, or []. */
    this.polygon       = polygon;
    /** Local U-axis of the plane (first tangent direction). */
    this.uAxis         = uAxis;
    /** Local V-axis of the plane (second tangent direction, = n × uAxis). */
    this.vAxis         = vAxis;
    /** Centroid of the polygon in Cartesian space. */
    this.planeCentroid = centroid;

    // Purple border outline around the polygon edges
    this._border = Plane._makeBorderMesh(polygon);
    this.add(this._border);

    this.setField(field);
  this.setColormap(colormap);
    this.setMode(mode ?? PLANE_VIS_NONE);
    
  }

  // ── mesh / geometry / material accessors ─────────────────────────────────

  /** The planar surface Mesh child of this Group. */
  get mesh() { return this._planeMesh; }

  /** Shorthand for `this._mesh.geometry`. */
  get geometry() { return this._planeMesh.geometry; }

  /** Shorthand for `this._mesh.material`. */
  get material() { return this._planeMesh.material; }
  set material(m) { this._planeMesh.material = m; }

  // ── static material factories ─────────────────────────────────────────────

  /**
   * @param {THREE.Plane[]} [clippingPlanes]
   * NOTE: renderer.localClippingEnabled must be true for clipping to work.
   */
  static _makeNoneMaterial(clippingPlanes = []) {
    const mat = new THREE.MeshBasicMaterial({
      color:       0x8c8c99,
      opacity:     0.70,
      //alphaHash: true, // helps with sorting issues when multiple planes overlap
      side:        THREE.DoubleSide,
      clippingPlanes: clippingPlanes,
      //clipShadows: true,
    });
    applyTransparency(mat, { kind: 'plane', opacity: 0.70 });
    return mat;
  }

  /** @param {THREE.Plane[]} [clippingPlanes] */
  static _makeFieldMaterial(clippingPlanes = []) {
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side:         THREE.DoubleSide,
    });
    mat.clippingPlanes = clippingPlanes;
    mat.clipShadows    = true;
    return mat;
  }

  /**
   * Build a border LineSegments that traces the polygon perimeter.
   * Falls back to a unit-square outline when no polygon is provided.
   * @param {THREE.Vector3[]} [polygon]
   */
  static _makeBorderMesh(polygon) {
    const pts = [];
    if (polygon && polygon.length >= 3) {
      const nv = polygon.length;
      for (let i = 0; i < nv; i++) {
        const p0 = polygon[i];
        const p1 = polygon[(i + 1) % nv];
        pts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
      }
    } else {
      console.warn('Plane._makeBorderMesh: no polygon provided, not drawing border.');
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color:       0x9933ff,
      linewidth:   2, // note: >1 only works with WebGL2 + LineMaterial addon
      opacity:     0.9,
    });
    applyTransparency(mat, { kind: 'planeBorder', opacity: 0.9 });
    return new THREE.LineSegments(geom, mat);
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Current visualization mode string. */
  get mode() { return this._mode; }

  /**
   * Switch the visualization mode.
   * @param {string} mode  - 'None' | 'Field'
   */
  setMode(mode) {
    if (mode === this._mode) return;
    this._mode = mode;

    // Dispose previous material
    if (this.material) {
      this.material.dispose();
    }

    switch (mode) {
      case PLANE_VIS_FIELD:
        this.material = Plane._makeFieldMaterial(this._clippingPlanes);
        this._border.visible = false;
        this.updateColorMap(); // populate vertex colors from field values
        break;

      case PLANE_VIS_NONE:
      default:
        this.material = Plane._makeNoneMaterial(this._clippingPlanes);
        this._border.visible = true;
        break;
    }
  }

  /**
   * Attach a Field object (metadata only — used to read min/max for normalisation).
   * @param {Field} field
   */
  setField(field) {
    if (!(field instanceof Field)) {
      console.warn('Plane.setField: argument is not a Field instance');
    }
    this._field = field;
  }

  setColormap(colormap = 'heatmap') {
    this._colormap = colormap || 'heatmap';
    this._lut = createPlaneLut(this._colormap);

    if (this._mode === PLANE_VIS_FIELD) {
      this.updateColorMap();
    }
  }

  setColormapRange(minValue = null, maxValue = null) {
    this._colormapMin = Number.isFinite(minValue) ? Number(minValue) : null;
    this._colormapMax = Number.isFinite(maxValue) ? Number(maxValue) : null;

    if (this._mode === PLANE_VIS_FIELD) {
      this.updateColorMap();
    }
  }

  setColormapScale(scale) {
    this._colormapScale = scale === 'log' ? 'log' : 'linear';

    if (this._mode === PLANE_VIS_FIELD) {
      this.updateColorMap();
    }
  }

  /**
   * Write field scalar values to the geometry's vertex-colour attribute.
   *
   * Values are symmetrically normalised around zero so the diverging
   * colormap's midpoint (t = 0.5) always represents the zero level.
   * Fill in `divergingColormap()` with your preferred palette.
   *
   * Operates on the plane's stored `_field` / resolution (no parameters).
   */
  updateColorMap() {

    if (!this._field) {
      console.warn('Plane.updateColorMap: no values provided and no field set');
      return;
    }

    const positions = this.geometry.getAttribute('position');
    const colArray = new Float32Array(positions.array.length);

    // Configure LUT range once — keep zero at the midpoint for diverging data
    const minValue = this._colormapMin ?? this._field?.minValue ?? -1;
    const maxValue = this._colormapMax ?? this._field?.maxValue ?? 1;
    this._lut.setMin(minValue).setMax(maxValue).setLogScale(this._colormapScale === 'log');

    for (let i = 0; i < positions.array.length; i += 3) {
      const vec = new THREE.Vector3(positions.array[i], positions.array[i + 1], positions.array[i + 2]);
      // Convert Cartesian position to relative (fractional) coordinates
      // in the voxel basis: vec = u*a + v*b + w*c  ->  [u,v,w]
      const voxelBasis = this._field?.voxel;
      if (!voxelBasis) continue;

      const [a, b, c] = voxelBasis.map(toVec3);
      const basisInv = new THREE.Matrix3()
        .setFromMatrix4(new THREE.Matrix4().makeBasis(a.multiplyScalar(this._field.nx), b.multiplyScalar(this._field.ny), c.multiplyScalar(this._field.nz)))
        .invert();
      vec.applyMatrix3(basisInv); // get fractional coordinates in the voxel basis
      vec.x = (vec.x % 1 + 1) % 1; // wrap fractional coordinates to [0,1]
      vec.y = (vec.y % 1 + 1) % 1;
      vec.z = (vec.z % 1 + 1) % 1;

      const interp = this._field.getValueAtPoint(vec.x, vec.y, vec.z);
      const col = this._lut.getColor(interp);

      colArray[i    ] = col.r;
      colArray[i + 1] = col.g;
      colArray[i + 2] = col.b;
    }

    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colArray, 3));

    // ── Refresh material if already in Field mode ─────────────────────────
    if (this._mode === PLANE_VIS_FIELD) {
      this.geometry.attributes.color.needsUpdate = true;
    }
  }

  /**
   * Free all GPU resources owned by this Plane.
   * Call before removing from scene.
   */
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this._border.geometry.dispose();
    this._border.material.dispose();
  }
}
