/**
 * Where a volumetric field's grid sits in the world — the one place that knows
 * how grid indices map to Angstrom.
 *
 * Two conventions live side by side, and every renderer has to agree on them:
 *
 *  - A PERIODIC field (CHGCAR, WAVECAR, a periodic-code cube) is drawn over the
 *    cell n_i * voxel_i: grid fraction 1 is the far cell face, so grid point i
 *    lands at i/(n-1) * n * voxel_i. That n/(n-1) stretch is a long-standing
 *    inaccuracy, but it is what the raster isosurface, the planes and the
 *    tracer all draw today, and it is kept exactly.
 *  - A BLOCK (`periodic === false`, a molecular cube whose atoms lie outside
 *    its grid) is finite data, drawn with exact spacing: grid point i sits at
 *    origin + i * voxel_i, so the whole grid spans (n-1) * voxel_i.
 *
 * Both carry `origin`. Periodic producers set it to zero, so the translation
 * column is zero for them and their matrices are unchanged by this module.
 *
 * Imports nothing (no THREE): the raster isosurface (`Isosurface.js`), the cut
 * planes (`Plane.js`) and the ray tracer (`SceneEncoder.js`) all need the same
 * mapping, and the unit tests run it in node. Matrices are plain 16-arrays in
 * THREE's column-major order, so `new Matrix4().fromArray(gridToWorld(f))` is
 * the whole bridge.
 */

/**
 * @typedef {{nx: number, ny: number, nz: number, origin?: number[] | null,
 *   voxel: number[][], periodic?: boolean}} GridLike
 */

/** Relative determinant below which a 3x3 counts as singular. */
const SINGULAR_TOL = 1e-12;

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const isMat3 = (m) => Array.isArray(m) && m.length === 3 && m.every(isVec3);

/** Grid counts and step rows must be usable before any of the maths runs. */
function assertGrid(field) {
  const dims = [field?.nx, field?.ny, field?.nz];
  if (!dims.every((n) => Number.isInteger(n) && n >= 1)) {
    throw new Error(`fieldGeometry: grid counts must be integers >= 1, got [${dims.join(', ')}]`);
  }
  if (!isMat3(field.voxel)) throw new Error('fieldGeometry: field.voxel must be a 3x3 matrix of finite numbers');
  if (field.origin != null && !isVec3(field.origin)) {
    throw new Error('fieldGeometry: field.origin must be [x, y, z] of finite numbers');
  }
}

/**
 * Inverse of a 3x3 (rows), or a clear error when it is singular.
 * @param {number[][]} m
 * @param {string} what names the matrix in the error
 * @returns {number[][]}
 */
function invert3(m, what) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const scale = Math.hypot(a, b, c) * Math.hypot(d, e, f) * Math.hypot(g, h, i);
  if (!Number.isFinite(det) || !(scale > 0) || Math.abs(det) <= SINGULAR_TOL * scale) {
    throw new Error(`fieldGeometry: ${what} is singular or degenerate`);
  }
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/**
 * Column-major 4x4 taking grid fractions [0,1]^3 to world Angstrom: column k
 * is voxel_k times the span (n_k for a periodic field, n_k - 1 for a block),
 * and the last column is the origin.
 *
 * @param {GridLike} field
 * @returns {number[]} 16 numbers, THREE.Matrix4.fromArray order
 */
export function gridToWorld(field) {
  assertGrid(field);
  const { nx, ny, nz, voxel } = field;
  const block = field.periodic === false;
  const span = block ? [nx - 1, ny - 1, nz - 1] : [nx, ny, nz];
  const o = field.origin ?? [0, 0, 0];
  const column = (k) => [voxel[k][0] * span[k], voxel[k][1] * span[k], voxel[k][2] * span[k], 0];
  return [...column(0), ...column(1), ...column(2), o[0], o[1], o[2], 1];
}

/**
 * Inverse of `gridToWorld` for one point.
 *
 * @param {GridLike} field
 * @param {number[]} p world point [x, y, z]
 * @returns {number[]} grid fractions [fx, fy, fz] (outside [0,1] when p is off the grid)
 */
