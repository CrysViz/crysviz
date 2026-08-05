import { fileBrowser, groups, general } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { runPeriodicWrapped, applyFrameFast, BOND_TOPOLOGY_STRIDE, deriveVisibleWrapped, lastFastFrameBail } from '../render/index.js';
import { buildNEPStructure, expandKeptFracToFull } from './relaxer.js';
import { transpose3x3, invert3x3, matVec, cartToFrac, fracToCart, normalizeFractionalPositions } from './math.js';
import {
  getSymmetryDegreesOfFreedom,
  isWyckoffModeActive,
  symmetrizeCartesianPositions,
  symmetrizeCartesianVectors,
} from '../ui/SymmetryEditModule.js';

const KB_EV_PER_K = 8.617333262e-5;
const ACCEL_AFS2_PER_EVAA_AMU = 0.00964853399;
const KE_EV_FACTOR = 103.642695; // m(amu) * v(A/fs)^2 -> eV (without 1/2)
const EV_A3_TO_GPA = 160.21766208;

const MASS_BY_SYMBOL = {
  H: 1.008, He: 4.0026, Li: 6.94, Be: 9.0122, B: 10.81, C: 12.011, N: 14.007, O: 15.999,
  F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305, Al: 26.982, Si: 28.085, P: 30.974, S: 32.06,
  Cl: 35.45, Ar: 39.948, K: 39.098, Ca: 40.078, Sc: 44.956, Ti: 47.867, V: 50.942, Cr: 51.996,
  Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Ga: 69.723, Ge: 72.630,
  As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798, Rb: 85.468, Sr: 87.62, Y: 88.906, Zr: 91.224,
  Nb: 92.906, Mo: 95.95, Tc: 98.0, Ru: 101.07, Rh: 102.91, Pd: 106.42, Ag: 107.87, Cd: 112.41,
  In: 114.82, Sn: 118.71, Sb: 121.76, Te: 127.60, I: 126.90, Xe: 131.29, Cs: 132.91, Ba: 137.33,
  La: 138.91, Ce: 140.12, Pr: 140.91, Nd: 144.24, Pm: 145.0, Sm: 150.36, Eu: 151.96, Gd: 157.25,
  Tb: 158.93, Dy: 162.50, Ho: 164.93, Er: 167.26, Tm: 168.93, Yb: 173.05, Lu: 174.97, Hf: 178.49,
  Ta: 180.95, W: 183.84, Re: 186.21, Os: 190.23, Ir: 192.22, Pt: 195.08, Au: 196.97, Hg: 200.59,
  Tl: 204.38, Pb: 207.2, Bi: 208.98, Ac: 227.0, Th: 232.04, Pa: 231.04, U: 238.03, Np: 237.0,
  Pu: 244.0,
};

