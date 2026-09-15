// Readers for SHELX/AIRSS .res (many structures per file — the "bulk" case)
// and CASTEP .cell input (LATTICE_ABC/POSITIONS_FRAC and LATTICE_CART +
// POSITIONS_ABS with unit lines). Drives the real load path
// (core/crystal-viewer.loadStructure) and inspects the parsed container.
'use strict';
const H = require('../harness');

// Three candidates concatenated into one .res, as an AIRSS search dump would be.
// Enthalpy is TITL field 4; each block is a simple cubic Na/Cl cell.
const RES = [
  'TITL cand-1 0.0 125.0 -50.5 0 0 2 (P1) n 1',
  'CELL 1.54 5.0 5.0 5.0 90.0 90.0 90.0',
  'LATT -1',
  'SFAC Na Cl',
  'Na1 1 0.0 0.0 0.0 1.0',
  'Cl1 2 0.5 0.5 0.5 1.0',
  'END',
  'TITL cand-2 0.0 126.0 -49.0 0 0 2 (P1) n 1',
  'CELL 1.54 5.1 5.1 5.1 90.0 90.0 90.0',
  'LATT -1',
  'SFAC Na Cl',
  'Na1 1 0.0 0.0 0.0 1.0',
  'Cl1 2 0.5 0.5 0.5 1.0',
  'END',
  'TITL cand-3 0.0 127.0 -48.25 0 0 2 (P1) n 1',
  'CELL 1.54 5.2 5.2 5.2 90.0 90.0 90.0',
  'LATT -1',
  'SFAC Na Cl',
  'Na1 1 0.0 0.0 0.0 1.0',
  'Cl1 2 0.5 0.5 0.5 1.0',
  'END',
].join('\n');

// CASTEP .cell using LATTICE_ABC + POSITIONS_FRAC, with `!` comments.
const CELL_FRAC = [
  '%BLOCK LATTICE_ABC',
  '  4.0 4.0 4.0   ! a b c',
  '  90.0 90.0 90.0',
  '%ENDBLOCK LATTICE_ABC',
  '',
  '%BLOCK POSITIONS_FRAC',
  '  Na 0.0 0.0 0.0',
  '  Cl 0.5 0.5 0.5',
  '%ENDBLOCK POSITIONS_FRAC',
].join('\n');

// CASTEP .cell using LATTICE_CART + POSITIONS_ABS, both with an `ang` units
// line. Cl at (2,2,2) Å in a 4 Å cube must come back as fractional (.5,.5,.5).
const CELL_ABS = [
  '%BLOCK LATTICE_CART',
  'ang',
  '4.0 0.0 0.0',
  '0.0 4.0 0.0',
  '0.0 0.0 4.0',
  '%ENDBLOCK LATTICE_CART',
  '%BLOCK POSITIONS_ABS',
  'ang',
  'Na 0.0 0.0 0.0',
  'Cl 2.0 2.0 2.0',
  '%ENDBLOCK POSITIONS_ABS',
].join('\n');

