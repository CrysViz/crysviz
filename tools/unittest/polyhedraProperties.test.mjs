// Unit tests for the per-polyhedron property kernels (docs/model/polyhedraProperties.js):
// distortion indices, convex-hull volume and the tilt/rotation fit, on the flat
// table the renderer's per-frame colouring will hand them.
// Run: npm run test:unit   (or: node --test tools/unittest/polyhedraProperties.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLYHEDRA_PROPERTIES, computePolyhedraProperty, polyhedronOrientation,
  convexHullVolume, bondLengthDistortion, regularCircumradius,
  computePolyhedraOrientations, meanOrientationFrame, alignFrameTo, cellReferenceFrame,
  convexHullTriangles, polyhedronAxes,
} from '../../docs/model/polyhedraProperties.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (eps ${eps})`);
const D = Math.PI / 180;
const CUBIC = [[4, 0, 0], [0, 4, 0], [0, 0, 4]];

/** Rodrigues rotation matrix (rows) for unit axis n and angle (rad). */
function rotMat(n, ang) {
  const l = Math.hypot(...n); const [x, y, z] = n.map((v) => v / l);
  const c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}
const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const apply = (R, v) => R.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
/** Independent matrix log: rotation vector (deg) of R. */
function rotVecDeg(R) {
  const th = Math.acos(Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)));
  const ax = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
  const f = th / (2 * Math.sin(th));
  return [...ax.map((v) => v * f / D), th / D];
}

const OCT = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const TET = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((v) => v.map((x) => x / Math.sqrt(3)));

/** Build a table from polyhedra [{center|null, verts}] (Float64 coordinates). */
function table(polys, lattice = CUBIC, extra = {}) {
  const count = polys.length;
  const vertStart = new Uint32Array(count), vertCount = new Uint32Array(count);
  const centerXYZ = new Float64Array(3 * count);
  let nv = 0;
  polys.forEach((p) => { nv += p.verts.length; });
  const vertXYZ = new Float64Array(3 * nv);
  let o = 0;
  polys.forEach((p, i) => {
    vertStart[i] = o; vertCount[i] = p.verts.length;
    const c = p.center ?? [NaN, NaN, NaN];
    centerXYZ.set(c, 3 * i);
    p.verts.forEach((v) => { vertXYZ.set(v, 3 * o); o++; });
  });
  return { count, centerXYZ, vertStart, vertCount, vertXYZ, lattice, ...extra };
}
const prop = (id, t) => computePolyhedraProperty(id, t, new Float64Array(t.count));
const all = (t) => Object.fromEntries(POLYHEDRA_PROPERTIES.map((d) => [d.id, prop(d.id, t)[0]]));
/** Place a unit-shape at centre c, scaled by r, after rotation R. */
const place = (shape, c, r = 2, R = null) => shape.map((v) => {
  const w = R ? apply(R, v) : v;
  return [c[0] + r * w[0], c[1] + r * w[1], c[2] + r * w[2]];
});

test('ideal octahedron aligned with a cubic cell: zero distortion, zero tilt', () => {
  const c = [10.3, -4.1, 7.7];
  const v = all(table([{ center: c, verts: place(OCT, c) }]));
  near(v.volume, (4 / 3) * 8, 1e-12, 'volume');
  near(v.bld, 0, 1e-15, 'bld');
  near(v.angleVariance, 0, 1e-20, 'angleVariance');
  near(v.quadraticElongation, 1, 1e-14, 'elongation');
  for (const k of ['tiltA', 'tiltB', 'tiltC', 'rotation']) near(v[k], 0, 1e-9, k);
});

test('rotations about single cell axes are recovered exactly, with the right-hand sign', () => {
  const c = [1, 2, 3];
  for (const [axis, comp] of [[[1, 0, 0], 'tiltA'], [[0, 1, 0], 'tiltB'], [[0, 0, 1], 'tiltC']]) {
    for (const deg of [5, -7, 20]) {
      const v = all(table([{ center: c, verts: place(OCT, c, 2, rotMat(axis, deg * D)) }]));
      near(v[comp], deg, 1e-6, comp);
      near(v.rotation, Math.abs(deg), 1e-6, 'rotation');
      for (const k of ['tiltA', 'tiltB', 'tiltC']) if (k !== comp) near(v[k], 0, 1e-6, k);
      near(v.bld, 0, 1e-12); near(v.angleVariance, 0, 1e-9); near(v.quadraticElongation, 1, 1e-12);
    }
  }
  // Sign: +10° about c turns the +a vertex towards +b.
  const R = rotMat([0, 0, 1], 10 * D);
  assert.ok(apply(R, [1, 0, 0])[1] > 0);
});

