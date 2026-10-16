// The app's one stress convention, end to end (model/Stress.js): a stored
// stress tensor is eV/Å³ with the Quantum ESPRESSO sign — compression positive,
// pressure = +trace/3 with no minus sign — and GPa is only a display unit.
//
//   1. the helpers: P = +tr/3, GPa only for display, tension-positive sources
//      negated
//   2. the in-browser calculator (NEP) at the app boundary: a squeezed cell
//      reads POSITIVE, a stretched one negative, and the pressure is the
//      thermodynamic one, P = -dE/dV (central finite difference); the
//      off-thread NEP worker agrees with the main-thread runner
//   3. the reported bug: after the EFS button, the Files window's Parameters
//      section shows the same pressure as the EFS readout, the energy in eV
//      and the full stress tensor in GPa
//   4. relaxation, through the panel: a squeezed cell relaxes OUTWARDS to
//      ~0 GPa; every saved frame carries its stress (eV/Å³) and energy; the
//      source structure is handed back untouched. With a target of +5 GPa the
//      relaxer lands on +5 GPa at a SMALLER volume than at 0 GPa
//   5. MD, through the panel (NPT, target 0): the squeezed cell's frames carry
//      positive pressure and their energy, and the barostat expands the cell
//   6. the other side: a STRETCHED cell (negative pressure, tension) relaxes
//      INWARDS to ~0 GPa and NPT MD contracts it, while a negative TARGET
//      pressure (-5 GPa) lands at a LARGER volume than 0 GPa
'use strict';
const H = require('../harness');

const EV_PER_A3_TO_GPA = 160.21766208;

/** Diamond Si, conventional 8-atom cell scaled to lattice constant `a`. */
function siPoscar(a, label = 'Si8') {
  const sites = [
    [0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0],
    [0.25, 0.25, 0.25], [0.25, 0.75, 0.75], [0.75, 0.25, 0.75], [0.75, 0.75, 0.25],
  ];
  return [
    label, '1.0',
    `${a.toFixed(6)} 0 0`, `0 ${a.toFixed(6)} 0`, `0 0 ${a.toFixed(6)}`,
    'Si', '8', 'Direct',
    // A small rattle so the relax has atomic work too, not only the cell.
    ...sites.map((s, i) => s.map((v, k) => (v + (i === 1 && k === 0 ? 0.01 : 0)).toFixed(6)).join(' ')),
    '',
  ].join('\n');
}

const A_SI = 5.43;
const SQUEEZED = siPoscar(A_SI * 0.97, 'Si8_squeezed');
const STRETCHED = siPoscar(A_SI * 1.03, 'Si8_stretched');

async function openBackend(page, mode) {
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('backend');
  });
  await page.waitForTimeout(300);
  // The panel opens in Relax mode, and clicking the active mode turns it OFF.
  await page.evaluate((m) => {
    const btn = document.querySelector(`#BackendModeSwitch button[data-mode="${m}"]`);
    if (btn && !btn.classList.contains(m)) btn.click();
  }, mode);
  await page.waitForTimeout(400);
}

async function loadPoscar(page, text, name) {
  await page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, name);
  }, { text, name });
  await page.waitForTimeout(800);
}

