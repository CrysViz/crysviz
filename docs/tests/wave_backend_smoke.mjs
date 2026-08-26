// Smoke test for the COMPILED docs/compiled/wave_backend.wasm: loads it through
// its ES6 loader and exercises every exported entry point across the JS
// boundary, checking the same numbers docs/tests/wave_backend_test.c checks natively.
//
// This catches the failures the native test cannot see: a missing entry in the
// Makefile's EXPORTED_FUNCTIONS, a heap view that was not exported, or a
// pointer/size mismatch in how JS hands buffers to the module.
//
// Run (any Node 18+, e.g. the one emsdk ships):
//   node docs/tests/wave_backend_smoke.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, '..', 'compiled', 'wave_backend.js');
const { default: WaveBackend } = await import(pathToFileURL(modulePath).href);

const m = await WaveBackend();

let failures = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failures++;
};

// ---- wf_next_smooth ----
const nextSmooth = m.cwrap('wf_next_smooth', 'number', ['number']);
console.log('wf_next_smooth');
ok(nextSmooth(70) === 72, '70 -> 72');
ok(nextSmooth(73) === 75, '73 -> 75');

// ---- wf_gen_gvecs ----
console.log('wf_gen_gvecs');
const a = 10.0;
const encut = 400.0;
const AU = 0.529177249, RY = 13.605826;
const gcut = Math.sqrt(encut / RY) * a / AU / (2 * Math.PI);
const n = Math.ceil(gcut) * 2 + 1;

const kgridPtr = m._malloc(3 * 4);
new Int32Array(m.HEAP32.buffer, kgridPtr, 3).set([n, n, n]);
const kvecPtr = m._malloc(3 * 8);
new Float64Array(m.HEAPF64.buffer, kvecPtr, 3).set([0, 0, 0]);
const recipPtr = m._malloc(9 * 8);
const B = new Float64Array(9);
B[0] = B[4] = B[8] = 2 * Math.PI / a;
new Float64Array(m.HEAPF64.buffer, recipPtr, 9).set(B);

const genGvecs = m.cwrap('wf_gen_gvecs', 'number',
  ['number', 'number', 'number', 'number', 'number', 'number', 'number']);

const count = genGvecs(kgridPtr, kvecPtr, recipPtr, encut, 0, 0, 0);
ok(count === 18037, `standard count is 18037 (got ${count})`);
const gammaCount = genGvecs(kgridPtr, kvecPtr, recipPtr, encut, 1, 0, 0);
ok(gammaCount === 9019, `gamma-x count is 9019 (got ${gammaCount})`);

const gvecPtr = m._malloc(count * 3 * 4);
const filled = genGvecs(kgridPtr, kvecPtr, recipPtr, encut, 0, gvecPtr, count);
ok(filled === count, 'filling pass matches the counting pass');
const gvecs = new Int32Array(m.HEAP32.buffer, gvecPtr, 3);
ok(gvecs[0] === 0 && gvecs[1] === 0 && gvecs[2] === 0, 'first G-vector is (0,0,0)');

// ---- scatter + ifft + reduce, end to end on a small gamma case ----
console.log('scatter -> ifft3 -> reduce');
const dims = [8, 8, 8];
const npts = dims[0] * dims[1] * dims[2];
const dimsPtr = m._malloc(3 * 4);
new Int32Array(m.HEAP32.buffer, dimsPtr, 3).set(dims);

const boxPtr = m._malloc(npts * 2 * 8);
new Float64Array(m.HEAPF64.buffer, boxPtr, npts * 2).fill(0);

const gv = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 2, -3];
const co = [0.7, 0.0, 0.3, 0.4, -0.2, 0.5, 0.15, -0.25];
const gvPtr = m._malloc(gv.length * 4);
new Int32Array(m.HEAP32.buffer, gvPtr, gv.length).set(gv);
const coPtr = m._malloc(co.length * 8);
new Float64Array(m.HEAPF64.buffer, coPtr, co.length).set(co);

