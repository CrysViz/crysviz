import * as workerPool from './workerPool.js';
import { getWaveBackend, transformToRealSpace } from '../math/wave-backend-wasm.js';

/**
 * Dispatch for the wavefunction transform: worker when possible, main thread
 * when not.
 *
 * Expanding one band is a 3D FFT over a box that runs from ~10^5 to ~10^7
 * points. On the main thread that is a visible freeze, and the user will click
 * through a list of bands, so it has to go to a worker.
 *
 * The payload is small in both directions relative to the work — coefficients
 * in, a Float32 field out — and both are ArrayBuffer-backed, so they transfer
 * zero-copy. The huge intermediate (the complex128 box) is allocated and freed
 * inside the WASM module and never crosses the boundary at all.
 *
 * SharedArrayBuffer is unavailable on GitHub Pages (no COOP/COEP), which is why
 * this is transfer-based rather than shared-memory; see workerPool.js.
 */

/**
 * Run scatter -> inverse FFT -> reduce for one wavefunction.
 *
 * @param {object} spec
 * @param {Float64Array} spec.coeffs interleaved re/im plane-wave coefficients
 * @param {Int32Array} spec.gvecs 3 per coefficient, in VASP's order
 * @param {number[]} spec.dims real-space FFT box
 * @param {number} spec.gamma GammaMode
 * @param {number} spec.quantity WaveQuantity
 * @param {number} spec.cellVolume Angstrom^3
 * @returns {Promise<{values: Float32Array, minValue: number, maxValue: number,
 *                    absMinValue: number, absMaxValue: number}>}
 */
export async function runWavefunctionTransform(spec) {
  if (workerPool.available()) {
    try {
      return await runInWorker(spec);
    } catch (error) {
      // A worker that cannot start (module worker unsupported, wasm blocked by
      // a CSP) must not take the feature down with it — fall back rather than
      // leaving the panel with a spinner and no field.
      console.warn('Wavefunction transform failed in a worker; falling back to the '
        + 'main thread. The UI will block while it runs.', error);
    }
  }
  return runOnMainThread(spec);
}

/** @param {object} spec */
async function runInWorker(spec) {
  // Copy the views into standalone buffers before transferring: the originals
  // are cached by WavefunctionSource and must survive this call. A transfer
  // detaches whatever buffer it is given.
  const coeffs = new Float64Array(spec.coeffs);
  const gvecs = new Int32Array(spec.gvecs);

  const payload = {
    coeffs,
    gvecs,
    dims: spec.dims,
    gamma: spec.gamma,
    quantity: spec.quantity,
    cellVolume: spec.cellVolume,
  };

  return workerPool.run('wavefunctionRealSpace', payload, [coeffs.buffer, gvecs.buffer]);
}

/** @param {object} spec */
async function runOnMainThread(spec) {
  const module = await getWaveBackend();
  return transformToRealSpace(module, spec);
}
