// model/averageFrames.js: the mean of several frames behind the Files
// window's ≡ ▸ Average Structure — fractional positions at their nearest
// periodic image of the first frame, the cell component by component, the
// frames that cannot be averaged (different atom counts or species order),
// and each atom's largest move, which makes the action warn past
// LARGE_DISPLACEMENT of a cell axis.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameAverage, averageFrames, compositionMismatch, LARGE_DISPLACEMENT,
} from '../../docs/model/averageFrames.js';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const nearVec = (a, b, eps) => { assert.equal(a.length, b.length); a.forEach((x, k) => near(x, b[k], eps)); };
const cubic = (a) => [[a, 0, 0], [0, a, 0], [0, 0, a]];
const frame = (positions, lattice = cubic(4), elements = ['Na', 'Cl']) => ({ elements, lattice, positions });

test('positions and cell are the plain mean of frames that stay inside the cell', () => {
  const r = averageFrames([
    frame([[0.10, 0.20, 0.30], [0.50, 0.50, 0.50]], cubic(4.0)),
    frame([[0.20, 0.20, 0.30], [0.55, 0.45, 0.50]], cubic(4.2)),
    frame([[0.30, 0.20, 0.30], [0.45, 0.55, 0.50]], cubic(3.8)),
  ]);
  assert.equal(r.frameCount, 3);
  assert.deepEqual(r.elements, ['Na', 'Cl']);
  nearVec(r.positions[0], [0.2, 0.2, 0.3]);
  nearVec(r.positions[1], [0.5, 0.5, 0.5]);
  nearVec(r.lattice[0], [4, 0, 0]);
  nearVec(r.lattice[1], [0, 4, 0]);
  nearVec(r.lattice[2], [0, 0, 4]);
});

test('an atom crossing a cell face is averaged at its nearest image of the first frame', () => {
  // 0.98 -> 0.01 -> 0.03 is a small step through x = 1 (0.98, 1.01, 1.03),
  // mean 1.00667 = 0.00667 in the cell; a plain mean would put it at 0.34.
  const r = averageFrames([
    frame([[0.98, 0.5, 0.0], [0.5, 0.5, 0.5]]),
    frame([[0.01, 0.5, 0.99], [0.5, 0.5, 0.5]]),
    frame([[0.03, 0.5, 0.02], [0.5, 0.5, 0.5]]),
  ]);
  nearVec(r.positions[0], [0.02 / 3, 0.5, 0.01 / 3], 1e-12);
  // And the other way round: from just above 0 down through the face.
  const back = averageFrames([
    frame([[0.01, 0.5, 0.5], [0.5, 0.5, 0.5]]),
    frame([[0.97, 0.5, 0.5], [0.5, 0.5, 0.5]]),
  ]);
  nearVec(back.positions[0], [0.99, 0.5, 0.5], 1e-12);
});

test('the result is wrapped into [0, 1)', () => {
  // Mean exactly on the face: 0.99 and 0.01 -> 1.0, which is 0 in the cell.
  const r = averageFrames([
    frame([[0.99, 0.0, 0.0], [0.5, 0.5, 0.5]]),
    frame([[0.01, 0.0, 0.0], [0.5, 0.5, 0.5]]),
  ]);
  for (const p of r.positions) for (const x of p) assert.ok(x >= 0 && x < 1, String(x));
  nearVec(r.positions[0], [0, 0, 0], 1e-12);
});

test('the first frame is the reference, also for a skewed cell that changes', () => {
  // Fractional minimum image does not depend on the cell, so it holds for a
  // monoclinic cell that breathes between frames too.
  const mono = (s) => [[4 * s, 0, 0], [0, 5 * s, 0], [-1 * s, 0, 6 * s]];
  const r = averageFrames([
    frame([[0.95, 0.05, 0.5], [0.25, 0.25, 0.25]], mono(1.0)),
    frame([[0.05, 0.95, 0.5], [0.25, 0.25, 0.25]], mono(1.1)),
  ]);
  nearVec(r.positions[0], [0.0, 0.0, 0.5], 1e-12);
  nearVec(r.positions[1], [0.25, 0.25, 0.25], 1e-12);
  nearVec(r.lattice[0], [4.2, 0, 0], 1e-12);
  nearVec(r.lattice[2], [-1.05, 0, 6.3], 1e-12);
});

