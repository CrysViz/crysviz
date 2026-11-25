// computeAutoRange (docs/utils/AutoRange.js): the colour bars' Auto Range.
// On a log-scale bar the range is taken over the positive values and padded
// in decades, so it starts just below the smallest value; it used to pad
// linearly, clamp at 0 and leave every log bar to swap that 0 for 0.01.
// Both scales round out to readable numbers: linear to a grid of a tenth of
// the span, log to 1, 2 or 5 × 10^k.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAutoRange, logScaleFloor, niceFloor125, niceCeil125 } from '../../docs/utils/AutoRange.js';

test('1-2-5 rounding', () => {
  assert.equal(niceFloor125(0.00101), 0.001);
  assert.equal(niceFloor125(0.3), 0.2);
  assert.equal(niceFloor125(7), 5);
  assert.equal(niceFloor125(0.01), 0.01);
  assert.equal(niceCeil125(0.0131), 0.02);
  assert.equal(niceCeil125(0.01), 0.01);
  assert.equal(niceCeil125(25.1), 50);
  assert.equal(niceCeil125(6), 10);
});

test('linear: pads 20% of the span, floored at 0 for magnitudes, rounded out', () => {
  assert.deepEqual(computeAutoRange([1, 2, 3]), { min: 0.6, max: 3.4 });
  assert.deepEqual(computeAutoRange([0.01, 5], 0.2, { clampMinAtZero: true }), { min: 0, max: 6 });
  // Small forces of a relaxed structure: 0 .. 0.0101 before, 0 .. 0.011 now.
  assert.deepEqual(computeAutoRange([0.0001, 0.0084], 0.2, { clampMinAtZero: true }), { min: 0, max: 0.011 });
  // No float noise from the grid.
  assert.deepEqual(computeAutoRange([0.1, 0.7]), { min: -0.05, max: 0.85 });
});

test('log: padded in decades from the smallest positive value, rounded to 1-2-5', () => {
  // 0.001 .. 10 is four decades; 10% pads 0.4 decade (3.98e-4, 25.1), then out to 1-2-5.
  const r = computeAutoRange([0.001, 0.05, 10], 0.2, { clampMinAtZero: true, log: true });
  assert.deepEqual(r, { min: 0.0002, max: 50 });
  // Forces below the old fixed 0.01 floor are inside the range now.
  assert.ok(r.min < 0.001);
});

test('log: zeros and non-finite values are left out, not clamped to', () => {
  assert.deepEqual(computeAutoRange([0, NaN, 0.02, 0.2], 0.2, { clampMinAtZero: true, log: true }), { min: 0.01, max: 0.5 });
});

test('log: a single value gets at least 0.05 decade either side', () => {
  assert.deepEqual(computeAutoRange([2.6, 2.6], 0.2, { clampMinAtZero: true, log: true }), { min: 2, max: 5 });
});

test('log: numerical noise far below the largest value does not stretch the bar', () => {
  // 1e-9 next to 0.1: the range covers four decades of data below 0.1.
  assert.deepEqual(computeAutoRange([1e-9, 0.01, 0.1], 0.2, { log: true }), { min: 0.000002, max: 0.5 });
});

test('log with nothing positive falls back to the linear range', () => {
  assert.deepEqual(computeAutoRange([-3, -1], 0.2, { log: true }), { min: -3.4, max: -0.6 });
  assert.equal(computeAutoRange([NaN], 0.2, { log: true }), null);
});

test('logScaleFloor: where the log Auto Range starts, else three decades below max', () => {
  // A linear 0 .. 0.011 switched to log used to become 0.01 .. 0.011.
  assert.equal(logScaleFloor(0.011, [0.0001, 0.0084]), 0.00005);
  assert.equal(logScaleFloor(2), 0.002);
  assert.equal(logScaleFloor(2, [0, 0]), 0.002);
  // Data above a typed max: still below max.
  assert.equal(logScaleFloor(0.5, [1, 2]), 0.0005);
});