test('composite rotations: 5° about a then 3° about c, and 10° about an arbitrary axis', () => {
  const c = [0, 0, 0];
  const R1 = mul(rotMat([0, 0, 1], 3 * D), rotMat([1, 0, 0], 5 * D));
  const R2 = rotMat([0.3, -0.5, 0.81], 10 * D);
  for (const R of [R1, R2]) {
    const exp = rotVecDeg(R);
    const v = all(table([{ center: c, verts: place(OCT, c, 2, R) }]));
    near(v.tiltA, exp[0], 1e-6, 'tiltA'); near(v.tiltB, exp[1], 1e-6, 'tiltB');
    near(v.tiltC, exp[2], 1e-6, 'tiltC'); near(v.rotation, exp[3], 1e-6, 'rotation');
  }
  // First order: the components are close to the individual tilts.
  const v = all(table([{ center: c, verts: place(OCT, c, 2, R1) }]));
  near(v.tiltA, 5, 0.01); near(v.tiltC, 3, 0.01); near(v.rotation, Math.hypot(5, 3), 0.01);
  near(rotVecDeg(R2)[3], 10, 1e-9);
});

test('stretched octahedron (one axis ×1.1): hand-computed bld and elongation, no tilt', () => {
  const verts = [[1.1, 0, 0], [-1.1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const v = all(table([{ center: [0, 0, 0], verts }]));
  // Distances 1.1,1.1,1,1,1,1: mean 6.2/6; Δ = (2·0.2/3 + 4·0.1/3)/6 / (6.2/6) = 4/93.
  near(v.bld, 4 / 93, 1e-14, 'bld');
  // V = (4/3)·1.1·1·1, l0 = (3V/4)^(1/3) = 1.1^(1/3), ⟨λ⟩ = (2·1.21 + 4)/6 / 1.1^(2/3).
  near(v.volume, 4.4 / 3, 1e-12, 'volume');
  near(v.quadraticElongation, (6.42 / 6) / Math.pow(1.1, 2 / 3), 1e-12, 'elongation');
  near(v.angleVariance, 0, 1e-12, 'angles all 90°');
  for (const k of ['tiltA', 'tiltB', 'tiltC', 'rotation']) near(v[k], 0, 1e-9, k);
});

test('off-centre cation does not register as tilt (axes from vertex differences)', () => {
  const v = all(table([{ center: [0.15, -0.05, 0.1], verts: place(OCT, [0, 0, 0]) }]));
  for (const k of ['tiltA', 'tiltB', 'tiltC', 'rotation']) near(v[k], 0, 1e-9, k);
  assert.ok(v.bld > 0);
});

test('tetrahedron: ideal, rotated, distorted', () => {
  const c = [2, 2, 2];
  let v = all(table([{ center: c, verts: place(TET, c, 1.6) }]));
  const r = 1.6, edge = r * Math.sqrt(8 / 3);
  near(v.volume, edge ** 3 / (6 * Math.SQRT2), 1e-12, 'volume');
  near(regularCircumradius(4, v.volume), r, 1e-12, 'circumradius');
  near(v.bld, 0, 1e-15); near(v.angleVariance, 0, 1e-12); near(v.quadraticElongation, 1, 1e-12);
  for (const k of ['tiltA', 'tiltB', 'tiltC', 'rotation']) near(v[k], 0, 1e-9, k);

  const R = rotMat([1, 2, -0.5], 12 * D), exp = rotVecDeg(R);
  v = all(table([{ center: c, verts: place(TET, c, 1.6, R) }]));
  near(v.tiltA, exp[0], 1e-6); near(v.tiltB, exp[1], 1e-6); near(v.tiltC, exp[2], 1e-6); near(v.rotation, 12, 1e-6);

  // One corner pushed out: angles unchanged, distances change.
  const verts = place(TET, c, 1.6); verts[0] = place([TET[0]], c, 1.8)[0];
  v = all(table([{ center: c, verts }]));
  near(v.angleVariance, 0, 1e-12);
  const mean = (1.8 + 3 * 1.6) / 4;
  near(v.bld, (Math.abs(1.8 - mean) + 3 * Math.abs(1.6 - mean)) / 4 / mean, 1e-14, 'bld');
  assert.ok(v.quadraticElongation > 1);
  // Angle variance of a squashed tetrahedron, by hand: z-compressed (1,1,s).
  const sq = [[1, 1, 0.8], [1, -1, -0.8], [-1, 1, -0.8], [-1, -1, 0.8]];
  v = all(table([{ center: [0, 0, 0], verts: sq }]));
  const ang = (a, b) => Math.acos((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))) / D;
  let s2 = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) s2 += (ang(sq[i], sq[j]) - 109.4712206) ** 2;
  near(v.angleVariance, s2 / 5, 1e-9, 'TAV');
});