const scatter = m.cwrap('wf_scatter', 'number', ['number', 'number', 'number', 'number', 'number', 'number']);
const ifft3 = m.cwrap('wf_ifft3', 'number', ['number', 'number', 'number']);
const reduce = m.cwrap('wf_reduce_scalar', 'number',
  ['number', 'number', 'number', 'number', 'number', 'number']);

ok(scatter(boxPtr, dimsPtr, coPtr, gvPtr, 4, 1) === 0, 'wf_scatter returns WF_OK');
ok(ifft3(boxPtr, dimsPtr, 1) === 0, 'wf_ifft3 returns WF_OK');

const box = new Float64Array(m.HEAPF64.buffer, boxPtr, npts * 2);
let maxIm = 0;
for (let i = 0; i < npts; i++) maxIm = Math.max(maxIm, Math.abs(box[i * 2 + 1]));
ok(maxIm < 1e-12, `gamma expansion is real (max |Im| = ${maxIm.toExponential(3)})`);

const outPtr = m._malloc(npts * 4);
const statsPtr = m._malloc(4 * 8);
const dv = 1.0 / npts;
ok(reduce(boxPtr, npts, 0, dv, outPtr, statsPtr) === 0, 'wf_reduce_scalar returns WF_OK');

const out = new Float32Array(m.HEAPF32.buffer, outPtr, npts);
const stats = new Float64Array(m.HEAPF64.buffer, statsPtr, 4);
let sum = 0;
for (let i = 0; i < npts; i++) sum += out[i] * dv;
ok(Math.abs(sum - 1) < 1e-5, `sum |psi|^2 dV == 1 (got ${sum})`);
ok(stats[1] > 0 && stats[0] >= 0, 'density stats are sane');

// ---- wf_reduce_spinor: the non-collinear reduction ----
// A second box standing in for psi_down, so the same points can be reduced as a
// spinor. Only the entry point is under test here — the numerics are pinned
// natively in docs/tests/wave_backend_test.c.
console.log('wf_reduce_spinor');
const downPtr = m._malloc(npts * 2 * 8);
new Float64Array(m.HEAPF64.buffer, downPtr, npts * 2).fill(0);
// Half the up box, so the down component is real, non-zero and the minority one.
{
  const up = new Float64Array(m.HEAPF64.buffer, boxPtr, npts * 2);
  const down = new Float64Array(m.HEAPF64.buffer, downPtr, npts * 2);
  for (let i = 0; i < npts * 2; i++) down[i] = up[i] * 0.5;
}

const reduceSpinor = m.cwrap('wf_reduce_spinor', 'number',
  ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']);

const WF_SPINOR_UP_UP = 2, WF_SPINOR_DOWN_DOWN = 5;
const integrate = () => {
  const values = new Float32Array(m.HEAPF32.buffer, outPtr, npts);
  let total = 0;
  for (let i = 0; i < npts; i++) total += values[i] * dv;
  return total;
};

ok(reduceSpinor(boxPtr, downPtr, npts, WF_SPINOR_UP_UP, 0, dv, outPtr, statsPtr) === 0,
  'wf_reduce_spinor returns WF_OK for up*up');
const upWeight = integrate();
ok(reduceSpinor(boxPtr, downPtr, npts, WF_SPINOR_DOWN_DOWN, 0, dv, outPtr, statsPtr) === 0,
  'wf_reduce_spinor returns WF_OK for down*down');
const downWeight = integrate();
ok(Math.abs(upWeight + downWeight - 1) < 1e-5,
  `the density matrix trace integrates to 1 (got ${upWeight + downWeight})`);
ok(upWeight > downWeight, 'the spinor is normalised as a whole, not component by component');

console.log(`\n${failures ? 'FAILED' : 'ALL PASSED'} (${failures} failure${failures === 1 ? '' : 's'})`);
process.exit(failures ? 1 : 0);
