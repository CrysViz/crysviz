/**
 * Shared math facade for vector, matrix, and lattice operations.
 *
 * Design:
 * - `backend-js.js` provides the default pure-JavaScript implementation.
 * - This file is the stable import surface for the rest of the app.
 * - Callers should import math helpers from `modules/math/index.js` rather than
 *   directly from a concrete backend.
 *
 * Backend switching:
 * - `setMathBackend(backend)` replaces the active backend with the default JS
 *   backend plus the supplied overrides.
 * - `configureMathBackend(overrides)` patches only selected functions on top of
 *   the current backend.
 * - `resetMathBackend()` restores the default JS implementation.
 * - Each exported helper delegates at call time to `activeMathBackend`, so a
 *   future WASM backend can replace only the hot functions without changing
 *   existing imports across the codebase.
 *
 * Intended future use:
 * - Keep the JS backend as the correctness/reference implementation.
 * - Add a WASM backend module with the same function names/signatures.
 * - Install it here once loaded, for example:
 *   `setMathBackend({ invert3x3: wasmInvert3x3, fracToCart: wasmFracToCart })`
 * - In this repository, `modules/math/backend-wasm.js` is the adapter layer for
 *   the Emscripten build in `docs/compiled/math_backend.c`.
 */
import * as jsMath from './backend-js.js';

let activeMathBackend = { ...jsMath };

export function setMathBackend(backend = {}) {
  activeMathBackend = { ...jsMath, ...backend };
  return activeMathBackend;
}

export function configureMathBackend(overrides = {}) {
  activeMathBackend = { ...activeMathBackend, ...overrides };
  return activeMathBackend;
}

export function resetMathBackend() {
  activeMathBackend = { ...jsMath };
  return activeMathBackend;
}

export function getMathBackend() {
  return activeMathBackend;
}

export function clamp(...args) { return activeMathBackend.clamp(...args); }
export function dot3(...args) { return activeMathBackend.dot3(...args); }
export function cross3(...args) { return activeMathBackend.cross3(...args); }
export function vectorLength3(...args) { return activeMathBackend.vectorLength3(...args); }
export function acosDeg(...args) { return activeMathBackend.acosDeg(...args); }
export function transpose3x3(...args) { return activeMathBackend.transpose3x3(...args); }
export function invert3x3(...args) { return activeMathBackend.invert3x3(...args); }
export function multiplyMatVec(...args) { return activeMathBackend.multiplyMatVec(...args); }
export function matVec(...args) { return activeMathBackend.matVec(...args); }
export function fracToCartPoint(...args) { return activeMathBackend.fracToCartPoint(...args); }
export function fracToCart(...args) { return activeMathBackend.fracToCart(...args); }
export function cartToFractional(...args) { return activeMathBackend.cartToFractional(...args); }
export function cartToFrac(...args) { return activeMathBackend.cartToFrac(...args); }
export function normalizeFractional(...args) { return activeMathBackend.normalizeFractional(...args); }
export function normalizeFractionalPoint(...args) { return activeMathBackend.normalizeFractionalPoint(...args); }
export function normalizeFractionalPositions(...args) { return activeMathBackend.normalizeFractionalPositions(...args); }
export function latticeFromCell(...args) { return activeMathBackend.latticeFromCell(...args); }
export function latticeVolume(...args) { return activeMathBackend.latticeVolume(...args); }
export function latticeParameters(...args) { return activeMathBackend.latticeParameters(...args); }

export { jsMath };