test('octahedral angle variance by hand (12 cis angles, m − 1 = 11)', () => {
  const verts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0.2, 0, 1], [-0.2, 0, -1]];
  const v = all(table([{ center: [0, 0, 0], verts }]));
  const ang = (a, b) => Math.acos((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))) / D;
  const trans = new Set(['0-1', '2-3', '4-5']);
  let s2 = 0;
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if (!trans.has(`${i}-${j}`)) s2 += (ang(verts[i], verts[j]) - 90) ** 2;
  near(v.angleVariance, s2 / 11, 1e-9);
});

test('other coordination numbers: CN-specific properties NaN, volume and bld still computed', () => {
  // Cube (CN8): square faces exercise the coplanar fan triangulation.
  const cube = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) cube.push([x, y, z]);
  let v = all(table([{ center: [0, 0, 0], verts: cube }]));
  near(v.volume, 8, 1e-12, 'cube volume');
  near(v.bld, 0, 1e-15);
  for (const k of ['angleVariance', 'quadraticElongation', 'tiltA', 'tiltB', 'tiltC', 'rotation']) assert.ok(Number.isNaN(v[k]), k);
  // Square pyramid (CN5) and a trigonal prism with a collinear-free quad set.
  v = all(table([{ center: [0, 0, 0.2], verts: [[1, 1, 0], [1, -1, 0], [-1, -1, 0], [-1, 1, 0], [0, 0, 1.5]] }]));
  near(v.volume, 4 * 1.5 / 3, 1e-12, 'pyramid');
  assert.ok(Number.isNaN(v.angleVariance));
  // Cuboctahedron (CN12): V = 5√2/3 a³ for edge a = √2 (vertices (±1,±1,0) perms).
  const cubo = [];
  for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) cubo.push([s1, s2, 0], [s1, 0, s2], [0, s1, s2]);
  v = all(table([{ center: [0, 0, 0], verts: cubo }]));
  near(v.volume, (5 * Math.SQRT2 / 3) * Math.SQRT2 ** 3, 1e-12, 'cuboctahedron');
  // Square with collinear midpoints on its edges (prism of an 8-point square).
  const sq8 = [];
  for (const z of [0, 1]) for (const [x, y] of [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]) sq8.push([x, y, z]);
  near(convexHullVolume(Float64Array.from(sq8.flat()), 0, 16), 4, 1e-12, 'collinear edge points');
  // Flat and too-small sets.
  assert.ok(Number.isNaN(convexHullVolume(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 0, 4)));
  assert.ok(Number.isNaN(convexHullVolume(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 0, 3)));
});

test('hull volume with near-coplanar corners: no double-counted faces', () => {
  // A cube with face-centre points jittered by ~the tolerance. A per-triple
  // "is this a hull face" test decided coplanarity differently for different
  // triples of one face and counted slivers twice (up to 30% too large); the
  // incremental hull keeps one consistent surface.
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (const eps of [0, 1e-12, 1e-9, 1e-7, 1e-5, 1e-3]) {
    for (let t = 0; t < 300; t++) {
      const P = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) P.push([x + eps * rnd() + 30, y + eps * rnd(), z + eps * rnd()]);
      P.push([30, 0, 1 + eps * rnd()], [31 + eps * rnd(), 0.3, 0.2], [30.4, -1 + eps * rnd(), -0.6]);
      near(convexHullVolume(Float64Array.from(P.flat()), 0, P.length), 8, 30 * eps + 1e-12, `eps ${eps}`);
    }
  }
});

test('non-orthogonal lattice: tilt frame is â, b⊥â, â×b̂', () => {
  // a along (cos30°, sin30°, 0), b at γ = 110° from a in the xy-plane, c skew.
  const ca = [Math.cos(30 * D), Math.sin(30 * D), 0];
  const cb = [Math.cos(140 * D), Math.sin(140 * D), 0];
  const lattice = [ca.map((x) => 5 * x), cb.map((x) => 6 * x), [0.8, 0.3, 7]];
  const fa = ca, fb = [Math.cos(120 * D), Math.sin(120 * D), 0], fc = [0, 0, 1];
  // Ideal octahedron along the frame, then rotated 6° about b̂' and 4° about ĉ'.
  const ideal = OCT.map((u) => [0, 1, 2].map((k) => u[0] * fa[k] + u[1] * fb[k] + u[2] * fc[k]));
  const Rf = mul(rotMat(fc, 4 * D), rotMat(fb, 6 * D));
  const c = [3, 1, 2];
  const v = all(table([{ center: c, verts: place(ideal, c, 2, Rf) }], lattice));
  // Expected: the rotation vector of Rf expressed in the frame.
  const ex = rotVecDeg(Rf);
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  near(v.tiltA, dot(ex, fa), 1e-6, 'tiltA'); near(v.tiltB, dot(ex, fb), 1e-6, 'tiltB');
  near(v.tiltC, dot(ex, fc), 1e-6, 'tiltC'); near(v.rotation, ex[3], 1e-6, 'rotation');
  near(v.tiltB, 6, 0.01); near(v.tiltC, 4, 0.01);
  // An explicit frame override replaces the lattice frame.
  const w = all(table([{ center: c, verts: place(OCT, c, 2) }], lattice, { frame: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }));
  near(w.rotation, 0, 1e-9);
});

