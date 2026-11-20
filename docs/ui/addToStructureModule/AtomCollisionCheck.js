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

// Minimum-image Cartesian distance between two Cartesian points under a
// lattice, checking all 27 neighbouring periodic images so atoms placed near
// a cell boundary are still compared against images that wrap close by.
function minImageDistance(posA, posB, lattice) {
  let best = Infinity;
  for (const i of IMAGE_OFFSETS) {
    for (const j of IMAGE_OFFSETS) {
      for (const k of IMAGE_OFFSETS) {
        const offset = fracToCartPoint([i, j, k], lattice);
        const dx = posA[0] - (posB[0] + offset[0]);
        const dy = posA[1] - (posB[1] + offset[1]);
        const dz = posA[2] - (posB[2] + offset[2]);
        const dist = Math.hypot(dx, dy, dz);
        if (dist < best) best = dist;
      }
    }
  }
  return best;
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

  /** @type {Map<string, number>} */
  const distanceCache = new Map();
  const distanceBetween = (i, j) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    let d = distanceCache.get(key);
    if (d === undefined) {
      d = minImageDistance(all[i].position, all[j].position, lattice);
      distanceCache.set(key, d);
    }
    return d;
  };

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (distanceBetween(i, j) < thresholdAngstrom) union(i, j);
    }
  }

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
