// Where a calculator's stress enters the app.
//
// NEP, PET-MAD (mlip.js) and the ASE backend all report stress tension-positive
// (eV/Å³, P = -tr/3). The app computes and stores it compression-positive
// (eV/Å³, P = +tr/3 — see model/Stress.js), so every calculator result is
// converted exactly once, here, and the relaxer, MD and everything that stores
// a frame work in the one convention from then on.

import { fromTensionPositive } from '../model/index.js';

const CONVERTED = Symbol('appStressConvention');

/** A calculator `stress` ({ matrix3x3, voigt, ... }) in the app convention. */
export function stressToAppConvention(stress) {
  if (!Array.isArray(stress?.matrix3x3)) return stress;
  return {
    ...stress,
    matrix3x3: fromTensionPositive(stress.matrix3x3),
    ...(stress.voigt ? { voigt: Array.from(stress.voigt, (v) => (v === 0 ? 0 : -v)) } : {}),
  };
}

/** An EFS result with its stress in the app convention. */
export function efsToAppConvention(out) {
  return out?.stress ? { ...out, stress: stressToAppConvention(out.stress) } : out;
}

/**
 * Make `runner.compute` return its stress in the app convention, keeping it
 * synchronous when it was (NEP) and async when it was (PET-MAD). Idempotent, so
 * a runner shared between panels is converted once.
 * @template T
 * @param {T} runner
 * @returns {T}
 */
export function withAppStressConvention(runner) {
  const r = /** @type {any} */ (runner);
  if (!r || r[CONVERTED]) return runner;
  const compute = r.compute.bind(r);
  r.compute = (/** @type {any[]} */ ...args) => {
    const out = compute(...args);
    return typeof out?.then === 'function' ? out.then(efsToAppConvention) : efsToAppConvention(out);
  };
  r[CONVERTED] = true;
  return runner;
}