/** The Parameters section, unfolded, as numbers. */
async function readParameters(page) {
  return page.evaluate(() => {
    const d = document.getElementById('fileStructureSummary');
    if (!d.open) d.querySelector('.fss-summary').click();
    const props = d.querySelector('#fssProperties').textContent;
    const grab = (re) => { const m = props.match(re); return m ? Number(m[1]) : NaN; };
    return {
      props,
      energy: grab(/Energy = (-?[\d.]+) eV/),
      pressure: grab(/Pressure = (-?[\d.]+) GPa/),
      stressHidden: d.querySelector('#fssStressBlock').hidden,
      stress: d.querySelector('#fssStress').textContent.split('\n').filter(Boolean)
        .map((line) => line.trim().split(/\s+/).map(Number)),
    };
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

  // ---- 1. helpers ---------------------------------------------------------------------
  const pure = await page.evaluate(async () => {
    const m = await import('./model/index.js');
    const t = [[0.01, 0.002, 0], [0.002, 0.02, 0], [0, 0, 0.03]];
    return {
      pEv: m.pressureEvA3(t),
      pGPa: m.pressureGPa(t),
      gpa: m.tensorGPa(t),
      flipped: m.fromTensionPositive([[1, 0, 0], [0, -2, 0], [0, 0, 0]], 2),
      missing: [m.pressureGPa(null), m.tensorGPa(undefined)],
      kbar: m.KBAR_TO_EV_PER_A3 * 160.21766208,
      ha: m.HARTREE_PER_BOHR3_TO_EV_PER_A3,
      stress: new m.Stress({ tensor: t }).pressureGPa,
    };
  });
  H.check('pressure is +trace/3 of the stored eV/Å³ tensor, shown in GPa',
    near(pure.pEv, 0.02, 1e-12) && near(pure.pGPa, 0.02 * EV_PER_A3_TO_GPA, 1e-9)
      && near(pure.stress, pure.pGPa, 1e-12) && near(pure.gpa[0][1], 0.002 * EV_PER_A3_TO_GPA, 1e-9),
    JSON.stringify(pure));
  H.check('tension-positive sources are negated (and scaled); missing stress stays missing',
    JSON.stringify(pure.flipped) === JSON.stringify([[-2, 0, 0], [0, 4, 0], [0, 0, 0]])
      && Number.isNaN(pure.missing[0]) && pure.missing[1] === null,
    JSON.stringify([pure.flipped, pure.missing]));
  H.check('unit constants: 1 kbar = 0.1 GPa, Hartree/Bohr³ = 183.63 eV/Å³',
    near(pure.kbar, 0.1, 1e-12) && near(pure.ha, 183.6315, 1e-3), JSON.stringify([pure.kbar, pure.ha]));

  // ---- 2. the calculator at the app boundary ------------------------------------------------
  await loadPoscar(page, siPoscar(A_SI, 'Si8'), 'Si8');
  const calc = await page.evaluate(async (A) => {
    const { general } = await import('./state/store.js');
    general.atomisticPotential = 'nep';
    const { ensureActiveCalculator } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { pressureEvA3 } = await import('./model/index.js');
    const { ensureWorkerNEPReady, createWorkerNEPForceEvaluator } = await import('./atomistic/nepWorkerClient.js');
    const { runner } = await ensureActiveCalculator();
    const base = buildNEPStructure(runner);
    const scaled = (s) => ({
      lattice: base.lattice.map((r) => r.map((v) => v * s)),
      positions: base.positions.map((r) => r.map((v) => v * s)),
      types: base.types,
    });
    const vol = (st) => {
      const [a, b, c] = st.lattice;
      return Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
    };
    const at = async (s) => {
      const st = scaled(s);
      const out = await runner.compute(st);
      return { V: vol(st), E: out.total_energy, P: pressureEvA3(out.stress.matrix3x3), S: out.stress.matrix3x3 };
    };
    const squeezed = await at(0.97);
    const stretched = await at(1.03);
    // P = -dE/dV, central difference about the squeezed cell (atoms on their
    // ideal diamond sites — the base cell has a 0.01 rattle on one atom, which
    // only adds an O(h²)-cancelling term here).
    const h = 0.002;
    const lo = await at(0.97 * (1 - h));
    const hi = await at(0.97 * (1 + h));
    const pFd = -(hi.E - lo.E) / (hi.V - lo.V);

    await ensureWorkerNEPReady();
    const evaluator = createWorkerNEPForceEvaluator();
    const viaWorker = await evaluator(scaled(0.97));
    return {
      squeezedGPa: squeezed.P * 160.21766208,
      stretchedGPa: stretched.P * 160.21766208,
      squeezedDiag: [squeezed.S[0][0], squeezed.S[1][1], squeezed.S[2][2]],
      pStress: squeezed.P,
      pFd,
      workerP: pressureEvA3(viaWorker.stress.matrix3x3),
    };
  }, A_SI);
  H.check('NEP: a squeezed cell reads positive pressure, a stretched one negative',
    calc.squeezedGPa > 1 && calc.stretchedGPa < -1 && calc.squeezedDiag.every((v) => v > 0),
    JSON.stringify(calc));
  H.check('NEP: the stress pressure is the thermodynamic one, +trace/3 = -dE/dV (within 2%)',
    Math.abs(calc.pStress - calc.pFd) <= 0.02 * Math.abs(calc.pFd),
    `stress ${calc.pStress.toFixed(6)} vs -dE/dV ${calc.pFd.toFixed(6)} eV/Å³`);
  H.check('the off-thread NEP worker returns the same convention as the main-thread runner',
    near(calc.workerP, calc.pStress, 1e-6 * Math.max(1, Math.abs(calc.pStress))),
    JSON.stringify([calc.workerP, calc.pStress]));

  // ---- 3. EFS button → Parameters section (the reported mismatch) ---------------------------
  await loadPoscar(page, SQUEEZED, 'Si8_squeezed');
  await openBackend(page, 'relax');
  await readParameters(page); // unfold before the EFS so the refresh path is exercised
  await page.evaluate(() => document.getElementById('relaxEfsCard').click());
  const efsText = await H.waitFor(page, () => {
    const t = document.getElementById('relaxEfsMetrics')?.textContent || '';
    return /pressure:\s*-?[\d.]+ GPa/.test(t) ? t : null;
  }, { timeout: 60000, interval: 250 });
  const efsPressure = Number((efsText || '').match(/pressure:\s*(-?[\d.]+) GPa/)?.[1]);
  const efsEnergyPerAtom = Number((efsText || '').match(/energy \/ atom:\s*(-?[\d.]+) eV/)?.[1]);
  const params = await readParameters(page);
  H.check('after EFS the Parameters pressure equals the EFS readout, positive for the squeezed cell',
    efsPressure > 1 && near(params.pressure, efsPressure, 0.006),
    JSON.stringify({ efsPressure, parameters: params.pressure }));
  H.check('after EFS the Parameters section shows the energy in eV (8 atoms × the EFS energy/atom)',
    near(params.energy, 8 * efsEnergyPerAtom, 1e-4), JSON.stringify({ energy: params.energy, efsEnergyPerAtom }));
  const diagMean = params.stress.length === 3 ? (params.stress[0][0] + params.stress[1][1] + params.stress[2][2]) / 3 : NaN;
  H.check('after EFS the full stress tensor is shown in GPa, positive diagonal, its trace/3 the pressure',
    !params.stressHidden && params.stress.length === 3 && params.stress.every((r) => r.length === 3)
      && [0, 1, 2].every((i) => params.stress[i][i] > 0) && near(diagMean, params.pressure, 1e-3),
    JSON.stringify(params.stress));

  // ---- 4. relaxation through the panel --------------------------------------------------
  const before = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return { energy: s.energy, stress: s.stress.tensor.map((r) => [...r]), lattice: s.lattice.map((r) => [...r]) };
  });
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input')); };
    set('relaxMaxStepsInput', 400);
    set('relaxTargetPressureInput', 0);
    set('relaxStressTolInput', 0.2);
    document.getElementById('relaxBtn').click();
  });
  const relaxDone = await H.waitFor(page, () => {
    const t = document.querySelector('#BackendSelectorPanel [data-role="source-state"], [data-role="source-state"]')?.textContent || '';
    return /Converged after|Stopped after/.test(t) ? t : null;
  }, { timeout: 180000, interval: 500 });
  await page.waitForTimeout(800);
  const relax = await page.evaluate(async (src) => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const { pressureGPa } = await import('./model/index.js');
    const { latticeVolume } = await import('./math/index.js');
    const container = structureShip.container.find((c) => /^relax_nep_/.test(c.fileName || ''));
    const frames = await Promise.resolve(container.framesSlice());
    const last = frames[frames.length - 1];
    const source = structureShip.container.find((c) => c.fileName === 'Si8_squeezed').structures[0];
    const series = container.plotSeries?.pressure ?? [];
    return {
      name: container.fileName,
      selected: fileBrowser.selectedStructure === container.structures[container.frameCount - 1] || /^relax_/.test(fileBrowser.selectedRow?.textContent || ''),
      nFrames: frames.length,
      framesWithStress: frames.slice(1).every((f) => !!f.stress?.tensor),
      framesWithEnergy: frames.slice(1).every((f) => Number.isFinite(f.energy)),
      firstP: pressureGPa(frames[1]?.stress?.tensor),
      lastP: pressureGPa(last.stress?.tensor),
      lastSeriesP: series[series.length - 1],
      v0: latticeVolume(src.lattice),
      vEnd: latticeVolume(last.lattice),
      sourceStress: source.stress?.tensor ?? null,
      sourceEnergy: source.energy,
    };
  }, before);
  H.check('relax finished', !!relaxDone, String(relaxDone));
  H.check('relax: the squeezed cell expands to ~0 GPa (|P| ≤ 0.2) at a larger volume',
    relax.firstP > 1 && Math.abs(relax.lastP) <= 0.2 && relax.vEnd > relax.v0,
    JSON.stringify({ firstP: relax.firstP, lastP: relax.lastP, v0: relax.v0, vEnd: relax.vEnd }));
  H.check('relax: every saved frame carries its stress and energy; the plot and the frame agree',
    relax.framesWithStress && relax.framesWithEnergy && near(relax.lastSeriesP, relax.lastP, 1e-6),
    JSON.stringify({ n: relax.nFrames, series: relax.lastSeriesP, frame: relax.lastP }));
  H.check('relax: the source structure keeps the stress and energy it had before the run',
    near(relax.sourceEnergy, before.energy, 1e-9)
      && JSON.stringify(relax.sourceStress) === JSON.stringify(before.stress),
    JSON.stringify({ before: before.energy, after: relax.sourceEnergy }));

  const target = await page.evaluate(async (squeezed) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(squeezed, 'Si8_target');
    const { ensureActiveCalculator } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { buildNEPStructure, relaxUntilConverged } = await import('./atomistic/relaxer.js');
    const { latticeVolume } = await import('./math/index.js');
    const { runner } = await ensureActiveCalculator();
    const start = buildNEPStructure(runner);
    const at = async (p) => {
      const r = await relaxUntilConverged(runner, start, { targetPressureGPa: p, pressureTolGPa: 0.1, maxSteps: 600 });
      return { converged: r.converged, p: r.pressureGPa, v: latticeVolume(r.structure.lattice) };
    };
    return { zero: await at(0), five: await at(5), minusFive: await at(-5) };
  }, SQUEEZED);
  H.check('relax to +5 GPa lands on +5 GPa at a smaller volume than relaxing to 0 GPa',
    target.zero.converged && target.five.converged && near(target.five.p, 5, 0.1) && target.five.v < target.zero.v,
    JSON.stringify(target));
  H.check('relax to -5 GPa (tension) lands on -5 GPa at a LARGER volume than relaxing to 0 GPa',
    target.minusFive.converged && near(target.minusFive.p, -5, 0.1) && target.minusFive.v > target.zero.v,
    JSON.stringify(target));

  // ---- 5. MD (NPT, target 0) through the panel ------------------------------------------
  await loadPoscar(page, SQUEEZED, 'Si8_md');
  await openBackend(page, 'md');
  await page.evaluate(() => {
    document.querySelector('#mdEnsembleSwitch button[data-ensemble="npt"]').click();
    const set = (id, v) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    set('mdStepsInput', 300);
    set('mdTemperatureInput', 100);
    set('mdPressureInput', 0);
    set('mdSaveStrideInput', 20);
    set('mdTauPInput', 100);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('mdStartBtn').click());
  await page.waitForTimeout(1000);
  const mdDone = await H.waitFor(page, async () => {
    const { structureShip } = await import('./state/store.js');
    const c = structureShip.container.find((x) => /^md_nep_Si8_md/.test(x.fileName || ''));
    return c && !document.getElementById('mdStartBtn').disabled ? true : null;
  }, { timeout: 240000, interval: 500 });
  const md = await page.evaluate(async () => {
    const { structureShip } = await import('./state/store.js');
    const { pressureGPa } = await import('./model/index.js');
    const { latticeVolume } = await import('./math/index.js');
    const container = structureShip.container.find((x) => /^md_nep_Si8_md/.test(x.fileName || ''));
    const frames = await Promise.resolve(container.framesSlice());
    const withStress = frames.slice(1);
    return {
      n: frames.length,
      firstP: pressureGPa(withStress[0]?.stress?.tensor),
      lastP: pressureGPa(withStress[withStress.length - 1]?.stress?.tensor),
      energies: withStress.every((f) => Number.isFinite(f.energy)),
      v0: latticeVolume(frames[0].lattice),
      vEnd: latticeVolume(frames[frames.length - 1].lattice),
    };
  });
  H.check('MD finished', !!mdDone);
  H.check('MD: the squeezed cell\'s frames carry positive pressure, and their energy',
    md.n > 2 && md.firstP > 1 && md.energies, JSON.stringify(md));
  H.check('MD NPT (target 0 GPa): the barostat expands the squeezed cell and relieves the pressure',
    md.vEnd > md.v0 && md.lastP < md.firstP, JSON.stringify(md));

  // ---- 6. a stretched cell: negative pressure, relaxes and NPT-runs INWARDS ---------------
  const stretched = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'Si8_stretched');
    const { fileBrowser } = await import('./state/store.js');
    const { ensureActiveCalculator } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { buildNEPStructure, relaxUntilConverged } = await import('./atomistic/relaxer.js');
    const { latticeVolume } = await import('./math/index.js');
    const md = await import('./atomistic/MD.js');
    const { runner } = await ensureActiveCalculator();
    const start = buildNEPStructure(runner);
    const v0 = latticeVolume(start.lattice);

    const relaxed = await relaxUntilConverged(runner, start, { targetPressureGPa: 0, pressureTolGPa: 0.1, maxSteps: 600 });

    const forceEvaluator = md.createNEPForceEvaluator(runner);
    const state = await md.initializeMDState({
      nepRunner: runner, structure: fileBrowser.selectedStructure, temperatureTargetK: 100, forceEvaluator,
    });
    const p0 = md.instantaneousPressureGPa(state);
    const pressures = [];
    await md.runMDSimulation({
      state, steps: 300, dtFs: 1.0, forceEvaluator,
      integrator: md.createVelocityVerletIntegrator(),
      thermostat: md.createBussiThermostat({ targetTemperatureK: 100, tauFs: 50 }),
      barostat: md.createStochasticCellBarostat({ targetPressureGPa: 0, tauFs: 100 }),
      onStep: ({ pressureGPa }) => { pressures.push(pressureGPa); },
    });
    const tail = pressures.slice(-50);
    return {
      v0,
      relax: { converged: relaxed.converged, p: relaxed.pressureGPa, v: latticeVolume(relaxed.structure.lattice) },
      md: { p0, pTail: tail.reduce((a, b) => a + b, 0) / tail.length, vEnd: md.cellVolume(state.lattice) },
    };
  }, STRETCHED);
  H.check('a stretched cell reads negative pressure (tension)',
    stretched.md.p0 < -1, JSON.stringify(stretched.md));
  H.check('relax: the stretched cell CONTRACTS to ~0 GPa (|P| ≤ 0.1) at a smaller volume',
    stretched.relax.converged && Math.abs(stretched.relax.p) <= 0.1 && stretched.relax.v < stretched.v0,
    JSON.stringify(stretched));
  H.check('MD NPT (target 0 GPa): the barostat CONTRACTS the stretched cell and relieves the tension',
    stretched.md.vEnd < stretched.v0 && stretched.md.pTail > stretched.md.p0,
    JSON.stringify(stretched));

  H.check('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