test('what does not move stays exactly as it is, over many frames', () => {
  const lattice = [[5.4307, 0, 0], [0, 5.4307, 0], [0, 0, 5.4307]];
  const average = new FrameAverage();
  for (let i = 0; i < 1000; i++) {
    assert.equal(average.add(frame([[0.1, 0.2, 0.3], [0.7, 0.8, 0.9]], lattice)), null);
  }
  const r = average.result();
  assert.equal(r.frameCount, 1000);
  assert.deepEqual(r.lattice, lattice);
  assert.deepEqual(r.positions, [[0.1, 0.2, 0.3], [0.7, 0.8, 0.9]]);
});

test('a single frame averages to itself; no frame is an error', () => {
  const r = averageFrames([frame([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])]);
  assert.equal(r.frameCount, 1);
  assert.deepEqual(r.positions, [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  assert.match(averageFrames([]).error, /no frames/);
  assert.equal(new FrameAverage().result(), null);
});

test('different atom counts cannot be averaged, and say so', () => {
  const r = averageFrames([
    frame([[0, 0, 0], [0.5, 0.5, 0.5]]),
    frame([[0, 0, 0], [0.5, 0.5, 0.5], [0.25, 0.25, 0.25]], cubic(4), ['Na', 'Cl', 'Cl']),
  ]);
  assert.match(r.error, /same atoms in every frame: one has 2 atoms, another 3/);
});

test('the same atoms in a different order cannot be averaged, and say which', () => {
  const r = averageFrames([
    frame([[0, 0, 0], [0.5, 0.5, 0.5]], cubic(4), ['Na', 'Cl']),
    frame([[0, 0, 0], [0.5, 0.5, 0.5]], cubic(4), ['Cl', 'Na']),
  ]);
  assert.match(r.error, /same order .*atom 1 is Na in one and Cl in another/);
});

test('a rejected frame leaves the average as it was', () => {
  const average = new FrameAverage();
  average.add(frame([[0.1, 0.1, 0.1], [0.5, 0.5, 0.5]]));
  average.add(frame([[0.3, 0.1, 0.1], [0.5, 0.5, 0.5]]));
  assert.ok(average.add(frame([[0.9, 0.9, 0.9]], cubic(4), ['Na'])));
  assert.ok(average.add({ elements: ['Na', 'Cl'], lattice: cubic(4), positions: [[0, 0, 0]] }));
  const r = average.result();
  assert.equal(r.frameCount, 2);
  nearVec(r.positions[0], [0.2, 0.1, 0.1], 1e-12);
});

test('compositionMismatch: shared or equal arrays match, anything else names the difference', () => {
  const shared = ['Si', 'O', 'O'];
  assert.equal(compositionMismatch(shared, shared), null);
  assert.equal(compositionMismatch(shared, ['Si', 'O', 'O']), null);
  assert.match(compositionMismatch(shared, ['Si', 'O']), /3 atoms, another 2/);
  assert.match(compositionMismatch(shared, ['O', 'Si', 'O']), /atom 1 is Si in one and O in another/);
});

test('the first frame\'s mixed sites are kept; the input is not changed', () => {
  const species = { 0: [{ element: 'Fe', occupancy: 0.5 }, { element: 'Ni', occupancy: 0.5 }] };
  const first = { ...frame([[0.98, 0, 0], [0.5, 0.5, 0.5]], cubic(4), ['Fe', 'O']), species };
  const second = frame([[0.02, 0, 0], [0.5, 0.5, 0.5]], cubic(4), ['Fe', 'O']);
  const r = averageFrames([first, second]);
  assert.deepEqual(r.species, species);
  assert.deepEqual(first.positions, [[0.98, 0, 0], [0.5, 0.5, 0.5]]);
  assert.deepEqual(second.positions, [[0.02, 0, 0], [0.5, 0.5, 0.5]]);
  nearVec(r.positions[0], [0, 0, 0], 1e-12);
});

test('the warning threshold is a tenth of a cell axis', () => {
  assert.equal(LARGE_DISPLACEMENT, 0.1);
});

test('each atom\'s largest move: fraction, axis, Å in that frame\'s cell, the frame and its tag', () => {
  const ortho = [[4, 0, 0], [0, 5, 0], [0, 0, 6]];
  const average = new FrameAverage();
  average.add(frame([[0.10, 0.50, 0.50], [0.50, 0.50, 0.50]], ortho), 'f0');
  average.add(frame([[0.20, 0.50, 0.50], [0.50, 0.55, 0.50]], ortho), 'f1');
  average.add(frame([[0.40, 0.45, 0.50], [0.50, 0.50, 0.48]], ortho), 'f2'); // Na: 0.3 of a, -0.05 of b
  average.add(frame([[0.25, 0.50, 0.50], [0.50, 0.50, 0.50]], ortho), 'f3');
  const moves = average.largeMoves();
  assert.equal(moves.length, 1, JSON.stringify(moves));
  const [na] = moves;
  assert.equal(na.atom, 0);
  assert.equal(na.axis, 'a');
  near(na.fraction, 0.3, 1e-12);
  near(na.distance, Math.hypot(0.3 * 4, -0.05 * 5), 1e-12);
  assert.equal(na.frame, 2);
  assert.equal(na.where, 'f2');
  // Cl moved at most 0.05 of b: under the threshold, but it is tracked.
  const all = average.largeMoves(0);
  assert.equal(all.length, 2);
  assert.equal(all[1].atom, 1);
  assert.equal(all[1].axis, 'b');
  near(all[1].fraction, 0.05, 1e-12);
  near(all[1].distance, 0.25, 1e-12);
  assert.equal(all[1].where, 'f1');
});

test('moves are measured through the cell face, like the mean', () => {
  // 0.95 -> 0.05 is a step of 0.1 through x = 1, not 0.9 back across the cell;
  // exactly 0.1 is not over the threshold, 0.15 is.
  const r = averageFrames([
    frame([[0.95, 0.5, 0.5], [0.5, 0.5, 0.5]]),
    frame([[0.05, 0.5, 0.5], [0.5, 0.5, 0.5]]),
  ]);
  assert.equal(r.moves.length, 0, JSON.stringify(r.moves));
  const over = averageFrames([
    frame([[0.95, 0.5, 0.5], [0.5, 0.5, 0.5]]),
    frame([[0.10, 0.5, 0.5], [0.5, 0.5, 0.5]]),
  ]);
  assert.equal(over.moves.length, 1);
  near(over.moves[0].fraction, 0.15, 1e-12);
  near(over.moves[0].distance, 0.6, 1e-12);
  assert.equal(over.moves[0].frame, 1);
});

test('the threshold applies to each axis on its own, not to the length', () => {
  // 0.08 along a, b and c: 0.139 of a body diagonal, but no axis over 0.1.
  const r = averageFrames([
    frame([[0.2, 0.2, 0.2], [0.5, 0.5, 0.5]]),
    frame([[0.28, 0.28, 0.28], [0.5, 0.5, 0.5]]),
  ]);
  assert.deepEqual(r.moves, []);
});

test('large moves come worst first, each with its own worst frame', () => {
  const r = averageFrames([
    frame([[0.1, 0.1, 0.1], [0.5, 0.5, 0.5], [0.3, 0.3, 0.3]], cubic(4), ['Na', 'Cl', 'Cl']),
    frame([[0.3, 0.1, 0.1], [0.5, 0.5, 0.5], [0.3, 0.3, 0.8]], cubic(4), ['Na', 'Cl', 'Cl']),
    frame([[0.1, 0.1, 0.1], [0.5, 0.9, 0.5], [0.3, 0.3, 0.3]], cubic(4), ['Na', 'Cl', 'Cl']),
  ]);
  assert.deepEqual(r.moves.map((m) => [m.atom, m.axis, m.where]), [[2, 'c', 1], [1, 'b', 2], [0, 'a', 1]]);
  near(r.moves[0].fraction, 0.5, 1e-12);
  near(r.moves[1].fraction, 0.4, 1e-12);
  near(r.moves[2].fraction, 0.2, 1e-12);
  // A larger threshold keeps the order and drops the rest.
  assert.deepEqual(averageFrames([
    frame([[0.1, 0.1, 0.1], [0.5, 0.5, 0.5], [0.3, 0.3, 0.3]], cubic(4), ['Na', 'Cl', 'Cl']),
    frame([[0.3, 0.1, 0.1], [0.5, 0.5, 0.5], [0.3, 0.3, 0.8]], cubic(4), ['Na', 'Cl', 'Cl']),
    frame([[0.1, 0.1, 0.1], [0.5, 0.9, 0.5], [0.3, 0.3, 0.3]], cubic(4), ['Na', 'Cl', 'Cl']),
  ], 0.3).moves.map((m) => m.atom), [2, 1]);
});

test('a quiet trajectory and a single frame have no large moves', () => {
  const quiet = averageFrames([
    frame([[0.10, 0.20, 0.30], [0.5, 0.5, 0.5]]),
    frame([[0.15, 0.25, 0.25], [0.55, 0.45, 0.5]]),
    frame([[0.05, 0.15, 0.35], [0.45, 0.55, 0.5]]),
  ]);
  assert.deepEqual(quiet.moves, []);
  assert.deepEqual(averageFrames([frame([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])]).moves, []);
});
