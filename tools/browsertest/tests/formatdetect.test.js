// Format detection goes by CONTENT first and by filename only as the tiebreak
// (io/formats.js). The bug this guards against: every DFT code writes `*.out`,
// and an FHI-aims run saved as `relax.out` or `Si.scf.out` used to be routed to
// the Quantum ESPRESSO reader (or the POSCAR fallback) purely by its name.
'use strict';
const H = require('../harness');

// The aims.test.js relaxation fixture, verbatim: two frames, Fe2.
const AIMS_OUT = [
  '  Input geometry:',
  '  | Unit cell:',
  '  |        4.00000000        0.00000000        0.00000000',
  '  |        0.00000000        4.00000000        0.00000000',
  '  |        0.00000000        0.00000000        4.00000000',
  '  | Atomic structure:',
  '  |       Atom                x            y            z',
  '  |    1: Species Fe          0.00000000       0.00000000       0.00000000',
  '  |    2: Species Fe          2.00000000       2.00000000       2.00000000',
  '',
  '  Total atomic forces (unitary forces cleaned) [eV/Ang]:',
  '  |    1         0.10000000        0.00000000        0.00000000',
  '  |    2        -0.10000000        0.00000000        0.00000000',
  '',
  '  | Total energy corrected        :        -0.100500000E+04 eV',
  '',
  '  Updated atomic structure:',
  '  ------------------------------------------------------------',
  '            x [A]             y [A]             z [A]',
  '  lattice_vector        4.00000000        0.00000000        0.00000000',
  '  lattice_vector        0.00000000        4.00000000        0.00000000',
  '  lattice_vector        0.00000000        0.00000000        4.00000000',
  '  atom         0.00000000        0.00000000        0.00000000 Fe',
  '  atom         2.10000000        2.00000000        2.00000000 Fe',
  '  ------------------------------------------------------------',
  '',
  '  | Total energy corrected        :        -0.101000000E+04 eV',
].join('\n');

// What a real aims.out opens with: the banner, then the geometry.in echo.
const AIMS_BANNER = [
  '------------------------------------------------------------',
  '          Invoking FHI-aims ...',
  '',
  '  Reading geometry description geometry.in.',
  '  lattice_vector 2.87 0.0 0.0',
  '  atom_frac 0.0 0.0 0.0 Fe',
].join('\n');

const QE_OUT = [
  '     Program PWSCF v.7.0 starts on 28Mar2025 at  8: 6:43',
  '     celldm(1)=   1.889726  celldm(2)=   0.000000  celldm(3)=   0.000000',
  '     crystal axes: (cart. coord. in units of alat)',
  'ATOMIC_POSITIONS (crystal)',
].join('\n');

const QE_IN = ['&CONTROL', '/', '&SYSTEM', '/', 'ATOMIC_SPECIES', 'ATOMIC_POSITIONS crystal', 'Na 0 0 0'].join('\n');
const OUTCAR = [' vasp.6.4.2 20Jul23 complex', ' INCAR:', ' POTCAR:    PAW_PBE Fe 06Sep2000'].join('\n');
const GEOM = ['lattice_vector 2.87 0.0 0.0', 'atom_frac 0.0 0.0 0.0 Fe'].join('\n');
const POSCAR = ['YBCO', '1.0', '3.82 0 0', '0 3.89 0', '0 0 11.68', 'Y', '1', 'Direct', '0 0 0'].join('\n');
const CHGCAR = [...POSCAR.split('\n'), '', '  24  24  24', ' 0.1 0.2'].join('\n');
const CUBE = [' c', ' c', ' 1 0 0 0', ' 2 0.5 0 0', ' 2 0 0.5 0', ' 2 0 0 0.5', ' 1 1.0 0 0 0'].join('\n');
const XYZ = ['1', 'comment', 'H 0 0 0'].join('\n');
const CIF = ['data_YBCO', '_cell_length_a 3.82', '_cell_length_b 3.89', '_cell_length_c 11.68',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  "_symmetry_space_group_name_H-M 'P 1'", 'loop_', '_atom_site_label', '_atom_site_type_symbol',
  '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z', 'Y1 Y 0 0 0'].join('\n');
