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
  const tooClose = [];

  for (let c = 0; c < candidateAtoms.length; c++) {
    for (let e = 0; e < existingAtoms.length; e++) {
      const distance = minImageDistance(candidateAtoms[c].position, existingAtoms[e].position, lattice);
      if (distance < thresholdAngstrom) {
        tooClose.push({
          a: endpoint(candidateAtoms[c], c, 'new'),
          b: endpoint(existingAtoms[e], e, 'existing'),
          distance,
        });
      }
    }
    for (let c2 = c + 1; c2 < candidateAtoms.length; c2++) {
      const distance = minImageDistance(candidateAtoms[c].position, candidateAtoms[c2].position, lattice);
      if (distance < thresholdAngstrom) {
        tooClose.push({
          a: endpoint(candidateAtoms[c], c, 'new'),
          b: endpoint(candidateAtoms[c2], c2, 'new'),
          distance,
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
