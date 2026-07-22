// "Continue MD" resumes a trajectory from its last frame's own velocities
// instead of a fresh Maxwell-Boltzmann draw. That rests on two contracts:
// initializeMDState() must use initialVelocities verbatim (not randomize) when
// given them, and applyMDStateToViewer() must write state.velocities onto the
// structure so snapshotCurrentStructure() (AtomisticPanels.js) can carry them
// onto the saved frame the same way it already carries forces. Also checks
// Structure keeps .velocities through its clone/copy (`.original`) path, the
// same way it keeps forces/energy.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);

  const res = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const md = await import('./atomistic/MD.js');
    const { Structure, Atom } = await import('./model/index.js');
    const structure = fileBrowser.selectedStructure;

    const forceEvaluator = async (cell) => ({
      forces: cell.positions.map(() => [0, 0, 0]),
      stress: { matrix3x3: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
      total_energy: 0,
    });
    const nepRunner = { modelInfo: { element_list: [...new Set(structure.elements)] } };

    // Fresh draw: no initialVelocities given -> a random (non-degenerate) set.
    const freshState = await md.initializeMDState({
      nepRunner, structure, temperatureTargetK: 500, forceEvaluator,
    });
    const freshNonZero = freshState.velocities.some((v) => v[0] !== 0 || v[1] !== 0 || v[2] !== 0);

    // Resume: initialVelocities given -> used verbatim, not redrawn.
    const seedVelocities = structure.atoms.map((_, i) => [i + 0.1, -(i + 0.2), (i + 0.3) * 2]);
    const resumedState = await md.initializeMDState({
      nepRunner, structure, temperatureTargetK: 500, forceEvaluator,
      initialVelocities: seedVelocities,
    });
    const resumedMatches = resumedState.velocities.every((v, i) => (
      Math.abs(v[0] - seedVelocities[i][0]) < 1e-12
      && Math.abs(v[1] - seedVelocities[i][1]) < 1e-12
      && Math.abs(v[2] - seedVelocities[i][2]) < 1e-12
    ));
    // Deep-copied, not aliased: mutating the input must not alter the state.
    seedVelocities[0][0] = 999;
    const resumedNotAliased = resumedState.velocities[0][0] !== 999;

    // applyMDStateToViewer carries state.velocities onto the structure (so a
    // later snapshotCurrentStructure() picks them up, like it does forces).
    const target = new Structure({
      elements: [...structure.elements],
      lattice: structure.lattice.map((r) => [...r]),
      atoms: structure.atoms.map((a, i) => new Atom({ position: [...a.position], element: structure.elements[i] })),
      periodic: { hash: 'None', wrapped: null },
    });
    md.applyMDStateToViewer(resumedState, target, { full: true });
    const viewerCarriesVelocities = Array.isArray(target.velocities)
      && target.velocities.length === resumedState.velocities.length
      && target.velocities.every((v, i) => (
        Math.abs(v[0] - resumedState.velocities[i][0]) < 1e-12
        && Math.abs(v[1] - resumedState.velocities[i][1]) < 1e-12
      ));

    // applyMDStateToViewer must not choke on a caller that omits velocities
    // entirely (mdviewerupdate.test.js drives it this way).
    let survivesMinimalState = true;
    try {
      md.applyMDStateToViewer({ lattice: structure.lattice.map((r) => [...r]), positions: structure.atoms.map(() => [0, 0, 0]) }, target, {});
    } catch {
      survivesMinimalState = false;
    }

    // Structure's clone/copy (`.original`) path: velocities survive it like
    // forces/energy do.
    const withVel = new Structure({
      elements: ['Si'],
      lattice: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      atoms: [],
      velocities: [[1, 2, 3]],
    });
    const originalPreserves = Array.isArray(withVel.original.velocities)
      && withVel.original.velocities[0][0] === 1
      && withVel.original.velocities[0][1] === 2
      && withVel.original.velocities[0][2] === 3;
    const defaultsNull = new Structure({ elements: [], lattice: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], atoms: [] }).velocities === null;

    return {
      freshNonZero, resumedMatches, resumedNotAliased, viewerCarriesVelocities,
      survivesMinimalState, originalPreserves, defaultsNull,
    };
  });

  H.check('initializeMDState draws non-degenerate velocities with no initialVelocities', res.freshNonZero, JSON.stringify(res));
  H.check('initializeMDState uses initialVelocities verbatim when given (Continue MD resume)', res.resumedMatches, JSON.stringify(res));
  H.check('initialVelocities is deep-copied, not aliased', res.resumedNotAliased, JSON.stringify(res));
  H.check('applyMDStateToViewer carries state.velocities onto the structure', res.viewerCarriesVelocities, JSON.stringify(res));
  H.check('applyMDStateToViewer tolerates a state with no velocities field', res.survivesMinimalState, JSON.stringify(res));
  H.check('Structure.original keeps velocities through the clone/copy path', res.originalPreserves, JSON.stringify(res));
  H.check('Structure.velocities defaults to null when unknown', res.defaultsNull, JSON.stringify(res));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
