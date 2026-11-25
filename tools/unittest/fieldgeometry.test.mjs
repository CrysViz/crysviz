// Unit tests for the field grid geometry (docs/model/fieldGeometry.js), the
// Field `periodic` flag and the CompositeField frame checks (Phase 2 of the
// non-periodic cube block plan).
// Run: make unittest   (or: node --test tools/unittest/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { gridToWorld, worldToGridFraction, blockCellRange, imageOffsets } from '../../docs/model/fieldGeometry.js';
import { Field } from '../../docs/model/Field.js';
import { combineFields, magnitudeField } from '../../docs/model/CompositeField.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const nearVec = (a, b, eps) => a.forEach((x, k) => near(x, b[k], eps));

/** Apply a column-major 4x4 to a point (w = 1). */
const apply = (m, f) => [0, 1, 2].map((r) => m[r] * f[0] + m[4 + r] * f[1] + m[8 + r] * f[2] + m[12 + r]);
const add = (...vs) => vs.reduce((s, v) => s.map((x, k) => x + v[k]), [0, 0, 0]);
const scale = (v, s) => v.map((x) => x * s);

const skewVoxel = [[0.5, 0.1, 0], [0, 0.6, 0.05], [0.02, 0, 0.7]];
const block = { nx: 4, ny: 5, nz: 6, origin: [1, 2, 3], voxel: skewVoxel, periodic: false };
const periodic = { nx: 4, ny: 5, nz: 6, origin: [0, 0, 0], voxel: skewVoxel };
const diag = (s) => [[s, 0, 0], [0, s, 0], [0, 0, s]];

// --- DW-2.1: grid point placement ------------------------------------------

test('test_DW_2_1_block_point_i_at_origin_plus_i_step', () => {
  const m = gridToWorld(block);
  for (let i = 0; i < block.nx; i++) for (let j = 0; j < block.ny; j++) for (let k = 0; k < block.nz; k++) {
    const frac = [i / (block.nx - 1), j / (block.ny - 1), k / (block.nz - 1)];
    const expected = add(block.origin, scale(skewVoxel[0], i), scale(skewVoxel[1], j), scale(skewVoxel[2], k));
    nearVec(apply(m, frac), expected);
  }
  // Grid fraction 1 is the LAST point, (n-1) steps out — not n.
  nearVec(apply(m, [1, 0, 0]), add(block.origin, scale(skewVoxel[0], block.nx - 1)));
});

test('test_DW_2_1_periodic_point_i_keeps_n_point_convention', () => {
  const m = gridToWorld(periodic);
  // Today's Isosurface matrix: columns voxel_k * n_k, no translation.
  const todays = [
    ...scale(skewVoxel[0], 4), 0,
    ...scale(skewVoxel[1], 5), 0,
    ...scale(skewVoxel[2], 6), 0,
    0, 0, 0, 1,
  ];
  assert.deepEqual(m, todays);
  for (let i = 0; i < periodic.nx; i++) {
    const world = apply(m, [i / (periodic.nx - 1), 0, 0]);
    nearVec(world, scale(skewVoxel[0], (i / (periodic.nx - 1)) * periodic.nx));
  }
});

test('test_DW_2_1_periodic_default_and_missing_origin', () => {
  // `periodic` absent or true, and no origin at all, still gives the n-point cell.
  const noFlag = { nx: 4, ny: 5, nz: 6, voxel: skewVoxel };
  assert.deepEqual(gridToWorld(noFlag), gridToWorld(periodic));
  assert.deepEqual(gridToWorld({ ...noFlag, periodic: true, origin: null }), gridToWorld(periodic));
});

test('test_DW_2_1_worldToGridFraction_inverts_gridToWorld', () => {
  for (const field of [block, periodic]) {
    const m = gridToWorld(field);
    for (const frac of [[0, 0, 0], [1, 1, 1], [0.3, 0.7, 0.2], [-0.5, 1.5, 2]]) {
      nearVec(worldToGridFraction(field, apply(m, frac)), frac, 1e-12);
    }
  }
  // Block grid point i comes back as fraction i/(n-1).
  const p = add(block.origin, scale(skewVoxel[0], 2), scale(skewVoxel[2], 5));
  nearVec(worldToGridFraction(block, p), [2 / 3, 0, 1], 1e-12);
});

test('test_gridToWorld_rejects_bad_grids', () => {
  assert.throws(() => gridToWorld({ nx: 0, ny: 2, nz: 2, voxel: diag(1) }), /grid counts/);
  assert.throws(() => gridToWorld({ nx: 2, ny: 2, nz: 2, voxel: [[1, 0], [0, 1]] }), /voxel/);
  assert.throws(() => gridToWorld({ nx: 2, ny: 2, nz: 2, voxel: diag(1), origin: [1, NaN, 0] }), /origin/);
  assert.throws(() => worldToGridFraction(block, [1, 2]), /point/);
});