test('cage (no centre): centre-based properties NaN, volume computed; mixed tables', () => {
  const t = table([
    { center: null, verts: place(OCT, [0, 0, 0]) },
    { center: [5, 5, 5], verts: place(OCT, [5, 5, 5], 2, rotMat([0, 0, 1], 8 * D)) },
  ]);
  for (const d of POLYHEDRA_PROPERTIES) {
    const out = prop(d.id, t);
    if (d.needsCenter) assert.ok(Number.isNaN(out[0]), d.id); else near(out[0], 32 / 3, 1e-12, d.id);
    assert.ok(Number.isFinite(out[1]), `${d.id} second`);
  }
  near(prop('tiltC', t)[1], 8, 1e-6);
  // centerXYZ absent altogether.
  const noC = { ...t, centerXYZ: null };
  assert.ok(Number.isNaN(prop('bld', noC)[1]));
  near(prop('volume', noC)[1], 32 / 3, 1e-12);
});

test('vertex order permutation invariance', () => {
  const R = rotMat([0.2, 0.9, -0.4], 9 * D);
  const verts = place([[1.05, 0, 0], [-0.97, 0, 0], [0, 1.02, 0], [0, -1, 0.03], [0.01, 0, 1.1], [0, 0, -0.95]], [1, 1, 1], 2, R);
  const tverts = place([[1.1, 1, 1], [1, -1, -1], [-1, 1.05, -1], [-1, -1, 0.9]], [0, 0, 0], 1, R);
  const base = all(table([{ center: [1, 1, 1], verts }, { center: [0, 0, 0], verts: tverts }]));
  const baseT = Object.fromEntries(POLYHEDRA_PROPERTIES.map((d) => [d.id, prop(d.id, table([{ center: [0, 0, 0], verts: tverts }]))[0]]));
  const perms6 = [[5, 3, 1, 0, 2, 4], [2, 0, 4, 5, 1, 3], [1, 0, 3, 2, 5, 4]];
  for (const pm of perms6) {
    const v = all(table([{ center: [1, 1, 1], verts: pm.map((i) => verts[i]) }]));
    for (const k of Object.keys(base)) near(v[k], base[k], 1e-9, k);
  }
  for (const pm of [[3, 2, 1, 0], [1, 3, 0, 2]]) {
    const v = all(table([{ center: [0, 0, 0], verts: pm.map((i) => tverts[i]) }]));
    for (const k of Object.keys(baseT)) near(v[k], baseT[k], 1e-9, k);
  }
});

test('bondLengthDistortion kernel honours start offsets', () => {
  const xyz = new Float64Array([9, 9, 9, 1, 0, 0, -2, 0, 0]);
  near(bondLengthDistortion(0, 0, 0, xyz, 1, 2), (0.5 + 0.5) / 2 / 1.5, 1e-15);
});

test('polyhedronOrientation single-polyhedron helper', () => {
  const t = table([{ center: [0, 0, 0], verts: place(OCT, [0, 0, 0], 2, rotMat([1, 0, 0], -4 * D)) }]);
  const res = polyhedronOrientation(t, 0, new Float64Array(4));
  near(res[0], -4, 1e-6); near(res[3], 4, 1e-6);
});

