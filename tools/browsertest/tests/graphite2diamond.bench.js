// Graphite -> diamond under NPT: does the whole stack (CSVR + stochastic cell
// barostat + cosine annealing + NEP89) reproduce a real phase transition?
//
// The diagnostic is coordination, not symmetry: graphite is sp2 (3 neighbours
// at 1.42 A), diamond is sp3 (4 at 1.54 A). Under compression the AB stacking
// of graphite maps topotactically onto HEXAGONAL diamond (lonsdaleite),
// not cubic, so do not expect Fd-3m out of this cell.
//
//   PRESSURE_GPA=60 PEAK_K=2000 STEPS=3000 tools/browsertest/run.sh tests/graphite2diamond.bench.js
'use strict';
const H = require('../harness');

const GRAPHITE = `C4
1.0
   1.2336456308015411   -2.1367369110836258    0.0000000000000000
   1.2336456308015411    2.1367369110836258    0.0000000000000000
   0.0000000000000000    0.0000000000000000    7.8030729999999995
C
4
direct
   0.0000000000000000    0.0000000000000000    0.2500000000000000
   0.0000000000000000    0.0000000000000000    0.7500000000000000
   0.3333333333333330    0.6666666666666661    0.2500000000000000
   0.6666666666666661    0.3333333333333330    0.7500000000000000
`;

