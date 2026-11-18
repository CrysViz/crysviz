// model/dataSource.js: where a structure's energy, forces and stress came from
// ("Source:" in the Parameters section, kept by .crysviz sessions).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanDataSource, formatDataSource, aseCalculatorSource, dataSourceOf, hasComputedData,
} from '../../docs/model/dataSource.js';

test('the formats that carry computed data name their code; geometry formats none', () => {
  assert.equal(formatDataSource('outcar'), 'VASP');
  assert.equal(formatDataSource('pwscf-out'), 'Quantum ESPRESSO');
  assert.equal(formatDataSource('castep-geom'), 'CASTEP');
  assert.equal(formatDataSource('aims-out'), 'FHI-aims');
  for (const id of ['cif', 'poscar', 'pwscf-in', 'xyz', 'traj']) assert.equal(formatDataSource(id), null, id);
});

test('an ASE trajectory names its calculator; unknown or none is plain ASE', () => {
  assert.equal(aseCalculatorSource('vasp'), 'VASP (via ASE)');
  assert.equal(aseCalculatorSource('espresso'), 'Quantum ESPRESSO (via ASE)');
  assert.equal(aseCalculatorSource('MACE'), 'MACE (via ASE)');
  assert.equal(aseCalculatorSource('my-model'), 'my-model (via ASE)');
  assert.equal(aseCalculatorSource('unknown'), 'ASE');
  assert.equal(aseCalculatorSource(null), 'ASE');
  assert.equal(aseCalculatorSource(''), 'ASE');
});

test('a label from a file or session is trimmed, single-spaced and at most 80 characters', () => {
  assert.equal(cleanDataSource('  PET-MAD   xs \n'), 'PET-MAD xs');
  assert.equal(cleanDataSource(''), null);
  assert.equal(cleanDataSource('   '), null);
  assert.equal(cleanDataSource(42), null);
  assert.equal(cleanDataSource({ toString: () => 'x' }), null);
  assert.equal(cleanDataSource('x'.repeat(200)).length, 80);
});

test('a structure\'s own source wins over its file\'s', () => {
  assert.equal(dataSourceOf({ dataSource: 'PET-MAD xs' }, { dataSource: 'VASP' }), 'PET-MAD xs');
  assert.equal(dataSourceOf({ dataSource: null }, { dataSource: 'VASP' }), 'VASP');
  assert.equal(dataSourceOf({}, null), null);
  assert.equal(dataSourceOf(null, { dataSource: 'VASP' }), 'VASP');
});

test('only a file with an energy, a stress or a non-zero force has computed data', () => {
  const zero = { vector: [0, 0, 0] };
  assert.equal(hasComputedData({ structures: [{ energy: null, stress: null, forces: [zero, zero] }] }), false);
  assert.equal(hasComputedData({ structures: [{ energy: -1.5, forces: [] }] }), true);
  assert.equal(hasComputedData({ structures: [{ energy: null, stress: { tensor: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } }] }), true);
  assert.equal(hasComputedData({ structures: [{ energy: null, forces: [zero, { vector: [0, 0.1, 0] }] }] }), true);
  assert.equal(hasComputedData({ store: { frames: [{ energy: null, stress: null, forces: null }] }, structures: [] }), false);
  assert.equal(hasComputedData({ store: { frames: [{ energy: null, stress: null, forces: null }, { energy: -3, stress: null, forces: null }] }, structures: [] }), true);
  assert.equal(hasComputedData({ store: {}, structures: [] }), true, 'a store read from disk on demand');
});
