import { fileBrowser } from '../store.js';
import { updateVisualization } from '../crystal-viewer.js';
import { runPeriodicWrapped } from '../modules/LatticeModule.js';
import { buildNEPStructure } from './relaxer.js';
import { transpose3x3, invert3x3, matVec, cartToFrac, fracToCart, normalizeFractionalPositions } from './math.js';
import {
  getSymmetryDegreesOfFreedom,
  isWyckoffModeActive,
  symmetrizeCartesianPositions,
  symmetrizeCartesianVectors,
} from '../modules/SymmetryEditModule.js';

const KB_EV_PER_K = 8.617333262e-5;
const ACCEL_AFS2_PER_EVAA_AMU = 0.00964853399;
const KE_EV_FACTOR = 103.642695; // m(amu) * v(A/fs)^2 -> eV (without 1/2)

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

export async function initializeMDState({
  nepRunner,
  structure = fileBrowser.selectedStructure,
  temperatureTargetK = 300,
  zeroMomentum = true,
  forceEvaluator = null,
} = {}) {
  if (!nepRunner) throw new Error('initializeMDState: nepRunner is required');
  const evalForce = forceEvaluator ?? createNEPForceEvaluator(nepRunner);

  const base = buildNEPStructure(nepRunner, structure);
  const masses = getMassesFromElements(structure.elements);
  const n = base.positions.length;
  const velocities = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const sigma = Math.sqrt((KB_EV_PER_K * temperatureTargetK) / (masses[i] * KE_EV_FACTOR));
    velocities[i] = [sigma * gaussianRand(), sigma * gaussianRand(), sigma * gaussianRand()];
  }
  if (zeroMomentum) removeCenterOfMassVelocity(velocities, masses);
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

function createTimingProfile(label) {
  return {
    label,
    totalMs: 0,
    integrateMs: 0,
    thermostatMs: 0,
    onStepMs: 0,
    waitMs: 0,
    steps: 0,
  };
}

export async function runMDSimulation({
  state,
  steps = 500,
  dtFs = 1.0,
  forceEvaluator,
  integrator = createVelocityVerletIntegrator(),
  thermostat = createNoThermostat(),
  onStep = null,
  shouldStop = null,
} = {}) {
  if (!state) throw new Error('runMDSimulation: state is required');
  if (!forceEvaluator) throw new Error('runMDSimulation: forceEvaluator is required');
  const stop = shouldStop ?? (() => false);
  let stopped = false;
  const startStep = state.step;
  const timing = createTimingProfile('MD');
  const totalStart = performance.now();

  for (let i = 1; i <= steps; i += 1) {
    if (stop()) {
      stopped = true;
      break;
    }

    syncStateSymmetryConstraint(state);

    let t0 = performance.now();
    await integrator.step(state, dtFs, forceEvaluator);
    timing.integrateMs += performance.now() - t0;

    t0 = performance.now();
    thermostat.apply(state, dtFs, {
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
        state,
      });
      timing.onStepMs += performance.now() - t0;
    }
    timing.steps = state.step - startStep;

    if (stop()) {
      stopped = true;
      break;
    }
    t0 = performance.now();
    await nextFrame();
    timing.waitMs += performance.now() - t0;
  }
  timing.totalMs = performance.now() - totalStart;

  return {
    stopped,
    stepsRun: state.step - startStep,
    timing,
  };
}

export function applyMDStateToViewer(
  state,
  structure = fileBrowser.selectedStructure,
  { forceRerender = false } = {},
) {
  const invL = invert3x3(transpose3x3(state.lattice));
  const frac = state.positions.map((r) => {
    const f = matVec(invL, r);
    return [((f[0] % 1) + 1) % 1, ((f[1] % 1) + 1) % 1, ((f[2] % 1) + 1) % 1];
  });

  structure.lattice = clone3xN(state.lattice);
  structure.atoms.forEach((atom, i) => {
    atom.position = [...frac[i]];
  });

  if (!structure.periodic) structure.periodic = { hash: 'None', wrapped: null };
  runPeriodicWrapped(structure.periodic, frac, [...structure.elements], structure.lattice);

  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    reRenderAtoms: forceRerender,
    reRenderBonds: forceRerender,
    reRenderLattice: true,
    reRenderOther: false,
    reRenderComposition: false,
  });
}