function symbolCase(sym) {
  const s = String(sym ?? '').trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function gaussianRand() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clone3xN(a) {
  return a.map((r) => [...r]);
}

function wrapCartesianPositionsToCell(positions, lattice) {
  const frac = normalizeFractionalPositions(cartToFrac(positions, lattice));
  return fracToCart(frac, lattice);
}

function kineticEnergyEv(velocities, masses) {
  let ke = 0;
  for (let i = 0; i < velocities.length; i += 1) {
    const v = velocities[i];
    const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    ke += 0.5 * masses[i] * v2 * KE_EV_FACTOR;
  }
  return ke;
}

function temperatureK(velocities, masses, constrainedDof = null) {
  const dof = Math.max(1, constrainedDof ?? (3 * velocities.length - 3));
  const ke = kineticEnergyEv(velocities, masses);
  return (2 * ke) / (dof * KB_EV_PER_K);
}

function removeCenterOfMassVelocity(velocities, masses) {
  let mtot = 0;
  const p = [0, 0, 0];
  for (let i = 0; i < velocities.length; i += 1) {
    const m = masses[i];
    mtot += m;
    p[0] += m * velocities[i][0];
    p[1] += m * velocities[i][1];
    p[2] += m * velocities[i][2];
  }
  if (mtot <= 0) return;
  const vcom = [p[0] / mtot, p[1] / mtot, p[2] / mtot];
  for (let i = 0; i < velocities.length; i += 1) {
    velocities[i][0] -= vcom[0];
    velocities[i][1] -= vcom[1];
    velocities[i][2] -= vcom[2];
  }
}

export function getMassesFromElements(elements) {
  return elements.map((el) => MASS_BY_SYMBOL[symbolCase(el)] ?? 50.0);
}

// ── Time scales ──────────────────────────────────────────────────────────────
//
// Everything below is in femtoseconds and is anchored to one physical fact: a
// vibrational period scales as sqrt(m), so the fastest motion in the cell — and
// therefore the largest usable timestep — is set by the LIGHTEST atom present.
// A flat 1 fs is right for a carbon-ish solid and plainly wrong for anything
// with hydrogen in it, where an X-H stretch has a period of ~10 fs and 1 fs
// integrates it with ten points per oscillation (visibly non-conserving).

/** Largest sensible timestep for this structure, fs. Anchored at 1 fs for carbon. */
export function recommendedTimestepFs(elements) {
  const masses = getMassesFromElements(elements ?? []);
  if (!masses.length) return 1;
  const lightest = Math.min(...masses);
  const dt = Math.sqrt(lightest / 12.011);
  // Snap DOWN onto a ladder of round values: a box reading 1.15 invites the
  // user to wonder what is special about 1.15 (nothing), and rounding down is
  // the safe direction for an explicit stability limit. Floored at 0.25 fs
  // (below that a run of any length is unaffordable here) and capped at 2 fs
  // (beyond it even heavy-atom solids start to drift).
  const ladder = [0.25, 0.5, 1, 1.5, 2];
  let chosen = ladder[0];
  for (const value of ladder) {
    if (dt >= value) chosen = value;
  }
  return chosen;
}

// Thermostat coupling. CSVR is canonical for ANY tau — tau only sets how fast
// energy is exchanged with the bath — so this is a responsiveness choice, not a
// correctness one, and the textbook 100 fs turned out to be the wrong default
// HERE: structures are usually loaded unrelaxed, and the relaxation dumps
// potential energy faster than a 100 fs coupling removes it. Measured on the
// default structure, 300 K setpoint: 838 K at tau = 100 fs, 458 K at 20 fs,
// 330 K at 5 fs. 20 fs is responsive enough to be usable on a cold start while
// staying slower than the timestep by a comfortable margin.
export const DEFAULT_THERMOSTAT_TAU_FS = 20;

// Barostat coupling. Stochastic cell rescaling is unconditionally stable — a
// sweep from 20 fs to 1000 fs on a K = 100 GPa toy solid never blew up, and the
// volume fluctuation did not grow at tight coupling (sd 5.1 at 20 fs vs 4.6 at
// 1000 fs) — so the only thing tau_p buys is settling time, which scales
// linearly with it (35 steps at 20 fs, 1344 at 1000 fs). The usual ">= 1 ps"
// advice comes from biomolecular water, not from stiff solids in a small cell,
// and at 1000 fs the panel's default 500-step run would end before the barostat
// acted once. 200 fs settles in ~300 steps, which fits inside a default run.
//
// It must still be well slower than the thermostat: the cell does work on the
// atoms, and the bath has to absorb that before the cell moves again. At a
// ratio of 2 an end-to-end NEP run came out ~10% hotter than the same run in
// NVT; at 10x the difference vanished (460 K vs 458 K).
export const DEFAULT_BAROSTAT_TAU_FS = 200;
export const MIN_BAROSTAT_TAU_RATIO = 10;

export function createNEPForceEvaluator(nepRunner) {
  return async ({ lattice, positions, types }) => nepRunner.compute({ lattice, positions, types });
}

export function createVelocityVerletIntegrator() {
  return {
    name: 'velocity-verlet',
    async step(state, dtFs, forceEvaluator) {
      const n = state.positions.length;
      const acc = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const f = state.forces[i];
        const m = state.masses[i];
        acc[i] = [
          ACCEL_AFS2_PER_EVAA_AMU * f[0] / m,
          ACCEL_AFS2_PER_EVAA_AMU * f[1] / m,
          ACCEL_AFS2_PER_EVAA_AMU * f[2] / m,
        ];
      }

      for (let i = 0; i < n; i += 1) {
        state.velocities[i][0] += 0.5 * dtFs * acc[i][0];
        state.velocities[i][1] += 0.5 * dtFs * acc[i][1];
        state.velocities[i][2] += 0.5 * dtFs * acc[i][2];

        state.positions[i][0] += dtFs * state.velocities[i][0];
        state.positions[i][1] += dtFs * state.velocities[i][1];
        state.positions[i][2] += dtFs * state.velocities[i][2];
      }
      state.positions = wrapCartesianPositionsToCell(state.positions, state.lattice);
      if (state.symmetryConstrained) {
        state.positions = symmetrizeCartesianPositions(state.positions, state.lattice);
        state.velocities = symmetrizeCartesianVectors(state.velocities, state.lattice);
      }

      const efs = await forceEvaluator({
        lattice: state.lattice,
        positions: state.positions,
        types: state.types,
      });
      state.forces = state.symmetryConstrained
        ? symmetrizeCartesianVectors(clone3xN(efs.forces), state.lattice)
        : clone3xN(efs.forces);
      state.potentialEnergyEv = Number(efs.total_energy);
      state.stress = clone3xN(efs.stress.matrix3x3);

      for (let i = 0; i < n; i += 1) {
        const f = state.forces[i];
        const m = state.masses[i];
        const a2x = ACCEL_AFS2_PER_EVAA_AMU * f[0] / m;
        const a2y = ACCEL_AFS2_PER_EVAA_AMU * f[1] / m;
        const a2z = ACCEL_AFS2_PER_EVAA_AMU * f[2] / m;
        state.velocities[i][0] += 0.5 * dtFs * a2x;
        state.velocities[i][1] += 0.5 * dtFs * a2y;
        state.velocities[i][2] += 0.5 * dtFs * a2z;
      }
      if (state.symmetryConstrained) {
        state.velocities = symmetrizeCartesianVectors(state.velocities, state.lattice);
      }
    },
  };
}

