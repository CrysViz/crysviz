// Slabs (docs/model/slab.js), the extended XYZ writer (docs/io/WriteExtXYZ.js)
// and the pure helpers of the host's structure commands (docs/host/structureTools.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlab } from '../../docs/model/slab.js';
import { writeExtXYZ } from '../../docs/io/WriteExtXYZ.js';
import {
  wyckoffSites, labelledQPoints, resolveQPoint, resolveBand, slicePlane,
} from '../../docs/host/structureTools.js';
import { frameIndices } from '../../docs/host/query.js';

const A = 3.615;
const CU = {
  lattice: [[A, 0, 0], [0, A, 0], [0, 0, A]],
  positions: [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]],
  elements: ['Cu', 'Cu', 'Cu', 'Cu'],
};

function cartesian(slab) {
  return slab.positions.map((p) => [0, 1, 2].map((k) => p[0] * slab.lattice[0][k] + p[1] * slab.lattice[1][k] + p[2] * slab.lattice[2][k]));
}

/** Shortest distance between two atoms, in-plane periodic images included. */
function nearest(slab) {
  const cart = cartesian(slab);
  const L = slab.lattice;
  let best = Infinity;
  for (let i = 0; i < cart.length; i++) for (let j = i; j < cart.length; j++) {
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) {
      if (i === j && !x && !y) continue;
      best = Math.min(best, Math.hypot(...[0, 1, 2].map((k) => cart[i][k] - cart[j][k] + x * L[0][k] + y * L[1][k])));
    }
  }
  return best;
}

const planes = (slab) => new Set(cartesian(slab).map((p) => p[2].toFixed(3))).size;

test('fcc (111): 4 layers are 4 atomic planes d111 apart, bulk neighbours, 15 Å gap along the normal', () => {
  const slab = buildSlab(CU, { hkl: [1, 1, 1], layers: 4, vacuum: 15 });
  assert.equal(planes(slab), 4);
  assert.ok(Math.abs(slab.thickness - 3 * A / Math.sqrt(3)) < 1e-6);
  assert.ok(Math.abs(nearest(slab) - A / Math.SQRT2) < 1e-6);
  // c is the surface normal: perpendicular to a and b, and the gap is exactly the vacuum.
  assert.equal(slab.lattice[2][0], 0);
  assert.equal(slab.lattice[2][1], 0);
  assert.equal(slab.lattice[0][2], 0);
  assert.equal(slab.lattice[1][2], 0);
  assert.ok(Math.abs(slab.lattice[2][2] - slab.thickness - 15) < 1e-9);
  assert.equal(slab.positions.length % 4, 0);
});

test('fcc (100) and (110): bulk neighbours, the gap is the vacuum, every atom kept', () => {
  for (const hkl of [[1, 0, 0], [1, 1, 0], [2, 1, 1]]) {
    const slab = buildSlab(CU, { hkl, layers: 3, vacuum: 10 });
    assert.ok(Math.abs(nearest(slab) - A / Math.SQRT2) < 1e-6, hkl.join(''));
    assert.ok(Math.abs(slab.lattice[2][2] - slab.thickness - 10) < 1e-9, hkl.join(''));
    const zs = cartesian(slab).map((p) => p[2]);
    assert.ok(Math.min(...zs) > 4.999 && Math.max(...zs) < slab.lattice[2][2] - 4.999, 'slab centred in the gap');
  }
  // (100) of the conventional cell: one stacking period is two atomic planes.
  assert.equal(planes(buildSlab(CU, { hkl: [1, 0, 0], layers: 4, vacuum: 15 })), 8);
});

test('slab rejects all-zero hkl', () => {
  assert.throws(() => buildSlab(CU, { hkl: [0, 0, 0], layers: 2, vacuum: 5 }));
});

test('extxyz: Lattice, species, Cartesian positions, energy and step', () => {
  const text = writeExtXYZ([
    { lattice: [[2, 0, 0], [0, 3, 0], [0, 0, 4]], positions: [[0.5, 0.5, 0.25]], elements: ['Li'], energy: -1.5, step: 10 },
    { lattice: null, positions: [[1, 2, 3]], elements: ['H'] },
  ]);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '1');
  assert.match(lines[1], /^Lattice="2\.00000000 0\.00000000 0\.00000000 0\.00000000 3\.00000000 .*" Properties=species:S:1:pos:R:3 energy=-1\.50000000 step=10 pbc="T T T"$/);
  assert.equal(lines[2], 'Li 1.00000000 1.50000000 1.00000000');
  assert.equal(lines[4], 'Properties=species:S:1:pos:R:3 pbc="F F F"');
  assert.equal(lines[5], 'H 1.00000000 2.00000000 3.00000000');
});

test('Wyckoff letters map back to atom indices, skipping hidden atoms', () => {
  const structure = { atoms: [{}, { hidden: true }, {}, {}] };
  assert.deepEqual(wyckoffSites(structure, ['a', 'b', 'b']), { sites: { a: [0], b: [2, 3] }, hiddenExcluded: 1 });
});

test('phonon q-points by index, Gamma or path label; bands by index or lowest_optical', () => {
  const q = (x) => ({ q: x, freqs: [] });
  const dataset = {
    qpoints: [q([0, 0, 0]), q([0.25, 0, 0]), q([0.5, 0, 0]), q([0.5, 0.25, 0]), q([0.5, 0.5, 0])],
    segments: [3, 2], labels: [['$\\Gamma$', 'X'], ['X', 'M']], nbands: 6,
  };
  assert.deepEqual(labelledQPoints(dataset).map((p) => [p.index, p.label]), [[0, '$\\Gamma$'], [2, 'X'], [3, 'X'], [4, 'M']]);
  assert.equal(resolveQPoint(dataset, 'Gamma'), 0);
  assert.equal(resolveQPoint(dataset, 'M'), 4);
  assert.equal(resolveQPoint(dataset, 2), 2);
  assert.throws(() => resolveQPoint(dataset, 9), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => resolveQPoint(dataset, 'K'), (e) => e.code === 'QPOINT_NOT_FOUND');
  assert.equal(resolveBand(dataset, 'lowest_optical'), 3);
  assert.equal(resolveBand(dataset, 5), 5);
  assert.throws(() => resolveBand({ nbands: 3 }, 'lowest_optical'));
});

test('field slices: (001) through an atom, and the default first lattice plane', () => {
  const lattice = [[4, 0, 0], [0, 4, 0], [0, 0, 6]];
  assert.deepEqual(slicePlane(lattice, [0, 0, 1], { point: [1, 1, 1.5] }), { normal: [0, 0, 1], d: 1.5 });
  assert.deepEqual(slicePlane(lattice, [0, 0, 2]), { normal: [0, 0, 1], d: 3 });
  assert.deepEqual(slicePlane(lattice, [0, 0, 1], { offset: 2 }), { normal: [0, 0, 1], d: 2 });
  assert.throws(() => slicePlane(lattice, [0, 0, 0]));
});

test('export_structure extxyz frame selection', () => {
  assert.deepEqual(frameIndices(3, 'all'), [0, 1, 2]);
  assert.deepEqual(frameIndices(3, undefined), [0, 1, 2]);
  assert.deepEqual(frameIndices(3, [2, 0]), [2, 0]);
  assert.throws(() => frameIndices(3, [3]), (e) => e.code === 'INVALID_ARGS');
});
