// AtomCollisionCheck.js
//
// Pure, DOM-free proximity check shared by every "add atoms" flow (add-to-
// existing-structure, create-new-structure, and eventually a symmetry/Wyckoff
// generator - see SymmetryWyckoffTabStub.js). Given a lattice and two groups
// of atoms, reports which pairs are closer than a threshold, checking
// existing-vs-candidate and candidate-vs-candidate pairs only - existing atoms
// are assumed already valid and are never re-checked against each other.

import { fracToCartPoint } from '../../math/index.js';

const IMAGE_OFFSETS = [-1, 0, 1];

// The 27 Cartesian lattice translations minImageDistance compares against,
// built once per check rather than once per pair.
function imageTranslations(lattice) {
  const out = [];
  for (const i of IMAGE_OFFSETS) {
    for (const j of IMAGE_OFFSETS) {
      for (const k of IMAGE_OFFSETS) out.push(fracToCartPoint([i, j, k], lattice));
    }
  }
  return out;
}

// Minimum-image Cartesian distance between two Cartesian points under a
// lattice, checking all 27 neighbouring periodic images so atoms placed near
// a cell boundary are still compared against images that wrap close by.
function minImageDistance(posA, posB, translations) {
  let best = Infinity;
  for (const offset of translations) {
    const dx = posA[0] - (posB[0] + offset[0]);
    const dy = posA[1] - (posB[1] + offset[1]);
    const dz = posA[2] - (posB[2] + offset[2]);
    const dist = Math.hypot(dx, dy, dz);
    if (dist < best) best = dist;
  }
  return best;
}

/** Inverse of a 3x3 matrix, or null when it is singular. */
function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * Every pair (i < j) of `positions` closer than `threshold` under
 * minImageDistance, found with a periodic cell list instead of comparing all
 * N²/2 pairs. The cell is binned in fractional space with each bin at least
 * `threshold` wide measured perpendicular to its faces, so two points within
 * `threshold` of each other (through any lattice translation) always sit in
 * the same or adjacent bins, wrapping round the cell. Only those pairs get the
 * exact 27-image distance, so the result is the same as the brute-force scan.
 * Falls back to that scan when the lattice is unusable.
 *
 * @param {number[][]} positions Cartesian
 * @param {number[][]} lattice row vectors
 * @param {number} threshold
 * @param {(i: number, j: number, distance: number) => void} onPair
 */
function forEachClosePair(positions, lattice, threshold, onPair) {
  const translations = imageTranslations(lattice);
  const n = positions.length;
  const brute = () => {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = minImageDistance(positions[i], positions[j], translations);
        if (d < threshold) onPair(i, j, d);
      }
    }
  };

  const inv = Array.isArray(lattice) && lattice.length === 3 ? invert3(lattice) : null;
  if (!inv || !(threshold > 0) || n < 2) { brute(); return; }

  // Bins per axis: the cell's width perpendicular to the other two vectors,
  // divided into slabs no thinner than the threshold.
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const [la, lb, lc] = lattice;
  const volume = Math.abs(la[0] * (lb[1] * lc[2] - lb[2] * lc[1])
    - la[1] * (lb[0] * lc[2] - lb[2] * lc[0]) + la[2] * (lb[0] * lc[1] - lb[1] * lc[0]));
  const bins = [cross(lb, lc), cross(lc, la), cross(la, lb)].map((faceNormal) => {
    const width = volume / Math.hypot(...faceNormal);
    return Math.max(1, Math.min(64, Math.floor(width / threshold)));
  });

  /** @type {Map<number, number[]>} */
  const grid = new Map();
  const cellOf = new Array(n);
  for (let p = 0; p < n; p++) {
    const [x, y, z] = positions[p];
    const cell = [0, 1, 2].map((axis) => {
      const f = x * inv[0][axis] + y * inv[1][axis] + z * inv[2][axis];
      const w = f - Math.floor(f);
      return Math.min(bins[axis] - 1, Math.floor(w * bins[axis]));
    });
    cellOf[p] = cell;
    const key = (cell[0] * bins[1] + cell[1]) * bins[2] + cell[2];
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(p);
  }

  // Neighbouring bin offsets per axis, de-duplicated so a 1- or 2-bin axis
  // (where -1 and +1 wrap onto the same bin) does not visit a bin twice.
  const steps = bins.map((count) => [...new Set([-1, 0, 1].map((d) => ((d % count) + count) % count))]);
  for (let p = 0; p < n; p++) {
    const [ca, cb, cc] = cellOf[p];
    for (const da of steps[0]) {
      for (const db of steps[1]) {
        for (const dc of steps[2]) {
          const key = (((ca + da) % bins[0]) * bins[1] + ((cb + db) % bins[1])) * bins[2] + ((cc + dc) % bins[2]);
          const list = grid.get(key);
          if (!list) continue;
          for (const q of list) {
            if (q <= p) continue;
            const d = minImageDistance(positions[p], positions[q], translations);
            if (d < threshold) onPair(p, q, d);
          }
        }
      }
    }
  }
}

