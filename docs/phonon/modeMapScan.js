// Mode-map scan: freeze a phonon eigenvector into the displayed supercell at
// a series of normal-mode amplitudes Q and evaluate each geometry with the
// active in-browser potential (NEP / PET-MAD — the same { modelInfo, compute }
// runner surface eos/eosCompute.js and the relaxer use). Sequential by design:
// the wasm calculators hold a single instance and are not reentrant. No DOM.

import { frozenDisplacement, fracToCart, displacedFractional, maxDisplacement, invert3x3 } from './phononMath.js';

function symbolCase(sym) {
  const s = String(sym || '').trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Map the supercell's species onto the runner's element list (throws for an
 *  element the model does not know, like buildNEPStructure does). */
export function speciesToTypes(runner, species) {
  const list = runner.modelInfo.element_list.map(symbolCase);
  return species.map((el) => {
    const t = list.indexOf(symbolCase(el));
    if (t < 0) throw new Error(`Model does not support element: ${el}`);
    return t;
  });
}

const nextFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve(undefined));
  else setTimeout(resolve, 0);
});

/**
 * The frozen geometries for a list of Q values — shared by the scan and by the
 * zip export, so exported structures are byte-for-byte the ones that were
 * computed.
 * @param {import('./phononMath.js').PhononSupercell} sc
 * @param {import('./phononMath.js').ModePattern} pattern
 * @param {number[]} Qs
 * @returns {{ Q: number, frac: number[][], positions: number[][], maxDisp: number }[]}
 */
export function frozenGeometries(sc, pattern, Qs) {
  const inv = invert3x3(sc.lattice);
  const buf = new Float64Array(sc.natom * 3);
  return Qs.map((Q) => {
    const u = frozenDisplacement(pattern, sc.masses, Q, buf);
    // Positions handed to the potential are wrapped into the cell: the same
    // structure for any periodic calculator, and the wasm wrappers (NEP_CPU,
    // mlip.cpp) are not guaranteed to build neighbour lists for atoms outside
    // the box. The unwrapped `frac` stays for the viewer frames.
    const frac = displacedFractional(sc, u, inv);
    const positions = frac.map((f) => fracToCart(sc.lattice, f.map((x) => x - Math.floor(x))));
    return { Q, frac, positions, maxDisp: maxDisplacement(u) };
  });
}

/**
 * @param {{ modelInfo: { element_list: string[] }, compute: (s: any) => any }} runner
 * @param {import('./phononMath.js').PhononSupercell} sc
 * @param {import('./phononMath.js').ModePattern} pattern
 * @param {number[]} Qs
 * @param {{ onProgress?: (text: string, i: number) => void, shouldStop?: () => boolean }} [opts]
 * @returns {Promise<{ Q: number[], energies: number[], maxDisp: number[], fracs: number[][][],
 *                     forces: (number[][]|null)[], stopped: boolean }>}
 */
export async function runModeMapScan(runner, sc, pattern, Qs, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const types = speciesToTypes(runner, sc.species);
  const lattice = sc.lattice.map((row) => [...row]);
  const geometries = frozenGeometries(sc, pattern, Qs);
  const Q = [];
  const energies = [];
  const maxDisp = [];
  const fracs = [];
  const forces = [];
  let stopped = false;
  for (let i = 0; i < geometries.length; i++) {
    if (shouldStop()) { stopped = true; break; }
    const g = geometries[i];
    onProgress(`point ${i + 1}/${geometries.length} — Q = ${g.Q.toFixed(3)} amu^½·Å, max |u| = ${g.maxDisp.toFixed(3)} Å`, i);
    const out = await runner.compute({ lattice, positions: g.positions, types });
    const energy = Number(out?.total_energy);
    if (!Number.isFinite(energy)) throw new Error('The potential returned no total energy.');
    Q.push(g.Q);
    energies.push(energy);
    maxDisp.push(g.maxDisp);
    fracs.push(g.frac);
    forces.push(Array.isArray(out.forces) ? out.forces.map((f) => [...f]) : null);
    await nextFrame();
  }
  return { Q, energies, maxDisp, fracs, forces, stopped };
}