export function createMDMonitorPanel() {
  const existing = document.getElementById('mdMonitorPanel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'mdMonitorPanel';
  const isMobile = window.innerWidth <= 1024;
  panel.style.position = 'fixed';
  panel.style.left = isMobile ? '8px' : '430px';
  panel.style.top  = isMobile ? '56px' : '110px';
  panel.style.width = isMobile ? Math.min(360, window.innerWidth - 16) + 'px' : '360px';
  panel.style.background = 'rgba(20,20,20,0.9)';
  panel.style.color = '#fff';
  panel.style.borderRadius = '12px';
  panel.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
  panel.style.backdropFilter = 'blur(6px)';
  panel.style.zIndex = '9999';

  panel.innerHTML = `
    <div class="panelHeader" id="mdHeader">
      MD Monitor <span id="mdFoldToggle">▼</span>
      <span id="mdCloseBtn" style="float:right; cursor:pointer; margin-left:8px; font-size:14px;">✖</span>
    </div>
    <div class="panelBody" id="mdBody">
      <canvas id="mdCanvas" width="330" height="170" style="border:1px solid #444; border-radius:6px; background:#111;"></canvas>
      <div style="display:flex; gap:12px; font-size:11px; margin-top:6px;">
        <span style="color:#53c7ff;">Blue: Temperature (K)</span>
        <span style="color:#95efff;">Dashed: Target T (K)</span>
        <span style="color:#ffb347;">Orange: Total Energy (eV)</span>
      </div>
      <div id="mdText" style="font-size:12px;"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const header = panel.querySelector('#mdHeader');
  const body = panel.querySelector('#mdBody');
  const fold = panel.querySelector('#mdFoldToggle');
  const closeBtn = panel.querySelector('#mdCloseBtn');
  const text = panel.querySelector('#mdText');
  const canvas = panel.querySelector('#mdCanvas');
  const ctx = canvas.getContext('2d');

  closeBtn.addEventListener('click', () => panel.remove());

  let dragging = false;
  let dx = 0;
  let dy = 0;
  header.addEventListener('mousedown', (e) => {
    if (e.target === fold || e.target === closeBtn) return;
    dragging = true;
    dx = e.clientX - panel.offsetLeft;
    dy = e.clientY - panel.offsetTop;
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = `${e.clientX - dx}px`;
    panel.style.top = `${e.clientY - dy}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });
  fold.addEventListener('click', () => {
    if (body.style.display === 'none') {
      body.style.display = 'flex';
      fold.textContent = '▼';
    } else {
      body.style.display = 'none';
      fold.textContent = '▲';
    }
  });

  const tSeries = [];
  const targetSeries = [];
  const eSeries = [];
  const maxPts = 250;

  function draw() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#666';
    ctx.strokeRect(0, 0, W, H);
    if (tSeries.length < 2) return;

    const n = tSeries.length;
    const xmin = 0;
    const xmax = Math.max(1, n - 1);
    const tmin = Math.min(...tSeries);
    const tmax = Math.max(...tSeries);
    const allTemps = [...tSeries, ...targetSeries.filter(Number.isFinite)];
    const emin = Math.min(...eSeries);
    const emax = Math.max(...eSeries);

    const mapX = (i) => ((i - xmin) / (xmax - xmin)) * (W - 10) + 5;
    const mapY = (v, vmin, vmax) => {
      const den = Math.max(1e-12, vmax - vmin);
      return H - (((v - vmin) / den) * (H - 10) + 5);
    };

    ctx.beginPath();
    ctx.strokeStyle = '#53c7ff';
    for (let i = 0; i < n; i += 1) {
      const x = mapX(i);
      const y = mapY(tSeries[i], Math.min(...allTemps), Math.max(...allTemps));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (targetSeries.some(Number.isFinite)) {
      ctx.beginPath();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#95efff';
      for (let i = 0; i < n; i += 1) {
        if (!Number.isFinite(targetSeries[i])) continue;
        const x = mapX(i);
        const y = mapY(targetSeries[i], Math.min(...allTemps), Math.max(...allTemps));
        if (i === 0 || !Number.isFinite(targetSeries[i - 1])) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.strokeStyle = '#ffb347';
    for (let i = 0; i < n; i += 1) {
      const x = mapX(i);
      const y = mapY(eSeries[i], emin, emax);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#53c7ff';
    ctx.font = '10px monospace';
    const plotTmin = Math.min(...allTemps);
    const plotTmax = Math.max(...allTemps);
    ctx.fillText(`T: ${plotTmin.toFixed(1)}..${plotTmax.toFixed(1)} K`, 8, 14);
    ctx.fillStyle = '#ffb347';
    ctx.fillText(`Etot: ${emin.toFixed(4)}..${emax.toFixed(4)} eV`, 8, 28);
  }

  return {
    update({ step, temperatureK, targetTemperatureK, etotEv, epotEv, ekinEv }) {
      tSeries.push(temperatureK);
      targetSeries.push(Number.isFinite(targetTemperatureK) ? targetTemperatureK : NaN);
      eSeries.push(etotEv);
      if (tSeries.length > maxPts) tSeries.shift();
      if (targetSeries.length > maxPts) targetSeries.shift();
      if (eSeries.length > maxPts) eSeries.shift();
      draw();
      const targetText = Number.isFinite(targetTemperatureK) ? ` | Ttarget=${targetTemperatureK.toFixed(1)} K` : '';
      text.textContent = `step=${step} | T=${temperatureK.toFixed(1)} K${targetText} | Etot=${etotEv.toFixed(4)} eV | Epot=${epotEv.toFixed(4)} eV | Ekin=${ekinEv.toFixed(4)} eV`;
    },
    remove() {
      panel.remove();
    },
  };
}
