import { ColoredObject } from './ColoredObject.js';

// ── The app's one stress convention ──────────────────────────────────────────
//
// A stored stress tensor (Stress.tensor, frame-store `stress`, calculator
// `out.stress.matrix3x3`) is in eV/Å³ with the Quantum ESPRESSO sign:
// compression is positive and the pressure is the plain mean of the diagonal,
// P = (S_xx + S_yy + S_zz) / 3 — no minus sign anywhere. GPa is a display unit
// only (pressureGPa / tensorGPa).
//
// Sources are converted ONCE, where they enter the app:
//   QE "total stress" (kbar), VASP OUTCAR "in kB"     same sign, unit change
//   ASE (.traj, the ASE server), NEP, PET-MAD,        tension-positive (P = -tr/3):
//   CASTEP .geom/.md (Hartree/Bohr³)                  negated, plus unit change
// ASE's own readers confirm it: they negate QE's and VASP's printed stress to
// reach ASE's tension-positive convention and pass CASTEP's through unchanged.

export const EV_PER_A3_TO_GPA = 160.21766208;
/** 1 kbar = 0.1 GPa, in eV/Å³. */
export const KBAR_TO_EV_PER_A3 = 0.1 / EV_PER_A3_TO_GPA;
/** Hartree/Bohr³ in eV/Å³. */
export const HARTREE_PER_BOHR3_TO_EV_PER_A3 = 27.211386245988 / 0.52917721067 ** 3;

function isTensor(tensor) {
  return Array.isArray(tensor) && tensor.length === 3
    && tensor.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite));
}

const mapTensor = (tensor, fn) => tensor.map((row) => row.map(fn));

/** Pressure of a stored tensor, eV/Å³ (compression positive). NaN when absent. */
export function pressureEvA3(tensor) {
  return isTensor(tensor) ? (tensor[0][0] + tensor[1][1] + tensor[2][2]) / 3 : NaN;
}

/** Pressure of a stored tensor, GPa (compression positive). NaN when absent. */
export function pressureGPa(tensor) {
  return pressureEvA3(tensor) * EV_PER_A3_TO_GPA;
}

/** A stored tensor in GPa, for display. null when absent. */
export function tensorGPa(tensor) {
  return isTensor(tensor) ? mapTensor(tensor, (v) => v * EV_PER_A3_TO_GPA) : null;
}

/** A tension-positive tensor (ASE, NEP, PET-MAD, CASTEP) in the app's sign. */
export function fromTensionPositive(tensor, scale = 1) {
  return mapTensor(tensor, (v) => (v === 0 ? 0 : -v * scale)); // no -0 in the copy
}

export class Stress extends ColoredObject {
  constructor({ tensor = [[0,0,0],[0,0,0],[0,0,0]], scaling = [], color = [], stressGroup = null } = {}) {
    const defaultColor = [];
    super({ color, defaultColor});
    this.tensor = Stress._validateTensor(tensor);
    this.pearson = Stress._computePearsonMeasure(this.tensor);
    this.scaling = scaling;
    this.stressGroup = stressGroup;
  }

  get N() {
    return this.scaling.length;
  }

  /** eV/Å³, compression positive (see the convention above). */
  get pressureEvA3() {
    return pressureEvA3(this.tensor);
  }

  /** GPa, compression positive. */
  get pressureGPa() {
    return pressureGPa(this.tensor);
  }

  setTensor(tensor) {
    this.tensor = Stress._validateTensor(tensor);
  }

  static _computePearsonMeasure(tensor) {
    return -1 ;
  }

  static _validateTensor(tensor) {
    if (!Array.isArray(tensor) || tensor.length !== 3) throw new Error("tensor must be a 3×3 array");
    for (let i = 0; i < 3; i++) {
      if (!Array.isArray(tensor[i]) || tensor[i].length !== 3) throw new Error("tensor must be a 3×3 array");
      for (let j = 0; j < 3; j++) {
        const v = tensor[i][j];
        if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`tensor[${i}][${j}] must be a finite number`);
      }
    }
    return tensor;
  }
}