export function createNoThermostat() {
  return { name: 'none', apply() {} };
}

// ── Pressure ─────────────────────────────────────────────────────────────────
//
// P = 2·KE/(3V) + P_virial. NEP returns σ = -W/V (see stressFromVirial in
// nep_simple.js), and the pressure convention that rises under compression is
// -tr(σ)/3 — verified against FCC Cu in tests/nppressure.bench.js: +118 GPa at
// a = 3.2 Å, ~0 near the energy minimum at Cu's real lattice constant.
//
// The kinetic term is NOT optional. It is what the barostat is balancing
// against: at 300 K and normal solid densities it is a few kbar, so a barostat
// driven by the virial alone would sit at the wrong volume forever.

export function cellVolume(lattice) {
  const [a, b, c] = lattice;
  return Math.abs(
    a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]),
  );
}

/** Virial (potential) part of the pressure, eV/Å³. */
function virialPressureEvA3(stress) {
  if (!Array.isArray(stress) || stress.length < 3) return NaN;
  return -(stress[0][0] + stress[1][1] + stress[2][2]) / 3;
}

/** Instantaneous pressure of an MD state, in GPa (kinetic + virial). */
export function instantaneousPressureGPa(state) {
  const volume = cellVolume(state.lattice);
  if (!(volume > 0)) return NaN;
  const kinetic = (2 * kineticEnergyEv(state.velocities, state.masses)) / (3 * volume);
  const virial = virialPressureEvA3(state.stress);
  if (!Number.isFinite(virial)) return NaN;
  return (kinetic + virial) * EV_A3_TO_GPA;
}

function resolveTargetTemperature(targetTemperatureK, context) {
  const target = typeof targetTemperatureK === 'function'
    ? targetTemperatureK(context)
    : targetTemperatureK;
  return Number.isFinite(target) ? target : null;
}

export function createVelocityRescaleThermostat({ targetTemperatureK = 300, tauFs = 20 } = {}) {
  return {
    name: 'rescale',
    apply(state, dtFs, context = {}) {
      const targetK = resolveTargetTemperature(targetTemperatureK, context);
      state.currentTargetTemperatureK = targetK;
      if (!Number.isFinite(targetK) || targetK <= 0) return;
      const tNow = Math.max(1e-8, temperatureK(state.velocities, state.masses, state.constrainedDof));
      const alpha = Math.max(0, Math.min(1, dtFs / Math.max(1e-6, tauFs)));
      const scale2 = 1 + alpha * (targetK / tNow - 1);
      const scale = Math.sqrt(Math.max(1e-12, scale2));
      for (let i = 0; i < state.velocities.length; i += 1) {
        state.velocities[i][0] *= scale;
        state.velocities[i][1] *= scale;
        state.velocities[i][2] *= scale;
      }
      if (state.symmetryConstrained) {
        state.velocities = symmetrizeCartesianVectors(state.velocities, state.lattice);
      }
    },
  };
}

