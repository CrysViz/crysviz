// Unit tests for the cube layout helpers (docs/io/cubeLayout.js).
// Run: make unittest   (or: node --test tools/unittest/)
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCube, BOHR_TO_ANGSTROM as B } from '../../docs/io/cubeParse.js';
import { countAtomsOutsideGrid, boxedCubeLayout } from '../../docs/io/cubeLayout.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const nearVec = (a, b, eps) => a.forEach((x, k) => near(x, b[k], eps));

/** Plain CubeData (Angstrom) without going through text. */
function makeCube({ origin = [0, 0, 0], grid = [4, 4, 4], voxel = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], atoms = [] } = {}) {
  return {
    label: '', units: 'angstrom', origin, grid, voxel,
    lattice: voxel.map((s, i) => s.map((c) => c * grid[i])),
    atoms: atoms.map((position) => ({ atomicNumber: 1, charge: 0, position })),
    datasetIds: null, values: [new Float32Array(grid[0] * grid[1] * grid[2])],
  };
}

/** Cube text with a 2x2x2 grid, step 1 (Bohr or Angstrom), given atom coords in file units. */
function cubeText(units, atomCoords) {
  const n = units === 'bohr' ? 2 : -2;
  return [
    'c1', 'c2',
    `${atomCoords.length} 0 0 0`,
    `${n} 1 0 0`, '2 0 1 0', '2 0 0 1',
    ...atomCoords.map((p) => `1 0 ${p.join(' ')}`),
    '1 1 1 1', '1 1 1 1',
  ].join('\n');
}

test('test_DW_1_1_inside_and_on_margin_counts_zero', () => {
  // Grid box is [0,4]^3; margin 1% = 0.04 A.
  const cube = makeCube({ atoms: [[0, 0, 0], [4, 4, 4], [2, 2, 2], [-0.04, 2, 2], [4.04, 2, 2]] });
  // -0.04/4 = -0.01 exactly and 4.04/4 = 1.01 (within float noise); use tiny inward nudge to be robust.
  const nudged = makeCube({ atoms: [[-0.0399, 2, 2], [4.0399, 2, 2], [2, -0.0399, 2], [2, 2, 4.0399]] });
  assert.deepEqual(countAtomsOutsideGrid(nudged), { outside: 0, total: 4 });
  assert.equal(countAtomsOutsideGrid(cube).total, 5);
});

test('test_DW_1_1_just_past_margin_counts_per_axis', () => {
  for (let axis = 0; axis < 3; axis++) {
    for (const v of [-0.0401, 4.0401]) {
      const p = [2, 2, 2];
      p[axis] = v;
      assert.equal(countAtomsOutsideGrid(makeCube({ atoms: [p, [1, 1, 1]] })).outside, 1, `axis ${axis} v ${v}`);
    }
  }
});

test('test_DW_1_1_counts_multiple_and_custom_margin', () => {
  const cube = makeCube({ atoms: [[-1, 0, 0], [5, 0, 0], [1, 1, 1]] });
  assert.deepEqual(countAtomsOutsideGrid(cube), { outside: 2, total: 3 });
  // Fractions are exactly -0.25 and 1.25 (binary-exact): on the margin is inside, below it outside.
  assert.equal(countAtomsOutsideGrid(cube, 0.25).outside, 0);
  assert.equal(countAtomsOutsideGrid(cube, 0.2).outside, 2);
});

test('test_DW_1_1_angstrom_and_bohr_cubes', () => {
  // Same geometry in both units: grid box is [0,2] A; atoms at 1 (in) and 3 (out).
  const angs = parseCube(cubeText('angstrom', [[1, 1, 1], [3, 1, 1]]));
  assert.deepEqual(countAtomsOutsideGrid(angs), { outside: 1, total: 2 });
  const bohr = parseCube(cubeText('bohr', [[1 / B, 1 / B, 1 / B], [3 / B, 1 / B, 1 / B]]));
  assert.deepEqual(countAtomsOutsideGrid(bohr), { outside: 1, total: 2 });
  const bohrIn = parseCube(cubeText('bohr', [[0.5, 0.5, 0.5], [2 * 1.005, 1, 1]]));
  assert.equal(countAtomsOutsideGrid(bohrIn).outside, 0); // 2.01 bohr cell is 2 bohr wide: frac 1.005
});