test('test_block_with_n_equal_1_has_zero_extent_and_no_inverse', () => {
  const flat = { nx: 1, ny: 3, nz: 3, origin: [1, 1, 1], voxel: diag(1), periodic: false };
  const m = gridToWorld(flat);
  assert.deepEqual(m.slice(0, 3), [0, 0, 0]); // every x fraction maps to the origin plane
  assert.throws(() => worldToGridFraction(flat, [1, 1, 1]), /singular/);
});

// --- blockCellRange ---------------------------------------------------------

test('test_blockCellRange_block_inside_crossing_and_spanning', () => {
  const lattice = diag(10);
  const inside = { nx: 5, ny: 5, nz: 5, origin: [1, 1, 1], voxel: diag(0.5), periodic: false };
  blockCellRange(inside, lattice).forEach((r) => nearVec(r, [0.1, 0.3]));

  const crossing = { ...inside, origin: [9, 1, 1] };
  const [rx, ry] = blockCellRange(crossing, lattice);
  nearVec(rx, [0.9, 1.1]);
  nearVec(ry, [0.1, 0.3]);

  const spanning = { ...crossing, nx: 51 }; // 25 A along x, from 9 to 34
  nearVec(blockCellRange(spanning, lattice)[0], [0.9, 3.4]);
});

test('test_blockCellRange_uses_all_corners_in_a_skewed_lattice', () => {
  const lattice = [[10, 0, 0], [5, 10, 0], [0, 0, 10]];
  const cube = { nx: 3, ny: 3, nz: 3, origin: [0, 0, 0], voxel: diag(1), periodic: false }; // [0,2]^3 in world
  // x = 10 fa + 5 fb, y = 10 fb: fa = (x - y/2) / 10 runs from -0.1 (x=0,y=2) to 0.2 (x=2,y=0).
  const [ra, rb, rc] = blockCellRange(cube, lattice);
  nearVec(ra, [-0.1, 0.2]);
  nearVec(rb, [0, 0.2]);
  nearVec(rc, [0, 0.2]);
});

test('test_blockCellRange_missing_lattice_is_the_unit_cube', () => {
  for (const lattice of [null, undefined, [], [[1, 0, 0]], 'x']) {
    assert.deepEqual(blockCellRange(block, /** @type {any} */ (lattice)), [[0, 1], [0, 1], [0, 1]]);
  }
  // A periodic field in its own n-point cell also fills exactly [0,1]^3.
  const own = skewVoxel.map((row, k) => scale(row, [4, 5, 6][k]));
  blockCellRange(periodic, own).forEach((r) => nearVec(r, [0, 1], 1e-12));
  assert.throws(() => blockCellRange(block, [[1, 0, 0], [2, 0, 0], [0, 0, 1]]), /lattice is singular/);
});

// --- imageOffsets -----------------------------------------------------------

/** Today's Isosurface rule (axisImageRange / boundsImageOffsets), verbatim. */
function todaysOffsets(bounds, eps = 1e-6, max = 5) {
  const axis = ([lo, hi]) => {
    const first = Math.floor(lo + eps);
    const last = Math.min(Math.max(first, Math.ceil(hi - eps) - 1), first + max - 1);
    const out = [];
    for (let n = first; n <= last; n++) out.push(n);
    return out;
  };
  const [ri, rj, rk] = bounds.map(axis);
  const out = [];
  for (const i of ri) for (const j of rj) for (const k of rk) out.push([i, j, k]);
  return out;
}

test('test_imageOffsets_periodic_matches_todays_rule', () => {
  const unit = [[0, 1], [0, 1], [0, 1]];
  const cases = [
    [[0, 1], [0, 1], [0, 1]],
    [[0, 1.2], [0, 1], [0, 1]],
    [[-0.5, 1], [0, 1], [0, 1]],
    [[0.5, 0.5], [1, 1], [0, 0]],
    [[1.0000001, 2], [-0.9999999, 1], [0, 1]],
    [[0.3, 0.7], [-1, 2], [-2, 3]],
    [[-3, 100], [0, 1], [0, 1]], // capped at 5 per axis
    [[-1e-6, 1], [0, 1 - 1e-6], [0, 1]],
  ];
  for (const bounds of cases) {
    assert.deepEqual(imageOffsets(unit, bounds), todaysOffsets(bounds), JSON.stringify(bounds));
  }
  assert.deepEqual(imageOffsets(unit, [[0, 1.2], [0, 1], [0, 1]]), [[0, 0, 0], [1, 0, 0]]);
  assert.deepEqual(imageOffsets(unit, [[-0.5, 1], [0, 1], [0, 1]]), [[-1, 0, 0], [0, 0, 0]]);
});

