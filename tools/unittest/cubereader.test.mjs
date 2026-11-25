// Gaussian cube parser (docs/io/cubeParse.js) against the cubegen spec — the
// cases the NCI analysis depends on: units, de-interleaved NVal / orbital
// datasets and the per-dataset density unit (Field.valueUnit) — plus the
// '.cub' name rule in docs/io/formats.js and the valueUnit / periodic
// propagation of Field and CompositeField. Run with `node --test tools/unittest/`.
// Layout and basic header parsing are covered by cubeparse.test.mjs.
//
// Fixtures in fixtures/cube/ are hand-sized grids whose values encode their
// own file position (100·i + 10·j + k along axes 1, 2, 3), so a wrong index
// order shows up as a wrong number rather than as a plausible-looking field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCube, cubeDensityUnit, BOHR_TO_ANGSTROM, CUBE_DENSITY_UNIT,
} from '../../docs/io/cubeParse.js';
import { detectFormat, headOf } from '../../docs/io/formats.js';
import { Field } from '../../docs/model/Field.js';
import { combineFields, magnitudeField } from '../../docs/model/CompositeField.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', 'cube', name), 'utf8');
const B = BOHR_TO_ANGSTROM;

/** Stored index of grid point (i, j, k): axis 1 fastest. */
const at = (cube, i, j, k) => i + cube.grid[0] * (j + cube.grid[1] * k);

function assertClose(actual, expected, message, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tol, `${message}: ${actual} vs ${expected}`);
}
function assertVecClose(actual, expected, message, tol = 1e-9) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  actual.forEach((x, i) => assertClose(x, expected[i], `${message}[${i}]`, tol));
}

test('(a) bohr cube, NVal = 1: units, atoms, density unit and x-fastest ordering', () => {
  const cube = parseCube(fixture('bohr_density.cube'));
  assert.equal(cube.title, 'Water fragment test cube');
  assert.equal(cube.description, 'Electron density from Total SCF Density');
  assert.equal(cube.units, 'bohr');
  assert.deepEqual(cube.grid, [2, 3, 4]);
  assert.equal(cube.datasetIds, null);

  assertVecClose(cube.origin, [-B, -B, -B], 'origin in Å');
  assertVecClose(cube.voxel[0], [0.5 * B, 0, 0], 'voxel a');
  assertVecClose(cube.lattice[0], [1.0 * B, 0, 0], 'lattice a = 2 × 0.5 bohr');
  assertVecClose(cube.lattice[1], [0, 1.5 * B, 0], 'lattice b = 3 × 0.5 bohr');
  assertVecClose(cube.lattice[2], [0, 0, 2.0 * B], 'lattice c = 4 × 0.5 bohr');

  assert.equal(cube.atoms.length, 2);
  assert.equal(cube.atoms[0].atomicNumber, 8);
  assert.equal(cube.atoms[1].atomicNumber, 1);
  assertVecClose(cube.atoms[1].position, [-0.5 * B, -0.5 * B, 0.5 * B], 'H position in Å');

  assert.equal(cube.values.length, 1);
  assert.deepEqual(cube.valueUnits, [CUBE_DENSITY_UNIT]);
  const [values] = cube.values;
  assert.equal(values.length, 24);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 4; k++) {
        assert.equal(values[at(cube, i, j, k)], 100 * i + 10 * j + k, `value at ${i},${j},${k}`);
      }
    }
  }
});

test('(b) Å cube (negative N): axes are not flipped, a potential has no unit', () => {
  const cube = parseCube(fixture('angstrom_potential.cube'));
  assert.equal(cube.units, 'angstrom');
  assert.deepEqual(cube.grid, [2, 2, 3]);
  assertVecClose(cube.voxel[0], [0.5, 0, 0], 'voxel a');
  assertVecClose(cube.lattice[2], [0, 0, 1.5], 'lattice c');
  assertVecClose(cube.atoms[0].position, [0.25, 0.5, 0.75], 'atom position');
  assert.deepEqual(cube.valueUnits, [null]);
  assert.equal(cube.values[0][at(cube, 1, 1, 2)], 112);
  assert.equal(cube.values[0][at(cube, 0, 1, 2)], 12);
});

test('(c) NVal = 4 gradient cube: four de-interleaved datasets, only the density has a unit', () => {
  const cube = parseCube(fixture('gradient_nval4.cube'));
  assert.equal(cube.values.length, 4);
  assert.deepEqual(cube.valueUnits, [CUBE_DENSITY_UNIT, null, null, null]);
  for (let v = 0; v < 4; v++) {
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          assert.equal(cube.values[v][at(cube, i, j, k)], 100 * i + 10 * j + k + 0.25 * v,
            `value ${v} at ${i},${j},${k}`);
        }
      }
    }
  }
});

