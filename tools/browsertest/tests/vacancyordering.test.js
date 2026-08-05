// A "Va" site is a vacancy — the absence of an atom — not a real element.
// Four places must treat it differently, and they used to disagree:
//   - Order Structure builds a visible cell: it KEEPS the vacancy images as
//     "Va" atoms so the user sees where they landed (they must NOT vanish).
//   - buildNEPStructure is the one viewer→potential payload builder (NEP and
//     MLIP): it EXCLUDES "Va" so the potential ignores it, and returns
//     keptIndices so the shorter forces/positions map back onto the full list.
//   - POSCAR has no way to say "empty site", so the download drops Va.
//   - .crysviz is a lossless save, so it MUST keep Va.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Inject a structure with a fractional site (something to order), an explicit
  // Va vacancy marker, and an ordinary atom — then probe every path.
  const r = await page.evaluate(async () => {
    const { Atom, Structure } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { buildOrderedStructure } = await import('./atomistic/order_structure.js');
    const { buildNEPStructure, expandKeptVectorsToFull } = await import('./atomistic/relaxer.js');
    const { poscartoFile } = await import('./ui/SavePanel.js');
    const { captureState } = await import('./ui/ShareModule.js');

    const atoms = [
      new Atom({ position: [0, 0, 0], species: [{ element: 'Fe', occupancy: 0.5 }] }),
      new Atom({ position: [0.5, 0.5, 0.5], element: 'Va' }),
      new Atom({ position: [0.25, 0.25, 0.25], element: 'O' }),
    ];
    const lattice = [[4, 0, 0], [0, 4, 0], [0, 0, 4]];
    const structure = new Structure({ atoms, elements: ['Fe', 'Va', 'O'], lattice });
    fileBrowser.selectedStructure = structure;

    const ordered = buildOrderedStructure(structure, { method: 'random', seed: 1, multiplier: 2 });

    // A fake potential whose model knows Fe and O but NOT Va — so if Va leaked
    // into the payload, buildNEPStructure would throw "Model does not support".
    const fakeRunner = { modelInfo: { element_list: ['Fe', 'O'] } };
    const nep = buildNEPStructure(fakeRunner, ordered);
    // Expand a per-(kept-)atom vector array back to full length; vacancies -> 0.
    const forcesFull = expandKeptVectorsToFull(
      ordered.atoms.length, nep.types.map(() => [1, 1, 1]), nep.keptIndices);

    const poscar = poscartoFile();
    const state = captureState();

    return {
      orderedElements: ordered.elements,
      nepTypesCount: nep.types.length,
      nepAtomCount: nep.positions.length,
      orderedAtomCount: ordered.atoms.length,
      vaCount: ordered.elements.filter((e) => e === 'Va').length,
      forcesFullLen: forcesFull.length,
      forcesAtVacancyAreZero: ordered.elements.every((el, i) =>
        el !== 'Va' || (forcesFull[i][0] === 0 && forcesFull[i][1] === 0 && forcesFull[i][2] === 0)),
      poscar,
      crysvizElements: state.structure.elements,
    };
  });

  H.check('Order Structure KEEPS vacancy images as visible Va atoms',
    r.orderedElements.includes('Va') && r.orderedElements.includes('Fe') && r.orderedElements.includes('O'),
    JSON.stringify(r.orderedElements));

  H.check('buildNEPStructure excludes Va from the potential payload',
    r.nepAtomCount === r.orderedAtomCount - r.vaCount && r.nepTypesCount === r.nepAtomCount && r.vaCount > 0,
    JSON.stringify({ nep: r.nepAtomCount, ordered: r.orderedAtomCount, va: r.vaCount }));

  H.check('forces expand back to full length with zeros on vacancies',
    r.forcesFullLen === r.orderedAtomCount && r.forcesAtVacancyAreZero,
    JSON.stringify({ full: r.forcesFullLen, ordered: r.orderedAtomCount }));

  H.check('POSCAR download omits the Va vacancy',
    !/\bVa\b/.test(r.poscar) && r.poscar.includes('O') && r.poscar.includes('Fe'),
    r.poscar.split('\n').slice(5, 8).join(' | '));

  H.check('.crysviz save preserves the Va vacancy',
    r.crysvizElements.includes('Va'),
    JSON.stringify(r.crysvizElements));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
