// Empty space in a periodic cell: the centres of its voids, as local maxima of
// the distance to the nearest atom on a grid. Step 1 of the cage search
// (PolyhedraModule.js findCages; mirrored in periodic_wasm_src polyhedra.rs),
// and on its own the host's get_voids (interstitial sites). Plain arrays, no
// three.js, so it runs in Node for the unit tests.

export const CAGE_GRID_STEP = 0.4;          // Å, spacing of the void-search grid
export const CAGE_GRID_MAX_POINTS = 400000; // a coarser grid beyond this many points
export const CAGE_SPLAT_RADIUS = 4.5;       // Å, the distance field is resolved up to here
export const CAGE_MIN_VOID = 0.7;           // Å, a void centre is at least this far from every atom

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const length = (u) => Math.sqrt(dot(u, u));

/**
 * Void centres of a periodic cell, in grid order.
 * @param {number[][]} lattice rows a, b, c (Å)
 * @param {number[][]} positions fractional atom positions
 * @param {number} [minVoid] smallest distance (Å) from a centre to every atom
 * @returns {{dims: number[], voids: {ijk: number[], frac: number[], radius: number}[]}}
 *   radius: the distance from the centre to the nearest atom
 */
export function findVoidCentres(lattice, positions, minVoid = CAGE_MIN_VOID) {
  const [a, b, c] = lattice;
  const cellVolume = Math.abs(dot(a, cross(b, c)));
  // Perpendicular widths V/|b×c|: how far a sphere reaches in grid steps.
  const widthA = cellVolume / Math.max(length(cross(b, c)), 1e-9);
  const widthB = cellVolume / Math.max(length(cross(c, a)), 1e-9);
  const widthC = cellVolume / Math.max(length(cross(a, b)), 1e-9);
  // Coarsened in fixed steps (not a cube root) so both paths get the same grid.
  let h = CAGE_GRID_STEP;
  while (cellVolume / (h * h * h) > CAGE_GRID_MAX_POINTS) h *= 1.25;
  const nA = Math.max(4, Math.ceil(length(a) / h));
  const nB = Math.max(4, Math.ceil(length(b) / h));
  const nC = Math.max(4, Math.ceil(length(c) / h));
  const field = new Float64Array(nA * nB * nC).fill(CAGE_SPLAT_RADIUS);
  const at = (i, j, k) => ((((i % nA) + nA) % nA) * nB + (((j % nB) + nB) % nB)) * nC + (((k % nC) + nC) % nC);
  const ea = Math.ceil((CAGE_SPLAT_RADIUS / widthA) * nA) + 1;
  const eb = Math.ceil((CAGE_SPLAT_RADIUS / widthB) * nB) + 1;
  const ec = Math.ceil((CAGE_SPLAT_RADIUS / widthC) * nC) + 1;
  // Each atom stamps its distance on the grid within CAGE_SPLAT_RADIUS (periodic by index wrap).
  for (const position of positions) {
    const f0 = position[0] - Math.floor(position[0]);
    const f1 = position[1] - Math.floor(position[1]);
    const f2 = position[2] - Math.floor(position[2]);
    const px = a[0] * f0 + b[0] * f1 + c[0] * f2;
    const py = a[1] * f0 + b[1] * f1 + c[1] * f2;
    const pz = a[2] * f0 + b[2] * f1 + c[2] * f2;
    const ci = Math.round(f0 * nA), cj = Math.round(f1 * nB), ck = Math.round(f2 * nC);
    for (let i = ci - ea; i <= ci + ea; i++) {
      const g0 = i / nA;
      for (let jj = cj - eb; jj <= cj + eb; jj++) {
        const g1 = jj / nB;
        for (let k = ck - ec; k <= ck + ec; k++) {
          const g2 = k / nC;
          const dx = a[0] * g0 + b[0] * g1 + c[0] * g2 - px;
          const dy = a[1] * g0 + b[1] * g1 + c[1] * g2 - py;
          const dz = a[2] * g0 + b[2] * g1 + c[2] * g2 - pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d >= CAGE_SPLAT_RADIUS) continue;
          const idx = at(i, jj, k);
          if (d < field[idx]) field[idx] = d;
        }
      }
    }
  }

  const voids = [];
  for (let i = 0; i < nA; i++) for (let j = 0; j < nB; j++) for (let k = 0; k < nC; k++) {
    const v = field[(i * nB + j) * nC + k];
    if (v < minVoid || v >= CAGE_SPLAT_RADIUS) continue;
    let isMax = true;
    for (let di = -1; di <= 1 && isMax; di++) for (let dj = -1; dj <= 1 && isMax; dj++) for (let dk = -1; dk <= 1; dk++) {
      if ((di || dj || dk) && field[at(i + di, j + dj, k + dk)] > v) { isMax = false; break; }
    }
    if (isMax) voids.push({ ijk: [i, j, k], frac: [i / nA, j / nB, k / nC], radius: v });
  }
  return { dims: [nA, nB, nC], voids };
}
