import { fileBrowser } from '../store.js';
import { updateVisualization } from '../crystal-viewer.js';
import { runPeriodicWrapped } from '../modules/LatticeModule.js';
import {
  fracToCart,
  cartToFrac,
  matVec,
} from './math.js';

function symbolCase(sym) {
  const s = String(sym ?? '').trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function wrapFrac01(frac) {
  return frac.map((v) => {
    let x = v - Math.floor(v);
    if (x < 0) x += 1;
    return x >= 1 ? 0 : x;
  });
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
  const moved = structure.positions.map((r, i) => [
    r[0] + atomStep * efs.forces[i][0],
    r[1] + atomStep * efs.forces[i][1],
    r[2] + atomStep * efs.forces[i][2],
  ]);

  const M = deformationFromStress(efs.stress.matrix3x3, cellStep, targetPressureEvA3);

  const newPositions = moved.map((r) => matVec(M, r));
  const newLattice = structure.lattice.map((row) => matVec(M, row));

  return { lattice: newLattice, positions: newPositions, types: structure.types };
}

export function applyStructureToViewer(nepStruct, structure = fileBrowser.selectedStructure) {
  const frac = cartToFrac(nepStruct.positions, nepStruct.lattice).map(wrapFrac01);
  structure.lattice = nepStruct.lattice.map((r) => [...r]);
  structure.atoms.forEach((atom, i) => {
    atom.position = [...frac[i]];
  });

  if (!structure.periodic) {
    structure.periodic = { hash: 'None', wrapped: null };
  }
  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);

  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    reRenderAtoms: false,
    reRenderBonds: false,
    reRenderLattice: true,
    reRenderOther: false,
    reRenderComposition: false,
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
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
    out = nepRunner.compute(current);
    mF = maxForce(out.forces);
    pGPa = pressureGPaFromStress(out.stress.matrix3x3);
    onStep(step, current, out, mF);

    const forceOK = mF <= fmaxTol;
    const pressureOK = Math.abs(pGPa - targetPressureGPa) <= pressureTolGPa;
    if ((forceOK && pressureOK) || step === maxSteps) break;

    current = applyRelaxStep(current, out, atomStep, cellStep, targetPressureEvA3);
    await nextFrame();
  }

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
  };
}
