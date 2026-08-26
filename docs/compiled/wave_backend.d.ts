/* tslint:disable */
/* eslint-disable */

/**
 * Type stub for the Emscripten output of `wave_backend.c`.
 *
 * `docs/compiled/**` is excluded from tsconfig.json, but `tsc` still follows the
 * import in `docs/math/wave-backend-wasm.js` into the generated glue and type-checks
 * it, which fails: the module is built with `ENVIRONMENT=web,worker,node` (so the
 * Node harness in `docs/tests/wave_backend_smoke.mjs` can load it), and the Node
 * branch references `node:module`, `node:fs` and `process`, none of which this
 * project has types for.
 *
 * Declaring the shape here makes `tsc` prefer this file over the generated .js,
 * which is the same arrangement `periodic_wasm.d.ts` provides for the wasm-bindgen
 * output next to it. Regenerating the module does not touch this file, so keep the
 * signatures in sync with the EMSCRIPTEN_KEEPALIVE exports in wave_backend.c.
 */

/** The instantiated module: Emscripten runtime helpers plus the C exports. */
export interface WaveBackendModule {
  _malloc(size: number): number;
  _free(pointer: number): void;

  /** Next 5-smooth integer >= n. */
  _wf_next_smooth(n: number): number;

  /**
   * Enumerate the k-grid and keep the G-vectors inside the cutoff, in VASP's
   * coefficient order. Returns the count, or a negative status code.
   * `out` may be 0 to count without writing.
   */
  _wf_gen_gvecs(
    kgrid: number, kvec: number, recip: number,
    encut: number, gamma: number, out: number, capacity: number,
  ): number;

  /** Place coefficients at their G-vectors in a zeroed FFT box. */
  _wf_scatter(
    box: number, dims: number, coeffs: number,
    gvecs: number, count: number, gamma: number,
  ): number;

  /** In-place 3D FFT; sign +1 is the inverse transform. */
  _wf_ifft3(box: number, dims: number, sign: number): number;

  /** Normalise and reduce to a float32 scalar field, filling `stats` with
   *  [min, max, absMin, absMax]. */
  _wf_reduce_scalar(
    box: number, count: number, mode: number, dv: number,
    out: number, stats: number,
  ): number;

  /** The same for a non-collinear band: two transformed boxes in, one
   *  WF_SPINOR_* component (amplitude or density-matrix element) out, with a
   *  single normalisation shared by both spinor components. */
  _wf_reduce_spinor(
    boxUp: number, boxDown: number, count: number, component: number,
    mode: number, dv: number, out: number, stats: number,
  ): number;

  // Heap views. These are re-read after every allocation on the JS side, because
  // ALLOW_MEMORY_GROWTH can detach the underlying ArrayBuffer.
  HEAPF64: Float64Array;
  HEAPF32: Float32Array;
  HEAP32: Int32Array;

  ccall(name: string, returnType: string | null, argTypes: string[], args: any[]): any;
  cwrap(name: string, returnType: string | null, argTypes: string[]): (...args: any[]) => any;
}

/** MODULARIZE=1 EXPORT_ES6=1 factory. */
declare function createWaveBackend(moduleOverrides?: Record<string, any>): Promise<WaveBackendModule>;

export default createWaveBackend;