// Sum of `n` squared standard normals, i.e. a chi-squared draw. Needed by the
// CSVR thermostat, where n is the number of degrees of freedom minus one and so
// is far too large to sample by adding up that many gaussians. Drawn as
// 2·Gamma(n/2) with Marsaglia-Tsang, which is exact rather than a large-n
// approximation (small cells and symmetry-constrained runs have few DOF, which
// is exactly where an approximation would show).
function sumOfSquaredGaussians(n) {
  if (n <= 0) return 0;
  if (n === 1) {
    const g = gaussianRand();
    return g * g;
  }
  return 2 * gammaRand(n / 2);
}

function gammaRand(shape) {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1)·U^(1/a)
    const u = Math.max(Number.MIN_VALUE, Math.random());
    return gammaRand(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = gaussianRand();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Bussi-Donadio-Parrinello canonical sampling through velocity rescaling
 * (J. Chem. Phys. 126, 014101 (2007)).
 *
 * Same shape as the Berendsen rescale it replaces — one global factor on every
 * velocity — plus the stochastic term that makes it actually sample the
 * canonical ensemble. Berendsen damps the kinetic-energy fluctuations instead
 * of reproducing them, so it gives the right mean temperature with the wrong
 * distribution (and the "flying ice cube" drift); this costs the same and is
 * correct, so there is no reason to prefer the old one.
 */
export function createBussiThermostat({ targetTemperatureK = 300, tauFs = 100 } = {}) {
  return {
    name: 'bussi',
    apply(state, dtFs, context = {}) {
      const targetK = resolveTargetTemperature(targetTemperatureK, context);
      state.currentTargetTemperatureK = targetK;
      if (!Number.isFinite(targetK) || targetK <= 0) return;

      const dof = Math.max(1, state.constrainedDof ?? (3 * state.velocities.length - 3));
      const ke = kineticEnergyEv(state.velocities, state.masses);
      if (!(ke > 0)) return;
      // Target kinetic energy for `dof` degrees of freedom.
      const keTarget = 0.5 * dof * KB_EV_PER_K * targetK;

      const decay = Math.exp(-dtFs / Math.max(1e-6, tauFs));
      const r1 = gaussianRand();
      const noise = sumOfSquaredGaussians(dof - 1);
      const ratio = keTarget / (dof * ke);

      const scale2 = decay
        + ratio * (1 - decay) * (r1 * r1 + noise)
        + 2 * r1 * Math.sqrt(ratio * (1 - decay) * decay);
      const scale = Math.sqrt(Math.max(1e-12, scale2));

      for (let i = 0; i < state.velocities.length; i += 1) {
        state.velocities[i][0] *= scale;
        state.velocities[i][1] *= scale;
        state.velocities[i][2] *= scale;
      }
      if (state.symmetryConstrained) {
        state.velocities = symmetrizeCartesianVectors(state.velocities, state.lattice);
      }
    },
  };
}

export function createNoBarostat() {
  return { name: 'none', apply() {} };
}

/**
 * Stochastic cell rescaling, isotropic (Bernetti & Bussi, J. Chem. Phys. 153,
 * 114107 (2020)) — the CSVR of barostats: first-order relaxation towards the
 * target pressure plus the noise term that makes the volume distribution the
 * correct isothermal-isobaric one.
 *
 *   dε = (β/τ_p)(P - P_ext)dt + sqrt(2 k_B T β/(V τ_p)) dW,   ε = ln V
 *
 * Isotropic on purpose. A uniform dilation commutes with every point-group
 * operation, so it cannot lower the space group — which means this works
 * unchanged in Wyckoff mode, where an anisotropic (Parrinello-Rahman) cell
 * fluctuation would shear a hexagonal cell into a triclinic one and would have
 * to be projected through symmetrizeCartesianStrain first.
 *
 * `compressibility` is β in GPa⁻¹; the default 0.01 corresponds to a bulk
 * modulus of 100 GPa, i.e. a typical hard solid. It only sets the response
 * rate, not the equilibrium volume, so being a factor of a few out costs
 * equilibration time and nothing else.
 */
/**
 * @param {{targetPressureGPa?: number|((context:any)=>number), tauFs?: number,
 *   compressibility?: number}} [opts]
 */
export function createStochasticCellBarostat({
  targetPressureGPa = 0,
  tauFs = 1000,
  compressibility = 0.01,
} = {}) {
  return {
    name: 'stochastic-cell',
    apply(state, dtFs, context = {}) {
      const targetP = typeof targetPressureGPa === 'function'
        ? targetPressureGPa(context)
        : targetPressureGPa;
      if (!Number.isFinite(targetP)) return;

      const volume = cellVolume(state.lattice);
      const pressure = instantaneousPressureGPa(state);
      if (!(volume > 0) || !Number.isFinite(pressure)) return;

      const temperatureTarget = Number.isFinite(state.currentTargetTemperatureK)
        && state.currentTargetTemperatureK > 0
        ? state.currentTargetTemperatureK
        : temperatureK(state.velocities, state.masses, state.constrainedDof);
      const kT = KB_EV_PER_K * temperatureTarget * EV_A3_TO_GPA; // GPa·Å³

      const tau = Math.max(1e-6, tauFs);
      const drift = (compressibility * dtFs / tau) * (pressure - targetP);
      const diffusion = Math.sqrt(Math.max(0,
        (2 * compressibility * kT * dtFs) / (volume * tau)));
      const dEpsilon = drift + diffusion * gaussianRand();

      // exp(dε) is the volume ratio; the cell scales by its cube root. Clamped
      // so one bad force evaluation cannot collapse or explode the cell.
      const volumeRatio = Math.exp(Math.max(-0.05, Math.min(0.05, dEpsilon)));
      const scale = Math.cbrt(volumeRatio);

      state.lattice = state.lattice.map((row) => row.map((v) => v * scale));
      for (let i = 0; i < state.positions.length; i += 1) {
        state.positions[i][0] *= scale;
        state.positions[i][1] *= scale;
        state.positions[i][2] *= scale;
      }
      state.currentPressureGPa = pressure;
      state.currentVolumeA3 = volume * volumeRatio;
    },
  };
}

export function createCosineAnnealingSchedule({
  startTemperatureK = 300,
  peakTemperatureK = 600,
  minTemperatureK = 100,
  peakFraction = 0.3,
  totalSteps = 500,
} = {}) {
  const total = Math.max(1, Number(totalSteps) || 1);
  const peakStep = Math.max(1, Math.min(total - 1, Math.round(total * Math.max(0, Math.min(1, peakFraction)))));
  const cosineLerp = (a, b, t) => a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t))));

  return ({ step }) => {
    const currentStep = Math.max(1, Math.min(total, Number(step) || 1));
    if (currentStep <= peakStep) {
      const rampT = peakStep <= 1 ? 1 : (currentStep - 1) / (peakStep - 1);
      return cosineLerp(startTemperatureK, peakTemperatureK, rampT);
    }
    const coolSpan = Math.max(1, total - peakStep);
    const coolT = (currentStep - peakStep) / coolSpan;
    return cosineLerp(peakTemperatureK, minTemperatureK, coolT);
  };
}