const MCIF = ['data_Fe', '_cell_length_a 2.87', '_space_group_magn.number_BNS "229.143"'].join('\n');
const RES = ['TITL x 0 1 -1 0 0 1 (P1) n - 1', 'CELL 1.54 4 4 4 90 90 90', 'SFAC Na', 'Na 1 0 0 0 1', 'END'].join('\n');
const CELL = ['%BLOCK LATTICE_CART', '4 0 0', '0 4 0', '0 0 4', '%ENDBLOCK LATTICE_CART'].join('\n');
const CASTEP_GEOM = [' BEGIN header', ' END header', '  -1.0  -1.0  <-- E'].join('\n');
const CRYSVIZ = '{"format":"crysviz","version":1}';

// [label, content, fileName, expected id]
const TABLE = [
  ['aims.out under its own name', AIMS_OUT, 'aims.out', 'aims-out'],
  ['aims.out as relax.out', AIMS_OUT, 'relax.out', 'aims-out'],
  ['aims.out as Fe.scf.out (QE-looking name)', AIMS_OUT, 'Fe.scf.out', 'aims-out'],
  ['aims.out pasted (no name)', AIMS_OUT, '', 'aims-out'],
  ['aims banner + geometry echo', AIMS_BANNER, 'run.out', 'aims-out'],
  ['geometry.in', GEOM, 'geometry.in', 'aims-geometry'],
  ['geometry.in renamed', GEOM, 'Fe.txt', 'aims-geometry'],
  ['QE output as relax.out', QE_OUT, 'relax.out', 'pwscf-out'],
  ['QE input renamed', QE_IN, 'pw.inp', 'pwscf-in'],
  ['OUTCAR renamed', OUTCAR, 'run.out', 'outcar'],
  ['POSCAR is the fallback', POSCAR, 'YBCO.vasp', 'poscar'],
  ['CHGCAR renamed', CHGCAR, 'density', 'chgcar'],
  ['ELFCAR by name (same layout as CHGCAR)', CHGCAR, 'ELFCAR', 'elfcar'],
  ['cube renamed', CUBE, 'rho.dat', 'cube'],
  ['xyz renamed', XYZ, 'mol.txt', 'xyz'],
  ['CIF renamed', CIF, 'download', 'cif'],
  ['mCIF named .cif', MCIF, 'Fe.cif', 'mcif'],
  ['res renamed', RES, 'x', 'res'],
  ['cell renamed', CELL, 'x', 'castep-cell'],
  ['castep geom renamed', CASTEP_GEOM, 'x', 'castep-geom'],
  ['crysviz renamed', CRYSVIZ, 'x.json', 'crysviz'],
  ['empty content, name decides', '', 'a.cif', 'cif'],
];

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // --- the detector itself, in the app's own module instance -------------
  const detected = await page.evaluate(async (table) => {
    const { detectFormat, headOf } = await import('./io/index.js');
    return table.map(([label, content, name, expected]) => ({
      label, expected, got: detectFormat({ fileName: name, head: headOf(content) }).id,
    }));
  }, TABLE);
  for (const r of detected) {
    H.check(`detect: ${r.label} -> ${r.expected}`, r.got === r.expected, `got ${r.got}`);
  }

  // --- end to end: the misnamed aims.out actually loads as a trajectory ----
  const load = (text, name) => page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(text, name);
    const c = structureShip.container[fileBrowser.selectedRowIndex];
    return {
      nframes: c.structures.length,
      elements: c.structures[0].elements.join(','),
      energy1: c.structures[1] ? c.structures[1].energy : null,
      forceCount: c.structures[0].forces ? c.structures[0].forces.length : 0,
    };
  }, { text, name });
  const near = (a, b, tol = 1e-3) => Number.isFinite(a) && Math.abs(a - b) < tol;

  for (const name of ['relax.out', 'Fe.scf.out']) {
    const o = await load(AIMS_OUT, name);
    H.check(`${name}: loads as a 2-frame aims trajectory`, o.nframes === 2, JSON.stringify(o));
    H.check(`${name}: Fe,Fe with forces`, o.elements === 'Fe,Fe' && o.forceCount === 2, JSON.stringify(o));
    H.check(`${name}: frame 2 energy -1010 eV`, near(o.energy1, -1010), String(o.energy1));
  }

  // A CIF under a name that says nothing about its format.
  const c = await load(CIF, 'download');
  H.check('download: CIF content loads as CIF (1 Y atom)', c.nframes === 1 && c.elements === 'Y', JSON.stringify(c));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
