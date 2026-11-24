// Pure helpers of the bond breaking tolerance (docs/model/bondBreakTolerance.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairExists, compactActive, bondPairKey, cornerKey, mergeCorners, reservedCorners, cageHeld,
} from '../../docs/model/bondBreakTolerance.js';

const F2 = 1.1 * 1.1;

test('pairExists: kept to cutoff × (1 + tol) when it existed, formed within the cutoff', () => {
  const cut = 2 * 2;
  assert.equal(pairExists(true, 2.15 ** 2, cut, F2), true);
  assert.equal(pairExists(true, 2.25 ** 2, cut, F2), false);
  assert.equal(pairExists(false, 2.05 ** 2, cut, F2), false);
  assert.equal(pairExists(false, 1.95 ** 2, cut, F2), true);
  // tol 0: the strict rule both ways
  assert.equal(pairExists(true, 2.01 ** 2, cut, 1), false);
  assert.equal(pairExists(false, 2.0 ** 2, cut, 1), true);
});

test('compactActive: stable partition of every array alike, strides and plain arrays', () => {
  // slots 2..6 of a longer row; keep the 2nd and 4th
  const xyz = Float64Array.from({ length: 24 }, (_, k) => k);
  const src = Int32Array.from([90, 91, 10, 11, 12, 13, 14, 99]);
  const obj = ['a', 'b', 'p', 'q', 'r', 's', 't', 'z'];
  const keep = Uint8Array.from([0, 1, 0, 1, 0]);
  const na = compactActive(keep, 2, 5, [{ data: xyz, stride: 3 }, { data: src }, { data: obj }]);
  assert.equal(na, 2);
  assert.deepEqual(Array.from(src), [90, 91, 11, 13, 10, 12, 14, 99]);
  assert.deepEqual(obj, ['a', 'b', 'q', 's', 'p', 'r', 't', 'z']);
  // corner 11 was slot 3 → xyz 9..11, now at slot 2 → xyz 6..8
  assert.deepEqual(Array.from(xyz.subarray(6, 9)), [9, 10, 11]);
  assert.deepEqual(Array.from(xyz.subarray(9, 12)), [15, 16, 17]);
  assert.deepEqual(Array.from(xyz.subarray(12, 15)), [6, 7, 8]);
  // untouched outside the row
  assert.deepEqual(Array.from(xyz.subarray(0, 6)), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(xyz.subarray(21, 24)), [21, 22, 23]);
  // compacting again with everything kept restores nothing and moves nothing
  const all = Uint8Array.from([1, 1, 1, 1, 1]);
  assert.equal(compactActive(all, 2, 5, [{ data: src }]), 5);
  assert.deepEqual(Array.from(src), [90, 91, 11, 13, 10, 12, 14, 99]);
  // grows its scratch for a long row
  const big = Int32Array.from({ length: 500 }, (_, k) => k);
  const keepBig = Uint8Array.from({ length: 500 }, (_, k) => (k % 2));
  assert.equal(compactActive(keepBig, 0, 500, [{ data: big }]), 250);
  assert.equal(big[0], 1);
  assert.equal(big[249], 499);
  assert.equal(big[250], 0);
});

test('bondPairKey: one key per bond, from either end', () => {
  const n = 1000;
  assert.equal(bondPairKey(n, 3, 7, 1, 0, -1), bondPairKey(n, 7, 3, -1, 0, 1));
  assert.notEqual(bondPairKey(n, 3, 7, 1, 0, -1), bondPairKey(n, 3, 7, 0, 0, -1));
  assert.notEqual(bondPairKey(n, 3, 7, 0, 0, 0), bondPairKey(n, 3, 8, 0, 0, 0));
  // a bond of an atom with its own image: the same key either way round
  assert.equal(bondPairKey(n, 5, 5, 0, 1, 0), bondPairKey(n, 5, 5, 0, -1, 0));
  assert.equal(bondPairKey(n, 1, 2, 9, 0, 0), -1);
  assert.ok(Number.isSafeInteger(bondPairKey(200000, 199999, 199998, 7, -7, 7)));
});

test('mergeCorners: new corners plus held ones within the tolerance, one per atom image', () => {
  const fresh = [{ key: cornerKey(1, 0, 0, 0) }, { key: cornerKey(2, 0, 0, 0) }];
  const held = [
    { key: cornerKey(2, 0, 0, 0), distSq: 4, cutSq: 4 }, // already new
    { key: cornerKey(3, 0, 0, 0), distSq: 2.15 ** 2, cutSq: 4 }, // held
    { key: cornerKey(3, 1, 0, 0), distSq: 2.15 ** 2, cutSq: 4 }, // another image: its own corner
    { key: cornerKey(4, 0, 0, 0), distSq: 2.3 ** 2, cutSq: 4 }, // beyond the tolerance
    { key: cornerKey(5, 0, 0, 0), distSq: 1, cutSq: 0 }, // no cutoff: never held
  ];
  const out = mergeCorners(fresh, held, F2);
  assert.deepEqual(out.map((c) => c.key), ['1:0,0,0', '2:0,0,0', '3:0,0,0', '3:1,0,0']);
  // tol 0: a held corner must be within the plain cutoff
  assert.deepEqual(mergeCorners([], held, 1).map((c) => c.key), ['2:0,0,0']);
});

test('reservedCorners: previous corners broken now and within reach, once each', () => {
  const inUse = ['1:0,0,0', '2:0,0,0'];
  const out = reservedCorners(inUse, [
    { key: '2:0,0,0', distSq: 5, cutSq: 4, reachSq: 9 }, // in use
    { key: '3:0,0,0', distSq: 5, cutSq: 4, reachSq: 9 }, // broken, kept for return
    { key: '3:0,0,0', distSq: 5, cutSq: 4, reachSq: 9 }, // the same corner again
    { key: '4:0,0,0', distSq: 10, cutSq: 4, reachSq: 9 }, // out of reach
    { key: '5:0,0,0', distSq: 3, cutSq: 4, reachSq: 9 }, // within the cutoff: left out by the search
  ]);
  assert.deepEqual(out.map((c) => c.key), ['3:0,0,0']);
});

test('cageHeld: every hull edge within its cutoff × (1 + tol)', () => {
  assert.equal(cageHeld([4, 4.5], [4, 4], F2), true);
  assert.equal(cageHeld([4, 5], [4, 4], F2), false);
  assert.equal(cageHeld([], [], F2), false);
  assert.equal(cageHeld([1], [0], F2), false);
});