// CASTEP .geom: two optimization frames, atomic units. Cubic cell a = 4 Å
// (7.5589045 Bohr); Cl at 2 Å = 3.77945225 Bohr -> frac .5. Energies -10 /
// -10.5 Hartree; a 0.1 Hartree/Bohr force on Na in frame 0.
const GEOM = [
  ' BEGIN header',
  ' END header',
  '',
  '                      0',
  '   -1.0000000000E+001   -1.0000000000E+001                    <-- E',
  '    7.5589045000E+000    0.0000000000E+000    0.0000000000E+000  <-- h',
  '    0.0000000000E+000    7.5589045000E+000    0.0000000000E+000  <-- h',
  '    0.0000000000E+000    0.0000000000E+000    7.5589045000E+000  <-- h',
  '    1.0000000000E-003    0.0000000000E+000    0.0000000000E+000  <-- S',
  '    0.0000000000E+000    1.0000000000E-003    0.0000000000E+000  <-- S',
  '    0.0000000000E+000    0.0000000000E+000    1.0000000000E-003  <-- S',
  ' Na   1    0.0000000000E+000   0.0000000000E+000   0.0000000000E+000  <-- R',
  ' Cl   2    3.7794522500E+000   3.7794522500E+000   3.7794522500E+000  <-- R',
  ' Na   1    1.0000000000E-001   0.0000000000E+000   0.0000000000E+000  <-- F',
  ' Cl   2   -1.0000000000E-001   0.0000000000E+000   0.0000000000E+000  <-- F',
  '',
  '                      1',
  '   -1.0500000000E+001   -1.0500000000E+001                    <-- E',
  '    7.5589045000E+000    0.0000000000E+000    0.0000000000E+000  <-- h',
  '    0.0000000000E+000    7.5589045000E+000    0.0000000000E+000  <-- h',
  '    0.0000000000E+000    0.0000000000E+000    7.5589045000E+000  <-- h',
  ' Na   1    0.0000000000E+000   0.0000000000E+000   0.0000000000E+000  <-- R',
  ' Cl   2    3.7794522500E+000   3.7794522500E+000   3.7794522500E+000  <-- R',
  ' Na   1    0.0000000000E+000   0.0000000000E+000   0.0000000000E+000  <-- F',
  ' Cl   2    0.0000000000E+000   0.0000000000E+000   0.0000000000E+000  <-- F',
].join('\n');

