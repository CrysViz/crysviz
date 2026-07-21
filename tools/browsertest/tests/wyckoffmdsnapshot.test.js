// Regression: symmetry-constrained MD ran UNCONSTRAINED from the panel.
//
// wyckoffmd.test.js drives MD on the selected structure directly and passes —
// but the Relax/MD panel does not do that. Since the working-copy change it
// animates a snapshotCurrentStructure() copy (so the user's source row is left
// untouched), and that copy did not carry `.symmetry`. Every symmetry hook in
// MD.js keys off `structure.symmetry.mode === 'wyckoff'` via
// isWyckoffModeActive, so the copy looked unconstrained: forces, velocities and
// positions were never symmetrized and even a site with zero degrees of freedom
// drifted.
//
// This drives the same copy the panel drives, with random (symmetry-blind)
// forces, and asserts the fully-pinned site does not move.
'use strict';
const H = require('../harness');

// C6N8, P-6 2 m — the two N sites at (2/3,1/3,3/4) and (1/3,2/3,1/4) sit on
// special positions with no free parameter at all: under the constraint they
// cannot move, however hard they are pushed.
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

  const res = await page.evaluate(async (poscar) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    const md = await import('./atomistic/MD.js');
    const { snapshotCurrentStructure } = await import('./ui/BackendPanel/AtomisticPanels.js');

    await cv.loadStructure(poscar, 'C6N8.poscar');
    const source = fileBrowser.selectedStructure;
    await sym.activateWyckoffMode(source, sym.DEFAULT_SYMPREC);

    const sourceActive = sym.isWyckoffModeActive(source);
    const sourceDof = sym.getSymmetryDegreesOfFreedom(source);

    // Exactly what the MD panel does before starting a run.
    const working = snapshotCurrentStructure();
    fileBrowser.selectedStructure = working;
    const workingActive = sym.isWyckoffModeActive(working);
    const workingDof = sym.getSymmetryDegreesOfFreedom(working);

    // Random forces respect no symmetry, so anything that stays put stayed put
    // because of the constraint.
    const forceEvaluator = async (cell) => ({
      forces: cell.positions.map(() => [
        (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
      ]),
      stress: { matrix3x3: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
      total_energy: 0,
    });
    const nepRunner = { modelInfo: { element_list: ['C', 'N'] } };

    const state = await md.initializeMDState({
      nepRunner, structure: working, temperatureTargetK: 600, forceEvaluator,
    });
    const start = state.positions.map((p) => [...p]);
    await md.runMDSimulation({ state, steps: 20, dtFs: 1.0, forceEvaluator });

    const moved = state.positions.map((p, i) => Math.hypot(
      p[0] - start[i][0], p[1] - start[i][1], p[2] - start[i][2]));

    fileBrowser.selectedStructure = source;
    return {
      sourceActive,
      sourceDof,
      workingActive,
      workingDof,
      stateConstrained: state.symmetryConstrained,
      // Indices 12 and 13 are the two pinned N sites.
      pinnedMoved: [moved[12], moved[13]],
      maxMoved: Math.max(...moved),
    };
  }, C6N8_POSCAR);

  H.check('source structure is in Wyckoff mode with reduced DOF',
    res.sourceActive && res.sourceDof > 0 && res.sourceDof < 3 * 14,
    JSON.stringify({ active: res.sourceActive, dof: res.sourceDof }));

  // The regression itself: the copy MD animates must still be constrained.
  H.check('the MD working copy keeps Wyckoff mode', res.workingActive === true,
    JSON.stringify(res));
  H.check('the MD working copy keeps the same DOF count', res.workingDof === res.sourceDof,
    JSON.stringify({ source: res.sourceDof, working: res.workingDof }));
  H.check('MD initialized on the working copy reports itself constrained',
    res.stateConstrained === true, JSON.stringify(res));

  // What the user actually sees: a site with no freedom does not move.
  H.check('a zero-freedom site does not move under constrained MD',
    res.pinnedMoved.every((d) => d < 1e-9), JSON.stringify(res.pinnedMoved));
  // Sanity: the run was violent enough that an unconstrained site would have.
  H.check('other sites did move (the run was not a no-op)', res.maxMoved > 1e-3,
    String(res.maxMoved));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
