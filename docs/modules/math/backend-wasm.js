import createMathModule from '../../compiled/math_backend.js';
import { jsMath, setMathBackend } from './index.js';

/**
 * WASM adapter for the shared math facade.
 *
 * Usage:
 * 1. Build the Emscripten output in `docs/compiled`:
 *    `cd docs/compiled && make wasm`
 * 2. Initialise this adapter once at startup:
 *    `await initMathWasmBackend()`
 * 3. Install it into the shared facade:
 *    `installMathWasmBackend(instance)`
 *
 * This backend only overrides the operations that are worth moving across the
 * JS/WASM boundary. All other functions continue using the JS backend.
 */

function flattenVec3Array(points) {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3 + 0] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

function unflattenVec3Array(flat) {
  const out = new Array(flat.length / 3);
  for (let i = 0; i < out.length; i++) {
    out[i] = [flat[i * 3 + 0], flat[i * 3 + 1], flat[i * 3 + 2]];
  }
  return out;
}

function flattenMatrix3x3(matrix) {
  return new Float64Array([
    matrix[0][0], matrix[0][1], matrix[0][2],
    matrix[1][0], matrix[1][1], matrix[1][2],
    matrix[2][0], matrix[2][1], matrix[2][2],
  ]);
}

function unflattenMatrix3x3(flat) {
  return [
    [flat[0], flat[1], flat[2]],
    [flat[3], flat[4], flat[5]],
    [flat[6], flat[7], flat[8]],
  ];
}

function createHeapView(module, ptr, length) {
  if (!module.HEAPF64) {
    throw new Error('WASM heap view HEAPF64 is unavailable. Rebuild compiled/math_backend.js with HEAPF64 exported.');
  }
  return new Float64Array(module.HEAPF64.buffer, ptr, length);
}

function createMathWasmBackend(module) {
  const allocBytes = (floatCount) => module._malloc(floatCount * Float64Array.BYTES_PER_ELEMENT);

  function withFloat64IO(inputArrays, outputLength, callback) {
    const inputMeta = inputArrays.map((array) => {
      const ptr = allocBytes(array.length);
      createHeapView(module, ptr, array.length).set(array);
      return { ptr, length: array.length };
    });

    const outPtr = allocBytes(outputLength);

    try {
      const status = callback(inputMeta, outPtr);
      const output = new Float64Array(outputLength);
      output.set(createHeapView(module, outPtr, outputLength));
      return { status, output };
    } finally {
      module._free(outPtr);
      for (const { ptr } of inputMeta) {
        module._free(ptr);
      }
    }
  }

  function invert3x3(matrix, tolerance = 1e-12) {
    const input = flattenMatrix3x3(matrix);
    const { status, output } = withFloat64IO([input], 9, ([m], outPtr) =>
      module._invert3x3(m.ptr, tolerance, outPtr)
    );
    if (status !== 0) throw new Error('Singular 3x3 matrix');
    return unflattenMatrix3x3(output);
  }

  function fracToCart(points, lattice) {
    const fracFlat = flattenVec3Array(points);
    const latticeFlat = flattenMatrix3x3(lattice);
    const { output } = withFloat64IO([fracFlat, latticeFlat], fracFlat.length, ([frac, lat], outPtr) => {
      module._frac_to_cart_batch(frac.ptr, points.length, lat.ptr, outPtr);
      return 0;
    });
    return unflattenVec3Array(output);
  }

  function cartToFractional(point, lattice, precomputedInverse) {
    if (precomputedInverse) {
      return jsMath.cartToFractional(point, lattice, precomputedInverse);
    }

    const cartFlat = new Float64Array(point);
    const latticeFlat = flattenMatrix3x3(lattice);
    const { status, output } = withFloat64IO([cartFlat, latticeFlat], 3, ([cart, lat], outPtr) =>
      module._cart_to_frac_batch(cart.ptr, 1, lat.ptr, outPtr)
    );
    if (status !== 0) throw new Error('Singular 3x3 matrix');
    return Array.from(output);
  }

  function cartToFrac(point, lattice, precomputedInverse) {
    return cartToFractional(point, lattice, precomputedInverse);
  }

  function normalizeFractional(value) {
    const values = new Float64Array([value]);
    const ptr = allocBytes(values.length);
    try {
      createHeapView(module, ptr, values.length).set(values);
      module._normalize_fractional_batch(ptr, 1);
      return createHeapView(module, ptr, values.length)[0];
    } finally {
      module._free(ptr);
    }
  }

  function latticeVolume(matrix) {
    const latticeFlat = flattenMatrix3x3(matrix);
    const ptr = allocBytes(latticeFlat.length);
    try {
      createHeapView(module, ptr, latticeFlat.length).set(latticeFlat);
      return module._lattice_volume(ptr);
    } finally {
      module._free(ptr);
    }
  }

  function latticeParameters(matrix) {
    const latticeFlat = flattenMatrix3x3(matrix);
    const { output } = withFloat64IO([latticeFlat], 7, ([lat], outPtr) => {
      module._lattice_parameters(lat.ptr, outPtr);
      return 0;
    });

    return {
      a: output[0],
      b: output[1],
      c: output[2],
      alpha: output[3],
      beta: output[4],
      gamma: output[5],
      volume: output[6],
    };
  }

  return {
    invert3x3,
    fracToCart,
    cartToFractional,
    cartToFrac,
    normalizeFractional,
    latticeVolume,
    latticeParameters,
  };
}

export async function initMathWasmBackend(wasmUrl = new URL('../../compiled/math_backend.wasm', import.meta.url)) {
  const module = await createMathModule({ locateFile: () => wasmUrl.href });
  return createMathWasmBackend(module);
}

export function installMathWasmBackend(backend) {
  return setMathBackend(backend);
}