test('test_no_atoms_never_suspect', () => {
  assert.deepEqual(countAtomsOutsideGrid(makeCube()), { outside: 0, total: 0 });
});

test('test_DW_1_1_uses_cube_origin_and_skewed_cell', () => {
  const voxel = [[1, 0, 0], [0.5, 1, 0], [0, 0, 1]];
  const cube = makeCube({ origin: [10, 10, 10], grid: [2, 2, 2], voxel, atoms: [[10 + 1 + 0.5, 10 + 1, 10 + 1], [10, 10, 10]] });
  // lattice rows [2,0,0],[1,2,0],[0,0,2]; first atom d=(1.5,1,1) -> frac (0.5,0.5,0.5).
  assert.equal(countAtomsOutsideGrid(cube).outside, 0);
  // Cartesian x=2.6 at y=0 is frac x=1.3 -> outside although within bounding x extent of skewed cell.
  cube.atoms.push({ atomicNumber: 1, charge: 0, position: [12.6, 10, 10] });
  assert.equal(countAtomsOutsideGrid(cube).outside, 1);
});

/** Shared DW-1.2 checks. */
function checkLayout(cube, padding) {
  const { lattice, positions, fieldOrigin } = boxedCubeLayout(cube, padding);
  assert.equal(lattice[0][1] + lattice[0][2] + lattice[1][0] + lattice[1][2] + lattice[2][0] + lattice[2][1], 0);
  const size = [lattice[0][0], lattice[1][1], lattice[2][2]];
  const pts = [...positions];
  for (let m = 0; m < 8; m++) {
    const c = [...fieldOrigin];
    for (let a = 0; a < 3; a++) if (m & (1 << a)) for (let k = 0; k < 3; k++) c[k] += (cube.grid[a] - 1) * cube.voxel[a][k];
    pts.push(c);
  }
  for (const p of pts) for (let k = 0; k < 3; k++) {
    assert.ok(p[k] >= padding - 1e-9, `low clearance ${p[k]}`);
    assert.ok(size[k] - p[k] >= padding - 1e-9, `high clearance ${size[k] - p[k]}`);
  }
  positions.forEach((p, i) => nearVec(p.map((c, k) => c - fieldOrigin[k]), cube.atoms[i].position.map((c, k) => c - cube.origin[k]), 1e-12));
  return { lattice, positions, fieldOrigin, size };
}

test('test_DW_1_2_box_contains_atoms_and_grid_with_padding', () => {
  const cube = makeCube({ origin: [-3, 5, 1], grid: [3, 4, 5], atoms: [[-10, 5, 1], [8, 20, -4], [0, 0, 0]] });
  const { size } = checkLayout(cube, 2);
  // x spans atoms -10..8 (grid -3..-1 inside), y 0..20, z -4..5 (grid z 1..5).
  nearVec(size, [18 + 4, 20 + 4, 9 + 4]);
});

test('test_DW_1_2_grid_dominates_when_atoms_small', () => {
  const cube = makeCube({ grid: [11, 3, 3], atoms: [[5, 1, 1]] });
  const { size, fieldOrigin } = checkLayout(cube, 2);
  nearVec(size, [14, 6, 6]);
  nearVec(fieldOrigin, [2, 2, 2]);
});

test('test_DW_1_2_custom_padding_and_default_is_two', () => {
  const cube = makeCube({ grid: [2, 2, 2], atoms: [[0.5, 0.5, 0.5]] });
  nearVec(boxedCubeLayout(cube).fieldOrigin, [2, 2, 2]);
  nearVec(boxedCubeLayout(cube, 0).fieldOrigin, [0, 0, 0]);
  checkLayout(cube, 3.5);
});

test('test_DW_1_2_no_atoms_box_is_grid_extent_plus_padding', () => {
  const { lattice, positions, fieldOrigin } = boxedCubeLayout(makeCube({ grid: [3, 3, 3] }), 2);
  assert.deepEqual(positions, []);
  nearVec([lattice[0][0], lattice[1][1], lattice[2][2]], [6, 6, 6]);
  nearVec(fieldOrigin, [2, 2, 2]);
});