// An AIRSS buildcell seed: POSITIONS_ABS, inline `#`/`%` comments, and NO
// lattice block. Must load as a molecule in a centered bounding box. Max
// coordinate magnitude is 1.71422 -> box side 2*(1.71422+2) = 7.42844 Å.
const SEED = [
  '#TARGVOL=7.69',
  '',
  '%BLOCK POSITIONS_ABS',
  '    C   0.86267   0.87843   0.69644 # 1-Td % NUM=1',
  '    H  -0.15687   1.20067   0.63115 # 1-Td',
  '    H   1.19106   0.93720   1.71422 # 1-Td',
  '    H   0.93994  -0.13355   0.35439 # 1-Td',
  '    H   1.47618   1.50890   0.08615 # 1-Td',
  '%ENDBLOCK POSITIONS_ABS',
  '',
  '#MINSEP=1.0 C-C=2.10 C-H=1.45 H-H=1.00',
].join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const load = async (text, name) => page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(text, name);
    const container = structureShip.container[fileBrowser.selectedRowIndex];
    return {
      fileName: container.fileName,
      nframes: container.structures.length,
      frames: container.structures.map((s) => ({
        elements: s.elements.join(','),
        energy: s.energy,
        a: s.lattice[0][0],
        clFrac: s.atoms[1].position,
        forceCount: s.forces ? s.forces.length : 0,
        naForceX: s.forces && s.forces[0] ? s.forces[0].vector[0] : null,
        stressXX: s.stress ? s.stress.tensor[0][0] : null,
        pressure: s.stress ? s.stress.pressure : null,
      })),
    };
  }, { text, name });

  const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) < tol;

  // --- bulk .res -----------------------------------------------------------
  const res = await load(RES, 'search.res');
  H.check('res: 3 structures parsed (bulk)', res.nframes === 3, JSON.stringify(res.nframes));
  H.check('res: elements per frame Na,Cl',
    res.frames.every((f) => f.elements === 'Na,Cl'), JSON.stringify(res.frames.map((f) => f.elements)));
  H.check('res: enthalpy carried onto energy',
    near(res.frames[0].energy, -50.5) && near(res.frames[1].energy, -49.0) && near(res.frames[2].energy, -48.25),
    JSON.stringify(res.frames.map((f) => f.energy)));
  H.check('res: per-candidate lattice a',
    near(res.frames[0].a, 5.0) && near(res.frames[2].a, 5.2),
    JSON.stringify(res.frames.map((f) => f.a)));
  H.check('res: fractional coords preserved',
    res.frames[0].clFrac.every((v) => near(v, 0.5)), JSON.stringify(res.frames[0].clFrac));

  // --- CASTEP .cell (fractional) ------------------------------------------
  const cf = await load(CELL_FRAC, 'NaCl.cell');
  H.check('cell(frac): one structure', cf.nframes === 1, JSON.stringify(cf.nframes));
  H.check('cell(frac): elements Na,Cl', cf.frames[0].elements === 'Na,Cl', cf.frames[0].elements);
  H.check('cell(frac): LATTICE_ABC -> a=4', near(cf.frames[0].a, 4.0), JSON.stringify(cf.frames[0].a));
  H.check('cell(frac): Cl at (.5,.5,.5)',
    cf.frames[0].clFrac.every((v) => near(v, 0.5)), JSON.stringify(cf.frames[0].clFrac));

  // --- CASTEP .cell (absolute + units) ------------------------------------
  const ca = await load(CELL_ABS, 'NaCl_abs.cell');
  H.check('cell(abs): elements Na,Cl', ca.frames[0].elements === 'Na,Cl', ca.frames[0].elements);
  H.check('cell(abs): 2Å in 4Å cube -> frac .5',
    ca.frames[0].clFrac.every((v) => near(v, 0.5)), JSON.stringify(ca.frames[0].clFrac));

  // --- CASTEP .geom trajectory --------------------------------------------
  const geom = await load(GEOM, 'relax.geom');
  H.check('geom: 2 frames parsed', geom.nframes === 2, JSON.stringify(geom.nframes));
  H.check('geom: Bohr -> Å lattice (a=4)', near(geom.frames[0].a, 4.0, 1e-4), JSON.stringify(geom.frames[0].a));
  H.check('geom: Cl Cartesian(Bohr) -> frac .5',
    geom.frames[0].clFrac.every((v) => near(v, 0.5, 1e-4)), JSON.stringify(geom.frames[0].clFrac));
  H.check('geom: Hartree -> eV energy',
    near(geom.frames[0].energy, -10 * 27.211386245988, 1e-2)
      && near(geom.frames[1].energy, -10.5 * 27.211386245988, 1e-2),
    JSON.stringify(geom.frames.map((f) => f.energy)));
  H.check('geom: one force per atom', geom.frames.every((f) => f.forceCount === 2),
    JSON.stringify(geom.frames.map((f) => f.forceCount)));
  H.check('geom: Hartree/Bohr -> eV/Å force',
    near(geom.frames[0].naForceX, 0.1 * (27.211386245988 / 0.52917721067), 1e-3),
    JSON.stringify(geom.frames[0].naForceX));
  // Stress: 1e-3 Hartree/Bohr^3 diagonal -> 29.421 GPa; pressure = -tr/3.
  H.check('geom: stress tensor Hartree/Bohr^3 -> GPa',
    near(geom.frames[0].stressXX, 1e-3 * 29421.02648, 1e-2), JSON.stringify(geom.frames[0].stressXX));
  H.check('geom: pressure = -tr/3 (GPa)',
    near(geom.frames[0].pressure, -1e-3 * 29421.02648, 1e-2), JSON.stringify(geom.frames[0].pressure));
  H.check('geom: frame without S has no stress',
    geom.frames[1].stressXX === null, JSON.stringify(geom.frames[1].stressXX));

  // --- AIRSS seed .cell: absolute positions, no lattice -> molecule in a box --
  const seed = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(text, 'CH4.cell');
    const s = structureShip.container[fileBrowser.selectedRowIndex].structures[0];
    return {
      elements: s.elements.join(','),
      natoms: s.atoms.length,
      a: s.lattice[0][0],
      offDiag: Math.abs(s.lattice[0][1]) + Math.abs(s.lattice[0][2]),
      allFracInCell: s.atoms.every((at) => at.position.every((v) => v >= 0 && v < 1)),
    };
  }, SEED);
  H.check('seed: loads all 5 atoms as CH4', seed.natoms === 5 && seed.elements === 'C,H,H,H,H',
    JSON.stringify(seed));
  H.check('seed: centered orthorhombic box ~7.428 Å',
    near(seed.a, 7.42844, 1e-3) && near(seed.offDiag, 0), JSON.stringify(seed));
  H.check('seed: fractional coords inside the box', seed.allFracInCell, JSON.stringify(seed));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
