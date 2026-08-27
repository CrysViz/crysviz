import createWaveModule from '../compiled/wave_backend.js';

/**
 * JS adapter for the plane-wave WASM backend (`docs/compiled/wave_backend.c`).
 *
 * Mirrors the arrangement `math/backend-wasm.js` uses for `math_backend.c`: the
 * C owns the numerics, this file owns marshalling, and nothing above it touches
 * a raw pointer.
 *
 * Build the module first:
 *   cd docs/compiled && make wasm-wave
 *
 * Unlike the math facade, there is no JS fallback. The transforms here are the
 * whole reason a WAVECAR can be displayed at all, and a slow JS reimplementation
 * would be a second correctness surface for the one part of this feature that
 * fails silently rather than loudly (see the G-vector ordering note in the C).
 * If the module is missing, `getWaveBackend()` rejects with a message pointing
 * at the build step.
 *
 * Memory: allocations are made and freed around each call. The FFT box for a
 * large cell runs to hundreds of MB, so holding one across calls would defeat
 * the whole point of the LRU budget in `model/LruByteCache.js`.
 */

// Both enums are annotated as plain numbers. Without that, `Object.freeze` on a
// literal makes each member its own literal type, so a parameter defaulting to
// `WaveQuantity.DENSITY` is inferred as the type `0` and every other member
// becomes unassignable to it.

/** Gamma-compression mode, matching the WF_GAMMA_* enum in the C.
 *  @type {{NONE: number, X: number, Z: number}} */
export const GammaMode = Object.freeze({
  NONE: 0,
  X: 1,
  Z: 2,
});

/** Scalar to reduce the complex wavefunction to, matching the WF_MODE_* enum.
 *  @type {{DENSITY: number, REAL: number, IMAG: number, SIGNED: number}} */
export const WaveQuantity = Object.freeze({
  DENSITY: 0,   // |psi|^2
  REAL: 1,      // Re(psi)
  IMAG: 2,      // Im(psi)
  SIGNED: 3,    // |psi| carrying sign(Re psi)
});

/** Which piece of a two-component spinor to reduce, matching the WF_SPINOR_*
 *  enum in the C. NONE is a JS-only sentinel for a collinear band, which has no
 *  spinor structure at all and goes through `transformToRealSpace` instead.
 *  @type {{NONE: number, UP: number, DOWN: number, UP_UP: number,
 *          UP_DOWN: number, DOWN_UP: number, DOWN_DOWN: number}} */
export const SpinorComponent = Object.freeze({
  NONE: -1,
  UP: 0,          // psi_up
  DOWN: 1,        // psi_down
  UP_UP: 2,       // rho_uu = conj(psi_up) psi_up
  UP_DOWN: 3,     // rho_ud = conj(psi_up) psi_down
  DOWN_UP: 4,     // rho_du = conj(psi_down) psi_up
  DOWN_DOWN: 5,   // rho_dd = conj(psi_down) psi_down
});

/**
 * Labels for the entries a non-collinear band offers, in the order the field
 * list shows them.
 *
 * Written with Unicode arrows and subscripts rather than markup: field labels
 * are rendered as plain text in the catalog list and in every field dropdown,
 * so LaTeX or markdown shorthand would show up literally.
 */
export const SPINOR_COMPONENT_LABELS = Object.freeze([
  { value: SpinorComponent.UP, label: 'ψ↑ (spinor up)' },
  { value: SpinorComponent.DOWN, label: 'ψ↓ (spinor down)' },
  { value: SpinorComponent.UP_UP, label: 'ρ↑↑ (up × up)' },
  { value: SpinorComponent.UP_DOWN, label: 'ρ↑↓ (up × down)' },
  { value: SpinorComponent.DOWN_UP, label: 'ρ↓↑ (down × up)' },
  { value: SpinorComponent.DOWN_DOWN, label: 'ρ↓↓ (down × down)' },
]);

/** True for the four density-matrix elements (as opposed to a raw amplitude). */
export function isDensityMatrixComponent(spinor) {
  return spinor >= SpinorComponent.UP_UP && spinor <= SpinorComponent.DOWN_DOWN;
}

/** Human-readable labels for the quantity dropdown in the field UI. */
export const WAVE_QUANTITY_LABELS = Object.freeze([
  { value: WaveQuantity.DENSITY, label: '|ψ|² (density)' },
  { value: WaveQuantity.SIGNED, label: 'signed |ψ| (lobes)' },
  { value: WaveQuantity.REAL, label: 'Re ψ' },
  { value: WaveQuantity.IMAG, label: 'Im ψ' },
]);

