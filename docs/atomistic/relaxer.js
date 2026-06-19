import { fileBrowser } from '../store.js';
import { updateVisualization } from '../crystal-viewer.js';
import { runPeriodicWrapped } from '../render/LatticeModule.js';
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

//todo : everything here is implemented elsewhere. WE NEED TO REFACTOR INTO A MATH MODULE

const EV_A3_TO_GPA = 160.21766208;

function deformationFromStress(stress, cellStep, targetPressureEvA3 = 0) {
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

  const M = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      M[i][j] -= cellStep * sym[i][j];
    }
  }

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

export function applyRelaxStep(structure, efs, atomStep = 0.02, cellStep = 0.002, targetPressureEvA3 = 0) {
  const activeForces = isWyckoffModeActive(fileBrowser.selectedStructure)
    ? symmetrizeCartesianVectors(efs.forces, structure.lattice, fileBrowser.selectedStructure)
    : efs.forces;

  const moved = structure.positions.map((r, i) => [
    r[0] + atomStep * activeForces[i][0],
    r[1] + atomStep * activeForces[i][1],
    r[2] + atomStep * activeForces[i][2],
  ]);

  const M = deformationFromStress(efs.stress.matrix3x3, cellStep, targetPressureEvA3);

  let newPositions = moved.map((r) => matVec(M, r));
  const newLattice = structure.lattice.map((row) => matVec(M, row));
  if (isWyckoffModeActive(fileBrowser.selectedStructure)) {
    newPositions = symmetrizeCartesianPositions(newPositions, newLattice, fileBrowser.selectedStructure);
  }

  return { lattice: newLattice, positions: newPositions, types: structure.types };
}

export function applyStructureToViewer(nepStruct, structure = fileBrowser.selectedStructure) {
  const frac = normalizeFractionalPositions(cartToFrac(nepStruct.positions, nepStruct.lattice));
  structure.lattice = nepStruct.lattice.map((r) => [...r]);
  structure.atoms.forEach((atom, i) => {
    atom.position = [...frac[i]];
  });

  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);

  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    reRenderAtoms: false,
    reRenderBonds: true,
    reRenderLattice: true,
    reRenderOther: false,
    reRenderComposition: false,
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

  let current = {
    lattice: initial.lattice.map((r) => [...r]),
    positions: initial.positions.map((r) => [...r]),
    types: [...initial.types],
  };

  let out = null;
  let mF = Infinity;
  let pGPa = Infinity;
  let step = 0;

  for (step = 1; step <= maxSteps; step += 1) {
    let t0 = performance.now();
    out = nepRunner.compute(current);
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
    current = applyRelaxStep(current, out, atomStep, cellStep, targetPressureEvA3);
    timing.updateMs += performance.now() - t0;

    t0 = performance.now();
    await nextFrame();
    timing.waitMs += performance.now() - t0;
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