test('test_DW_1_3_skewed_voxels_use_all_corners', () => {
  // Strong shear: the far corner sits at x = (n1-1)*1 + (n2-1)*3 = 1+3 = 4, y = 3.
  const voxel = [[1, 0, 0], [3, 1, 0], [0, -2, 1]];
  const cube = makeCube({ origin: [1, 1, 1], grid: [2, 2, 2], voxel, atoms: [[2, 2, 2]] });
  const { size } = checkLayout(cube, 2);
  // Corners x: 1, 2, 4, 5 -> 1..5 ; y: 1, 2(=1+1... ) computed below.
  const xs = [], ys = [], zs = [];
  for (let m = 0; m < 8; m++) {
    const c = [...cube.origin];
    for (let a = 0; a < 3; a++) if (m & (1 << a)) for (let k = 0; k < 3; k++) c[k] += cube.voxel[a][k];
    xs.push(c[0]); ys.push(c[1]); zs.push(c[2]);
  }
  const span = (v) => Math.max(...v, 2) - Math.min(...v, 2);
  nearVec(size, [span(xs) + 4, span(ys) + 4, span(zs) + 4]);
  assert.ok(size[1] > 4 + 2, 'y extent comes from the sheared corners');
});

test('test_DW_1_3_n_equals_one_axis_has_zero_extent', () => {
  const cube = makeCube({ grid: [1, 5, 1], atoms: [] });
  const { lattice, fieldOrigin } = checkLayout(cube, 2);
  nearVec([lattice[0][0], lattice[2][2]], [4, 4]); // zero extent + 2*padding
  near(lattice[1][1], 8);
  nearVec(fieldOrigin, [2, 2, 2]);
  assert.deepEqual(countAtomsOutsideGrid(makeCube({ grid: [1, 1, 1], atoms: [[0.5, 0.5, 0.5]] })), { outside: 0, total: 1 });
});

test('test_DW_1_3_singular_or_bad_input_throws', () => {
  const flat = makeCube({ voxel: [[1, 0, 0], [2, 0, 0], [0, 0, 1]] });
  assert.throws(() => countAtomsOutsideGrid(flat), /singular|degenerate/);
  assert.throws(() => boxedCubeLayout(flat), /singular|degenerate/);
  assert.throws(() => boxedCubeLayout(makeCube({ voxel: [[0, 0, 0], [0, 1, 0], [0, 0, 1]] })), /singular|degenerate/);
  assert.throws(() => boxedCubeLayout(makeCube({ voxel: [[NaN, 0, 0], [0, 1, 0], [0, 0, 1]] })), /finite/);
  assert.throws(() => boxedCubeLayout(makeCube({ grid: [0, 2, 2] })), /grid/);
  assert.throws(() => boxedCubeLayout(makeCube(), -1), /padding/);
});

test('countAtomsOutsideGrid: atoms exactly on the margin are inside, just beyond are outside', () => {
  // Grid box [0,4]^3 with margin 0.25 (exact in binary): fractions -0.25 and 1.25 are exactly representable.
  const onEdge = makeCube({ atoms: [[-1, 2, 2], [5, 2, 2], [2, -1, 2], [2, 5, 2], [2, 2, -1], [2, 2, 5]] });
  assert.deepEqual(countAtomsOutsideGrid(onEdge, 0.25), { outside: 0, total: 6 });
  const beyond = makeCube({ atoms: [[-1.0001, 2, 2], [5.0001, 2, 2]] });
  assert.deepEqual(countAtomsOutsideGrid(beyond, 0.25), { outside: 2, total: 2 });
});

test('countAtomsOutsideGrid: non-finite or negative margin is rejected', () => {
  const cube = makeCube({ atoms: [[1, 1, 1]] });
  for (const bad of [NaN, -0.01, Infinity, -Infinity]) assert.throws(() => countAtomsOutsideGrid(cube, bad), /margin/);
  assert.deepEqual(countAtomsOutsideGrid(cube, 0), { outside: 0, total: 1 });
});

test('boxedCubeLayout handles a very large atom list (no argument-spread limit)', () => {
  const atoms = Array.from({ length: 300000 }, (_, i) => [i % 7, i % 5, i % 3]);
  const { lattice } = boxedCubeLayout(makeCube({ atoms, grid: [2, 2, 2] }), 0);
  nearVec([lattice[0][0], lattice[1][1], lattice[2][2]], [6, 4, 2]);
});
