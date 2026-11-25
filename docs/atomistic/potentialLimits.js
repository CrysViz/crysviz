// How many atoms the in-browser potentials can take.
//
// Both run as WebAssembly with a fixed memory ceiling, and past it they do not
// fail gracefully: the module aborts and stays dead for the session. So the
// size is checked before a structure is handed over, everywhere one is
// (atomistic runners via withAtomLimit; the panels up front so a refused run
// leaves no empty trajectory row behind).
//
// Measured headless (Chromium, 4 cores; tools/bench/results/2026-10-19-memory):
//  - NEP (nep89, 2 GB wasm heap): ~75 KB per atom; 17,576 atoms evaluate
//    (1.4 s), 21,952 abort. Limit 15,000 leaves headroom for denser cells.
//  - PET-MAD (mlip.cpp, wasm32, 4 GB): ~2.5 MB per atom (graph autograd
//    buffers); 832 atoms take 2.6 GB. Limit 1,000. Measured on random
//    stand-ins in mlip.cpp's hand-written `pet` layout; the published files
//    are `pet-graph` exports. With the graph allocator patch
//    (external/mlip_wasm/README.md), stand-ins of that format at the
//    published sizes: XS evaluates 832 atoms in 2.7 GB, S 351 atoms in
//    2.4 GB but not 832. The S stand-in needs more memory than the real
//    PET-MAD-S (it failed at 104 atoms before the patch, the real one at
//    351), so the limit stays until it is measured with the real files.
// The ASE backend runs on a server and is not limited here.

/** @type {Record<string, number>} */
export const POTENTIAL_ATOM_LIMITS = {
  nep: 15000,
  mlip: 1000,
};

const LABELS = { nep: 'NEP', mlip: 'PET-MAD' };

/**
 * @param {string} potential 'nep' | 'mlip' | 'ase'
 * @returns {number} the atom limit, Infinity when the potential has none
 */
export function potentialAtomLimit(potential) {
  return POTENTIAL_ATOM_LIMITS[potential] ?? Infinity;
}

/**
 * The reason a structure of `atomCount` atoms cannot use `potential`, or null.
 * @param {string} potential
 * @param {number} atomCount
 * @returns {string|null}
 */
export function potentialSizeProblem(potential, atomCount) {
  const limit = potentialAtomLimit(potential);
  if (!(atomCount > limit)) return null;
  const name = LABELS[potential] || potential;
  return `${name} runs in the browser and is limited to ${limit.toLocaleString('en-US')} atoms; `
    + `this structure has ${atomCount.toLocaleString('en-US')}. Use a smaller cell`
    + `${potential === 'mlip' ? ', NEP' : ''} or the ASE backend.`;
}

/** Throw the size problem as an Error (with `.code`), if there is one. */
export function assertPotentialSize(potential, atomCount) {
  const problem = potentialSizeProblem(potential, atomCount);
  if (problem) {
    const error = new Error(problem);
    /** @type {any} */ (error).code = 'POTENTIAL_TOO_MANY_ATOMS';
    throw error;
  }
}

const LIMITED = Symbol('atomLimit');

/**
 * Make `runner.compute({ positions })` refuse structures over the potential's
 * limit before they reach the wasm. Keeps a synchronous compute synchronous.
 * Idempotent.
 * @template T
 * @param {T} runner
 * @param {string} potential
 * @returns {T}
 */
export function withAtomLimit(runner, potential) {
  const r = /** @type {any} */ (runner);
  if (!r || r[LIMITED]) return runner;
  const compute = r.compute.bind(r);
  r.compute = (/** @type {any} */ structure, /** @type {any[]} */ ...rest) => {
    const n = structure?.positions?.length;
    if (Number.isFinite(n)) assertPotentialSize(potential, n);
    return compute(structure, ...rest);
  };
  r[LIMITED] = true;
  return runner;
}