/** Physical constants, kept in sync with the C so JS-side sizing agrees. */
export const AU_TO_A = 0.529177249;
export const RY_TO_EV = 13.605826;

/** @type {Promise<any> | null} */
let modulePromise = null;

/**
 * Instantiate (once) and return the WASM module.
 * @returns {Promise<any>}
 */
export function getWaveBackend() {
  if (!modulePromise) {
    modulePromise = createWaveModule().catch((error) => {
      // Let a later call retry rather than caching the failure forever.
      modulePromise = null;
      throw new Error(
        'The plane-wave WASM backend failed to load. Build it with '
        + `"cd docs/compiled && make wasm-wave". (${error && error.message})`);
    });
  }
  return modulePromise;
}

/**
 * Scratch allocation helper. Every public function below funnels through this so
 * that a throw mid-computation still frees the (potentially very large) buffers.
 * @template T
 * @param {any} module
 * @param {number[]} sizes byte sizes to allocate
 * @param {(pointers: number[]) => T} body
 * @returns {T}
 */
function withMemory(module, sizes, body) {
  const pointers = [];
  try {
    for (const size of sizes) {
      const ptr = module._malloc(size);
      if (!ptr) throw new Error(`wave backend: failed to allocate ${size} bytes`);
      pointers.push(ptr);
    }
    return body(pointers);
  } finally {
    for (const ptr of pointers) module._free(ptr);
  }
}

// Heap views must be re-read after any allocation: ALLOW_MEMORY_GROWTH can
// detach the old ArrayBuffer, and a view captured before a _malloc would then
// throw or, worse, address freed memory.
const i32 = (module, ptr, length) => new Int32Array(module.HEAP32.buffer, ptr, length);
const f32 = (module, ptr, length) => new Float32Array(module.HEAPF32.buffer, ptr, length);
const f64 = (module, ptr, length) => new Float64Array(module.HEAPF64.buffer, ptr, length);

/**
 * Round each dimension up to the next 5-smooth size.
 *
 * The FFT box only has to be at least twice the k-grid; padding beyond that is
 * exact interpolation, so this buys a radix-2/3/5-only transform for at most
 * ~20% more points. See the sizing note in the C.
 *
 * @param {any} module
 * @param {number[]} dims
 * @returns {number[]}
 */
export function smoothDims(module, dims) {
  return dims.map((n) => module._wf_next_smooth(n));
}

/**
 * The reciprocal-space grid extent VASP implies for a given cutoff and cell.
 *
 * `kgrid_i = ceil(sqrt(encut/Ry) * |a_i| / a0 / 2pi) * 2 + 1`, transcribed from
 * httk. The +1 keeps the ladder odd so it is symmetric about zero.
 *
 * @param {number[][]} lattice rows are the a, b, c vectors in Angstrom
 * @param {number} encut in eV
 * @returns {number[]}
 */
export function kgridSizeFor(lattice, encut) {
  return lattice.map((row) => {
    const length = Math.hypot(row[0], row[1], row[2]);
    const g = Math.sqrt(encut / RY_TO_EV) * length / AU_TO_A / (2 * Math.PI);
    return Math.ceil(g) * 2 + 1;
  });
}

/**
 * 2*pi times the reciprocal lattice, as a flat row-major 9-array where row j is
 * b_j — the layout `wf_gen_gvecs` expects.
 * @param {number[][]} lattice
 * @returns {Float64Array}
 */
export function reciprocalTimes2Pi(lattice) {
  const [a, b, c] = lattice;
  const cross = (u, v) => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const bc = cross(b, c);
  const ca = cross(c, a);
  const ab = cross(a, b);
  const volume = a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2];
  if (!Number.isFinite(volume) || volume === 0) {
    throw new Error('reciprocalTimes2Pi: lattice is singular');
  }
  const k = 2 * Math.PI / volume;
  return new Float64Array([
    bc[0] * k, bc[1] * k, bc[2] * k,
    ca[0] * k, ca[1] * k, ca[2] * k,
    ab[0] * k, ab[1] * k, ab[2] * k,
  ]);
}

/**
 * Count the G-vectors inside the cutoff without materialising them.
 *
 * This is how gamma compression is detected: the count for each candidate mode
 * is compared against the file's own plane-wave count for the first k-point.
 *
 * @param {any} module
 * @param {{kgrid: number[], kvec: number[], recip: Float64Array, encut: number, gamma: number}} spec
 * @returns {number}
 */
