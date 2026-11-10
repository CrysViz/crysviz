/**
 * Pure layout helpers for Gaussian cube files whose atoms do not sit inside
 * the grid box. Such a file is a finite block of data rather than a periodic
 * cell, so the loader asks the user, and for "not periodic" it needs a padded
 * orthorhombic box around every atom and the whole grid.
 *
 * Imports nothing: the `CubeData` shape comes from `io/cubeParse.js` (JSDoc only).
 */

/** @typedef {import('./cubeParse.js').CubeData} CubeData */

const DEFAULT_MARGIN = 0.01;
/** Matches the XYZ / aims molecular-box buffer (Angstrom). */
const DEFAULT_PADDING = 2;
/** Relative determinant below which a step matrix counts as degenerate. */
const SINGULAR_TOL = 1e-12;

const norm = (v) => Math.hypot(v[0], v[1], v[2]);

/**
 * Inverse of a 3x3 matrix (rows), or throws when it is singular or non-finite.
 * @param {number[][]} m
 * @returns {number[][]}
 */
function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const scale = norm(m[0]) * norm(m[1]) * norm(m[2]);
  if (!Number.isFinite(det) || !(scale > 0) || Math.abs(det) <= SINGULAR_TOL * scale) {
    throw new Error('Cube layout: the grid step vectors are singular or degenerate');
  }
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** Throws unless the grid counts and step rows are usable. */
function assertUsableGrid(cube) {
  const { grid, voxel, origin } = cube;
  if (!Array.isArray(grid) || grid.length !== 3 || !grid.every((n) => Number.isInteger(n) && n >= 1)) {
    throw new Error('Cube layout: grid must be three positive integers');
  }
  if (!voxel?.every((r) => r?.length === 3 && r.every(Number.isFinite)) || voxel.length !== 3
    || origin?.length !== 3 || !origin.every(Number.isFinite)) {
    throw new Error('Cube layout: origin and step vectors must be finite 3-vectors');
  }
}

/**
 * Count atoms lying outside the periodic cell the file implies (rows
 * `cube.lattice` = N_i * step_i, corner at `cube.origin`), allowing `margin`
 * in fractional units on every side. An atom exactly on the margin is inside.
 * @param {CubeData} cube
 * @param {number} [margin]
 * @returns {{ outside: number, total: number }}
 */
export function countAtomsOutsideGrid(cube, margin = DEFAULT_MARGIN) {
  assertUsableGrid(cube);
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Cube layout: margin must be a non-negative number');
  const inv = invert3(cube.lattice);
  let outside = 0;
  for (const atom of cube.atoms) {
    const d = atom.position.map((c, k) => c - cube.origin[k]);
    // fraction_j = sum_k d_k * inv[k][j]   (d = f * lattice  =>  f = d * inv)
    const isOut = [0, 1, 2].some((j) => {
      const f = d[0] * inv[0][j] + d[1] * inv[1][j] + d[2] * inv[2][j];
      return f < -margin || f > 1 + margin;
    });
    if (isOut) outside++;
  }
  return { outside, total: cube.atoms.length };
}

/**
 * Orthorhombic box around every atom and the whole sampled grid (all 8 corners
 * of origin + (n_i - 1) * step_i, so skewed voxels work), padded on each side.
 * Atoms keep their true relative positions; the field keeps its own grid, with
 * grid point i at `fieldOrigin + i * step`.
 * @param {CubeData} cube
 * @param {number} [padding] Angstrom
 * @returns {{ lattice: number[][], positions: number[][], fieldOrigin: number[] }}
 */
export function boxedCubeLayout(cube, padding = DEFAULT_PADDING) {
  assertUsableGrid(cube);
  invert3(cube.voxel); // degeneracy check
  if (!Number.isFinite(padding) || padding < 0) throw new Error('Cube layout: padding must be a non-negative number');

  const points = cube.atoms.map((a) => a.position);
  for (let mask = 0; mask < 8; mask++) {
    const corner = [...cube.origin];
    for (let axis = 0; axis < 3; axis++) {
      if (!(mask & (1 << axis))) continue;
      const span = cube.grid[axis] - 1;
      for (let k = 0; k < 3; k++) corner[k] += span * cube.voxel[axis][k];
    }
    points.push(corner);
  }

  // Loop rather than Math.min(...points): spreading ~100k+ atoms can exceed the
  // engine's argument limit.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  }
  for (let k = 0; k < 3; k++) { lo[k] -= padding; hi[k] += padding; }
  return {
    lattice: [[hi[0] - lo[0], 0, 0], [0, hi[1] - lo[1], 0], [0, 0, hi[2] - lo[2]]],
    positions: cube.atoms.map((a) => a.position.map((c, k) => c - lo[k])),
    fieldOrigin: cube.origin.map((c, k) => c - lo[k]),
  };
}