test('test_imageOffsets_block_crossing_a_face_gets_the_far_image', () => {
  const range = [[0.74, 1.31], [0.26, 0.82], [0.26, 0.45]];
  // Unit bounds: the far-side image (n = -1 covers [-0.26, 0.31]) overlaps [0,1].
  assert.deepEqual(imageOffsets(range, [[0, 1], [0, 1], [0, 1]]), [[-1, 0, 0], [0, 0, 0]]);
  assert.deepEqual(imageOffsets(range, [[0, 2], [0, 1], [0, 1]]), [[-1, 0, 0], [0, 0, 0], [1, 0, 0]]);
  // A block just past the far face only touches the cell, so its own copy is
  // not drawn — but its n = -1 image ([0, 0.5]) is inside and is.
  assert.deepEqual(imageOffsets([[1, 1.5], [0, 1], [0, 1]], [[0, 1], [0, 1], [0, 1]]), [[-1, 0, 0]]);
  // No image overlaps at all: one copy is still returned (clipped to nothing), as today.
  assert.deepEqual(imageOffsets([[0.2, 0.3], [0, 1], [0, 1]], [[0.5, 0.9], [0, 1], [0, 1]]), [[1, 0, 0]]);
  // A block spanning more than one cell: every image that reaches into the bounds.
  assert.deepEqual(imageOffsets([[0.9, 3.4], [0, 1], [0, 1]], [[0, 1], [0, 1], [0, 1]]).map((o) => o[0]), [-3, -2, -1, 0]);
  assert.equal(imageOffsets([[0, 0.1], [0, 1], [0, 1]], [[-50, 50], [0, 1], [0, 1]], { maxPerAxis: 3 }).length, 3);
});

// --- Field.periodic and getValueAtPoint -------------------------------------

function grid3() {
  return new Float32Array(27).map((_, i) => i);
}

test('test_Field_periodic_defaults_true_and_only_literal_false_makes_a_block', () => {
  assert.equal(new Field({}).periodic, true);
  assert.equal(new Field({ periodic: false }).periodic, false);
  for (const value of [true, undefined, null, 0, '', 'false', 'no']) {
    assert.equal(new Field({ periodic: /** @type {any} */ (value) }).periodic, true, String(value));
  }
});

/** Today's Field.getValueAtPoint, frozen, for the regression comparison. */
function todaysValueAtPoint(field, x_frac, y_frac, z_frac) {
  if (!field.values) return null;
  const at = (i, j, k) => field.values[i + field.nx * (j + field.ny * k)];
  const x = x_frac * (field.nx - 1), y = y_frac * (field.ny - 1), z = z_frac * (field.nz - 1);
  const i0 = Math.floor(x), j0 = Math.floor(y), k0 = Math.floor(z);
  const i1 = Math.min(i0 + 1, field.nx - 1), j1 = Math.min(j0 + 1, field.ny - 1), k1 = Math.min(k0 + 1, field.nz - 1);
  const fx = x - i0, fy = y - j0, fz = z - k0;
  const v00 = at(i0, j0, k0) * (1 - fx) + at(i1, j0, k0) * fx;
  const v10 = at(i0, j1, k0) * (1 - fx) + at(i1, j1, k0) * fx;
  const v01 = at(i0, j0, k1) * (1 - fx) + at(i1, j0, k1) * fx;
  const v11 = at(i0, j1, k1) * (1 - fx) + at(i1, j1, k1) * fx;
  const v0 = v00 * (1 - fy) + v10 * fy;
  const v1 = v01 * (1 - fy) + v11 * fy;
  return v0 * (1 - fz) + v1 * fz;
}

const samplePoints = [
  [0.5, 0.5, 0.5], [0, 0, 0], [1, 1, 1], [0.25, 0.75, 0.1],
  [-0.3, 0.5, 0.5], [1.5, 0, 0], [0.5, 2, 0.5], [-1, -1, -1], [3, 3, 3], [1.0001, 0.5, 0.5],
];

test('test_DW_2_7_periodic_getValueAtPoint_out_of_range_unchanged', () => {
  const field = new Field({ nx: 3, ny: 3, nz: 3, voxel: diag(1), values: grid3() });
  for (const p of samplePoints) {
    const got = field.getValueAtPoint(...p);
    const want = todaysValueAtPoint(field, ...p);
    // Object.is: NaN equals NaN, and an undefined-derived NaN stays what it was.
    assert.ok(Object.is(got, want), `${JSON.stringify(p)}: ${got} vs ${want}`);
  }
  near(field.getValueAtPoint(0.5, 0.5, 0.5), 13);
});

