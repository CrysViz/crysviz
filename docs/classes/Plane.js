import * as THREE from "three";
import { Lut } from '../external/three/Lut.js';
import { Field } from './Field.js';

// ---------------------------------------------------------------------------
//  Visualization modes
// ---------------------------------------------------------------------------
export const PLANE_VIS_NONE  = 'None';
export const PLANE_VIS_FIELD = 'Field';

// Resolution of the field colormap texture
const DEFAULT_COLORMAP_RESOLUTION = 256;

// ---------------------------------------------------------------------------
//  Colormap helpers
// ---------------------------------------------------------------------------

// Shared cool-to-warm LUT (Three.js addon). Range is configured per-call in
// updateColorMap() before the vertex loop.
const _lut = new Lut('cooltowarm', 256);

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
 * @param {Array} cell – [a, b, c], each a THREE.Vector3 or [x,y,z]
 */
function getCellCorners(cell) {
  const [a, b, c] = cell.map(toVec3);
  const corners = [];
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++)
      for (let k = 0; k < 2; k++) {
        const p = new THREE.Vector3();
        if (i) p.add(a);
        if (j) p.add(b);
        if (k) p.add(c);
        corners.push(p);
      }
  return corners;
}

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

let edge_vector_inds = [
    1, 0, 1, 0, 1, 0, 1, 0, 2, 2, 2, 2
]

/**
 * Compute the convex polygon formed by the intersection of the plane n·x = d
 * with the cell parallelepiped.  Returns a CCW-sorted array of THREE.Vector3,
 * or an empty array when there is no intersection.
 *
 * @param {THREE.Vector3} n – unit plane normal
 * @param {number}        d – plane offset (n·x = d)
 * @param {Array}         cell – lattice vectors [a, b, c]
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
 * @param {THREE.Vector3[]} polygon    – convex polygon vertices in Cartesian space
 * @param {THREE.Vector3}   n          – unit plane normal
 * @param {Array}           [cell]     – lattice vectors [a, b, c] for clipping planes
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
 * @param {Array} cell – lattice vectors [a, b, c]
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
   * @param {Array|THREE.Vector3}  opts.normal      – plane normal in Cartesian space
   * @param {number}               [opts.d=0]       – plane offset so that n·x = d (Cartesian)
   * @param {Array}                opts.cell        – lattice vectors [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]
   *                                                  or array of THREE.Vector3
   * @param {number}               [opts.resolution=256] – colormap texture resolution
   * @param {string}               [opts.mode]      – initial vis mode ('None' | 'Field')
   */
  constructor({ normal, d = 0, cell, resolution = DEFAULT_COLORMAP_RESOLUTION, mode } = {}) {
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
    this._planeMesh = new THREE.Mesh(geometry, Plane._makeNoneMaterial(clippingPlanes));
    this.add(this._planeMesh);

    this._resolution     = resolution;
    this._mode           = null;
    this._field          = null;
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
      transparent: true,
      opacity:     0.35,
      side:        THREE.DoubleSide,
      clippingPlanes: clippingPlanes,
      clipShadows: true
    });
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
      transparent: true,
      opacity:     0.9,
    });
    return new THREE.LineSegments(geom, mat);
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Current visualization mode string. */
  get mode() { return this._mode; }

  /**
   * Switch the visualization mode.
   * @param {string} mode  – 'None' | 'Field'
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
        if (!this.geometry.getAttribute('color')) {
          // No vertex colours yet; show grey until setFieldZValues is called
          this.material = Plane._makeNoneMaterial(this._clippingPlanes);
        } else {
          this.material = Plane._makeFieldMaterial(this._clippingPlanes);
        }
        this._border.visible = false;
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

  /**
   * Write field scalar values to the geometry's vertex-colour attribute.
   *
   * Values are symmetrically normalised around zero so the diverging
   * colormap's midpoint (t = 0.5) always represents the zero level.
   * Fill in `divergingColormap()` with your preferred palette.
   *
   * @param {Float32Array} zValues     – row-major grid, length = resolution²
   * @param {number}       [resolution] – side length of the grid; defaults to
   *                                      the constructor resolution
   */
  updateColorMap() {

    if (!this._field) {
      console.warn('Plane.updateColorMap: no values provided and no field set');
      return;
    }

    const positions = this.geometry.getAttribute('position');
    const colArray = new Float32Array(positions.array.length);

    // Configure LUT range once — keep zero at the midpoint for diverging data
    const minValue = this._field?.minValue ?? -1;
    const maxValue = this._field?.maxValue ?? 1;
    _lut.setMin(minValue).setMax(maxValue);

    for (let i = 0; i < positions.array.length; i += 3) {
      const vec = new THREE.Vector3(positions.array[i], positions.array[i + 1], positions.array[i + 2]);
      // Convert Cartesian position to relative (fractional) coordinates
      // in the voxel basis: vec = u*a + v*b + w*c  ->  [u,v,w]
      const voxelBasis = this._field?.voxel;
      
      const [a, b, c] = voxelBasis.map(toVec3);
      const basisInv = new THREE.Matrix3()
        .setFromMatrix4(new THREE.Matrix4().makeBasis(a, b, c))
        .invert();
      vec.applyMatrix3(basisInv);

      const ind_x = vec.x * this._field.nx;
      const ind_y = vec.y * this._field.ny;
      const ind_z = vec.z * this._field.nz;
      const cubeind_x = Math.floor(ind_x);
      const cubeind_y = Math.floor(ind_y);
      const cubeind_z = Math.floor(ind_z);
      const pos_x = ind_x - cubeind_x;
      const pos_y = ind_y - cubeind_y;
      const pos_z = ind_z - cubeind_z;

      const values = [
        [
          [this._field.getValueAt(cubeind_x, cubeind_y, cubeind_z),
            this._field.getValueAt(cubeind_x, cubeind_y, (cubeind_z + 1) % this._field.nz)],
          [this._field.getValueAt(cubeind_x, (cubeind_y + 1) % this._field.ny, cubeind_z),
            this._field.getValueAt(cubeind_x, (cubeind_y + 1) % this._field.ny, (cubeind_z + 1) % this._field.nz)]
        ],
        [
          [this._field.getValueAt((cubeind_x + 1) % this._field.nx, cubeind_y, cubeind_z),
            this._field.getValueAt((cubeind_x + 1) % this._field.nx, cubeind_y, (cubeind_z + 1) % this._field.nz)],
          [this._field.getValueAt((cubeind_x + 1) % this._field.nx, (cubeind_y + 1) % this._field.ny, cubeind_z),
            this._field.getValueAt((cubeind_x + 1) % this._field.nx, (cubeind_y + 1) % this._field.ny, (cubeind_z + 1) % this._field.nz)]
        ]
      ];

      // Trilinear interpolation
      const c00 = values[0][0][0] * (1 - pos_x) + values[1][0][0] * pos_x;
      const c01 = values[0][0][1] * (1 - pos_x) + values[1][0][1] * pos_x;
      const c10 = values[0][1][0] * (1 - pos_x) + values[1][1][0] * pos_x;
      const c11 = values[0][1][1] * (1 - pos_x) + values[1][1][1] * pos_x;
      const c0 = c00 * (1 - pos_y) + c10 * pos_y;
      const c1 = c01 * (1 - pos_y) + c11 * pos_y;
      const interp = c0 * (1 - pos_z) + c1 * pos_z;
      const col = _lut.getColor(interp);

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