export function worldToGridFraction(field, p) {
  if (!isVec3(p)) throw new Error('fieldGeometry: the point must be [x, y, z] of finite numbers');
  const e = gridToWorld(field);
  // Rows of the linear part: row r = [e[r], e[4+r], e[8+r]].
  const inv = invert3([[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]], 'the grid extent');
  const d = [p[0] - e[12], p[1] - e[13], p[2] - e[14]];
  return inv.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
}

/**
 * The field's extent in the fractional coordinates of `lattice`: the eight
 * corners of the grid, expressed in that cell, reduced to a per-axis [lo, hi].
 * A block inside the cell gives a sub-range of [0,1]; one crossing a face runs
 * past 1 (or below 0); one larger than the cell spans more than one unit.
 *
 * With no usable lattice the field's own cell is the reference, so the answer
 * is the unit cube.
 *
 * @param {GridLike} field
 * @param {number[][] | null | undefined} lattice rows = vectors, world units
 * @returns {[number, number][]} per-axis [lo, hi]
 */
export function blockCellRange(field, lattice) {
  if (!isMat3(lattice)) {
    assertGrid(field);
    return [[0, 1], [0, 1], [0, 1]];
  }
  const e = gridToWorld(field);
  // w = f . L (rows = vectors)  =>  f = w . L^-1
  const inv = invert3(lattice, 'the lattice');
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const g = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const w = [0, 1, 2].map((r) => e[r] * g[0] + e[4 + r] * g[1] + e[8 + r] * g[2] + e[12 + r]);
    for (let k = 0; k < 3; k++) {
      const f = w[0] * inv[0][k] + w[1] * inv[1][k] + w[2] * inv[2][k];
      if (f < lo[k]) lo[k] = f;
      if (f > hi[k]) hi[k] = f;
    }
  }
  return [[lo[0], hi[0]], [lo[1], hi[1]], [lo[2], hi[2]]];
}

/**
 * Integer cell translations whose copy of the field overlaps the display
 * bounds. Copy n covers [rlo + n, rhi + n] on an axis and is wanted when that
 * strictly overlaps [lo, hi] — merely touching does not count, and `eps`
 * absorbs a user-typed bound a hair over an integer (1.0000001 must not
 * conjure a whole extra cell). For the unit range [0,1] this is exactly the
 * rule the isosurface always used: [0,1] -> [0]; [0,1.2] -> [0,1];
 * [-0.5,1] -> [-1,0]; a zero-thickness bound still yields one copy.
 *
 * Offsets come out in nested i, j, k order, ascending, so the first one is
 * the lowest translation (the isosurface gives that one to its base meshes).
 *
 * @param {[number, number][]} range the field's extent in cell fractions
 * @param {[number, number][]} bounds per-axis [lo, hi] in cell fractions
 * @param {{maxPerAxis?: number, eps?: number}} [options]
 * @returns {number[][]} every [i, j, k]
 */
export function imageOffsets(range, bounds, { maxPerAxis = 5, eps = 1e-6 } = {}) {
  const axis = (k) => {
    const [rlo, rhi] = range[k];
    const [lo, hi] = bounds[k];
    const first = Math.floor(lo + eps - rhi) + 1;
    // max(): a zero-thickness region still resolves to one cell, which the
    // clipping then reduces to nothing — better than no mesh at all.
    const last = Math.min(Math.max(first, Math.ceil(hi - rlo - eps) - 1), first + maxPerAxis - 1);
    const out = [];
    for (let n = first; n <= last; n++) out.push(n);
    return out;
  };
  const [ri, rj, rk] = [axis(0), axis(1), axis(2)];
  const out = [];
  for (const i of ri) for (const j of rj) for (const k of rk) out.push([i, j, k]);
  return out;
}

/** Fractional-bounds tolerance: bounds within this of the unit cell count as unit bounds. */
export const BOUND_EPS = 1e-6;

/**
 * True for the plain unit cell [0,1] on every axis (within BOUND_EPS) — the
 * default display bounds, in which a field is drawn once and needs no clipping.
 * @param {[number, number][]} bounds
 */
export function isUnitBounds(bounds) {
  return bounds.every(([lo, hi]) => Math.abs(lo) < BOUND_EPS && Math.abs(hi - 1) < BOUND_EPS);
}