function syncStateSymmetryConstraint(state, structure = fileBrowser.selectedStructure) {
  const symmetryConstrained = isWyckoffModeActive(structure);
  state.symmetryConstrained = symmetryConstrained;
  state.constrainedDof = symmetryConstrained ? getSymmetryDegreesOfFreedom(structure) : null;

  if (!symmetryConstrained) return;

  state.positions = symmetrizeCartesianPositions(state.positions, state.lattice, structure);
  state.velocities = symmetrizeCartesianVectors(state.velocities, state.lattice, structure);
  state.forces = symmetrizeCartesianVectors(state.forces, state.lattice, structure);
}

/**
 * @param {{nepRunner?:any, structure?:any, temperatureTargetK?:number,
 *   zeroMomentum?:boolean, forceEvaluator?:any, initialVelocities?:any}} [opts]
 */
export async function initializeMDState({
  nepRunner,
  structure = fileBrowser.selectedStructure,
  temperatureTargetK = 300,
  zeroMomentum = true,
  forceEvaluator = null,
  // "Continue MD": resume with a prior frame's own velocities instead of a
  // fresh Maxwell-Boltzmann draw. Deep-copied so the returned state doesn't
  // alias whatever array the caller passed in (e.g. a frame's .velocities).
  initialVelocities = null,
} = {}) {
  if (!nepRunner) throw new Error('initializeMDState: nepRunner is required');
  const evalForce = forceEvaluator ?? createNEPForceEvaluator(nepRunner);

  const base = buildNEPStructure(nepRunner, structure);
  // Masses must line up with base.positions, which excludes vacancies — take
  // the elements of exactly the kept atoms (keptIndices null = nothing filtered).
  const keptElements = base.keptIndices
    ? base.keptIndices.map((i) => structure.elements[i])
    : structure.elements;
  const masses = getMassesFromElements(keptElements);
  const n = base.positions.length;
  let velocities;
  if (initialVelocities) {
    velocities = initialVelocities.map((v) => [...v]);
  } else {
    velocities = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const sigma = Math.sqrt((KB_EV_PER_K * temperatureTargetK) / (masses[i] * KE_EV_FACTOR));
      velocities[i] = [sigma * gaussianRand(), sigma * gaussianRand(), sigma * gaussianRand()];
    }
    if (zeroMomentum) removeCenterOfMassVelocity(velocities, masses);
  }
  const symmetryConstrained = isWyckoffModeActive(structure);
  if (symmetryConstrained) {
    for (let i = 0; i < velocities.length; i += 1) {
      velocities[i] = [...velocities[i]];
    }
    const baseLattice = base.lattice.map((row) => [...row]);
    const basePositions = symmetrizeCartesianPositions(base.positions, baseLattice, structure);
    const symVelocities = symmetrizeCartesianVectors(velocities, baseLattice, structure);
    base.positions = basePositions;
    for (let i = 0; i < symVelocities.length; i += 1) velocities[i] = symVelocities[i];
  }

  const efs = await evalForce(base);
  const constrainedDof = getSymmetryDegreesOfFreedom(structure);
  return {
    lattice: clone3xN(base.lattice),
    positions: clone3xN(base.positions),
    types: [...base.types],
    // Original atom index of each kept (non-vacancy) entry, so the viewer apply
    // can map these vacancy-excluded arrays back onto the full atom list.
    keptIndices: base.keptIndices,
    masses,
    velocities,
    forces: symmetryConstrained ? symmetrizeCartesianVectors(clone3xN(efs.forces), base.lattice, structure) : clone3xN(efs.forces),
    stress: clone3xN(efs.stress.matrix3x3),
    potentialEnergyEv: Number(efs.total_energy),
    step: 0,
    timeFs: 0,
    currentTargetTemperatureK: temperatureTargetK,
    symmetryConstrained,
    constrainedDof,
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// Yield to the event loop without waiting for the paint to finish. Used when
// the potential runs in a worker: the browser can paint the frame we just
// pushed while the worker computes the next one, so blocking on rAF here would
// serialise two things that are free to overlap.
function nextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createTimingProfile(label) {
  return {
    label,
    totalMs: 0,
    integrateMs: 0,
    forceEvalMs: 0,
    thermostatMs: 0,
    onStepMs: 0,
    waitMs: 0,
    steps: 0,
  };
}

// Buckets the MD loop cannot time itself: the work the caller's onStep does
// (pushing the frame to the viewer, feeding the plot, snapshotting a trajectory
// frame). AtomisticPanels reports into these through mdProfileMeasure so the
// breakdown printed at the end of a run accounts for the whole step, not just
// the parts inside runMDSimulation. Reset per run.
const mdProfileBuckets = { viewerMs: 0, plotMs: 0, saveMs: 0, fastFrames: 0, fullFrames: 0 };

function resetMdProfileBuckets() {
  mdProfileBuckets.viewerMs = 0;
  mdProfileBuckets.plotMs = 0;
  mdProfileBuckets.saveMs = 0;
  mdProfileBuckets.fastFrames = 0;
  mdProfileBuckets.fullFrames = 0;
}

/** Time `fn` into one of the onStep buckets — a no-op unless profiling is on. */
export function mdProfileMeasure(bucket, fn) {
  if (!general.mdProfile || !(bucket in mdProfileBuckets)) return fn();
  const t0 = performance.now();
  const result = fn();
  mdProfileBuckets[bucket] += performance.now() - t0;
  return result;
}

function logMdProfile(timing) {
  const { totalMs, steps } = timing;
  if (!steps || totalMs <= 0) return;
  const pct = (ms) => `${(100 * ms / totalMs).toFixed(1)}%`;
  const row = (name, ms) => `${name.padEnd(18)} ${(ms / steps).toFixed(2).padStart(8)} ms/step  ${pct(ms).padStart(6)}`;
  // integrateMs contains the force evaluation (the integrator awaits it), so
  // the JS-side integration cost is the difference.
  const integrationOnly = Math.max(0, timing.integrateMs - timing.forceEvalMs);
  const accounted = timing.integrateMs + timing.thermostatMs + timing.onStepMs + timing.waitMs;
  console.log(
    [
      `[MD profile] ${steps} steps in ${totalMs.toFixed(0)} ms — `
        + `${(1000 * steps / totalMs).toFixed(1)} steps/s (${(totalMs / steps).toFixed(2)} ms/step)`,
      row('force eval', timing.forceEvalMs),
      row('integration (JS)', integrationOnly),
      row('thermostat', timing.thermostatMs),
      row('onStep total', timing.onStepMs),
      row('  · viewer', mdProfileBuckets.viewerMs),
      row('  · plot', mdProfileBuckets.plotMs),
      row('  · frame save', mdProfileBuckets.saveMs),
      row('rAF wait', timing.waitMs),
      row('unaccounted', Math.max(0, totalMs - accounted)),
      `viewer frames      ${mdProfileBuckets.fastFrames} fast / ${mdProfileBuckets.fullFrames} full rebuild`
        + (mdProfileBuckets.fullFrames ? ` (last fallback: ${lastFastFrameBail() ?? 'stride/forced'})` : ''),
    ].join('\n'),
  );
}

/**
 * @param {{state?:any, steps?:number, dtFs?:number, forceEvaluator?:any,
 *   integrator?:any, thermostat?:any, barostat?:any, onStep?:any,
 *   shouldStop?:any, offThreadForces?:boolean}} [opts]
 */
export async function runMDSimulation({
  state,
  steps = 500,
  dtFs = 1.0,
  forceEvaluator,
  integrator = createVelocityVerletIntegrator(),
  thermostat = createNoThermostat(),
  barostat = createNoBarostat(),
  onStep = null,
  shouldStop = null,
  // True when forceEvaluator does its work off the main thread (the NEP
  // worker). Changes only how this loop yields — see nextMacrotask.
  offThreadForces = false,
} = {}) {
  if (!state) throw new Error('runMDSimulation: state is required');
  if (!forceEvaluator) throw new Error('runMDSimulation: forceEvaluator is required');
  const stop = shouldStop ?? (() => false);
  let stopped = false;
  const startStep = state.step;
  const timing = createTimingProfile('MD');
  resetMdProfileBuckets();
  // Force evaluation happens inside integrator.step (it awaits the evaluator),
  // so the only way to separate "the potential" from "our JS" is to time the
  // evaluator itself.
  const timedForceEvaluator = async (cell) => {
    const t = performance.now();
    const result = await forceEvaluator(cell);
    timing.forceEvalMs += performance.now() - t;
    return result;
  };
  const totalStart = performance.now();
  // Run consecutive steps without yielding to the render loop until this many
  // ms have elapsed since the last rAF yield, then yield once. Keeps fast
  // integration off the ~60 fps cap while still letting the browser paint; slow
  // (async MLIP) force evals exceed the budget every step and degrade to one
  // yield per step (prior behavior).
  const FRAME_BUDGET_MS = 12;
  let lastYield = performance.now();

  for (let i = 1; i <= steps; i += 1) {
    if (stop()) {
      stopped = true;
      break;
    }

    syncStateSymmetryConstraint(state);

    let t0 = performance.now();
    await integrator.step(state, dtFs, timedForceEvaluator);
    timing.integrateMs += performance.now() - t0;

    t0 = performance.now();
    thermostat.apply(state, dtFs, {
      step: state.step + 1,
      totalSteps: steps,
      timeFs: state.timeFs + dtFs,
      state,
    });
    // Barostat after the thermostat and inside the same timing bucket: it is a
    // handful of scalar operations plus one cell scaling, far below the noise
    // floor of a force evaluation.
    barostat.apply(state, dtFs, {
      step: state.step + 1,
      totalSteps: steps,
      timeFs: state.timeFs + dtFs,
      state,
    });
    timing.thermostatMs += performance.now() - t0;

    state.step += 1;
    state.timeFs += dtFs;

    const ke = kineticEnergyEv(state.velocities, state.masses);
    const temp = temperatureK(state.velocities, state.masses, state.constrainedDof);
    const epot = state.potentialEnergyEv;
    const etot = epot + ke;
    const pressureGPa = instantaneousPressureGPa(state);
    const volumeA3 = cellVolume(state.lattice);

    if (onStep) {
      t0 = performance.now();
      onStep({
        step: state.step,
        timeFs: state.timeFs,
        temperatureK: temp,
        targetTemperatureK: state.currentTargetTemperatureK,
        epotEv: epot,
        ekinEv: ke,
        etotEv: etot,
        pressureGPa,
        volumeA3,
        state,
      });
      timing.onStepMs += performance.now() - t0;
    }
    timing.steps = state.step - startStep;

    if (stop()) {
      stopped = true;
      break;
    }
    if (performance.now() - lastYield >= FRAME_BUDGET_MS) {
      t0 = performance.now();
      await (offThreadForces ? nextMacrotask() : nextFrame());
      timing.waitMs += performance.now() - t0;
      lastYield = performance.now();
    }
  }
  timing.totalMs = performance.now() - totalStart;
  timing.viewerMs = mdProfileBuckets.viewerMs;
  timing.plotMs = mdProfileBuckets.plotMs;
  timing.saveMs = mdProfileBuckets.saveMs;
  if (general.mdProfile) logMdProfile(timing);

  return {
    stopped,
    stepsRun: state.step - startStep,
    timing,
  };
}

let _mdViewerUpdateCount = 0;

export function applyMDStateToViewer(
  state,
  structure = fileBrowser.selectedStructure,
  { forceRerender = false, full = false } = {},
) {
  const invL = invert3x3(transpose3x3(state.lattice));
  const keptFrac = state.positions.map((r) => {
    const f = matVec(invL, r);
    return [((f[0] % 1) + 1) % 1, ((f[1] % 1) + 1) % 1, ((f[2] % 1) + 1) % 1];
  });
  // Vacancies aren't in the MD state; put them back so the full atom list stays
  // aligned (they hold their fractional position, inert to the dynamics).
  const frac = expandKeptFracToFull(structure, keptFrac, state.keptIndices);

  structure.lattice = clone3xN(state.lattice);
  structure.atoms.forEach((atom, i) => {
    atom.position = [...frac[i]];
  });
  // Carried onto every emitted frame (via snapshotCurrentStructure, which
  // copies structure.velocities like it does structure.forces) so "Continue
  // MD" can later resume from a frame's own velocities instead of redrawing.
  // Guarded: callers may pass a minimal state (e.g. tests driving positions
  // only) with no velocities to carry.
  if (Array.isArray(state.velocities)) {
    structure.velocities = clone3xN(state.velocities);
  }

  if (!structure.periodic) structure.periodic = { hash: 'None', wrapped: null };

  _mdViewerUpdateCount += 1;
  const strideDue = _mdViewerUpdateCount % BOND_TOPOLOGY_STRIDE === 0;

  // Fast in-place update; skipped on run-end full apply, caller-forced rebuilds,
  // and the periodic bond-topology refresh. Returns false on topology change.
  if (!full && !forceRerender && !strideDue && structure.periodic.wrapped && applyFrameFast(structure)) {
    mdProfileBuckets.fastFrames += 1;
    return;
  }
  mdProfileBuckets.fullFrames += 1;

  // Full path: re-establishes topology (fast path resumes on the next frame).
  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);
  // .visibleWrapped is derived from the .wrapped just recomputed — derive it here
  // too, not only inside updateVisualization, because the rebuild decision below
  // counts its instances and a stale count leaves orphan instances in the mesh.
  deriveVisibleWrapped(structure);
  const wrappedCount = structure.periodic.visibleWrapped?.elements?.length ?? 0;
  const needAtomRebuild = full || forceRerender || !groups.atomsMesh || groups.atomsMesh.count !== wrappedCount;
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

