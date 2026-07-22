// Does an MD run in Wyckoff mode actually keep every frame symmetric?
//
// MD.js symmetrizes positions, velocities and forces each step
// (syncStateSymmetryConstraint + initializeMDState). This drives a real
// runMDSimulation with a deliberately hostile force evaluator — random forces,
// which respect no symmetry at all — and re-analyses EVERY frame with moyo at
// the same symprec the lock was taken at. If the constraint is doing its job,
// the space group never changes.
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

/** Run `steps` of MD on the selected structure with random forces, analysing
 *  every frame. `constrained` decides whether Wyckoff mode is on. */
async function runMD(page, { constrained, steps }) {
  return page.evaluate(async ({ constrained, steps }) => {
    const { fileBrowser } = await import('./state/store.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    const md = await import('./atomistic/MD.js');
    const structure = fileBrowser.selectedStructure;

    if (constrained) await sym.activateWyckoffMode(structure, sym.DEFAULT_SYMPREC);
    else sym.deactivateWyckoffMode(structure);

    // Random forces: no symmetry whatsoever, so anything symmetric in the
    // trajectory came from the constraint and nowhere else.
    const forceEvaluator = async (cell) => ({
      forces: cell.positions.map(() => [
        (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2,
      ]),
      stress: { matrix3x3: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
      total_energy: 0,
    });
    const nepRunner = { modelInfo: { element_list: ['C', 'N'] } };

    const state = await md.initializeMDState({
      nepRunner, structure, temperatureTargetK: 600, forceEvaluator,
    });

    // Analyse a Cartesian frame without disturbing the live structure.
    const saved = structure.atoms.map((a) => [...a.position]);
    const invLattice = (L) => {
      const [a, b, c, d, e, f, g, h, i] = [L[0][0], L[1][0], L[2][0], L[0][1], L[1][1], L[2][1], L[0][2], L[1][2], L[2][2]];
      const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
      return [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
      ];
    };
    const analyseFrame = async (positions, lattice) => {
      const M = invLattice(lattice);
      structure.atoms.forEach((atom, idx) => {
        const p = positions[idx];
        atom.position = [0, 1, 2].map((k) => {
          const v = M[k][0] * p[0] + M[k][1] * p[1] + M[k][2] * p[2];
          return ((v % 1) + 1) % 1;
        });
      });
      try {
        const d = await sym.analyzeStructureSymmetry(structure, sym.DEFAULT_SYMPREC);
        return d.number;
      } catch (e) {
        return String(e).slice(0, 40);
      }
    };

    const frames = [];
    const numbers = [];
    numbers.push(await analyseFrame(state.positions, state.lattice));
    structure.atoms.forEach((a, i) => { a.position = saved[i]; });

    await md.runMDSimulation({
      state, steps, dtFs: 1.0, forceEvaluator,
      onStep: ({ state: s }) => { frames.push(s.positions.map((p) => [...p])); },
    });

    const lattice = state.lattice;
    for (const f of frames) numbers.push(await analyseFrame(f, lattice));
    structure.atoms.forEach((a, i) => { a.position = saved[i]; });

    const displacement = Math.max(...frames[frames.length - 1].map((p, i) => Math.hypot(
      p[0] - state.positions[i][0], p[1] - state.positions[i][1], p[2] - state.positions[i][2])));

    return {
      constrainedFlag: state.symmetryConstrained,
      dof: state.constrainedDof,
      frames: numbers.length,
      numbers,
      distinct: [...new Set(numbers.map(String))],
      movedAtAll: frames.length > 1,
      displacement,
    };
  }, { constrained, steps });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'C6N8');
  }, C6N8_POSCAR);
  await page.waitForTimeout(2500);

  const constrained = await runMD(page, { constrained: true, steps: 25 });
  H.check('MD reports itself symmetry-constrained with a reduced DOF count',
    constrained.constrainedFlag === true && constrained.dof > 0 && constrained.dof < 3 * 14,
    `constrained=${constrained.constrainedFlag}, dof=${constrained.dof} (unconstrained would be 42)`);
  H.check('every MD frame is still P6_3/m at symprec 0.01',
    constrained.frames === 26 && constrained.distinct.length === 1 && constrained.numbers[0] === 176,
    `${constrained.frames} frames, space groups seen: ${constrained.distinct.join(', ')}`);

  // Control: the same run without the lock must NOT stay symmetric, otherwise
  // the check above proves nothing about the constraint.
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'C6N8-free');
  }, C6N8_POSCAR);
  await page.waitForTimeout(2500);
  const free = await runMD(page, { constrained: false, steps: 25 });
  H.check('the same MD without the lock loses the space group (control)',
    free.constrainedFlag === false && free.distinct.some((n) => n !== '176'),
    `space groups seen: ${free.distinct.slice(0, 6).join(', ')}`);

  H.check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await H.finish(browser);
})().catch(H.crash);
