import { fileBrowser, groups, general } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { runPeriodicWrapped, applyFrameFast, BOND_TOPOLOGY_STRIDE, deriveVisibleWrapped } from '../render/index.js';

let _viewerUpdateCount = 0;
import {
  fracToCart,
  cartToFrac,
  matVec,
  normalizeFractionalPositions,
} from './math.js';
import { symmetrizeCartesianPositions, symmetrizeCartesianVectors, isWyckoffModeActive } from '../ui/SymmetryEditModule.js';

function symbolCase(sym) {
  const s = String(sym ?? '').trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

// TODO: everything here is implemented elsewhere; refactor into a math module.

const EV_A3_TO_GPA = 160.21766208;

// Cell relaxation: FIRE on the 6 Voigt strain components, independent of the
// atomic FIRE state (no combined atom+cell vector, so no ASE-style cell-factor
// norm balancing is needed). Generalized force on strain is
// g = -(sym(σ) + P_target·I); the first step reproduces the legacy fixed step
// dε = -cellStep·g, and velocity accumulation grows it adaptively from there.
// That matters: a sensible strain step is ~σ/B (B = bulk modulus, ~0.6 eV/Å³
// for Si), i.e. an effective cellStep of ~1/B ≈ 1.6 — the legacy 0.002 was
// ~800× under-stepped. dtMax is chosen so dtMax² ≈ 900·cellStep ≈ 1/B.
function deformationFromStress(stress, cellFire, targetPressureEvA3 = 0) {
  const sym = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      sym[i][j] = 0.5 * (stress[i][j] + stress[j][i]);
    }
  }

  //the update acts on (sigma - sigma_target) = (sigma + P_target * I).
  for (let i = 0; i < 3; i += 1) {
    sym[i][i] += targetPressureEvA3;
  }

  // Voigt [xx, yy, zz, yz, xz, xy]
  const g = [-sym[0][0], -sym[1][1], -sym[2][2], -sym[1][2], -sym[0][2], -sym[0][1]];
  const v = cellFire.v;
  let power = 0;
  let v2 = 0;
  let g2 = 0;
  for (let i = 0; i < 6; i += 1) {
    power += g[i] * v[i];
    v2 += v[i] * v[i];
    g2 += g[i] * g[i];
  }
  if (power > 0) {
    const scale = g2 > 0 ? Math.sqrt(v2 / g2) : 0;
    for (let i = 0; i < 6; i += 1) {
      v[i] = (1 - cellFire.alpha) * v[i] + cellFire.alpha * scale * g[i];
    }
    cellFire.nPos += 1;
    if (cellFire.nPos > FIRE_N_MIN) {
      cellFire.dt = Math.min(cellFire.dt * FIRE_F_INC, cellFire.dtMax);
      cellFire.alpha *= FIRE_F_ALPHA;
    }
  } else {
    v.fill(0);
    cellFire.alpha = FIRE_ALPHA_START;
    cellFire.dt *= FIRE_F_DEC;
    cellFire.nPos = 0;
  }
  for (let i = 0; i < 6; i += 1) v[i] += cellFire.dt * g[i];
  const e = v.map((c) => cellFire.dt * c);

  const M = [
    [1 + e[0], e[5], e[4]],
    [e[5], 1 + e[1], e[3]],
    [e[4], e[3], 1 + e[2]],
  ];

  // Trust region (unchanged): at most 4% axial / 3% shear strain per step.
  // Clamping decouples the realized strain from v·dt for that step; FIRE's
  // power sign still catches the overshoot on the next evaluation.
  for (let i = 0; i < 3; i += 1) {
    M[i][i] = Math.max(0.96, Math.min(1.04, M[i][i]));
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (i === j) continue;
      M[i][j] = Math.max(-0.03, Math.min(0.03, M[i][j]));
    }
  }

  return M;
}

export function buildNEPStructure(nepRunner, structure = fileBrowser.selectedStructure) {
  const lattice = structure.lattice.map((row) => [...row]);
  const frac = structure.atoms.map((a) => a.position);
  const positions = fracToCart(frac, lattice);

  const modelElements = nepRunner.modelInfo.element_list.map(symbolCase);
  const symbols = structure.elements.map(symbolCase);
  const types = symbols.map((sym) => {
    const i = modelElements.indexOf(sym);
    if (i < 0) throw new Error(`Model does not support element: ${sym}`);
    return i;
  });

  return { lattice, positions, types };
}

export function maxForce(forces) {
  return Math.max(...forces.map((v) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)));
}

export function pressureFromStress(stress) {
  // Pressure conventio -trace(stress)/3 - not sure if this is right but the cell moves in the right direction
  return -(stress[0][0] + stress[1][1] + stress[2][2]) / 3.0;
}

export function pressureGPaFromStress(stress) {
  return pressureFromStress(stress) * EV_A3_TO_GPA;
}

