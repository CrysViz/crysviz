/**
 * periodicWrapped – WASM-backed drop-in for the original JS implementation.
 *
 * SETUP in LatticeModule.js (or wherever periodicWrapped lives):
 *
 *   import init, { periodic_wrapped } from '../compiled/periodic_wasm.js';
 *   import { initPeriodicWasm, periodicWrapped } from '../compiled/periodicWasm.js';
 *
 *   // Once at startup – pass the already-imported wasm-bindgen module:
 *   await initPeriodicWasm(init, periodic_wrapped, new URL('../compiled/periodic_wasm_bg.wasm', import.meta.url));
 */

// ---------------------------------------------------------------------------
// Module-level WASM function handle
// ---------------------------------------------------------------------------
let _periodic_wrapped = null;

/**
 * Initialise the WASM module.
 *
 * @param {Function} init              – default export from periodic_wasm.js (wasm-bindgen init)
 * @param {Function} periodic_wrapped_fn  named export from periodic_wasm.js
 * @param {URL|string} wasmUrl         – URL to the .wasm binary
 */
export async function initPeriodicWasm(init, periodic_wrapped_fn, wasmUrl) {
  await init(wasmUrl);
  _periodic_wrapped = periodic_wrapped_fn;
}

// ---------------------------------------------------------------------------
// Bond-table helper
// ---------------------------------------------------------------------------
export function buildBondTable(elements, bondLengths) {
  const seen = new Map();
  for (const el of elements) {
    if (!seen.has(el)) seen.set(el, seen.size);
  }

  const nElem = seen.size;
  const table = new Float64Array(nElem * nElem);

  if (bondLengths) {
    for (const [key, cutoff] of Object.entries(bondLengths)) {
      if (typeof key === 'string' && key.includes('-')) {
        const [a, b] = key.split('-');
        const ia = seen.get(a);
        const ib = seen.get(b);
        if (ia !== undefined && ib !== undefined) {
          // bondLengths values are { min, max } objects (legacy: plain number)
          const maxCutoff = (typeof cutoff === 'number') ? cutoff : (cutoff?.max ?? 0);
          table[ia * nElem + ib] = maxCutoff;
          table[ib * nElem + ia] = maxCutoff;
        }
      }
    }
  }

  return { table, nElem, elementToIdx: seen };
}

// ---------------------------------------------------------------------------
// Main export – identical signature to the original periodicWrapped
// ---------------------------------------------------------------------------
export function periodicWrapped(general, frac, elements, lattice) {
  if (!_periodic_wrapped) {
    throw new Error('[periodicWrapped] WASM not initialised. Call initPeriodicWasm() first.');
  }

  const n = elements.length;
  const showPeriodic = !!general.showPeriodic;
  const showPBCBonds = !!general.showPBCBonds;

  const { table: bondTable, nElem, elementToIdx } = buildBondTable(
    elements,
    general.bondLengths
  );

  const elemIdx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    elemIdx[i] = elementToIdx.get(elements[i]) ?? 0;
  }

  const fracFlat = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    fracFlat[3 * i]     = frac[i][0];
    fracFlat[3 * i + 1] = frac[i][1];
    fracFlat[3 * i + 2] = frac[i][2];
  }

  // Transpose before sending: JS fracToCart uses L^T * frac, Rust uses L * frac.
  // Sending L^T makes Rust compute L^T * frac = correct Cartesian.
  const latticeFlat = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      latticeFlat[c * 3 + r] = lattice[r][c];
    }
  }

  const result = _periodic_wrapped(
    showPeriodic,
    showPBCBonds,
    elemIdx,
    fracFlat,
    latticeFlat,
    bondTable,
    nElem
  );

  const m = result.len();

  const idxToElement = Array.from(elementToIdx.entries()).reduce((acc, [sym, idx]) => {
    acc[idx] = sym;
    return acc;
  }, {});

  const outElements = [];
  const rawElem = result.elements();
  const rawFrac = result.frac();
  const rawCart = result.cart();
  const rawSrc  = result.src_index();

  const outFrac = new Array(m);
  const outCart = new Array(m);
  const outSrc  = new Array(m);

  for (let i = 0; i < m; i++) {
    outElements.push(idxToElement[rawElem[i]]);
    outFrac[i] = [rawFrac[3 * i], rawFrac[3 * i + 1], rawFrac[3 * i + 2]];
    outCart[i] = [rawCart[3 * i], rawCart[3 * i + 1], rawCart[3 * i + 2]];
    outSrc[i]  = rawSrc[i];
  }

  result.free();

  return {
    elements: outElements,
    frac:     outFrac,
    cart:     outCart,
    srcIndex: outSrc,
  };
}
