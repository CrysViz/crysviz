// Surface slabs: a crystal cut along (h k l), `layers` repeats thick, with
// vacuum along the surface normal. The construction is the standard one (as
// in ASE's ase.build.surface): an in-plane basis c1, c2 and a stacking vector
// c3 with (h k l)·c3 = 1 found by the extended Euclid algorithm, the crystal
// re-expressed in that basis, repeated along c3, then c3 replaced by a vector
// perpendicular to the surface so the vacuum is a true gap along the normal.
// Plain arrays, no app state: the host's build_slab registers the result.

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const norm = (u) => Math.sqrt(dot(u, u));
const scale = (u, s) => u.map((x) => x * s);
const add = (...vs) => [0, 1, 2].map((k) => vs.reduce((sum, v) => sum + v[k], 0));
// Python's floor division and modulo, which the construction relies on for negative indices.
const pyDiv = (a, b) => Math.floor(a / b);
const pyMod = (a, b) => a - b * Math.floor(a / b);

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** x, y with a·x + b·y = gcd(a, b) (Python-convention extended Euclid). */
function extGcd(a, b) {
  if (b === 0) return [1, 0];
  if (pyMod(a, b) === 0) return [0, 1];
  const [x, y] = extGcd(b, pyMod(a, b));
  return [y, x - y * pyDiv(a, b)];
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const matVec = (m, v) => m.map((row) => dot(row, v));

/**
 * The integer basis (rows c1, c2, c3, in units of the input lattice vectors):
 * c1, c2 span the (h k l) plane, (h k l)·c3 = 1.
 * @param {number[][]} lattice rows a, b, c
 * @param {number[]} hkl
 */
export function surfaceBasis(lattice, [h, k, l]) {
  const zeros = [h === 0, k === 0, l === 0];
  if (zeros.filter(Boolean).length === 2) {
    if (!zeros[0]) return [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
    if (!zeros[1]) return [[0, 0, 1], [1, 0, 0], [0, 1, 0]];
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  const [a1, a2, a3] = lattice;
  let [p, q] = extGcd(k, l);
  // The c1 of smallest |c1·c2| among the equivalent choices p + i·l, q − i·k.
  const lk = add(scale(a2, l), scale(a3, -k));
  const k1 = dot(add(scale(add(scale(a1, k), scale(a2, -h)), p), scale(add(scale(a1, l), scale(a3, -h)), q)), lk);
  const k2 = dot(add(scale(add(scale(a1, k), scale(a2, -h)), l), scale(add(scale(a1, l), scale(a3, -h)), -k)), lk);
  if (Math.abs(k2) > 1e-10) {
    const i = -Math.round(k1 / k2);
    p += i * l;
    q -= i * k;
  }
  const [a, b] = extGcd(p * k + q * l, h);
  const g = gcd(l, k);
  return [[p * k + q * l, -p * h, -q * h], [0, l / g, -k / g], [b, a * p, a * q]];
}

/**
 * Cut a slab.
 * @param {{lattice: number[][], positions: number[][], elements: string[]}} crystal
 *   rows a, b, c (Å) and fractional positions
 * @param {{hkl: number[], layers: number, vacuum: number}} options
 *   vacuum: the gap (Å) between the slab and its periodic image along the normal
 * @returns {{lattice: number[][], positions: number[][], elements: string[], thickness: number}}
 *   lattice rows: a along x, b in the xy plane, c along z (the surface normal)
 */
export function buildSlab({ lattice, positions, elements }, { hkl, layers, vacuum }) {
  const tol = 1e-10;
  if (!Array.isArray(hkl) || hkl.length !== 3 || !hkl.every(Number.isInteger) || hkl.every((x) => x === 0)) {
    throw new Error('hkl must be three integers, not all zero');
  }
  const g = gcd(gcd(hkl[0], hkl[1]), hkl[2]);
  const basis = surfaceBasis(lattice, hkl.map((x) => x / g));
  // Oriented cell: rows basis · lattice; positions re-expressed in it and wrapped.
  const cell = basis.map((row) => add(scale(lattice[0], row[0]), scale(lattice[1], row[1]), scale(lattice[2], row[2])));
  const basisTInv = invert3([0, 1, 2].map((i) => basis.map((row) => row[i])));
  // An oriented cell |det| times the input holds |det| images of each atom.
  const det = Math.round(Math.abs(dot(cell[0], cross(cell[1], cell[2])) / dot(lattice[0], cross(lattice[1], lattice[2]))));
  const shifts = [];
  const range = 3 * Math.max(...basis.flat().map(Math.abs)) + 1;
  for (let i = -range; i <= range; i++) for (let j = -range; j <= range; j++) for (let k = -range; k <= range; k++) shifts.push([i, j, k]);
  const cellAtoms = [];
  positions.forEach((pos, n) => {
    const seen = [];
    for (const s of shifts) {
      const f = matVec(basisTInv, add(pos, s)).map((x) => x - Math.floor(x + tol));
      if (f.some((x) => x < -tol || x >= 1 - tol)) continue;
      if (seen.some((o) => o.every((x, k) => Math.abs(x - f[k]) < 1e-6))) continue;
      seen.push(f);
      cellAtoms.push({ element: elements[n], frac: f });
    }
  });
  if (cellAtoms.length !== positions.length * det) {
    throw new Error(`slab construction found ${cellAtoms.length} atoms, expected ${positions.length * det}`);
  }
  // Repeat along c3, as Cartesian points.
  const cart = [];
  const els = [];
  for (let n = 0; n < layers; n++) {
    for (const atom of cellAtoms) {
      cart.push(add(scale(cell[0], atom.frac[0]), scale(cell[1], atom.frac[1]), scale(cell[2], atom.frac[2] + n)));
      els.push(atom.element);
    }
  }
  // Rotate so a1 is along x and the normal along z.
  const [a1, a2] = cell;
  const ex = scale(a1, 1 / norm(a1));
  const ez = scale(cross(a1, a2), 1 / norm(cross(a1, a2)));
  const ey = cross(ez, ex);
  const rotated = cart.map((p) => [dot(p, ex), dot(p, ey), dot(p, ez)]);
  const zs = rotated.map((p) => p[2]);
  const zmin = Math.min(...zs);
  const thickness = Math.max(...zs) - zmin;
  const c = thickness + vacuum;
  const A = [norm(a1), 0, 0];
  const B = [dot(a2, ex), dot(a2, ey), 0];
  const C = [0, 0, c];
  const inv = invert3([A, B, C].map((_, i) => [A[i], B[i], C[i]]));
  // Centre the slab in the gap; wrap in-plane.
  const out = rotated.map((p) => {
    const f = matVec(inv, [p[0], p[1], p[2] - zmin + vacuum / 2]);
    return [f[0] - Math.floor(f[0] + tol), f[1] - Math.floor(f[1] + tol), f[2]];
  });
  return { lattice: [A, B, C], positions: out, elements: els, thickness };
}
