// Colour-bar ticks (docs/utils/ColorBarTicks.js): round values between Min
// and Max, printed with the decimals their spacing needs. They used to sit
// at 1/4, 1/2 and 3/4 of the bar with two decimals, so a 0 .. 0.0101 bar of
// small forces read "0, 0.01, 0.01".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTicks, formatTick, formatLimit, ticksClearOfFields } from '../../docs/utils/ColorBarTicks.js';

const labels = (min, max, scale = 'linear') => computeTicks(min, max, scale).map((t) => t.label);

test('small linear range: distinct round labels (was "0, 0.01, 0.01")', () => {
  const l = labels(0, 0.0101);
  assert.deepEqual(l, ['0.0025', '0.005', '0.0075']);
  assert.equal(new Set(l).size, l.length);
});

test('linear: round steps, placed at their true position', () => {
  assert.deepEqual(labels(0, 2), ['0.5', '1', '1.5']);
  assert.deepEqual(labels(0, 6), ['2', '4']);
  const t = computeTicks(-0.3, 1, 'linear');
  assert.deepEqual(t.map((x) => x.label), ['0', '0.5']);
  assert.ok(Math.abs(t[0].frac - 0.3 / 1.3) < 1e-9);
});

test('no tick next to the Min/Max fields', () => {
  for (const [a, b, s] of [[0, 0.011, 'linear'], [0.6, 3.4, 'linear'], [0.0005, 20, 'log'], [12, 130, 'log'], [2e-6, 0.5, 'log']]) {
    for (const t of computeTicks(a, b, s)) assert.ok(t.frac >= 0.12 - 1e-9 && t.frac <= 0.88 + 1e-9, `${a}..${b} ${s}: ${t.label}@${t.frac}`);
  }
});

test('log over several decades: the decades, in one notation per bar', () => {
  assert.deepEqual(labels(0.0005, 20, 'log'), ['0.01', '0.1', '1']);
  assert.deepEqual(labels(0.00005, 0.011, 'log'), ['1e-4', '1e-3']);
  assert.deepEqual(labels(2e-6, 0.5, 'log'), ['1e-5', '1e-4', '1e-2', '1e-1']);
  assert.deepEqual(labels(1, 1e7, 'log'), ['1e1', '1e3', '1e4', '1e6']);
});

test('log with fewer than two decades inside: 1, 2, 5 steps', () => {
  assert.deepEqual(labels(0.02, 0.5, 'log'), ['0.05', '0.1', '0.2']);
  assert.deepEqual(labels(12, 130, 'log'), ['20', '50']);
});

test('log within a decade: round values at their log position', () => {
  const t = computeTicks(0.005, 0.01, 'log');
  assert.deepEqual(t.map((x) => x.label), ['0.006', '0.008']);
  assert.ok(Math.abs(t[0].frac - Math.log10(0.006 / 0.005) / Math.log10(2)) < 1e-9);
});

test('formatTick: decimals from the step, e-notation only for tiny or huge values', () => {
  assert.equal(formatTick(0.0075, 0.0025), '0.0075');
  assert.equal(formatTick(0.005, 0.0025), '0.005');
  assert.equal(formatTick(1, 0.5), '1');
  assert.equal(formatTick(0.00015, 0.00005), '1.5e-4');
  assert.equal(formatTick(500000, 250000), '5e5');
  assert.equal(formatTick(0.010025, 0.000025), '0.010025');
  // Without a step: three significant figures.
  assert.equal(formatTick(0.0101), '0.0101');
  assert.equal(formatTick(5.678), '5.68');
  assert.equal(formatTick(123.4), '123');
  assert.equal(formatTick(0), '0');
});

test('an empty or reversed range has no ticks', () => {
  assert.deepEqual(computeTicks(1, 1, 'linear'), []);
  assert.deepEqual(computeTicks(2, 1, 'log'), []);
});

test('fewer zeros: below 0.001 in e-notation, one notation per bar', () => {
  // A typed 1e-4 .. 1e-3 bar printed 0.0002, 0.0004, 0.0006 (the last two touching).
  assert.deepEqual(labels(1e-4, 1e-3, 'log'), ['2e-4', '5e-4']);
  assert.deepEqual(labels(5e-5, 0.02, 'log'), ['2e-4', '1e-3', '5e-3']);
  assert.deepEqual(labels(0, 0.0002), ['5e-5', '1e-4', '1.5e-4']);
  for (const [a, b, sc] of [[1e-4, 1e-3, 'log'], [5e-5, 0.02, 'log'], [0, 0.0002, 'linear'], [2e-6, 0.5, 'log']]) {
    for (const l of labels(a, b, sc)) assert.ok(!/0\.000/.test(l), `${a}..${b}: ${l}`);
  }
});

test('formatLimit: the Min/Max fields when the program sets them', () => {
  assert.equal(formatLimit(0.00005), '5e-5');
  assert.equal(formatLimit(0.0002), '2e-4');
  assert.equal(formatLimit(0.001), '0.001');
  assert.equal(formatLimit(0.011), '0.011');
  assert.equal(formatLimit(3.4), '3.4');
  assert.equal(formatLimit(0), '0');
  assert.equal(formatLimit(200000), '2e5');
  assert.equal(formatLimit(0.30000000000000004), '0.3');
});

test('ticksClearOfFields: drops labels touching a field or each other', () => {
  const ticks = [{ frac: 0.1, label: 'a' }, { frac: 0.5, label: 'b' }, { frac: 0.53, label: 'c' }, { frac: 0.9, label: 'd' }];
  const kept = ticksClearOfFields(ticks, { length: 300, minSpan: [-25, 40], maxSpan: [270, 330], labelSize: () => 20 });
  // a (20..40) touches the min field, c (149..169) touches b (140..160), d (260..280) the max field.
  assert.deepEqual(kept.map((t) => t.label), ['b']);
  // Decades (rank 0) are kept before a 2 or 5 next to them, whatever the order.
  const ranked = [{ frac: 0.5, label: 'x', rank: 1 }, { frac: 0.53, label: 'y', rank: 0 }];
  assert.deepEqual(ticksClearOfFields(ranked, { length: 300, minSpan: [-25, 25], maxSpan: [275, 325], labelSize: () => 20 }).map((t) => t.label), ['y']);
  // Hidden bar (length 0): nothing dropped.
  assert.equal(ticksClearOfFields(ticks, { length: 0, minSpan: [0, 0], maxSpan: [0, 0], labelSize: () => 20 }).length, 4);
});

