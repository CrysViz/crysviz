// FHI-aims readers: geometry.in (structure + magnetism, and a lattice-less
// molecule) and aims.out (relaxation trajectory with per-frame energy, forces,
// and per-atom spin moments).
'use strict';
const H = require('../harness');

// Magnetic bcc Fe: fractional atoms + collinear initial_moment.
const GEOM = [
  '# bcc Fe, ferromagnetic',
  'lattice_vector 2.87 0.0 0.0',
  'lattice_vector 0.0 2.87 0.0',
  'lattice_vector 0.0 0.0 2.87',
  'atom_frac 0.0 0.0 0.0 Fe',
  'initial_moment 2.2',
  'atom_frac 0.5 0.5 0.5 Fe',
  'initial_moment 2.1',
].join('\n');

// A water molecule with Cartesian atoms and no lattice -> centered box.
const MOLECULE = [
  'atom 0.0 0.0 0.0 O',
  'atom 0.0 0.0 0.96 H',
  'atom 0.93 0.0 -0.24 H',
].join('\n');

// A two-step relaxation output with energy, forces and a Mulliken spin table.
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
  '  Full analysis of Mulliken charges and spin moments:',
  '  |  atom      charge      spin',
  '  |    1  Fe    0.0000      2.2000',
  '  |    2  Fe    0.0000      2.1000',
  '',
  '  | Total energy uncorrected      :        -0.100000000E+04 eV',
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

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const load = (text, name) => page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(text, name);
    const c = structureShip.container[fileBrowser.selectedRowIndex];
    return {
      nframes: c.structures.length,
      frames: c.structures.map((s) => ({
        elements: s.elements.join(','),
        a: s.lattice[0][0],
        off: Math.abs(s.lattice[0][1]) + Math.abs(s.lattice[0][2]),
        energy: s.energy,
        spinCount: s.spins ? s.spins.length : 0,
        spinZ0: s.spins && s.spins[0] ? s.spins[0].vector[2] : null,
        forceCount: s.forces ? s.forces.length : 0,
        force0x: s.forces && s.forces[0] ? s.forces[0].vector[0] : null,
        atom1: s.atoms[1] ? s.atoms[1].position : null,
      })),
    };
  }, { text, name });

  const near = (a, b, tol = 1e-3) => Number.isFinite(a) && Math.abs(a - b) < tol;

  // --- geometry.in with magnetism ----------------------------------------
  const g = await load(GEOM, 'geometry.in');
  const gf = g.frames[0];
  H.check('geom: one structure, 2 Fe', g.nframes === 1 && gf.elements === 'Fe,Fe', JSON.stringify(g));
  H.check('geom: lattice a = 2.87', near(gf.a, 2.87), JSON.stringify(gf.a));
  H.check('geom: atom_frac preserved (0.5,0.5,0.5)',
    gf.atom1 && gf.atom1.every((v) => near(v, 0.5)), JSON.stringify(gf.atom1));
  H.check('geom: collinear moments -> spins along z',
    gf.spinCount === 2 && near(gf.spinZ0, 2.2), JSON.stringify(gf));

  // --- lattice-less molecule ---------------------------------------------
  const m = await load(MOLECULE, 'geometry.in');
  const mf = m.frames[0];
  H.check('molecule: 3 atoms O,H,H', mf.elements === 'O,H,H', mf.elements);
  H.check('molecule: centered box (orthorhombic, a>0)',
    mf.a > 0 && near(mf.off, 0), JSON.stringify(mf));
  H.check('molecule: no spins', mf.spinCount === 0, String(mf.spinCount));

  // --- aims.out trajectory ------------------------------------------------
  const o = await load(AIMS_OUT, 'aims.out');
  H.check('out: 2 frames', o.nframes === 2, JSON.stringify(o.nframes));
  H.check('out: elements Fe,Fe each frame',
    o.frames.every((f) => f.elements === 'Fe,Fe'), JSON.stringify(o.frames.map((f) => f.elements)));
  H.check('out: per-frame corrected energy',
    near(o.frames[0].energy, -1005) && near(o.frames[1].energy, -1010),
    JSON.stringify(o.frames.map((f) => f.energy)));
  H.check('out: frame 0 forces (eV/Å)',
    o.frames[0].forceCount === 2 && near(o.frames[0].force0x, 0.1), JSON.stringify(o.frames[0]));
  H.check('out: frame 0 Mulliken spins',
    o.frames[0].spinCount === 2 && near(o.frames[0].spinZ0, 2.2), JSON.stringify(o.frames[0]));
  H.check('out: frame 1 geometry moved (atom 1 x shifted)',
    o.frames[1].atom1 && o.frames[1].atom1[0] !== o.frames[0].atom1[0], JSON.stringify(o.frames.map((f) => f.atom1)));

  // --- spin sanity check: magnetic run, unreadable per-atom moments ---------
  // Same geometry, but a net moment + a spin-section header whose rows are in a
  // layout the reader can't parse. The structure must still load (no spins),
  // and the load-warning modal must appear telling the user spins were dropped.
  const BAD_SPIN = [
    '  Input geometry:',
    '  | Unit cell:',
    '  |        4.0 0.0 0.0',
    '  |        0.0 4.0 0.0',
    '  |        0.0 0.0 4.0',
    '  | Atomic structure:',
    '  |    1: Species Fe   0.0 0.0 0.0',
    '  |    2: Species Fe   2.0 2.0 2.0',
    '  | N_up - N_down (sum over all atoms) :        4.30000',
    '  Hirshfeld analysis of spin moments:',
    '     (a version-specific layout the reader does not recognise)',
    '  | Total energy corrected        :        -0.100000000E+04 eV',
  ].join('\n');

  const bad = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    await cv.loadStructure(text, 'magnetic.aims.out');
    const c = structureShip.container[fileBrowser.selectedRowIndex];
    const s = c.structures[0];
    const modal = document.getElementById('loadErrorModal');
    const msg = document.getElementById('loadErrorMessage');
    return {
      loaded: c.structures.length === 1 && s.atoms.length === 2,
      spinCount: s.spins ? s.spins.length : 0,
      warnings: Array.isArray(c.loadWarnings) ? c.loadWarnings.length : 0,
      modalVisible: !!modal && !modal.hidden,
      isWarningTone: !!modal && modal.classList.contains('load-modal-warning'),
      msg: msg ? msg.textContent : '',
    };
  }, BAD_SPIN);
  H.check('bad-spin: structure still loads without spins',
    bad.loaded && bad.spinCount === 0, JSON.stringify(bad));
  H.check('bad-spin: container carries a load warning', bad.warnings === 1, String(bad.warnings));
  H.check('bad-spin: warning modal shown (warning tone)',
    bad.modalVisible && bad.isWarningTone, JSON.stringify(bad));
  H.check('bad-spin: warning mentions spin', /spin/i.test(bad.msg), bad.msg);

  const closed = await page.evaluate(() => {
    document.getElementById('loadErrorOk').click();
    return document.getElementById('loadErrorModal').hidden;
  });
  H.check('bad-spin: OK closes the warning', closed === true, String(closed));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