function endpoint(atom, index, group) {
  return { group, index, element: atom.element || '?' };
}

// checkAtomCollisions({ lattice, existingAtoms, candidateAtoms, thresholdAngstrom })
//   lattice: 3x3 Cartesian row-vector matrix
//   existingAtoms / candidateAtoms: [{ position /* Cartesian [x,y,z] */, element }]
//   thresholdAngstrom: distance below which a pair is flagged (default 0.5 Å)
//
// Returns { tooClose: [{ a, b, distance }] } - empty array means clear. `a`/`b`
// are { group: 'new'|'existing', index, element }, `index` being the position
// within whichever of candidateAtoms/existingAtoms it came from - callers use
// this to map a conflict back to a specific atom-table row (see
// conflictingCandidateIndices below) or to build a human-readable label.
export function checkAtomCollisions({ lattice, existingAtoms = [], candidateAtoms = [], thresholdAngstrom = 0.5 }) {
  // Two atoms at the same position are not necessarily a mistake: that is
  // exactly how substitutional disorder is expressed, both in CIF and in this
  // editor, where co-located rows are grouped into one site. So a coincident
  // GROUP is only a conflict when its occupancies sum above 1 - i.e. when the
  // site would be over-filled and could not be a disorder statement.
  //
  // This has to be judged over the whole cluster of mutually-close atoms, not
  // pairwise: three rows at 0.5 occupancy each sum to 1.5 (over-filled) but
  // every PAIR among them sums to only 1.0, so a pairwise check would miss it
  // entirely. Atoms are grouped into clusters by proximity (union-find over
  // the threshold graph) and judged as a whole.
  const all = [
    ...existingAtoms.map((a, i) => ({ ...a, group: 'existing', index: i })),
    ...candidateAtoms.map((a, i) => ({ ...a, group: 'new', index: i })),
  ];

  const parent = all.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };

  // Only pairs under the threshold matter (they are all a cluster can hold),
  // so their distances are the only ones kept.
  /** @type {Map<string, number>} */
  const closeDistance = new Map();
  forEachClosePair(all.map((a) => a.position), lattice, thresholdAngstrom, (i, j, d) => {
    closeDistance.set(`${i}:${j}`, d);
    union(i, j);
  });
  const translations = imageTranslations(lattice);
  const distanceBetween = (i, j) => closeDistance.get(i < j ? `${i}:${j}` : `${j}:${i}`)
    ?? minImageDistance(all[i].position, all[j].position, translations);

  /** @type {Map<number, number[]>} */
  const clusters = new Map();
  all.forEach((_, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  });

  const tooClose = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const totalOccupancy = members.reduce((sum, i) => sum + (all[i].occupancy ?? 1), 0);
    if (totalOccupancy <= 1 + 1e-3) continue;   // a legitimate disorder group

    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const i = members[a], j = members[b];
        if (all[i].group !== 'new' && all[j].group !== 'new') continue;   // pre-existing pair, not this edit's concern
        tooClose.push({
          a: endpoint(all[i], all[i].index, all[i].group),
          b: endpoint(all[j], all[j].index, all[j].group),
          distance: distanceBetween(i, j),
        });
      }
    }
  }

  return { tooClose };
}

// Unique candidate ("new") atom indices involved in any conflict - the rows
// an atom-table editor should highlight so the user can see and fix them.
export function conflictingCandidateIndices(tooClose) {
  const indices = new Set();
  for (const pair of tooClose) {
    if (pair.a.group === 'new') indices.add(pair.a.index);
    if (pair.b.group === 'new') indices.add(pair.b.index);
  }
  return [...indices];
}