test('test_block_getValueAtPoint_is_null_outside_the_grid_and_samples_the_faces', () => {
  const field = new Field({ nx: 3, ny: 3, nz: 3, voxel: diag(1), values: grid3(), periodic: false });
  for (const p of [[1.01, 0.5, 0.5], [-0.001, 0.5, 0.5], [0.5, 1.5, 0.5], [0.5, 0.5, -1], [NaN, 0.5, 0.5]]) {
    assert.equal(field.getValueAtPoint(...p), null, JSON.stringify(p));
  }
  near(field.getValueAtPoint(0.5, 0.5, 0.5), 13);
  near(field.getValueAtPoint(1, 1, 1), 26);
  near(field.getValueAtPoint(0, 0, 0), 0);
  // A hair past a face (float noise from a world -> grid inversion) still samples it.
  near(field.getValueAtPoint(1 + 1e-10, 1, 1 - 1e-10), 26, 1e-6);
  assert.equal(new Field({ nx: 3, ny: 3, nz: 3, voxel: diag(1), periodic: false }).getValueAtPoint(0.5, 0.5, 0.5), null);
});

// --- DW-2.5: CompositeField frame checks -----------------------------------

function makeField({ origin = [0, 0, 0], periodic = true, label = 'f' } = {}) {
  return new Field({ nx: 2, ny: 2, nz: 2, origin, voxel: diag(1), values: new Float32Array(8).fill(1), periodic, label });
}

test('test_DW_2_5_combineFields_rejects_origin_mismatch', () => {
  const a = makeField({ origin: [1, 2, 3], periodic: false, label: 'A' });
  const b = makeField({ origin: [1, 2, 3.5], periodic: false, label: 'B' });
  assert.throws(() => combineFields([{ field: a, weight: 1 }, { field: b, weight: 1 }]),
    /combineFields: origin mismatch — "B" starts at \[1, 2, 3.5\], expected \[1, 2, 3\]/);
});

test('test_DW_2_5_combineFields_rejects_periodic_mismatch', () => {
  const a = makeField({ label: 'Rho' });
  const b = makeField({ periodic: false, label: 'Orbital' });
  assert.throws(() => combineFields([{ field: a, weight: 1 }, { field: b, weight: -1 }]),
    /combineFields: periodic mismatch — "Orbital" is a finite block, but "Rho" is periodic/);
  assert.throws(() => combineFields([{ field: b, weight: 1 }, { field: a, weight: 1 }]),
    /"Rho" is periodic, but "Orbital" is a finite block/);
});

test('test_DW_2_5_magnitudeField_rejects_mismatch', () => {
  const a = makeField({ label: 'mx' });
  assert.throws(() => magnitudeField([a, makeField({ periodic: false, label: 'my' })]), /magnitudeField: periodic mismatch/);
  assert.throws(() => magnitudeField([a, makeField({ origin: [0, 0, 1e-6], label: 'mz' })]), /magnitudeField: origin mismatch/);
});

test('test_DW_2_5_matching_blocks_combine_and_keep_flags', () => {
  const a = makeField({ origin: [1, 2, 3], periodic: false, label: 'A' });
  const b = makeField({ origin: [1, 2, 3 + 1e-12], periodic: false, label: 'B' }); // float noise is fine
  const sum = combineFields([{ field: a, weight: 1 }, { field: b, weight: 1 }]);
  assert.equal(sum.periodic, false);
  assert.deepEqual(sum.origin, [1, 2, 3]);
  assert.equal(sum.values[0], 2);
  const mag = magnitudeField([a, b]);
  assert.equal(mag.periodic, false);
  assert.deepEqual(mag.origin, [1, 2, 3]);
  // Periodic pairs are untouched: the result stays periodic.
  assert.equal(combineFields([{ field: makeField(), weight: 1 }, { field: makeField(), weight: 1 }]).periodic, true);
});

test('block getValueAtPoint: a point within the face tolerance below 0 returns the face value', () => {
  const n = 3;
  const values = Float32Array.from({ length: n * n * n }, (_, i) => i + 1);
  const field = new Field({ nx: n, ny: n, nz: n, origin: [0, 0, 0], voxel: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], periodic: false, values });
  const face = field.getValueAtPoint(0, 0, 0);
  assert.equal(face, 1);
  assert.equal(field.getValueAtPoint(-1e-10, 0, 0), face);
  assert.equal(field.getValueAtPoint(-1e-10, -1e-10, -1e-10), face);
  assert.equal(field.getValueAtPoint(1 + 1e-10, 1, 1), values[26]);
  assert.equal(field.getValueAtPoint(-1e-6, 0, 0), null);
});
