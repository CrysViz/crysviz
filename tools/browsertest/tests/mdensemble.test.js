// NVT / NPT: is the physics right?
//
// Driven at the engine level with synthetic potentials (no NEP), so each check
// isolates one claim:
//   - pressure = 2KE/3V + virial, with the kinetic term actually present
//   - CSVR reaches the target temperature AND fluctuates (Berendsen does not)
//   - the barostat moves the cell the right way and converges on the volume
//     where P equals the target
//   - an isotropic barostat cannot break the space group in Wyckoff mode
'use strict';
const H = require('../harness');

const C6N8_POSCAR = `C6 N8
1.0
   3.2252631334172732   -5.5863196148575156    0.0000000000000000
   3.2252631334172732    5.5863196148575156    0.0000000000000000
   0.0000000000000000    0.0000000000000000    2.4231400000000001
C N
6 8
direct
   0.7732450000000001    0.5949050000000000    0.7500000000000000
   0.4050950000000000    0.1783400000000000    0.7500000000000000
   0.8216599999999991    0.2267549999999990    0.7500000000000000
   0.2267549999999990    0.4050950000000000    0.2500000000000000
   0.5949050000000000    0.8216599999999991    0.2500000000000000
   0.1783400000000000    0.7732450000000001    0.2500000000000000
   0.0333069999999990    0.7034199999999990    0.7500000000000000
   0.2965800000000000    0.3298870000000000    0.7500000000000000
   0.6701130000000000    0.9666929999999990    0.7500000000000000
   0.9666929999999990    0.2965800000000000    0.2500000000000000
   0.7034199999999990    0.6701130000000000    0.2500000000000000
   0.3298870000000000    0.0333069999999990    0.2500000000000000
   0.6666666666666661    0.3333333333333330    0.7500000000000000
   0.3333333333333330    0.6666666666666661    0.2500000000000000
`;

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // ---- 1. pressure: kinetic term present, correct magnitude -----------------
  const pressure = await page.evaluate(async () => {
    const md = await import('./atomistic/MD.js');
    const L = 10;
    const n = 50;
    const speed = 0.01; // A/fs along x
    const state = {
      lattice: [[L, 0, 0], [0, L, 0], [0, 0, L]],
      velocities: Array.from({ length: n }, () => [speed, 0, 0]),
      masses: Array.from({ length: n }, () => 12),
      stress: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], // no virial: pure ideal gas
    };
    const KE_EV_FACTOR = 103.642695;
    const EV_A3_TO_GPA = 160.21766208;
    const ke = n * 0.5 * 12 * speed * speed * KE_EV_FACTOR;
    const expectedGPa = (2 * ke) / (3 * L ** 3) * EV_A3_TO_GPA;

    const idealGas = md.instantaneousPressureGPa(state);

    // Add an isotropic virial: sigma = -P I means +P of pressure on top.
    const extra = 1.5 / EV_A3_TO_GPA;
    state.stress = [[-extra, 0, 0], [0, -extra, 0], [0, 0, -extra]];
    const withVirial = md.instantaneousPressureGPa(state);

    return {
      idealGas,
      expectedGPa,
      withVirial,
      volume: md.cellVolume(state.lattice),
    };
  });

  H.check('pressure includes the kinetic term, with the right magnitude',
    Math.abs(pressure.idealGas - pressure.expectedGPa) < 1e-9,
    `got ${pressure.idealGas}, want ${pressure.expectedGPa}`);
  H.check('an isotropic virial adds to the pressure',
    Math.abs(pressure.withVirial - (pressure.idealGas + 1.5)) < 1e-9,
    JSON.stringify(pressure));
  H.check('cell volume is the determinant', Math.abs(pressure.volume - 1000) < 1e-9,
    String(pressure.volume));

  // ---- 2. thermostats: CSVR is canonical, Berendsen is not ------------------
  const thermo = await page.evaluate(async () => {
    const md = await import('./atomistic/MD.js');
    const run = (thermostat, steps) => {
      const n = 64;
      const state = {
        positions: Array.from({ length: n }, (_, i) => [i * 0.1, 0, 0]),
        velocities: Array.from({ length: n }, () => [0.005, -0.005, 0.005]),
        masses: Array.from({ length: n }, () => 28),
        lattice: [[20, 0, 0], [0, 20, 0], [0, 0, 20]],
        constrainedDof: null,
        symmetryConstrained: false,
      };
      const temps = [];
      for (let s = 0; s < steps; s += 1) {
        thermostat.apply(state, 1.0, { step: s + 1, totalSteps: steps, state });
        // No forces: the thermostat is the only thing acting, which is exactly
        // what isolates its statistics.
        let ke = 0;
        for (let i = 0; i < n; i += 1) {
          const v = state.velocities[i];
          ke += 0.5 * state.masses[i] * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) * 103.642695;
        }
        temps.push((2 * ke) / ((3 * n - 3) * 8.617333262e-5));
      }
      const tail = temps.slice(Math.floor(steps * 0.75));
      const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
      const variance = tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length;
      return { mean, rel: Math.sqrt(variance) / mean };
    };

    const target = 300;
    // 20k steps, and the mean is taken over the last quarter. This is a
    // stochastic estimator with an autocorrelation time of tau, so a short run
    // gives a mean that wanders a few percent from the setpoint — at 4k steps
    // it was landing anywhere in 285-316 K and failing a 5% tolerance roughly
    // one run in three. There are no forces to evaluate here, so length is
    // nearly free.
    const bussi = run(md.createBussiThermostat({ targetTemperatureK: target, tauFs: 50 }), 20000);
    const berendsen = run(
      md.createVelocityRescaleThermostat({ targetTemperatureK: target, tauFs: 50 }), 20000);
    // Canonical prediction for the relative KE fluctuation: sqrt(2/Nf).
    const expectedRel = Math.sqrt(2 / (3 * 64 - 3));
    return { bussi, berendsen, expectedRel, target };
  });

  H.check('CSVR holds the target temperature',
    Math.abs(thermo.bussi.mean - thermo.target) / thermo.target < 0.04,
    `mean=${thermo.bussi.mean.toFixed(1)} K`);
  H.check('CSVR reproduces the canonical fluctuation sqrt(2/Nf)',
    Math.abs(thermo.bussi.rel - thermo.expectedRel) / thermo.expectedRel < 0.35,
    `rel=${thermo.bussi.rel.toFixed(4)} want~${thermo.expectedRel.toFixed(4)}`);
  H.check('Berendsen damps those fluctuations (the reason it was replaced)',
    thermo.berendsen.rel < thermo.bussi.rel / 3,
    `berendsen=${thermo.berendsen.rel.toExponential(2)} csvr=${thermo.bussi.rel.toFixed(4)}`);

  // ---- 3. barostat: right direction, converges on the target ----------------
  const baro = await page.evaluate(async () => {
    const md = await import('./atomistic/MD.js');
    const EV_A3_TO_GPA = 160.21766208;
    const V0 = 1000;
    const BULK_GPa = 50;

    // A toy solid: P(V) = K (V0/V - 1). Static (no atom motion, no kinetic
    // term) so the equilibrium volume is analytic: V* = V0 / (1 + P_target/K).
    const makeState = () => ({
      lattice: [[10, 0, 0], [0, 10, 0], [0, 0, 10]],
      positions: [[0, 0, 0], [5, 5, 5]],
      velocities: [[0, 0, 0], [0, 0, 0]],
      masses: [28, 28],
      forces: [[0, 0, 0], [0, 0, 0]],
      stress: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      types: [0, 0],
      step: 0,
      timeFs: 0,
      potentialEnergyEv: 0,
      currentTargetTemperatureK: 300,
      symmetryConstrained: false,
      constrainedDof: null,
    });
    const refreshStress = (state) => {
      const v = md.cellVolume(state.lattice);
      const p = BULK_GPa * (V0 / v - 1) / EV_A3_TO_GPA;
      state.stress = [[-p, 0, 0], [0, -p, 0], [0, 0, -p]];
    };

    const settle = (targetPressureGPa, steps, trailingWindow = 0, disableCoupling = false) => {
      const state = makeState();
      const barostat = disableCoupling
        ? { apply() {} }
        : md.createStochasticCellBarostat({
          targetPressureGPa, tauFs: 20, compressibility: 0.02,
        });
      const trailingPressures = [];
      for (let s = 0; s < steps; s += 1) {
        refreshStress(state);
        barostat.apply(state, 1.0, { step: s + 1, state });
        refreshStress(state);
        if (s >= steps - trailingWindow) {
          trailingPressures.push(md.instantaneousPressureGPa(state));
        }
      }
      refreshStress(state);
      const pressure = md.instantaneousPressureGPa(state);
      const meanPressure = trailingPressures.length
        ? trailingPressures.reduce((sum, value) => sum + value, 0) / trailingPressures.length
        : pressure;
      return { volume: md.cellVolume(state.lattice), pressure, meanPressure };
    };

    // The 1,000-step tail gives a physical, time-averaged NPT pressure
    // estimator without extending the 4,000-step settling run.
    const squeezed = settle(10, 4000, 1000);   // +10 GPa -> smaller cell
    const relaxed = settle(0, 4000);     // 0 GPa   -> back to V0
    const pulled = settle(-5, 4000);     // tension -> larger cell
    // Permanent negative control: this has the same toy solid and estimator,
    // but a barostat with its coupling disabled inside this test.
    const broken = settle(10, 4000, 1000, true);
    return {
      squeezed,
      relaxed,
      pulled,
      broken,
      wantSqueezed: V0 / (1 + 10 / BULK_GPa),
      wantRelaxed: V0,
      wantPulled: V0 / (1 - 5 / BULK_GPa),
    };
  });

  H.check('barostat compresses towards a positive target pressure',
    Math.abs(baro.squeezed.volume - baro.wantSqueezed) / baro.wantSqueezed < 0.05,
    `V=${baro.squeezed.volume.toFixed(1)} want~${baro.wantSqueezed.toFixed(1)}`);
  H.check('barostat settles at V0 for P = 0',
    Math.abs(baro.relaxed.volume - baro.wantRelaxed) / baro.wantRelaxed < 0.05,
    `V=${baro.relaxed.volume.toFixed(1)} want~${baro.wantRelaxed.toFixed(1)}`);
  H.check('barostat expands under tension',
    Math.abs(baro.pulled.volume - baro.wantPulled) / baro.wantPulled < 0.08,
    `V=${baro.pulled.volume.toFixed(1)} want~${baro.wantPulled.toFixed(1)}`);
  // In 25 independent in-session settling runs, this trailing estimator had
  // sigma = 0.084 GPa and mean = 9.996 GPa. 0.35 GPa is about 4.2 sigma.
  const pressureMatchesTarget = (pressure) => Math.abs(pressure - 10) < 0.35;
  H.check('the time-averaged settled pressure matches the target',
    pressureMatchesTarget(baro.squeezed.meanPressure),
    `mean P=${baro.squeezed.meanPressure.toFixed(2)} GPa`);
  H.check('the settled-pressure estimator rejects disabled barostat coupling',
    !pressureMatchesTarget(baro.broken.meanPressure),
    `broken mean P=${baro.broken.meanPressure.toFixed(2)} GPa`);

  // ---- 4. Wyckoff: isotropic scaling cannot lower the space group -----------
  const sym = await page.evaluate(async (poscar) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');
    const symMod = await import('./ui/SymmetryEditModule.js');
    const md = await import('./atomistic/MD.js');

    await cv.loadStructure(poscar, 'C6N8_npt.poscar');
    const s = fileBrowser.selectedStructure;
    await symMod.activateWyckoffMode(s, symMod.DEFAULT_SYMPREC);
    const before = (await symMod.analyzeStructureSymmetry(s, symMod.DEFAULT_SYMPREC)).number;

    const lattice = s.lattice.map((r) => [...r]);
    const state = {
      lattice,
      positions: s.atoms.map((a) => [
        a.position[0] * lattice[0][0] + a.position[1] * lattice[1][0] + a.position[2] * lattice[2][0],
        a.position[0] * lattice[0][1] + a.position[1] * lattice[1][1] + a.position[2] * lattice[2][1],
        a.position[0] * lattice[0][2] + a.position[1] * lattice[1][2] + a.position[2] * lattice[2][2],
      ]),
      velocities: s.atoms.map(() => [0, 0, 0]),
      masses: s.atoms.map(() => 12),
      stress: [[-0.05, 0, 0], [0, -0.05, 0], [0, 0, -0.05]],
      currentTargetTemperatureK: 300,
      symmetryConstrained: true,
      constrainedDof: symMod.getSymmetryDegreesOfFreedom(s),
    };
    const barostat = md.createStochasticCellBarostat({ targetPressureGPa: 0, tauFs: 20 });
    const v0 = md.cellVolume(state.lattice);
    for (let i = 0; i < 200; i += 1) barostat.apply(state, 1.0, { step: i + 1, state });
    const v1 = md.cellVolume(state.lattice);

    // Push the scaled cell back onto the structure and re-analyse.
    const inv = (L) => {
      const d = L[0][0] * (L[1][1] * L[2][2] - L[1][2] * L[2][1])
        - L[1][0] * (L[0][1] * L[2][2] - L[0][2] * L[2][1])
        + L[2][0] * (L[0][1] * L[1][2] - L[0][2] * L[1][1]);
      return d;
    };
    void inv;
    s.lattice = state.lattice.map((r) => [...r]);
    const after = (await symMod.analyzeStructureSymmetry(s, symMod.DEFAULT_SYMPREC)).number;
    return { before, after, v0, v1 };
  }, C6N8_POSCAR);

  H.check('the barostat actually changed the cell', Math.abs(sym.v1 - sym.v0) > 1e-6,
    `${sym.v0} -> ${sym.v1}`);
  H.check('isotropic NPT preserves the space group in Wyckoff mode',
    sym.after === sym.before, `${sym.before} -> ${sym.after}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