const PRESSURE_GPA = Number(process.env.PRESSURE_GPA ?? 60);
const PEAK_K = Number(process.env.PEAK_K ?? 2000);
const STEPS = Number(process.env.STEPS ?? 3000);
const NX = Number(process.env.NX ?? 3);
const NY = Number(process.env.NY ?? 3);
const NZ = Number(process.env.NZ ?? 2);

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (cfg) => {
    const cv = await import('./core/crystal-viewer.js');
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const md = await import('./atomistic/MD.js');
    const { ensureWorkerNEPReady, createWorkerNEPForceEvaluator } = await import('./atomistic/nepWorkerClient.js');

    await cv.loadStructure(cfg.poscar, 'graphite.poscar');
    await new Promise((r) => setTimeout(r, 400));
    createSupercell(cfg.nx, cfg.ny, cfg.nz);
    await new Promise((r) => setTimeout(r, 600));

    const info = await ensureWorkerNEPReady();
    const forceEvaluator = createWorkerNEPForceEvaluator();
    const nepRunner = { modelInfo: { element_list: info.elementList } };
    const structure = fileBrowser.selectedStructure;
    const natoms = structure.atoms.length;

    // Mean coordination within `cut`, minimum-image over the (triclinic) cell.
    // Uses the app's own cartToFractional: a hand-rolled 3x3 inverse got the
    // hexagonal cell wrong and reported coordination 4.6 for pristine graphite,
    // which should be exactly 3.
    const { cartToFractional } = await import('./math/index.js');
    const coordination = (positions, lattice, cut) => {
      const frac = positions.map((p) => cartToFractional(p, lattice));
      const n = positions.length;
      let total = 0;
      const bonds = [];
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const d = [0, 1, 2].map((k) => {
            let x = frac[i][k] - frac[j][k];
            x -= Math.round(x);
            return x;
          });
          const cart = [0, 1, 2].map((k) =>
            d[0] * lattice[0][k] + d[1] * lattice[1][k] + d[2] * lattice[2][k]);
          const r = Math.hypot(cart[0], cart[1], cart[2]);
          if (r < cut) { total += 2; bonds.push(r); }
        }
      }
      bonds.sort((x, y) => x - y);
      return {
        mean: total / n,
        medianBond: bonds.length ? bonds[Math.floor(bonds.length / 2)] : NaN,
      };
    };

    const state = await md.initializeMDState({
      nepRunner, structure, temperatureTargetK: 300, forceEvaluator,
    });
    const v0 = md.cellVolume(state.lattice);
    const c0 = coordination(state.positions, state.lattice, 1.9);

    const schedule = md.createCosineAnnealingSchedule({
      startTemperatureK: 300,
      peakTemperatureK: cfg.peakK,
      minTemperatureK: 300,
      peakFraction: 0.45,
      totalSteps: cfg.steps,
    });

    const trace = [];
    await md.runMDSimulation({
      state,
      steps: cfg.steps,
      dtFs: 1.0,
      forceEvaluator,
      integrator: md.createVelocityVerletIntegrator(),
      thermostat: md.createBussiThermostat({ targetTemperatureK: schedule, tauFs: 20 }),
      barostat: md.createStochasticCellBarostat({
        targetPressureGPa: cfg.pressureGPa, tauFs: 200,
      }),
      offThreadForces: true,
      onStep: ({ step, temperatureK, pressureGPa, volumeA3, state: s }) => {
        if (step % Math.max(1, Math.floor(cfg.steps / 10)) === 0) {
          const c = coordination(s.positions, s.lattice, 1.9);
          trace.push({
            step,
            T: temperatureK,
            P: pressureGPa,
            vPerAtom: volumeA3 / s.positions.length,
            coord: c.mean,
            bond: c.medianBond,
          });
        }
      },
    });

    const cEnd = coordination(state.positions, state.lattice, 1.9);
    const vEnd = md.cellVolume(state.lattice);
    // Carbon: 12.011 amu/atom; 1 amu/A^3 = 1.66054 g/cm^3.
    const density = (m, v) => (m * 12.011 / v) * 1.66054;
    return {
      natoms,
      v0PerAtom: v0 / natoms,
      vEndPerAtom: vEnd / natoms,
      rho0: density(natoms, v0),
      rhoEnd: density(natoms, vEnd),
      coord0: c0.mean,
      coordEnd: cEnd.mean,
      bond0: c0.medianBond,
      bondEnd: cEnd.medianBond,
      trace,
    };
  }, {
    poscar: GRAPHITE,
    nx: NX, ny: NY, nz: NZ,
    pressureGPa: PRESSURE_GPA, peakK: PEAK_K, steps: STEPS,
  });

  console.log(`  ${res.natoms} atoms, target ${PRESSURE_GPA} GPa, anneal 300 -> ${PEAK_K} -> 300 K over ${STEPS} fs`);
  console.log('   step      T(K)    P(GPa)   V/atom   coord   bond(A)');
  for (const t of res.trace) {
    console.log(`  ${String(t.step).padStart(5)} ${t.T.toFixed(0).padStart(9)} ${t.P.toFixed(1).padStart(9)}`
      + ` ${t.vPerAtom.toFixed(2).padStart(8)} ${t.coord.toFixed(2).padStart(7)} ${t.bond.toFixed(3).padStart(9)}`);
  }
  console.log(`  start: V/atom=${res.v0PerAtom.toFixed(2)} A^3, rho=${res.rho0.toFixed(2)} g/cm^3,`
    + ` coord=${res.coord0.toFixed(2)}, bond=${res.bond0.toFixed(3)} A`);
  console.log(`  end  : V/atom=${res.vEndPerAtom.toFixed(2)} A^3, rho=${res.rhoEnd.toFixed(2)} g/cm^3,`
    + ` coord=${res.coordEnd.toFixed(2)}, bond=${res.bondEnd.toFixed(3)} A`);
  console.log('  reference: graphite sp2 coord 3, 1.42 A, 2.27 g/cm^3'
    + ' | diamond sp3 coord 4, 1.54 A, 3.51 g/cm^3');

  H.check('started as graphite (sp2, coordination ~3)',
    res.coord0 > 2.5 && res.coord0 < 3.5, `coord=${res.coord0.toFixed(2)}`);
  H.check('the cell densified under pressure', res.rhoEnd > res.rho0,
    `${res.rho0.toFixed(2)} -> ${res.rhoEnd.toFixed(2)} g/cm^3`);
  H.check('ended sp3 (coordination >= 3.8)', res.coordEnd >= 3.8,
    `coord=${res.coordEnd.toFixed(2)}`);
  H.check('bond length moved towards the diamond value (1.54 A)',
    res.bondEnd > 1.48, `${res.bond0.toFixed(3)} -> ${res.bondEnd.toFixed(3)} A`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