export function countGvecs(module, { kgrid, kvec, recip, encut, gamma }) {
  return withMemory(module, [3 * 4, 3 * 8, 9 * 8], ([kgridPtr, kvecPtr, recipPtr]) => {
    i32(module, kgridPtr, 3).set(kgrid);
    f64(module, kvecPtr, 3).set(kvec);
    f64(module, recipPtr, 9).set(recip);
    const count = module._wf_gen_gvecs(kgridPtr, kvecPtr, recipPtr, encut, gamma, 0, 0);
    if (count < 0) throw new Error(`wf_gen_gvecs failed with status ${-count}`);
    return count;
  });
}

/**
 * Generate the G-vectors inside the cutoff, in VASP's coefficient order.
 * @param {any} module
 * @param {{kgrid: number[], kvec: number[], recip: Float64Array, encut: number, gamma: number}} spec
 * @returns {Int32Array} 3 entries per vector
 */
export function generateGvecs(module, spec) {
  const { kgrid, kvec, recip, encut, gamma } = spec;
  // Upper bound: the full ladder. The gamma modes emit at most half of it.
  const capacity = kgrid[0] * kgrid[1] * kgrid[2];

  return withMemory(
    module,
    [3 * 4, 3 * 8, 9 * 8, capacity * 3 * 4],
    ([kgridPtr, kvecPtr, recipPtr, outPtr]) => {
      i32(module, kgridPtr, 3).set(kgrid);
      f64(module, kvecPtr, 3).set(kvec);
      f64(module, recipPtr, 9).set(recip);
      const count = module._wf_gen_gvecs(kgridPtr, kvecPtr, recipPtr, encut, gamma, outPtr, capacity);
      if (count < 0) throw new Error(`wf_gen_gvecs failed with status ${-count}`);
      // Copy out of the heap before it is freed.
      return new Int32Array(i32(module, outPtr, count * 3));
    });
}

/**
 * The whole scatter -> inverse FFT -> reduce chain for one wavefunction.
 *
 * Kept as a single call because the intermediate is the expensive thing: a
 * complex128 box for a large cell is hundreds of MB, and returning it across the
 * boundary only to hand it straight back would double that.
 *
 * @param {any} module
 * @param {object} spec
 * @param {Float64Array} spec.coeffs interleaved re/im plane-wave coefficients
 * @param {Int32Array} spec.gvecs 3 per coefficient, same order
 * @param {number[]} spec.dims FFT box size (already 5-smooth)
 * @param {number} spec.gamma GammaMode
 * @param {number} spec.quantity WaveQuantity
 * @param {number} spec.cellVolume in Angstrom^3, for the dV in the normalisation
 * @returns {{values: Float32Array, minValue: number, maxValue: number,
 *            absMinValue: number, absMaxValue: number}}
 */
export function transformToRealSpace(module, spec) {
  const { coeffs, gvecs, dims, gamma, quantity, cellVolume } = spec;
  const points = dims[0] * dims[1] * dims[2];
  const count = gvecs.length / 3;

  if (coeffs.length < count * 2) {
    throw new Error(`transformToRealSpace: ${count} G-vectors need ${count * 2} coefficient `
      + `components, got ${coeffs.length}`);
  }

  const sizes = [
    3 * 4,                 // dims
    points * 2 * 8,        // complex box
    count * 3 * 4,         // gvecs
    count * 2 * 8,         // coeffs
    points * 4,            // float32 output
    4 * 8,                 // stats
  ];

  return withMemory(module, sizes, ([dimsPtr, boxPtr, gvecPtr, coeffPtr, outPtr, statsPtr]) => {
    i32(module, dimsPtr, 3).set(dims);
    // The box must start zeroed: wf_scatter only writes the occupied G-vectors.
    f64(module, boxPtr, points * 2).fill(0);
    i32(module, gvecPtr, count * 3).set(gvecs);
    f64(module, coeffPtr, count * 2).set(coeffs.subarray(0, count * 2));

    let status = module._wf_scatter(boxPtr, dimsPtr, coeffPtr, gvecPtr, count, gamma);
    if (status !== 0) throw new Error(`wf_scatter failed with status ${status}`);

    status = module._wf_ifft3(boxPtr, dimsPtr, 1);
    if (status !== 0) throw new Error(`wf_ifft3 failed with status ${status}`);

    // dV so that sum |psi|^2 dV integrates over the cell to 1.
    const dv = cellVolume / points;
    status = module._wf_reduce_scalar(boxPtr, points, quantity, dv, outPtr, statsPtr);
    if (status !== 0) throw new Error(`wf_reduce_scalar failed with status ${status}`);

    const stats = f64(module, statsPtr, 4);
    return {
      values: new Float32Array(f32(module, outPtr, points)),
      minValue: stats[0],
      maxValue: stats[1],
      absMinValue: stats[2],
      absMaxValue: stats[3],
    };
  });
}