// Trace of a 3×3 stress tensor (σxx+σyy+σzz), in whatever units the tensor is.
// Guarded: returns NaN for a missing/malformed tensor instead of throwing, so
// callers can plot pressure only when stress data actually exists.
export function stressTrace(stress) {
  if (!Array.isArray(stress) || stress.length < 3) return NaN;
  const xx = stress[0]?.[0];
  const yy = stress[1]?.[1];
  const zz = stress[2]?.[2];
  if (!Number.isFinite(xx) || !Number.isFinite(yy) || !Number.isFinite(zz)) return NaN;
  return xx + yy + zz;
}

// Mean of the stress-tensor diagonal, (σxx+σyy+σzz)/3 — the isotropic (scalar)
// stress plotted as "pressure" on the trajectory chart. NaN for missing data.
export function stressMean(stress) {
  const tr = stressTrace(stress);
  return Number.isFinite(tr) ? tr / 3 : NaN;
}

// FIRE — Fast Inertial Relaxation Engine (Bitzek et al., PRL 97, 170201
// (2006)), semi-implicit Euler variant with the ASE update order. Unit atomic
// mass, so dt² carries units of Å²/(eV/Å): the first step's displacement is
// dt²·F, and dt is seeded from the legacy atomStep knob so the previous step
// size keeps its meaning as the starting (pre-acceleration) step.
const FIRE_N_MIN = 5;        // uphill-free steps before dt may grow
const FIRE_F_INC = 1.1;      // dt growth factor
const FIRE_F_DEC = 0.5;      // dt cut on overshoot (power <= 0)
const FIRE_ALPHA_START = 0.1;
const FIRE_F_ALPHA = 0.99;   // alpha decay while descending
const FIRE_MAX_STEP_A = 0.2; // per-atom displacement cap (Å)

function createFireState(atomStep, cellStep, nAtoms) {
  const dt = Math.sqrt(Math.max(Number(atomStep) || 0.02, 1e-4));
  const cellDt = Math.sqrt(Math.max(Number(cellStep) || 0.002, 1e-6));
  return {
    dt,
    dtMax: 10 * dt,
    alpha: FIRE_ALPHA_START,
    nPos: 0,
    velocities: Array.from({ length: nAtoms }, () => [0, 0, 0]),
    cell: {
      dt: cellDt,
      dtMax: 30 * cellDt,
      alpha: FIRE_ALPHA_START,
      nPos: 0,
      v: new Float64Array(6),
    },
  };
}

export function applyRelaxStep(structure, efs, fire, targetPressureEvA3 = 0) {
  const activeForces = isWyckoffModeActive(fileBrowser.selectedStructure)
    ? symmetrizeCartesianVectors(efs.forces, structure.lattice, fileBrowser.selectedStructure)
    : efs.forces;
  const v = fire.velocities;
  const n = structure.positions.length;

  // Power with the incoming velocities (ASE order: mix, then accelerate).
  let power = 0;
  let vNorm2 = 0;
  let fNorm2 = 0;
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      power += activeForces[i][k] * v[i][k];
      vNorm2 += v[i][k] * v[i][k];
      fNorm2 += activeForces[i][k] * activeForces[i][k];
    }
  }

  if (power > 0) {
    const scale = fNorm2 > 0 ? Math.sqrt(vNorm2 / fNorm2) : 0;
    for (let i = 0; i < n; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        v[i][k] = (1 - fire.alpha) * v[i][k] + fire.alpha * scale * activeForces[i][k];
      }
    }
    fire.nPos += 1;
    if (fire.nPos > FIRE_N_MIN) {
      fire.dt = Math.min(fire.dt * FIRE_F_INC, fire.dtMax);
      fire.alpha *= FIRE_F_ALPHA;
    }
  } else {
    // Overshot: kill inertia, restart cautiously.
    for (let i = 0; i < n; i += 1) {
      v[i][0] = 0; v[i][1] = 0; v[i][2] = 0;
    }
    fire.alpha = FIRE_ALPHA_START;
    fire.dt *= FIRE_F_DEC;
    fire.nPos = 0;
  }

  // v += dt·F (unit mass), then move with a per-atom displacement cap so a
  // late dt growth cannot fling atoms through the cell.
  const moved = structure.positions.map((r, i) => {
    let dx = 0; let dy = 0; let dz = 0;
    v[i][0] += fire.dt * activeForces[i][0];
    v[i][1] += fire.dt * activeForces[i][1];
    v[i][2] += fire.dt * activeForces[i][2];
    dx = fire.dt * v[i][0];
    dy = fire.dt * v[i][1];
    dz = fire.dt * v[i][2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > FIRE_MAX_STEP_A) {
      const s = FIRE_MAX_STEP_A / d;
      dx *= s; dy *= s; dz *= s;
    }
    return [r[0] + dx, r[1] + dy, r[2] + dz];
  });

  const M = deformationFromStress(efs.stress.matrix3x3, fire.cell, targetPressureEvA3);

  let newPositions = moved.map((r) => matVec(M, r));
  const newLattice = structure.lattice.map((row) => matVec(M, row));
  if (isWyckoffModeActive(fileBrowser.selectedStructure)) {
    newPositions = symmetrizeCartesianPositions(newPositions, newLattice, fileBrowser.selectedStructure);
  }

  return { lattice: newLattice, positions: newPositions, types: structure.types };
}

