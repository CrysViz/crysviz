// Regression: a pw.x (Quantum ESPRESSO) relaxation output must load as a
// trajectory carrying per-frame energy, forces and stress — the Trajectory
// panel had nothing to plot for QE files because the reader never parsed the
// "!    total energy" line at all.
//
// The second thing asserted here is the pairing. pw.x prints the energy /
// forces / stress of the CURRENT geometry and only afterwards the
// CELL_PARAMETERS + ATOMIC_POSITIONS of the NEXT one, so a reader that splits
// on "End of self-consistent calculation" hands every frame the forces of the
// geometry before it. Frame 0 must be the header geometry with the first
// block's energy.
'use strict';
const H = require('../harness');

// Two ionic steps plus the final scf, 2 atoms, cubic-ish cell. alat = 1.889726
// bohr = 1 Å, so the header numbers are Ångström as written.
const QE_OUT = [
  '     Program PWSCF v.7.0 starts on 28Mar2025 at  8: 6:43',
  '',
  '     celldm(1)=   1.889726  celldm(2)=   0.000000  celldm(3)=   0.000000',
  '',
  '     crystal axes: (cart. coord. in units of alat)',
  '               a(1) = (   4.000000   0.000000   0.000000 )  ',
  '               a(2) = (   0.000000   4.000000   0.000000 )  ',
  '               a(3) = (   0.000000   0.000000   4.000000 )  ',
  '',
  '   Cartesian axes',
  '',
  '     site n.     atom                  positions (alat units)',
  '         1           Na  tau(   1) = (   0.0000000   0.0000000   0.0000000  )',
  '         2           Cl  tau(   2) = (   2.0000000   0.0000000   0.0000000  )',
  '',
  '     End of self-consistent calculation',
  '',
  '!    total energy              =     -10.00000000 Ry',
  '',
  '     Forces acting on atoms (cartesian axes, Ry/au):',
  '',
  '     atom    1 type  1   force =     0.10000000    0.00000000    0.00000000',
  '     atom    2 type  2   force =    -0.10000000    0.00000000    0.00000000',
  '',
  '     Total force =     0.141421     Total SCF correction =     0.000001',
  '',
  '     Computing stress (Cartesian axis) and pressure',
  '',
  '          total   stress  (Ry/bohr**3)                   (kbar)     P=      100.00',
  '   0.00000000   0.00000000   0.00000000          100.00        0.00        0.00',
  '   0.00000000   0.00000000   0.00000000            0.00      100.00        0.00',
  '   0.00000000   0.00000000   0.00000000            0.00        0.00      100.00',
  '',
  'CELL_PARAMETERS (alat=  1.88972616)',
  '   4.100000   0.000000   0.000000',
  '   0.000000   4.100000   0.000000',
  '   0.000000   0.000000   4.100000',
  '',
  'ATOMIC_POSITIONS (crystal)',
  'Na            0.0000000000        0.0000000000        0.0000000000',
  'Cl            0.4000000000        0.0000000000        0.0000000000',
  '',
  '     End of self-consistent calculation',
  '',
  '!    total energy              =     -11.00000000 Ry',
  '',
  '     Forces acting on atoms (cartesian axes, Ry/au):',
  '',
  '     atom    1 type  1   force =     0.01000000    0.00000000    0.00000000',
  '     atom    2 type  2   force =    -0.01000000    0.00000000    0.00000000',
  '',
  '     Computing stress (Cartesian axis) and pressure',
  '',
  '          total   stress  (Ry/bohr**3)                   (kbar)     P=       50.00',
  '   0.00000000   0.00000000   0.00000000           50.00        0.00        0.00',
  '   0.00000000   0.00000000   0.00000000            0.00       50.00        0.00',
  '   0.00000000   0.00000000   0.00000000            0.00        0.00       50.00',
  '',
  '     A final scf calculation at the relaxed structure.',
  '',
  '     End of self-consistent calculation',
  '',
  '!    total energy              =     -11.10000000 Ry',
  '',
  '     Forces acting on atoms (cartesian axes, Ry/au):',
  '',
  '     atom    1 type  1   force =     0.00100000    0.00000000    0.00000000',
  '     atom    2 type  2   force =    -0.00100000    0.00000000    0.00000000',
  '',
  '     Computing stress (Cartesian axis) and pressure',
  '',
  '          total   stress  (Ry/bohr**3)                   (kbar)     P=       10.00',
  '   0.00000000   0.00000000   0.00000000           10.00        0.00        0.00',
  '   0.00000000   0.00000000   0.00000000            0.00       10.00        0.00',
  '   0.00000000   0.00000000   0.00000000            0.00        0.00       10.00',
  '',
  '     JOB DONE.',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');

    await cv.loadStructure(text, 'AgN5.scf.in.out');
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    const frames = container.structures;
    const pressure = (s) => {
      const t = s.stress && s.stress.tensor;
      return t ? (t[0][0] + t[1][1] + t[2][2]) / 3 : null;
    };

    // Plotly draws asynchronously; poll rather than guess a delay.
    openPanel('trajectory');
    let plotted = false;
    for (let i = 0; i < 80 && !plotted; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const chart = document.querySelector('#trajPlotHost .js-plotly-plot');
      plotted = !!(chart && chart.data && chart.data.length > 0);
    }

    return {
      nframes: frames.length,
      fileName: container.fileName,
      energies: frames.map((s) => s.energy),
      forceCounts: frames.map((s) => (s.forces ? s.forces.length : 0)),
      firstForceX: frames.map((s) => (s.forces && s.forces[0] ? s.forces[0].vector[0] : null)),
      pressures: frames.map(pressure),
      elements: frames.map((s) => s.elements.join(',')),
      latticeA: frames.map((s) => s.lattice[0][0]),
      clFracX: frames.map((s) => s.atoms[1].position[0]),
      plotted,
    };
  }, QE_OUT);

  const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) < tol;

  // Three scf blocks in, three frames out — nothing dropped, nothing doubled.
  H.check('3 frames parsed', res.nframes === 3, String(res.nframes));
  H.check('elements per frame', res.elements.every((e) => e === 'Na,Cl'), String(res.elements));

  // Ry -> eV on every frame (13.605693 eV/Ry).
  const wantE = [-10, -11, -11.1].map((ry) => ry * 13.605693);
  H.check('per-frame energy in eV',
    res.energies.every((e, i) => near(e, wantE[i], 1e-3)),
    JSON.stringify(res.energies));

  // Forces on every frame, Ry/bohr -> eV/Å (25.71104).
  H.check('per-frame forces', res.forceCounts.every((c) => c === 2), String(res.forceCounts));
  const wantFx = [0.1, 0.01, 0.001].map((f) => f * 25.71104);
  H.check('forces converted to eV/A',
    res.firstForceX.every((fx, i) => near(fx, wantFx[i], 1e-3)),
    JSON.stringify(res.firstForceX));

  // kbar -> GPa.
  H.check('per-frame pressure in GPa',
    [10, 5, 1].every((gpa, i) => near(res.pressures[i], gpa, 1e-6)),
    JSON.stringify(res.pressures));

  // The pairing check: frame 0 is the header geometry (a = 4 Å, Cl at x = 0.5),
  // not the post-step one the file prints right after frame 0's forces.
  H.check('frame 0 is the header geometry',
    near(res.latticeA[0], 4, 1e-6) && near(res.clFracX[0], 0.5, 1e-6),
    `a=${res.latticeA[0]} x=${res.clFracX[0]}`);
  H.check('frame 1 is the first relaxed geometry',
    near(res.latticeA[1], 4.1, 1e-6) && near(res.clFracX[1], 0.4, 1e-6),
    `a=${res.latticeA[1]} x=${res.clFracX[1]}`);
  // The final scf re-runs at the last geometry, so it repeats it.
  H.check('final scf reuses the last geometry', near(res.latticeA[2], 4.1, 1e-6),
    String(res.latticeA[2]));

  H.check('trajectory panel plots the QE run', res.plotted, '');

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
