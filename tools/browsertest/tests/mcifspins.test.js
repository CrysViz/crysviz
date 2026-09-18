// mCIF spins: io/load_structure.js's parse_cif must wrap the expanded
// moments in Spin objects (like the OUTCAR/QE readers). Bare arrays used to
// make the Spins window throw on open (spin.vector undefined) for every mCIF.
'use strict';
const H = require('../harness');

// Trimmed Bilbao-style mCIF (CrVO3-like, P-1 with C-centering, 2 Cr moments).
const MCIF = `#\\#CIF_2.0
data_test
_space_group_magn.number_BNS  2.4
_space_group_magn.name_BNS  "P -1"
_cell_length_a             5.56800
_cell_length_b             8.20800
_cell_length_c             5.97700
_cell_angle_alpha          90.00
_cell_angle_beta           90.00
_cell_angle_gamma          90.00

loop_
_space_group_symop_magn_operation.id
_space_group_symop_magn_operation.xyz
1 x,y,z,+1
2 -x,-y,-z,+1

loop_
_space_group_symop_magn_centering.id
_space_group_symop_magn_centering.xyz
1 x,y,z,+1
2 x+1/2,y+1/2,z,+1

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Cr1_1 Cr 0.00000 0.00000 0.00000
Cr1_2 Cr  0.00000 0.00000 0.50000
V1 V 0.00000 0.35500 0.25000
O1_1 O 0.00000 0.24100 0.02600
O1_2 O  0.00000 0.75900 0.52600
O2_1 O 0.25100 0.47500 0.25000
O2_2 O  0.74900 0.47500 0.25000

loop_
_atom_site_moment.label
_atom_site_moment.crystalaxis_x
_atom_site_moment.crystalaxis_y
_atom_site_moment.crystalaxis_z
_atom_site_moment.symmform
_atom_site_moment.magnitude
Cr1_1 1.87 0.92 0.33 mx,my,mz       2.1(2)
Cr1_2 -1.87 -0.92 -0.33 mx,my,mz    2.1
`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const load = await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    const r = await cv.loadStructure(text, 'test.mcif');
    return { ok: r?.ok };
  }, MCIF);
  H.check('mcif loads', load.ok === true, JSON.stringify(load));
  await page.waitForTimeout(1500);

  const info = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { Spin } = await import('./model/index.js');
    const s = fileBrowser.selectedStructure;
    const mags = s.spins.map((sp) => Math.hypot(...sp.vector));
    return {
      n: s.atoms.length,
      nSpins: s.spins.length,
      allSpin: s.spins.every((sp) => sp instanceof Spin),
      nMagnetic: mags.filter((m) => m > 0.5).length,
    };
  });
  H.check('24 atoms, one spin per atom', info.n === 24 && info.nSpins === 24, JSON.stringify(info));
  H.check('spins are Spin objects', info.allSpin, JSON.stringify(info));
  H.check('4 Cr carry a moment', info.nMagnetic === 4, JSON.stringify(info));

  const open = await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    try { openPanel('spins'); return { ok: true }; } catch (e) { return { ok: false, err: String(e.stack || e) }; }
  });
  H.check('Spins window opens without throwing', open.ok, open.err ?? '');
  await page.waitForTimeout(500);
  const list = await page.evaluate(() => /** @type {HTMLTextAreaElement} */ (document.querySelector('.cv-spin-textarea--list'))?.value ?? '');
  H.check('current-spins list filled', list.split('\n').length === 24, list.slice(0, 120));

  const arrows = await page.evaluate(async () => {
    const { general, groups } = await import('./state/store.js');
    const { updateSpins } = await import('./render/index.js');
    general.spinsActive = true;
    updateSpins(general.spinScale ?? 1.0);
    return groups.spinShaftMesh?.count ?? 0;
  });
  H.check('spin arrows drawn', arrows > 0, `count=${arrows}`);

  H.check('no errors', errors.length === 0, errors.join('\n'));
  await H.finish(browser);
})().catch(H.crash);