/**
 * The same chain for a non-collinear band, whose stored wavefunction is a
 * two-component spinor.
 *
 * A LNONCOLLINEAR WAVECAR writes 2*nplw coefficients per band: psi_up over the
 * k-point's G-vectors, then psi_down over the same G-vectors. Each half is
 * scattered and inverse-transformed into its own box, and `wf_reduce_spinor`
 * then picks either one amplitude or one element of the band's density matrix
 * rho_ab = conj(psi_a) psi_b.
 *
 * Two boxes instead of one doubles the transient allocation, which for a large
 * cell is the dominant cost of the whole operation. It is unavoidable: every
 * density-matrix element is a pointwise product of the two real-space
 * components, so both have to exist at the same time.
 *
 * @param {any} module
 * @param {object} spec
 * @param {Float64Array} spec.coeffs the full spinor, interleaved re/im, up half first
 * @param {Int32Array} spec.gvecs 3 per PLANE WAVE — half as many as `coeffs` holds pairs
 * @param {number[]} spec.dims FFT box size (already 5-smooth)
 * @param {number} spec.gamma GammaMode (always NONE in practice: vasp_ncl has no gamma build)
 * @param {number} spec.quantity WaveQuantity
 * @param {number} spec.spinor SpinorComponent
 * @param {number} spec.cellVolume in Angstrom^3
 * @returns {{values: Float32Array, minValue: number, maxValue: number,
 *            absMinValue: number, absMaxValue: number}}
 */
export function transformSpinorToRealSpace(module, spec) {
  const { coeffs, gvecs, dims, gamma, quantity, spinor, cellVolume } = spec;
  const points = dims[0] * dims[1] * dims[2];
  const count = gvecs.length / 3;

  if (coeffs.length < count * 4) {
    throw new Error(`transformSpinorToRealSpace: ${count} G-vectors need ${count * 4} spinor `
      + `coefficient components, got ${coeffs.length}`);
  }
  if (spinor < SpinorComponent.UP || spinor > SpinorComponent.DOWN_DOWN) {
    throw new Error(`transformSpinorToRealSpace: unknown spinor component ${spinor}`);
  }

  const sizes = [
    3 * 4,                 // dims
    points * 2 * 8,        // psi_up box
    points * 2 * 8,        // psi_down box
    count * 3 * 4,         // gvecs
    count * 2 * 8,         // one half of the coefficients at a time
    points * 4,            // float32 output
    4 * 8,                 // stats
  ];

  return withMemory(module, sizes, (pointers) => {
    const [dimsPtr, upPtr, downPtr, gvecPtr, coeffPtr, outPtr, statsPtr] = pointers;
    i32(module, dimsPtr, 3).set(dims);
    i32(module, gvecPtr, count * 3).set(gvecs);

    // Both boxes must start zeroed: wf_scatter only writes occupied G-vectors.
    // The coefficient buffer is reused for the second half, which is safe
    // because wf_scatter has already copied what it needs into the box.
    for (const [boxPtr, offset] of [[upPtr, 0], [downPtr, count * 2]]) {
      f64(module, boxPtr, points * 2).fill(0);
      f64(module, coeffPtr, count * 2).set(coeffs.subarray(offset, offset + count * 2));
      let status = module._wf_scatter(boxPtr, dimsPtr, coeffPtr, gvecPtr, count, gamma);
      if (status !== 0) throw new Error(`wf_scatter failed with status ${status}`);
      status = module._wf_ifft3(boxPtr, dimsPtr, 1);
      if (status !== 0) throw new Error(`wf_ifft3 failed with status ${status}`);
    }

    const dv = cellVolume / points;
    const status = module._wf_reduce_spinor(
      upPtr, downPtr, points, spinor, quantity, dv, outPtr, statsPtr);
    if (status !== 0) throw new Error(`wf_reduce_spinor failed with status ${status}`);

    const stats = f64(module, statsPtr, 4);
    return {
      values: new Float32Array(f32(module, outPtr, points)),
      minValue: stats[0],
      maxValue: stats[1],
      absMinValue: stats[2],
      absMaxValue: stats[3],
    };
  });
}
