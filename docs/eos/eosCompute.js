// Equation-of-state scan computed directly from the in-browser atomistic
// potential (NEP / PET-MAD), instead of a user-supplied P/E/V file: a sweep
// over TARGET PRESSURES (tension allowed — a negative GPa target expands the
// cell), each point a full cell+atom relaxation to that pressure, yielding
// measured (V, E, P) points the EOS panel fits exactly like a loaded dataset.
// No DOM here; the panel (docs/ui/EOSPanel.js) owns all UI and ingestion.

import { Structure, Atom } from '../model/index.js';
import { latticeVolume } from '../math/index.js';
import { cartToFrac, normalizeFractionalPositions } from '../atomistic/math.js';
import { buildNEPStructure, relaxUntilConverged, expandKeptFracToFull } from '../atomistic/relaxer.js';

/** Viewer-ready deep copy of `structure` carrying a relaxed geometry: the
 *  given lattice, and fractional positions from the relaxed cartesians. Only
 *  what an EOS frame needs travels (elements, lattice, positions) — styles/
 *  forces/symmetry stay with the source. `positionsCart` excludes vacancies
 *  (the potential never saw them); keptIndices maps them back so vacancy atoms
 *  stay in the frame at their own positions. */
function cloneWithGeometry(structure, lattice, positionsCart, keptIndices = null) {
  const elements = [...structure.elements];
  const keptFrac = normalizeFractionalPositions(cartToFrac(positionsCart, lattice));
  const frac = expandKeptFracToFull(structure, keptFrac, keptIndices);
  return new Structure({
    elements,
    lattice: lattice.map((row) => [...row]),
    atoms: structure.atoms.map((atom, i) => new Atom({
      element: elements[i],
      position: [...frac[i]],
      // Kept like snapshotCurrentStructure keeps it: the atom mesh keys
      // per-copy styles by uuid and crashes on null when the frame renders.
      uuid: atom.uuid,
    })),
    periodic: { hash: 'None', wrapped: null },
  });
}

/**
 * Compute an EOS scan with `runner` ({ modelInfo, compute } — NEP or PET-MAD
 * surface): nPoints target pressures evenly spaced in [pMinGPa, pMaxGPa],
 * each fully relaxed (cell + atoms, relaxer defaults) until forces ≤ fmaxTol
 * and the measured pressure is within pressureTolGPa of the target. The scan
 * walks the targets in order and seeds every relaxation from the previous
 * point's relaxed structure — the cell is already close, far fewer steps than
 * restarting from `baseStructure`, which only seeds the first point.
 * Cooperative cancel via shouldStop — aborts between points (and mid-relax)
 * and returns the completed points with stopped:true. A point that exhausts
 * maxSteps is still recorded, flagged false in the per-point `converged`
 * array (and called out through onProgress).
 *
 * Returns { volumes (Å³), energies (eV), pressures (GPa — MEASURED from the
 * relaxed stress, not the target), structures, converged, stopped }, sorted
 * by volume; structures are viewer-ready frames with per-frame energy.
 */
export async function runEOSScan(runner, baseStructure, {
  nPoints = 7,
  pMinGPa = -2,
  pMaxGPa = 20,
  fmaxTol = 0.01,
  maxSteps = 200,
  pressureTolGPa = 0.2,
  onProgress = (_text) => {},
  shouldStop = /** @type {() => boolean} */ (() => false),
} = {}) {
  const points = [];
  let stopped = false;
  let seed = buildNEPStructure(runner, baseStructure);

  for (let i = 0; i < nPoints; i += 1) {
    if (shouldStop()) { stopped = true; break; }
    const target = nPoints > 1
      ? pMinGPa + ((pMaxGPa - pMinGPa) * i) / (nPoints - 1)
      : pMinGPa;

    const relaxed = await relaxUntilConverged(runner, seed, {
      targetPressureGPa: target,
      pressureTolGPa,
      fmaxTol,
      maxSteps,
      shouldStop,
      onStep: (step, _current, _out, mF) => {
        onProgress(`point ${i + 1}/${nPoints} (target ${target.toFixed(2)} GPa) — relax step ${step}, max force ${mF.toFixed(4)} eV/Å`);
      },
    });
    if (relaxed.stopped) { stopped = true; break; } // drop the half-relaxed point
    if (!relaxed.converged) {
      onProgress(`point ${i + 1}/${nPoints} (target ${target.toFixed(2)} GPa) — NOT converged after ${relaxed.steps} steps (P=${relaxed.pressureGPa.toFixed(2)} GPa)`);
    }
    // Even an unconverged endpoint beats the base structure as the next seed —
    // it has already walked most of the way toward this pressure range.
    seed = relaxed.structure;

    const structure = cloneWithGeometry(baseStructure, relaxed.structure.lattice, relaxed.structure.positions, relaxed.structure.keptIndices);
    const energy = Number(relaxed.result.total_energy);
    structure.energy = energy; // per-frame energy, like an MD/relax trajectory
    points.push({
      volume: latticeVolume(structure.lattice),
      energy,
      pressure: relaxed.pressureGPa, // measured from the relaxed stress, not the target
      structure,
      converged: relaxed.converged,
    });
  }

  points.sort((a, b) => a.volume - b.volume);
  return {
    volumes: points.map((p) => p.volume),
    energies: points.map((p) => p.energy),
    pressures: points.map((p) => p.pressure),
    structures: points.map((p) => p.structure),
    converged: points.map((p) => p.converged),
    stopped,
  };
}