export function applyStructureToViewer(nepStruct, structure = fileBrowser.selectedStructure, { full = false } = {}) {
  const frac = normalizeFractionalPositions(cartToFrac(nepStruct.positions, nepStruct.lattice));
  structure.lattice = nepStruct.lattice.map((r) => [...r]);
  structure.atoms.forEach((atom, i) => {
    atom.position = [...frac[i]];
  });

  _viewerUpdateCount += 1;
  const strideDue = _viewerUpdateCount % BOND_TOPOLOGY_STRIDE === 0;

  // Fast in-place update; skipped on the run-end full apply and on the periodic
  // bond-topology refresh. Returns false when topology changed -> fall through.
  if (!full && !strideDue && applyFrameFast(structure)) {
    return;
  }

  // Full path: re-establishes topology (fast path resumes on the next frame).
  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);
  // See applyMDStateToViewer: the rebuild decision counts .visibleWrapped, so it
  // must be re-derived from the freshly recomputed .wrapped before we read it.
  deriveVisibleWrapped(structure);
  const wrappedCount = structure.periodic.visibleWrapped?.elements?.length ?? 0;
  const needAtomRebuild = full || !groups.atomsMesh || groups.atomsMesh.count !== wrappedCount;
  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    reRenderAtoms: needAtomRebuild,
    reRenderBonds: true,
    reRenderLattice: true,
    reRenderOther: false,
    reRenderComposition: false,
    // Polyhedra track the moving atoms whenever the feature is visible (the fast
    // path bails in that mode, so every frame lands here); otherwise only refresh
    // them on the run-end full apply (P6).
    reRenderPolyhedra: full || general.showPolyhedra || general.completePolyhedra,
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function createTimingProfile(label) {
  return {
    label,
    totalMs: 0,
    computeMs: 0,
    onStepMs: 0,
    updateMs: 0,
    waitMs: 0,
    steps: 0,
  };
}

export async function relaxUntilConverged(nepRunner, initial, opts = {}) {
  const fmaxTol = Number(opts.fmaxTol ?? 0.01);
  const maxSteps = Number(opts.maxSteps ?? 250);
  const atomStep = Number(opts.atomStep ?? 0.02);
  const cellStep = Number(opts.cellStep ?? 0.002);
  const targetPressureGPa = Number(opts.targetPressureGPa ?? 0.0);
  const pressureTolGPa = Number(opts.pressureTolGPa ?? 0.2);
  const targetPressureEvA3 = targetPressureGPa / EV_A3_TO_GPA;
  const onStep = opts.onStep ?? (() => {});
  const timing = createTimingProfile('Relax');
  const totalStart = performance.now();
  // Run consecutive steps without yielding to the render loop until this many
  // ms have elapsed since the last rAF yield, then yield once. This keeps
  // throughput off the ~60 fps cap when steps are fast, while still letting the
  // browser paint. For slow (e.g. async MLIP) computes the budget is exceeded
  // every step, degrading gracefully to one yield per step (prior behavior).
  const FRAME_BUDGET_MS = 12;
  let lastYield = performance.now();

  let current = {
    lattice: initial.lattice.map((r) => [...r]),
    positions: initial.positions.map((r) => [...r]),
    types: [...initial.types],
  };

  let out = null;
  let mF = Infinity;
  let pGPa = Infinity;
  let step = 0;
  const fire = createFireState(atomStep, cellStep, current.positions.length);

  for (step = 1; step <= maxSteps; step += 1) {
    let t0 = performance.now();
    // NEP's compute is synchronous; MLIPRunner's is async. Awaiting a plain
    // value is a no-op, so this supports both runners.
    out = await nepRunner.compute(current);
    timing.computeMs += performance.now() - t0;
    mF = maxForce(out.forces);
    pGPa = pressureGPaFromStress(out.stress.matrix3x3);

    t0 = performance.now();
    onStep(step, current, out, mF);
    timing.onStepMs += performance.now() - t0;
    timing.steps = step;

    const forceOK = mF <= fmaxTol;
    const pressureOK = Math.abs(pGPa - targetPressureGPa) <= pressureTolGPa;
    if ((forceOK && pressureOK) || step === maxSteps) break;

    t0 = performance.now();
    current = applyRelaxStep(current, out, fire, targetPressureEvA3);
    timing.updateMs += performance.now() - t0;

    if (performance.now() - lastYield >= FRAME_BUDGET_MS) {
      t0 = performance.now();
      await nextFrame();
      timing.waitMs += performance.now() - t0;
      lastYield = performance.now();
    }
  }
  timing.totalMs = performance.now() - totalStart;

  const convergedForce = mF <= fmaxTol;
  const convergedPressure = Math.abs(pGPa - targetPressureGPa) <= pressureTolGPa;

  return {
    structure: current,
    result: out,
    steps: step,
    maxForce: mF,
    pressureGPa: pGPa,
    convergedForce,
    convergedPressure,
    converged: convergedForce && convergedPressure,
    timing,
  };
}