test('batch of 10 000 random octahedra (Float32 input) in a generous time bound', () => {
  // The kernels use module-level scratch only; nothing is allocated per
  // polyhedron (checked by reading the code: no array literals, closures or
  // `new` inside compute paths). This test is a sanity bound, not a benchmark.
  const N = 10000;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const polys = [];
  const rots = [];
  for (let i = 0; i < N; i++) {
    const c = [rnd() * 100, rnd() * 100, rnd() * 100];
    const ax = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const ang = rnd() * 20 * D;
    rots.push(ang / D);
    polys.push({ center: c, verts: place(OCT, c, 1.9 + 0.2 * rnd(), rotMat(ax, ang)) });
  }
  const t64 = table(polys);
  const t = { ...t64, vertXYZ: Float32Array.from(t64.vertXYZ), centerXYZ: Float32Array.from(t64.centerXYZ) };
  const out = new Float32Array(N);
  const t0 = performance.now();
  for (const d of POLYHEDRA_PROPERTIES) computePolyhedraProperty(d.id, t, out);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms} ms`);
  computePolyhedraProperty('rotation', t, out);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - rots[i]));
  assert.ok(maxErr < 1e-2, `float32 rotation error ${maxErr}°`);
  computePolyhedraProperty('quadraticElongation', t, out);
  for (let i = 0; i < N; i++) near(out[i], 1, 1e-4, 'elongation');
});

test('unknown id throws; registry entries are well-formed', () => {
  assert.throws(() => computePolyhedraProperty('nope', table([])));
  const ids = new Set();
  for (const d of POLYHEDRA_PROPERTIES) {
    assert.ok(!ids.has(d.id)); ids.add(d.id);
    assert.equal(d.kind, 'scalar');
    assert.equal(typeof d.compute, 'function');
  }
});


// ---------------------------------------------------------------------------
// Batch orientation fill, per-row frames, the automatic (mean) frame
// ---------------------------------------------------------------------------

test('computePolyhedraOrientations fills the four columns as the single-column path does', () => {
  const polys = [];
  for (let i = 0; i < 40; i++) {
    const c = [i * 4.1, (i % 3) * 3.9, (i % 5) * 4.2];
    const R = rotMat([Math.sin(i), Math.cos(2 * i), 0.3 + (i % 4)], (i % 7 - 3) * 2.5 * D);
    polys.push({ center: c, verts: place(i % 2 ? OCT : TET, c, 2, R) });
  }
  polys.push({ center: null, verts: place(OCT, [0, 0, 0]) }); // cage: NaN
  polys.push({ center: [0, 0, 0], verts: place(OCT, [0, 0, 0]).slice(0, 5) }); // CN5: NaN
  const t = table(polys);
  const n = t.count;
  const A = new Float64Array(n), B = new Float64Array(n), C = new Float64Array(n), Rt = new Float64Array(n);
  computePolyhedraOrientations(t, A, B, C, Rt);
  const cols = { tiltA: A, tiltB: B, tiltC: C, rotation: Rt };
  for (const [id, col] of Object.entries(cols)) {
    const ref = prop(id, t);
    for (let p = 0; p < n; p++) {
      if (Number.isNaN(ref[p])) assert.ok(Number.isNaN(col[p]), `${id}[${p}] NaN`);
      else near(col[p], ref[p], 1e-12, `${id}[${p}]`);
    }
  }
  assert.ok(Number.isNaN(A[n - 2]) && Number.isNaN(A[n - 1]));
  // any output may be omitted
  const only = new Float64Array(n);
  computePolyhedraOrientations(t, null, null, only, null);
  for (let p = 0; p < n - 2; p++) near(only[p], C[p], 1e-12);
});

test('per-row frames: frameOf selects a frame per polyhedron, -1 keeps the cell frame', () => {
  const c = [0, 0, 0];
  // Octahedron turned 10° about c; frame 0 = the cell axes turned 10° about c
  const R10 = rotMat([0, 0, 1], 10 * D);
  const verts = place(OCT, c, 2, R10);
  const frames = new Float64Array(9);
  const rowsR = [apply(R10, [1, 0, 0]), apply(R10, [0, 1, 0]), [0, 0, 1]];
  rowsR.forEach((r, k) => frames.set(r, 3 * k));
  const t = table([{ center: c, verts }, { center: c, verts }], CUBIC,
    { frames, frameOf: new Int32Array([0, -1]) });
  const C = new Float64Array(2), Rt = new Float64Array(2);
  computePolyhedraOrientations(t, null, null, C, Rt);
  near(C[0], 0, 1e-9, 'own frame: untilted');
  near(Rt[0], 0, 1e-9, 'own frame: no rotation');
  near(C[1], 10, 1e-9, 'cell frame: 10°');
});

test('stand-in centre (centerIsCentroid): bld NaN, the other centre-based properties computed', () => {
  const c = [1, 1, 1];
  const verts = place(OCT, c, 2, rotMat([0, 0, 1], 8 * D));
  const t = table([{ center: c, verts }], CUBIC, { centerIsCentroid: new Uint8Array([1]) });
  const v = all(t);
  assert.ok(Number.isNaN(v.bld), 'bld');
  near(v.tiltC, 8, 1e-9, 'tiltC');
  near(v.angleVariance, 0, 1e-9, 'angleVariance');
  near(v.quadraticElongation, 1, 1e-9, 'elongation');
});

/**
 * An a⁻a⁻c⁺-like set in a √2×√2×2 cell: the cell axes a, b lie at 45° to
 * the pseudo-cubic x, y. Octahedra on a checkerboard (and alternating along
 * c for the anti-phase tilts) carry rotations about the pseudo-cubic axes
 * whose sign alternates between neighbours.
 */
function tiltedSet() {
  const ap = 3.9; // pseudo-cubic spacing
  const s2 = Math.SQRT1_2;
  const ex = [s2, -s2, 0], ey = [s2, s2, 0], ez = [0, 0, 1]; // pseudo-cubic axes (Cartesian)
  const lattice = [[ap * Math.SQRT2, 0, 0], [0, ap * Math.SQRT2, 0], [0, 0, 2 * ap]];
  const P = [ex, ey, ez]; // rows: pseudo-cubic axes
  const toCart = (v) => [0, 1, 2].map((k) => v[0] * P[0][k] + v[1] * P[1][k] + v[2] * P[2][k]);
  const polys = [];
  const signs = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
    const sIn = ((i + j) % 2 ? -1 : 1); // in-phase about z: checkerboard in xy
    const sAnti = ((i + j + k) % 2 ? -1 : 1); // anti-phase about x, y
    // rotation in pseudo-cubic coordinates, then expressed in Cartesian
    const Rpc = mul(rotMat([0, 0, 1], sIn * 7 * D), mul(rotMat([1, 0, 0], sAnti * 5 * D), rotMat([0, 1, 0], sAnti * 5 * D)));
    const Pm = [ex, ey, ez]; // rows
    const PT = [0, 1, 2].map((r) => [Pm[0][r], Pm[1][r], Pm[2][r]]);
    const Rc = mul(PT, mul(Rpc, Pm)); // Cartesian rotation
    const c = toCart([i * ap, j * ap, k * ap]);
    // untilted corners along the pseudo-cubic axes (Pᵀ e_k), then tilted
    polys.push({ center: c, verts: place(OCT, c, 1.95, mul(Rc, PT)) });
    signs.push({ sIn, sAnti });
  }
  return { lattice, polys, signs, ex, ey, ez };
}

test('automatic frame: the mean orientation recovers the pseudo-cubic axes of a √2×√2 cell', () => {
  const { lattice, polys, ex, ey, ez } = tiltedSet();
  const t = table(polys, lattice);
  const rows = Int32Array.from(polys.map((_, i) => i));
  const frame = new Float64Array(9);
  const used = meanOrientationFrame(t, rows, 0, rows.length, null, frame, 0);
  assert.equal(used, polys.length);
  const cell = new Float64Array(9);
  assert.ok(cellReferenceFrame(lattice, cell));
  alignFrameTo(frame, 0, cell);
  // every frame axis is one of ±ex, ±ey, ±ez to well under a degree (the
  // composed tilts Rz·Rx·Ry do not cancel to second order, ~0.2°: cos > 0.9999)
  for (let k = 0; k < 3; k++) {
    const f = [frame[3 * k], frame[3 * k + 1], frame[3 * k + 2]];
    const best = Math.max(...[ex, ey, ez].map((e) => Math.abs(f[0] * e[0] + f[1] * e[1] + f[2] * e[2])));
    near(best, 1, 1e-4, `axis ${k}`);
  }
  // right-handed, orthonormal
  const d = frame[0] * (frame[4] * frame[8] - frame[5] * frame[7]) - frame[1] * (frame[3] * frame[8] - frame[5] * frame[6])
    + frame[2] * (frame[3] * frame[7] - frame[4] * frame[6]);
  near(d, 1, 1e-9, 'det');
  // the axis aligned with c is c
  near(Math.abs(frame[8]), 1, 1e-9, 'third axis along c');
});

test('automatic frame: tilts in it alternate in sign between neighbours (cell frame does not)', () => {
  const { lattice, polys, signs } = tiltedSet();
  const n = polys.length;
  const frames = new Float64Array(9);
  const base = table(polys, lattice);
  const rows = Int32Array.from(polys.map((_, i) => i));
  meanOrientationFrame(base, rows, 0, n, null, frames, 0);
  const cell = new Float64Array(9);
  cellReferenceFrame(lattice, cell);
  alignFrameTo(frames, 0, cell);
  const t = table(polys, lattice, { frames, frameOf: new Int32Array(n) });
  const A = new Float64Array(n), B = new Float64Array(n), C = new Float64Array(n), Rt = new Float64Array(n);
  computePolyhedraOrientations(t, A, B, C, Rt);
  // tilt about the axis along c follows the in-phase checkerboard sign, ±7°
  for (let p = 0; p < n; p++) {
    near(Math.abs(C[p]), 7, 0.6, `|tiltC[${p}]|`);
    assert.equal(Math.sign(C[p]) * Math.sign(C[0]), signs[p].sIn * signs[0].sIn, `tiltC sign ${p}`);
    near(Math.abs(A[p]), 5, 0.8, `|tiltA[${p}]|`);
    assert.equal(Math.sign(A[p]) * Math.sign(A[0]), signs[p].sAnti * signs[0].sAnti, `tiltA sign ${p}`);
    assert.equal(Math.sign(B[p]) * Math.sign(B[0]), signs[p].sAnti * signs[0].sAnti, `tiltB sign ${p}`);
  }
  // the mean of each signed column is ~0 (the frame is the untilted one)
  const mean = (col) => col.reduce((x, y) => x + y, 0) / n;
  near(mean(A), 0, 1e-6, 'mean tiltA'); near(mean(C), 0, 1e-6, 'mean tiltC');
  // in the cell frame every octahedron reads ~45° about c instead
  const Cc = prop('rotation', table(polys, lattice));
  assert.ok(Cc.every((v) => v > 30), 'cell frame sees the 45° setting');
});

test('automatic frame with a seed keeps the previous axis order; tetrahedra give axes too', () => {
  const { lattice, polys } = tiltedSet();
  const t = table(polys, lattice);
  const rows = Int32Array.from(polys.map((_, i) => i));
  const f1 = new Float64Array(9);
  meanOrientationFrame(t, rows, 0, rows.length, null, f1, 0);
  // a seed with the axes permuted: the result follows the seed's order
  const seed = new Float64Array([...f1.slice(3, 6), ...f1.slice(0, 3), ...f1.slice(6, 9).map((x) => -x)]);
  const f2 = new Float64Array(9);
  meanOrientationFrame(t, rows, 0, rows.length, seed, f2, 0);
  for (let k = 0; k < 9; k++) near(f2[k], seed[k], 1e-6, `seeded ${k}`);
  // tetrahedron: its three two-fold axes are the cube axes
  const tt = table([{ center: [0, 0, 0], verts: place(TET, [0, 0, 0], 2, rotMat([0, 0, 1], 12 * D)) }]);
  const ax = new Float64Array(9);
  assert.ok(polyhedronAxes(tt, 0, ax));
  const R = rotMat([0, 0, 1], 12 * D);
  const want = [apply(R, [1, 0, 0]), apply(R, [0, 1, 0]), [0, 0, 1]];
  for (let k = 0; k < 3; k++) {
    const best = Math.max(...want.map((w) => Math.abs(ax[3 * k] * w[0] + ax[3 * k + 1] * w[1] + ax[3 * k + 2] * w[2])));
    near(best, 1, 1e-9, `tet axis ${k}`);
  }
});

test('convexHullTriangles: outward-wound closed triangulation, interior points left out', () => {
  const pts = [...OCT.map((v) => v.map((x) => 2 * x)), [0.1, 0, 0]]; // + an interior point
  const xyz = Float64Array.from(pts.flat());
  const out = new Uint16Array(3 * 20);
  const nf = convexHullTriangles(xyz, 0, pts.length, 1e-9, out, 0);
  assert.equal(nf, 8);
  for (let f = 0; f < nf; f++) {
    const [a, b, c] = [out[3 * f], out[3 * f + 1], out[3 * f + 2]].map((i) => pts[i]);
    assert.ok(![out[3 * f], out[3 * f + 1], out[3 * f + 2]].includes(6), 'interior point unused');
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    assert.ok(nrm[0] * cen[0] + nrm[1] * cen[1] + nrm[2] * cen[2] > 0, `face ${f} outward`);
  }
  assert.equal(convexHullTriangles(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 0, 4, 1e-9, out), 0, 'flat');
});

// ---- shape check: tilts only for octahedra / tetrahedra in shape ----------

// The six O around a Ca of a CaTiO3 a⁻a⁻c⁺ MD snapshot that came within the
// Ca–O cutoff (the A-site row that read −29° tilt about c): CN6 by count, but
// its greedy trans pairs span 132°, 123° and 121°, and the axes are 76–85°
// apart — not an octahedron.
const CA_O6 = {
  center: [-30.59609, 69.04636, 57.46844],
  verts: [
    [-32.76143, 68.91047, 55.76371], [-32.75327, 68.87479, 59.28892], [-28.89888, 67.12345, 57.42450],
    [-30.62699, 70.71380, 55.61051], [-30.67547, 70.65781, 59.21686], [-28.57712, 70.61681, 57.55655],
  ],
};
const ORIENT = ['tiltA', 'tiltB', 'tiltC', 'rotation'];
const SCALAR = ['volume', 'bld', 'angleVariance', 'quadraticElongation'];

test('shape check: tilted and Jahn–Teller octahedra and a tetrahedron keep their tilts', () => {
  const R = mul(rotMat([0, 0, 1], 18 * D), rotMat([1, 0, 0], 12 * D));
  const want = rotVecDeg(R);
  // regular, tilted
  const reg = all(table([{ center: [0, 0, 0], verts: place(OCT, [0, 0, 0], 1.95, R) }]));
  // Jahn–Teller: one trans pair 2.4 Å, four 1.95 Å, same tilt
  const jtShape = OCT.map((v, i) => v.map((x) => x * (i >= 4 ? 2.4 : 1.95)));
  const jt = all(table([{ center: [0, 0, 0], verts: place(jtShape, [0, 0, 0], 1, R) }]));
  for (const v of [reg, jt]) {
    for (let k = 0; k < 4; k++) near(v[ORIENT[k]], want[k], 1e-6, ORIENT[k]);
  }
  // tetrahedron, rotated
  const Rt = rotMat([1, 2, 3], 9 * D);
  const tet = all(table([{ center: [0, 0, 0], verts: place(TET, [0, 0, 0], 1.6, Rt) }]));
  const wt = rotVecDeg(Rt);
  for (let k = 0; k < 4; k++) near(tet[ORIENT[k]], wt[k], 1e-6, `tet ${ORIENT[k]}`);
});

test('shape check: an irregular CN6 and a square-planar CN4 get no tilt, scalars unchanged', () => {
  const ca = all(table([CA_O6]));
  for (const id of ORIENT) assert.ok(Number.isNaN(ca[id]), `Ca–O6 ${id} NaN (${ca[id]})`);
  for (const id of SCALAR) assert.ok(Number.isFinite(ca[id]), `Ca–O6 ${id} finite`);
  // flattened CN6 built by hand: trans angle ~120°
  const flat = [[1, 0, 0], [-0.5, 0.866, 0], [-0.5, -0.866, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0.14]];
  const fv = all(table([{ center: [0, 0, 0], verts: place(flat, [0, 0, 0], 2) }]));
  for (const id of ORIENT) assert.ok(Number.isNaN(fv[id]), `flattened ${id} NaN`);
  // square-planar CN4 (four 90° and two 180° angles) and a see-saw
  const sq = all(table([{ center: [0, 0, 0], verts: place(OCT.slice(0, 4), [0, 0, 0], 2) }]));
  for (const id of ORIENT) assert.ok(Number.isNaN(sq[id]), `square-planar ${id} NaN`);
  assert.ok(Number.isFinite(sq.angleVariance) && Number.isFinite(sq.bld), 'square-planar scalars');
  const seesaw = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-0.5, 0.866, 0]];
  const ss = all(table([{ center: [0, 0, 0], verts: place(seesaw, [0, 0, 0], 2) }]));
  for (const id of ORIENT) assert.ok(Number.isNaN(ss[id]), `see-saw ${id} NaN`);
  // tetrahedron with one bond 1.6× the others: unlike bonds, rejected
  const longTet = TET.map((v, i) => v.map((x) => x * (i === 0 ? 3.2 : 2)));
  assert.ok(Number.isNaN(all(table([{ center: [0, 0, 0], verts: longTet }])).rotation), 'bond ratio 1.6');
  // the batch path and polyhedronAxes agree
  const t = table([CA_O6, { center: [0, 0, 0], verts: place(OCT, [0, 0, 0], 2) }]);
  const C = new Float64Array(2);
  computePolyhedraOrientations(t, null, null, C, null);
  assert.ok(Number.isNaN(C[0]) && C[1] === 0, `batch ${C[0]} ${C[1]}`);
  assert.equal(polyhedronAxes(t, 0, new Float64Array(9)), false);
  assert.ok(Number.isNaN(polyhedronOrientation(t, 0, new Float64Array(4))[3]));
});

test('shape check: a rejected member is left out of the mean orientation frame', () => {
  const { lattice, polys } = tiltedSet();
  const rows = Int32Array.from(polys.map((_, i) => i));
  const f0 = new Float64Array(9);
  const used0 = meanOrientationFrame(table(polys, lattice), rows, 0, rows.length, null, f0, 0);
  // the Ca–O6 shape moved next to the set, put first so it would also seed
  const off = [0, 0, 0].map((_, k) => 5 - CA_O6.center[k]);
  const ca = { center: CA_O6.center.map((x, k) => x + off[k]), verts: CA_O6.verts.map((v) => v.map((x, k) => x + off[k])) };
  const withCa = [ca, ...polys];
  const rows1 = Int32Array.from(withCa.map((_, i) => i));
  const f1 = new Float64Array(9);
  const used1 = meanOrientationFrame(table(withCa, lattice), rows1, 0, rows1.length, null, f1, 0);
  assert.equal(used1, used0);
  for (let k = 0; k < 9; k++) assert.equal(f1[k], f0[k], `frame ${k}`);
});
