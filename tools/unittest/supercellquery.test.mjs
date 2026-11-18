// Supercell queries in the feature search (docs/ui/search/supercellQuery.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSupercellQuery, MAX_FACTOR } from '../../docs/ui/search/supercellQuery.js';

const f = (nx, ny, nz) => ({ nx, ny, nz });

test('three digits are the three factors', () => {
  assert.deepEqual(parseSupercellQuery('222'), f(2, 2, 2));
  assert.deepEqual(parseSupercellQuery('232'), f(2, 3, 2));
  assert.deepEqual(parseSupercellQuery('333'), f(3, 3, 3));
  assert.deepEqual(parseSupercellQuery(' 411 '), f(4, 1, 1));
  assert.deepEqual(parseSupercellQuery('111'), f(1, 1, 1));
});

test('numbers with x, ×, *, commas or spaces between them', () => {
  assert.deepEqual(parseSupercellQuery('2x2x2'), f(2, 2, 2));
  assert.deepEqual(parseSupercellQuery('2X3X2'), f(2, 3, 2));
  assert.deepEqual(parseSupercellQuery('2×3×4'), f(2, 3, 4));
  assert.deepEqual(parseSupercellQuery('2 * 2 * 1'), f(2, 2, 1));
  assert.deepEqual(parseSupercellQuery('2,3,2'), f(2, 3, 2));
  assert.deepEqual(parseSupercellQuery('2 3 2'), f(2, 3, 2));
  assert.deepEqual(parseSupercellQuery('10x1x1'), f(10, 1, 1));
  assert.deepEqual(parseSupercellQuery('2 x 2 x 12'), f(2, 2, 12));
});

test('the word supercell (or sc) before or after', () => {
  assert.deepEqual(parseSupercellQuery('supercell 232'), f(2, 3, 2));
  assert.deepEqual(parseSupercellQuery('Supercell: 2x2x1'), f(2, 2, 1));
  assert.deepEqual(parseSupercellQuery('super cell 222'), f(2, 2, 2));
  assert.deepEqual(parseSupercellQuery('sc 2 2 2'), f(2, 2, 2));
  assert.deepEqual(parseSupercellQuery('sc222'), f(2, 2, 2));
  assert.deepEqual(parseSupercellQuery('3x3x3 supercell'), f(3, 3, 3));
  assert.deepEqual(parseSupercellQuery('222 supercells'), f(2, 2, 2));
  assert.deepEqual(parseSupercellQuery('supercell 333'), f(3, 3, 3));
});

test('not a supercell: one or two numbers (also with the word), zeros, too large, other words', () => {
  for (const q of ['', '2', '12', '22', '2222', '1234', '202', '0x2x2', '2x2', '2x2x2x2', 'supercell',
    'supercell 3', 'sc 2', '3 supercell', 'supercell 12', 'supercell 0', `${MAX_FACTOR + 1}x1x1`, 'supercell 222 now', '2a2', 'cell 222', 'abc', '2.5x2x2', null, undefined]) {
    assert.equal(parseSupercellQuery(q), null, JSON.stringify(q));
  }
});