test('(d) orbital cube (NAtoms < 0): MO record read, one dataset per orbital, no unit', () => {
  const cube = parseCube(fixture('mo_two_orbitals.cube'));
  assert.equal(cube.atoms.length, 1);
  assert.deepEqual(cube.datasetIds, [5, 6]);
  assert.equal(cube.values.length, 2);
  assert.deepEqual(cube.valueUnits, [null, null]);
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < 3; k++) {
      assert.equal(cube.values[0][at(cube, i, 0, k)], 10 * i + k + 1);
      assert.equal(cube.values[1][at(cube, i, 0, k)], -(10 * i + k + 1));
    }
  }
});

test('(e) truncated data throws instead of leaving zeros', () => {
  assert.throws(() => parseCube(fixture('truncated.cube')), /expected 24 data values, found 20/);
});

test('(f) non-orthogonal axes and CRLF line ends; spin density is a density', () => {
  const cube = parseCube(fixture('sheared_spin.cub'));
  assert.equal(cube.title, 'Sheared grid');
  assert.deepEqual(cube.grid, [3, 3, 2]);
  assertVecClose(cube.lattice[0], [1.5 * B, 0, 0], 'lattice a', 1e-6);
  assertVecClose(cube.lattice[1], [0.75 * B, 3 * 0.4330127 * B, 0], 'lattice b', 1e-6);
  assertVecClose(cube.lattice[2], [0.2 * B, 0.2 * B, 1.0 * B], 'lattice c', 1e-6);
  const shifted = cube.atoms[0].position.map((c, i) => c - cube.origin[i]);
  const expected = [0, 1, 2].map((c) => cube.voxel[0][c] + 2 * cube.voxel[1][c]);
  assertVecClose(shifted, expected, 'atom offset from the origin', 1e-6);
  assert.deepEqual(cube.valueUnits, [CUBE_DENSITY_UNIT]);
});

test('cubeDensityUnit: densities vs other cube quantities', () => {
  const cases = [
    ['Electron density from Total SCF Density', CUBE_DENSITY_UNIT],
    ['Spin density from Total SCF Density', CUBE_DENSITY_UNIT],
    ['Alpha density from Total SCF Density', CUBE_DENSITY_UNIT],
    ['Electrostatic potential from Total SCF Density', null],
    ['Laplacian of electron density from Total SCF Density', null],
    ['Norm of density gradient from Total SCF Density', null],
    ['MO coefficients', null],
    ['Contains the selected quantity on a FFT grid', null],
    ['', null],
  ];
  for (const [description, unit] of cases) assert.equal(cubeDensityUnit(description), unit, description);
});

test('a boilerplate "OUTER LOOP" second line: the unit is judged from line 1', () => {
  const text = [' H2 molecule, electron density', ' OUTER LOOP: X, MIDDLE LOOP: Y, INNER LOOP: Z',
    '    0 0 0 0', '    1 1 0 0', '    1 0 1 0', '    2 0 0 1', ' 0.1 0.2'].join('\n');
  assert.deepEqual(parseCube(text).valueUnits, [CUBE_DENSITY_UNIT]);
});

test('formats.js: .cub and .cube are cube files by name, .cubic is not', () => {
  const byName = (name) => detectFormat({ fileName: name, head: headOf('') }).id;
  assert.equal(byName('NCI.cub'), 'cube');
  assert.equal(byName('density.cube'), 'cube');
  assert.equal(byName('x.CUB'), 'cube');
  assert.notEqual(byName('x.cubic'), 'cube');
  // An orbital cube (negative NAtoms) is still sniffed as a cube under any name.
  assert.equal(detectFormat({ fileName: 'orbitals.dat', head: headOf(fixture('mo_two_orbitals.cube')) }).id, 'cube');
});

test('Field: valueUnit / periodic / colorBy defaults and combined-field propagation', () => {
  const grid = (valueUnit, periodic) => new Field({
    nx: 1, ny: 1, nz: 2, values: new Float32Array([1, 2]), valueUnit, periodic, label: 'f',
  });
  const plain = new Field({});
  assert.equal(plain.valueUnit, null);
  assert.equal(plain.periodic, true);
  assert.equal(plain.colorBy, null);

  const a = grid('e/Å³', true);
  const b = grid('e/Å³', true);
  const sum = combineFields([{ field: a, weight: 0.5 }, { field: b, weight: -0.5 }]);
  assert.equal(sum.valueUnit, 'e/Å³');
  assert.equal(sum.periodic, true);
  assert.equal(magnitudeField([a, b]).valueUnit, 'e/Å³');

  // Mixed units leave the unit unknown; a periodic field and a finite block
  // do not share a frame and are refused outright.
  assert.equal(combineFields([{ field: a, weight: 1 }, { field: grid('e/bohr³', true), weight: 1 }]).valueUnit, null);
  assert.equal(combineFields([{ field: a, weight: 1 }, { field: grid(null, true), weight: 1 }]).valueUnit, null);
  assert.throws(() => combineFields([{ field: a, weight: 1 }, { field: grid('e/Å³', false), weight: 1 }]),
    /periodic mismatch/);
  const blockSum = combineFields([{ field: grid(null, false), weight: 1 }, { field: grid(null, false), weight: 1 }]);
  assert.equal(blockSum.periodic, false);
});
