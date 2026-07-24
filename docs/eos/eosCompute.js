// Equation-of-state scan computed directly from the in-browser atomistic
// potential (NEP / PET-MAD), instead of a user-supplied P/E/V file: a set of
// isotropically strained copies of a base structure, each optionally relaxed
// at FIXED cell (the scan owns the volume — only atoms may move), yielding
// E(V)/P(V) points the EOS panel fits exactly like a loaded dataset. No DOM
// here; the panel (docs/ui/EOSPanel.js) owns all UI and ingestion.

import { Structure, Atom } from '../model/index.js';
import { latticeVolume } from '../math/index.js';
import { cartToFrac, normalizeFractionalPositions } from '../atomistic/math.js';
import { buildNEPStructure, relaxUntilConverged, pressureGPaFromStress } from '../atomistic/relaxer.js';

/**
 * Deep-copied Structure with the cell scaled to `volumeFactor` times the
 * source volume (isotropic: every lattice entry × volumeFactor^(1/3)).
 * Fractional coordinates are volume-independent, so atom positions copy
 * unchanged. Only the geometry an EOS point needs is carried (elements,
 * lattice, positions) — styles/forces/symmetry stay with the source.
 */
export function scaleStructureVolume(structure, volumeFactor) {
  const scale = Math.cbrt(volumeFactor);
  const elements = [...structure.elements];
  return new Structure({
    elements,
    lattice: structure.lattice.map((row) => row.map((x) => x * scale)),
    atoms: structure.atoms.map((atom, i) => new Atom({
      element: elements[i],
      position: [...atom.position],
      // Kept like snapshotCurrentStructure keeps it: the atom mesh keys
      // per-copy styles by uuid and crashes on null when the frame renders.
      uuid: atom.uuid,
    })),
    periodic: { hash: 'None', wrapped: null },
  });
}

/**
 * Compute an EOS scan with `runner` ({ modelInfo, compute } — NEP or PET-MAD
 * surface): nPoints volume factors evenly spaced in [1-s, 1+s]
 * (s = maxStrainPct/100) around `baseStructure`'s volume. Each point is
 * relaxed atoms-only at fixed cell (or single-point computed when doRelax is
 * false). Cooperative cancel via shouldStop — aborts between points (and
 * mid-relax) and returns the completed points with stopped:true.
 *
 * Returns { volumes (Å³), energies (eV), pressures (GPa), structures, stopped },
 * sorted by volume; structures are viewer-ready (fractional positions updated
 * from the relaxed cartesians, energy recorded per frame).
 */
export async function runEOSScan(runner, baseStructure, {
  nPoints = 7,
  maxStrainPct = 5,
  fmaxTol = 0.01,
  maxSteps = 200,
  doRelax = true,
  onProgress = (_text) => {},
  shouldStop = /** @type {() => boolean} */ (() => false),
} = {}) {
  const s = maxStrainPct / 100;
  const points = [];
  let stopped = false;

  for (let i = 0; i < nPoints; i += 1) {
    if (shouldStop()) { stopped = true; break; }
    const factor = nPoints > 1 ? (1 - s) + (2 * s * i) / (nPoints - 1) : 1;
    const structure = scaleStructureVolume(baseStructure, factor);
    const point = buildNEPStructure(runner, structure);

    let out;
    if (doRelax) {
      const relaxed = await relaxUntilConverged(runner, point, {
        relaxCell: false,
        fmaxTol,
        maxSteps,
        shouldStop,
        onStep: (step, _current, _out, mF) => {
          onProgress(`point ${i + 1}/${nPoints} — relax step ${step}, max force ${mF.toFixed(4)} eV/Å`);
        },
      });
      if (relaxed.stopped) { stopped = true; break; } // drop the half-relaxed point
      // Fold the relaxed cartesian positions back into the scaled copy.
      const frac = normalizeFractionalPositions(cartToFrac(relaxed.structure.positions, structure.lattice));
      structure.atoms.forEach((atom, j) => { atom.position = [...frac[j]]; });
      out = relaxed.result;
    } else {
      onProgress(`point ${i + 1}/${nPoints} — single-point energy`);
      out = await runner.compute(point);
    }

    const energy = Number(out.total_energy);
    structure.energy = energy; // per-frame energy, like an MD/relax trajectory
    points.push({
      volume: latticeVolume(structure.lattice),
      energy,
      // NaN (not a throw) when the calculator provides no stress — the P-V
      // fit then fails visibly in the panel instead of killing the scan.
      pressure: out.stress?.matrix3x3 ? pressureGPaFromStress(out.stress.matrix3x3) : NaN,
      structure,
    });
  }

  points.sort((a, b) => a.volume - b.volume);
  return {
    volumes: points.map((p) => p.volume),
    energies: points.map((p) => p.energy),
    pressures: points.map((p) => p.pressure),
    structures: points.map((p) => p.structure),
    stopped,
  };
}
