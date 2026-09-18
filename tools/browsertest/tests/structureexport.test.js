// Structure-file export: CIF (P1), CIF (symmetry), CASTEP .cell and FHI-aims
// geometry.in. Each exporter's output must round-trip back through the loader
// to the same atom count, element multiset and cell parameters; the symmetric
// CIF must additionally carry the right space group, its full symop loop and
// only the asymmetric unit as atom sites.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // a periodic structure is selected

  const res = await page.evaluate(async () => {
    const save = await import('./ui/SavePanel.js');
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { latticeParameters } = await import('./math/index.js');

    const stat = (s) => ({
      n: s.atoms.length,
      els: [...s.elements].sort().join(','),
      a: latticeParameters(s.lattice).a,
      b: latticeParameters(s.lattice).b,
      c: latticeParameters(s.lattice).c,
    });

    const original = stat(fileBrowser.selectedStructure);

    // Build all three while the original is selected.
    const out = {
      cif: save.cifToFile(),
      cell: save.cellToFile(),
      geom: save.aimsGeometryToFile(),
    };

    const roundtrip = async (text, name) => {
      await cv.loadStructure(text, name);
      const c = structureShip.container[fileBrowser.selectedRowIndex];
      return stat(c.structures[0]);
    };

    return {
      original,
      out,
      cif: await roundtrip(out.cif, 'roundtrip.cif'),
      cell: await roundtrip(out.cell, 'roundtrip.cell'),
      geom: await roundtrip(out.geom, 'geometry.in'),
    };
  });

  const near = (a, b, tol = 1e-3) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < tol;
  const same = (o, r) => r.n === o.n && r.els === o.els && near(r.a, o.a) && near(r.b, o.b) && near(r.c, o.c);

  H.check('CIF has P1 symmetry + atom_site loop',
    /_space_group_symop_operation_xyz/.test(res.out.cif) && /_atom_site_fract_x/.test(res.out.cif),
    res.out.cif.slice(0, 80));
  H.check('cell has LATTICE_CART + POSITIONS_FRAC',
    /%BLOCK LATTICE_CART/.test(res.out.cell) && /%BLOCK POSITIONS_FRAC/.test(res.out.cell), '');
  H.check('geometry.in has lattice_vector + atom_frac',
    /lattice_vector/.test(res.out.geom) && /atom_frac/.test(res.out.geom), '');

  H.check('CIF round-trips (atoms, elements, cell)', same(res.original, res.cif),
    JSON.stringify({ original: res.original, cif: res.cif }));
  H.check('cell round-trips (atoms, elements, cell)', same(res.original, res.cell),
    JSON.stringify({ original: res.original, cell: res.cell }));
  H.check('geometry.in round-trips (atoms, elements, cell)', same(res.original, res.geom),
    JSON.stringify({ original: res.original, geom: res.geom }));

  // --- Quantum ESPRESSO: copyable structural cards (a modal, not a download) --
  const qe = await page.evaluate(async () => {
    const save = await import('./ui/SavePanel.js');
    const block = save.qeInputBlock();
    // Drive the real menu button so the modal wiring is exercised.
    document.getElementById('qeInputButton').click();
    const modal = document.getElementById('qeInputModal');
    const ta = document.getElementById('qeInputText');
    const out = {
      hasCards: /ATOMIC_SPECIES/.test(block) && /CELL_PARAMETERS angstrom/.test(block)
        && /ATOMIC_POSITIONS crystal/.test(block),
      hasNamelistHints: /ibrav = 0/.test(block) && /nat\s+=/.test(block) && /ntyp\s+=/.test(block),
      modalVisible: !!modal && !modal.hidden,
      textareaMatchesBlock: !!ta && ta.value === block,
    };
    if (modal) modal.hidden = true; // tidy up
    return out;
  });
  H.check('QE block has the structural cards', qe.hasCards, JSON.stringify(qe));
  H.check('QE block carries &SYSTEM hints', qe.hasNamelistHints, JSON.stringify(qe));
  H.check('QE modal opens with the block text', qe.modalVisible && qe.textareaMatchesBlock, JSON.stringify(qe));

  // --- Symmetric CIF: the cell AS DISPLAYED with its own operations and one
  // site per orbit. Shared in-page helper: export the selected structure
  // symmetrically, parse the pieces the assertions need, then round-trip the
  // text through the loader.
  const symExport = async (page, tolerance) => page.evaluate(async (tolerance) => {
    const save = await import('./ui/SavePanel.js');
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { latticeParameters } = await import('./math/index.js');
    const abc = (s) => { const p = latticeParameters(s.lattice); return [p.a, p.b, p.c].sort((x, y) => x - y); };
    const orig = fileBrowser.selectedStructure;
    const text = await save.cifSymmetricToFile(tolerance);
    const lines = text.split('\n');
    const ops = lines.filter((l) => /^\s+\d+ '[^']*'$/.test(l)).length;
    const siteRows = lines.filter((l) => /^  [A-Z][a-z]?\d+\s/.test(l)).map((l) => l.trim().split(/\s+/));
    await cv.loadStructure(text, 'roundtrip_sym.cif');
    const rt = structureShip.container[fileBrowser.selectedRowIndex].structures[0];
    return {
      head: text.split('data_')[0],
      number: Number(/_symmetry_Int_Tables_number\s+(\d+)/.exec(text)?.[1]),
      hm: /_symmetry_space_group_name_H-M\s+'([^']*)'/.exec(text)?.[1],
      hasHall: /_space_group_name_Hall/.test(text),
      decimals: /written as decimals/.test(text),
      fromLock: /Wyckoff lock/.test(text),
      ops,
      // [label, symbol, multiplicity, wyckoff, x, y, z, occ]
      sites: siteRows.map((r) => ({ label: r[0], symbol: r[1], mult: Number(r[2]), wyckoff: r[3], occ: Number(r[7]) })),
      origN: orig.atoms.length, rtN: rt.atoms.length,
      origEls: [...orig.elements].sort().join(','), rtEls: [...rt.elements].sort().join(','),
      origAbc: abc(orig), rtAbc: abc(rt),
    };
  }, tolerance);
  const sameAbc = (x, y) => x.length === y.length && x.every((v, i) => near(v, y[i]));
  const roundTrips = (r) => r.rtN === r.origN && r.rtEls === r.origEls && sameAbc(r.origAbc, r.rtAbc);

  // YBCO (the default structure, Pmmm, 13 atoms in the conventional cell).
  await H.loadDefaultStructure(page);
  const ybco = await symExport(page);
  H.check('sym CIF: YBCO is Pmmm (47) with its 8 operations, no Hall symbol',
    ybco.number === 47 && ybco.hm === 'P m m m' && ybco.ops === 8 && !ybco.hasHall && !ybco.decimals,
    JSON.stringify({ number: ybco.number, hm: ybco.hm, ops: ybco.ops, hasHall: ybco.hasHall, head: ybco.head }));
  H.check('sym CIF: YBCO asymmetric unit is 8 sites whose multiplicities sum to 13',
    ybco.sites.length === 8 && ybco.sites.reduce((n, s) => n + s.mult, 0) === 13
      && ybco.sites.every((s) => /^[a-z]$/.test(s.wyckoff)),
    JSON.stringify(ybco.sites));
  H.check('sym CIF: YBCO round-trips (atoms, elements, cell)', roundTrips(ybco),
    JSON.stringify({ origN: ybco.origN, rtN: ybco.rtN, origAbc: ybco.origAbc, rtAbc: ybco.rtAbc }));
  H.check('sym CIF: header records tolerance and largest deviation',
    /tolerance 0\.01 Å/.test(ybco.head) && /largest deviation/.test(ybco.head), ybco.head);

  // With the Wyckoff editor active the export reads the lock: same 8 sites,
  // and the header says so.
  await H.loadDefaultStructure(page);
  await page.evaluate(async () => {
    const sym = await import('./ui/SymmetryEditModule.js');
    await sym.activateWyckoffMode(undefined, 0.02);
  });
  const locked = await symExport(page);
  await page.evaluate(async () => {
    const sym = await import('./ui/SymmetryEditModule.js');
    const { structureShip } = await import('./state/store.js');
    // The YBCO entry is two rows back (the round-trip CIF was loaded since).
    const ybcoContainer = structureShip.container[structureShip.container.length - 2];
    sym.deactivateWyckoffMode(ybcoContainer.structures[0]);
  });
  H.check('sym CIF: Wyckoff lock is reused (tolerance 0.02 from the lock, 8 sites, round-trips)',
    locked.fromLock && /tolerance 0\.02 Å/.test(locked.head) && locked.number === 47 && locked.sites.length === 8 && roundTrips(locked),
    JSON.stringify({ head: locked.head, sites: locked.sites.length, rtN: locked.rtN }));

  // Primitive fcc Cu: the 1-atom rhombohedral cell stays as it is — 48 point
  // operations, no centring, Fm-3m as the group TYPE, one site of multiplicity 1.
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(['Cu primitive', '1.0', '0 1.8 1.8', '1.8 0 1.8', '1.8 1.8 0', 'Cu', '1', 'Direct', '0 0 0', ''].join('\n'), 'cu_prim.vasp');
  });
  const cu = await symExport(page);
  H.check('sym CIF: primitive fcc Cu keeps its cell — Fm-3m (225) type, 48 operations, one 1-fold site a',
    cu.number === 225 && cu.hm === 'F m -3 m' && cu.ops === 48 && cu.sites.length === 1 && cu.sites[0].mult === 1
      && cu.sites[0].wyckoff === 'a' && !cu.decimals,
    JSON.stringify({ number: cu.number, hm: cu.hm, ops: cu.ops, sites: cu.sites }));
  H.check('sym CIF: primitive Cu round-trips to 1 atom in the 2.546 Å rhombohedral cell',
    roundTrips(cu) && cu.rtN === 1 && near(cu.rtAbc[0], 1.8 * Math.SQRT2),
    JSON.stringify({ rtN: cu.rtN, rtAbc: cu.rtAbc }));

  // Same cell with the atom off the origin: inversion-type operations pick up
  // translations of twice the shift, which are no fractions — written as
  // decimals, flagged in the header, and still read back correctly.
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(['Cu shifted', '1.0', '0 1.8 1.8', '1.8 0 1.8', '1.8 1.8 0', 'Cu', '1', 'Direct', '0.1234 0.1234 0.1234', ''].join('\n'), 'cu_shift.vasp');
  });
  const shifted = await symExport(page);
  H.check('sym CIF: off-origin cell writes decimal translations, flags it, and round-trips',
    shifted.number === 225 && shifted.ops === 48 && shifted.decimals && roundTrips(shifted),
    JSON.stringify({ number: shifted.number, ops: shifted.ops, decimals: shifted.decimals, rtN: shifted.rtN, head: shifted.head }));

  // Disorder: rocksalt with a 50/50 Na/K site, given as a P1 CIF of the
  // conventional cell. Sites are labelled by composition, so the mixed site
  // stays one orbit (4a) with both species written at 0.5, and Cl is 4b.
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const rows = [];
    const cat = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
    cat.forEach(([x, y, z], i) => { rows.push(`Na${i + 1} Na ${x} ${y} ${z} 0.5`); rows.push(`K${i + 1} K ${x} ${y} ${z} 0.5`); });
    cat.forEach(([x, y, z], i) => rows.push(`Cl${i + 1} Cl ${x + 0.5 > 1 ? x - 0.5 : x + 0.5} ${y} ${z} 1`));
    const text = ['data_mix', "_symmetry_space_group_name_H-M 'P 1'", '_cell_length_a 5.6', '_cell_length_b 5.6', '_cell_length_c 5.6',
      '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90', 'loop_', '_atom_site_label', '_atom_site_type_symbol',
      '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z', '_atom_site_occupancy', ...rows, ''].join('\n');
    await cv.loadStructure(text, 'mixed_rocksalt.cif');
  });
  const mix = await symExport(page);
  const mixNaK = mix.sites.filter((s) => s.symbol === 'Na' || s.symbol === 'K');
  const mixCl = mix.sites.filter((s) => s.symbol === 'Cl');
  H.check('sym CIF: mixed rocksalt is Fm-3m (192 ops) with Na/K rows on one 4-fold site at 0.5 and Cl on the other',
    mix.number === 225 && mix.ops === 192 && mixNaK.length === 2 && mixNaK.every((s) => s.mult === 4 && s.occ === 0.5)
      && mixCl.length === 1 && mixCl[0].mult === 4 && mixCl[0].occ === 1 && mixNaK[0].wyckoff !== mixCl[0].wyckoff,
    JSON.stringify({ number: mix.number, ops: mix.ops, sites: mix.sites, origN: mix.origN }));

  // --- The export dialog: tolerance box, live preview, ladder, actions -------
  await H.loadDefaultStructure(page);
  await H.clickById(page, 'saveCifSymButton');
  const dialog = await H.waitFor(page, () => {
    const modal = document.getElementById('cifExportModal');
    const spg = document.getElementById('cifExportSpg')?.textContent || '';
    const ladder = document.querySelectorAll('#cifExportLadder button');
    if (!modal || modal.hidden || !/P m m m/.test(spg) || ladder.length < 4) return null;
    return {
      tol: document.getElementById('cifExportTol').value,
      spg,
      sites: document.getElementById('cifExportSites').textContent,
      dev: document.getElementById('cifExportDev').textContent,
      trans: document.getElementById('cifExportTrans').textContent,
      ladder: [...ladder].map((b) => b.textContent),
      exportEnabled: !document.getElementById('cifExportGo').disabled,
    };
  }, { timeout: 20000, interval: 300 });
  H.check('CIF dialog opens with the panel tolerance and a live preview of Pmmm',
    !!dialog && dialog.tol === '0.01' && /P m m m \(47\)/.test(dialog.spg) && dialog.sites === '8 / 13'
      && /Å$/.test(dialog.dev) && dialog.trans === 'exact fractions' && dialog.exportEnabled,
    JSON.stringify(dialog));
  H.check('CIF dialog shows the tolerance ladder with a result per rung',
    !!dialog && dialog.ladder.length === 4 && dialog.ladder.every((t) => /Å/.test(t) && /\(\d+\)/.test(t)),
    JSON.stringify(dialog && dialog.ladder));
  // Picking a rung changes the tolerance box and the store's shared value.
  const rung = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    document.querySelectorAll('#cifExportLadder button')[1].click();
    await new Promise((r) => setTimeout(r, 1500));
    const out = { tol: document.getElementById('cifExportTol').value, store: general.symmetryTolerance };
    document.getElementById('cifExportCancel').click();
    out.hidden = document.getElementById('cifExportModal').hidden;
    // Leave the app's tolerance at its default for later tests.
    general.symmetryTolerance = 0.01;
    return out;
  });
  H.check('CIF dialog ladder click sets the tolerance (box + store) and Cancel closes it',
    rung.tol === '0.001' && rung.store === 0.001 && rung.hidden, JSON.stringify(rung));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
