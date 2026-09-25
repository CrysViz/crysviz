// Files window ▸ Structure info: the selected structure's lattice, positions
// and Wyckoff positions, copyable, with a ✎ that opens Modify Structure.
//
//   - the section, titled "Parameters", sits in the Files window body under the
//     table, folded by default, with no file name or atom count in the header
//   - a structure carrying energy / stress / forces (an OUTCAR frame) shows
//     those as chips at the top; a bare POSCAR shows a "no EFS data" note
//   - unfolding renders the lattice (3 vectors, parameters, volume), the
//     positions table (one row per atom, fractional; the frac/cart pair
//     switches to Cartesian) and, from a local moyo analysis, the space group
//     and one Wyckoff row per orbit (YBCO: Pmmm, 47)
//   - values are plain selectable text (no click-to-copy); a block's ⧉ copies
//     the block (clipboard stubbed to observe it)
//   - ✎ opens the Modify Structure panel without folding the section
//   - the section follows a structure switch (Si diamond: 2 atoms, Fd-3m)
//   - the pure text builders in structureSummaryText.js
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO, 13 atoms

  const read = () => page.evaluate(() => {
    const d = document.getElementById('fileStructureSummary');
    const inFiles = !!d?.closest('.cv-panel[data-panel-id="files"]');
    const rows = [...d.querySelectorAll('#fssPositionsBody tr')];
    const wyRows = [...d.querySelectorAll('#fssWyckoffBody tr')];
    return {
      exists: !!d,
      inFiles,
      open: d.open,
      title: d.querySelector('.fss-title').textContent,
      hasName: !!d.querySelector('#fssName'),
      propsHidden: d.querySelector('#fssProperties').hidden,
      props: d.querySelector('#fssProperties').textContent,
      latticeLines: d.querySelector('#fssLattice').textContent.split('\n').filter(Boolean),
      params: d.querySelector('#fssParams').textContent,
      paramChips: [...d.querySelectorAll('#fssParams .fss-chip')].map((c) => c.textContent),
      positionsHead: d.querySelector('#fssPositionsHead').textContent,
      nRows: rows.length,
      row2: rows[1] ? [...rows[1].querySelectorAll('td')].map((td) => td.textContent) : null,
      cartActive: d.querySelector('#fssCartBtn').classList.contains('active'),
      spaceGroup: d.querySelector('#fssSpaceGroup').textContent,
      sgLink: d.querySelector('#fssSpaceGroup a.sym-link')?.getAttribute('href') ?? null,
      sgLinkText: d.querySelector('#fssSpaceGroup a.sym-link')?.textContent ?? null,
      wyckoffHidden: d.querySelector('#fssWyckoffTable').hidden,
      // Neither table may overflow its block horizontally in the sidebar.
      fits: [...d.querySelectorAll('.fss-table-wrap')].every((w) => w.scrollWidth <= w.clientWidth + 1),
      nWyckoff: wyRows.length,
      wyckoffRow0: wyRows[0] ? [...wyRows[0].querySelectorAll('td')].map((td) => td.textContent) : null,
      pref: JSON.parse(localStorage.getItem('panelPrefs') || '{}').fileStructureInfoOpen,
    };
  });

  // ---- 1. folded, in the Files window, naming the structure --------------------
  let s = await read();
  H.check('section titled "Parameters", in the Files window, folded, with no name/atom-count in the header',
    s.exists && s.inFiles && s.open === false && s.title === 'Parameters' && !s.hasName, JSON.stringify(s));

  // ---- 2. unfold: lattice, positions, Wyckoff ---------------------------------
  await page.evaluate(() => document.querySelector('#fileStructureSummary .fss-summary').click());
  await page.waitForTimeout(300);
  const structure = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const st = fileBrowser.selectedStructure;
    return { lattice: st.lattice, positions: st.atoms.map((a) => [...a.position]), elements: [...st.elements] };
  });
  s = await read();
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
  const latticeOk = s.latticeLines.length === 3 && s.latticeLines.every((line, i) =>
    line.trim().split(/\s+/).every((v, j) => near(parseFloat(v), structure.lattice[i][j])));
  H.check('unfolding shows the three lattice vectors to 6 decimals', latticeOk, JSON.stringify(s.latticeLines));
  H.check('lattice parameters and volume as seven chips',
    /a = /.test(s.params) && /γ = /.test(s.params) && /V = /.test(s.params) && s.paramChips.length === 7,
    JSON.stringify([s.params, s.paramChips]));
  H.check('one positions row per atom, fractional by default, no horizontal overflow',
    s.nRows === 13 && s.positionsHead === 'Fractional positions' && s.row2 && s.row2[1] === structure.elements[1]
      && [2, 3, 4].every((k) => near(parseFloat(s.row2[k]), structure.positions[1][k - 2])) && s.fits,
    JSON.stringify([s.nRows, s.positionsHead, s.row2, s.fits]));
  H.check('unfolding is remembered in the panel prefs', s.pref === true, String(s.pref));
  H.check('a bare POSCAR (no energy/stress/forces) shows the "no EFS data" note',
    s.propsHidden === false && /No energy, force or stress data/.test(s.props)
      && !/Energy = /.test(s.props), JSON.stringify([s.propsHidden, s.props]));

  const wy = await H.waitFor(page, async () => {
    const d = document.getElementById('fileStructureSummary');
    return !d.querySelector('#fssWyckoffTable').hidden && d.querySelectorAll('#fssWyckoffBody tr').length > 0;
  }, { timeout: 20000, interval: 300 });
  s = await read();
  H.check('Wyckoff block: YBCO analyses to Pmmm (47) with one row per orbit',
    wy && /Pmmm \(47\)/.test(s.spaceGroup) && s.nWyckoff >= 6 && s.nWyckoff <= 13
      && s.wyckoffRow0 && s.wyckoffRow0.length === 5 && /^\d+[a-z]$/.test(s.wyckoffRow0[1]) && s.fits,
    JSON.stringify([s.spaceGroup, s.nWyckoff, s.wyckoffRow0]));
  H.check('the space group is a symdata link showing "Pmmm (47)", and the tolerance reads 1e-5',
    s.sgLinkText === 'Pmmm (47)' && /^https:\/\/symdata\./.test(s.sgLink || '') && /tolerance 1e-5 Å/.test(s.spaceGroup),
    JSON.stringify([s.sgLinkText, s.sgLink, s.spaceGroup]));

  // ---- 3. frac / cart ------------------------------------------------------------
  await page.evaluate(() => document.getElementById('fssCartBtn').click());
  await page.waitForTimeout(100);
  s = await read();
  const L = structure.lattice;
  const f = structure.positions[1];
  const cart = [0, 1, 2].map((k) => f[0] * L[0][k] + f[1] * L[1][k] + f[2] * L[2][k]);
  H.check('cart switches the table to Cartesian Å',
    s.cartActive && /Cartesian/.test(s.positionsHead) && [2, 3, 4].every((k) => near(parseFloat(s.row2[k]), cart[k - 2], 1e-5)),
    JSON.stringify([s.positionsHead, s.row2, cart]));
  await page.evaluate(() => document.getElementById('fssFracBtn').click());

  // ---- 4. copying ------------------------------------------------------------------
  const copies = await page.evaluate(async () => {
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
    });
    const d = document.getElementById('fileStructureSummary');
    const cellEl = d.querySelector('#fssPositionsBody tr:nth-child(2) td:nth-child(3)');
    cellEl.click();
    await new Promise((r) => setTimeout(r, 50));
    const selectable = getComputedStyle(cellEl).userSelect === 'text'
      && getComputedStyle(d.querySelector('#fssLattice')).userSelect === 'text';
    const clickCopied = copied.length; // must stay 0: a value click copies nothing
    d.querySelector('[data-copy-block="lattice"]').click();
    await new Promise((r) => setTimeout(r, 50));
    d.querySelector('[data-copy-block="positions"]').click();
    await new Promise((r) => setTimeout(r, 50));
    return { copied, selectable, clickCopied, noCopyAll: !d.querySelector('#fssCopyAllBtn') };
  });
  H.check('values are selectable text and a click on one copies nothing',
    copies.selectable && copies.clickCopied === 0, JSON.stringify([copies.selectable, copies.clickCopied]));
  H.check('the lattice block copies vectors + parameters',
    copies.copied[0]?.split('\n').length === 4 && /V = /.test(copies.copied[0]), JSON.stringify(copies.copied[0]));
  H.check('the positions block copies every atom; there is no Copy all button',
    /# Fractional positions/.test(copies.copied[1]) && copies.noCopyAll, JSON.stringify([copies.copied[1]?.slice(0, 40), copies.noCopyAll]));

  // ---- 5. ✎ opens Modify Structure ------------------------------------------------
  await page.evaluate(() => document.getElementById('fssEditBtn').click());
  await page.waitForTimeout(500);
  const edit = await page.evaluate(() => ({
    modifyOpen: !!document.querySelector('.cv-panel[data-panel-id="modifyStructure"]'),
    stillOpen: document.getElementById('fileStructureSummary').open,
  }));
  H.check('✎ opens the Modify Structure panel and leaves the section unfolded',
    edit.modifyOpen && edit.stillOpen, JSON.stringify(edit));
  await page.evaluate(async () => {
    const { removePanel } = await import('./ui/panels/PanelManager.js');
    removePanel('modifyStructure');
  });

  // ---- 6. follows a structure switch ----------------------------------------------
  await H.loadDefaultStructure(page, 'defaultPOSCAR5', 'Si_diamond');
  const si = await H.waitFor(page, async () => {
    const d = document.getElementById('fileStructureSummary');
    return /Fd-3m/.test(d.querySelector('#fssSpaceGroup').textContent);
  }, { timeout: 20000, interval: 300 });
  s = await read();
  H.check('a structure switch re-renders: Si diamond, 2 atoms, Fd-3m',
    si && s.nRows === 2 && /Fd-3m \(227\)/.test(s.spaceGroup) && s.nWyckoff === 1,
    JSON.stringify([s.nRows, s.spaceGroup, s.nWyckoff]));

  // ---- 6b. a frame carrying energy / stress / forces shows the properties ----------
  const OUTCAR = [
    ' vasp.6.4.2 20Jul23 complex',
    ' POTCAR:    PAW_PBE Na_pv 19Sep2006',
    ' POTCAR:    PAW_PBE Cl 06Sep2000',
    '   ions per type =               1   1', '',
    '  direct lattice vectors                 reciprocal lattice vectors',
    '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
    '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
    '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
    '',
    ' POSITION                                       TOTAL-FORCE (eV/Angst)',
    ' -----------------------------------------------------------------------------------',
    '      0.00000      0.00000      0.00000         0.030000      0.040000      0.000000',
    '      2.00000      0.00000      0.00000        -0.030000     -0.040000      0.000000',
    ' -----------------------------------------------------------------------------------',
    '    total drift:                                0.000000      0.000000      0.000000', '',
    '  in kB      16.00000     16.00000     16.00000      0.00      0.00      0.00', '',
    '  FREE ENERGIE OF THE ION-ELECTRON SYSTEM (eV)',
    '  ---------------------------------------------------',
    '  free  energy   TOTEN  =      -42.50000000 eV', '',
    '  energy  without entropy=      -42.50000000  energy(sigma->0) =      -42.50000000', '',
  ].join('\n');
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'OUTCAR');
  }, OUTCAR);
  await page.waitForTimeout(800);
  s = await read();
  // Pressure = stress trace / 3 (the app's convention, same as the Lattice/Trajectory
  // plots: the OUTCAR 'in kB' number is used as-is and labelled GPa) = 16; max force = 0.05.
  H.check('an OUTCAR frame shows energy, energy/atom, pressure and max force as chips',
    s.propsHidden === false && /Energy = -42\.500000 eV/.test(s.props) && /Energy\/atom = -21\.250000 eV/.test(s.props)
      && /Pressure = 16\.0000 GPa/.test(s.props) && /Max force = 0\.0500 eV\/Å/.test(s.props),
    JSON.stringify(s.props));

  // ---- 7. pure builders -------------------------------------------------------------
  const pure = await page.evaluate(async () => {
    const { latticeText, latticeParamsText, positionsTable, wyckoffRows, wyckoffText, siteLabel, scalarProperties } = await import('./ui/structureSummaryText.js');
    const lattice = [[4, 0, 0], [0, 4, 0], [0, 0, 4]];
    const structure = {
      lattice, elements: ['Na', 'Cl', 'Cl'],
      atoms: [{ position: [0, 0, 0] }, { position: [0.5, 0.5, 0.5] }, { position: [0.5, 0, 0], species: [{ element: 'Cl', occupancy: 0.5 }, { element: 'Br', occupancy: 0.5 }] }],
    };
    const dataset = { hm_symbol: 'Pm-3m', number: 221, orbits: [0, 1, 2], wyckoffs: ['a', 'b', 'c'], site_symmetry_symbols: ['m-3m', 'm-3m', '4/mm.m'] };
    const info = wyckoffRows(structure, { dataset });
    return {
      lattice: latticeText(lattice), params: latticeParamsText(lattice),
      frac: positionsTable(structure).text, cart: positionsTable(structure, true).rows[1].xyz,
      label: siteLabel(structure.atoms[2], 'Cl'), info, text: wyckoffText(info),
      scalarsEmpty: scalarProperties(structure),
      scalars: scalarProperties({ atoms: [{}, {}], energy: -10, stress: { tensor: [[3, 0, 0], [0, 3, 0], [0, 0, 3]] }, forces: [{ vector: [0.3, 0, 0.4] }] }),
    };
  });
  H.check('latticeText / latticeParamsText', pure.lattice.split('\n').length === 3 && /^\s+4\.000000\s+0\.000000\s+0\.000000$/.test(pure.lattice.split('\n')[0])
    && pure.params === 'a = 4.0000 Å  b = 4.0000 Å  c = 4.0000 Å  α = 90.000°  β = 90.000°  γ = 90.000°  V = 64.0000 Å³', JSON.stringify([pure.lattice, pure.params]));
  H.check('positionsTable: header + one row per atom, Cartesian conversion, mixed-site label',
    pure.frac.split('\n').length === 4 && /^# Fractional positions/.test(pure.frac) && pure.cart.every((v) => near(v, 2))
      && pure.label === 'Cl/Br (0.50/0.50)' && /Cl\/Br \(0\.50\/0\.50\)/.test(pure.frac),
    JSON.stringify([pure.frac, pure.cart, pure.label]));
  H.check('wyckoffRows from a moyo dataset: space group, one row per orbit, multiplicity+letter',
    pure.info.spaceGroup === 'Pm-3m' && pure.info.number === 221 && pure.info.rows.length === 3
      && pure.info.rows[1].wyckoff === '1b' && pure.info.rows[1].siteSymmetry === 'm-3m'
      && /^# Space group Pm-3m \(221\)/.test(pure.text) && pure.text.split('\n').length === 4,
    JSON.stringify([pure.info, pure.text]));

  H.check('scalarProperties: none for a bare structure; energy+per-atom+pressure+maxforce when present',
    pure.scalarsEmpty.length === 0
      && pure.scalars.map((r) => r.key).join(',') === 'energy,energyPerAtom,pressure,maxForce'
      && near(pure.scalars[1].value, -5) && near(pure.scalars[2].value, 3) && near(pure.scalars[3].value, 0.5),
    JSON.stringify(pure.scalars));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
