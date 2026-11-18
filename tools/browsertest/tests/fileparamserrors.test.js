// Files ▸ Parameters with a CIF's errors: a structure read from a CIF with
// its standard uncertainties shows them in the Parameters section as the
// measurements do — the cell parameters and volume as a = 4.9160(1) Å, the
// fractional positions and Wyckoff coordinates as 0.4135(3) — while "Show
// CIF Errors" is on, and copies them. See model/cifErrors.js
// (cellParameterSus, fracCoordinateSus).
//
//   - written as everywhere else (model/cifErrors.js formatWithSu, the
//     "rule of 19"): an s.u. of 0.0001 has two digits, 4.91600(10)
//   - a structure without errors (YBCO): plain values, no note
//   - α-quartz with its errors read: the lattice vectors' components through
//     the cell's orientation (a along x: a_x = 4.91600(10), a_y = a_z = 0
//     exact; b = (b cos γ, b sin γ, 0): −2.45800(5), 4.25738(9)); a rotated
//     cell rotates the errors with it
//   - a, b, c, V with s.u. (a = b tied, so
//     σ(V) = √3·a·c·σ(a) ⊕ (√3/2)·a²·σ(c)), α/β/γ exact; the O site's
//     coordinates with theirs, a symmetry copy's through the operation
//     (y' = x − y: σ = √2 · 0.0003 → (4)); the Wyckoff rows too; a note
//   - Cartesian positions carry none; the copy buttons carry them
//   - Show CIF Errors off: plain values, note gone; on: back
//   - a 2×1×1 supercell keeps them: a = 9.8320(2) Å, x halves with its s.u.
'use strict';
const H = require('../harness');

const QUARTZ_CIF = [
  'data_quartz',
  "_symmetry_space_group_name_H-M   'P 32 2 1'",
  '_space_group_IT_number   154',
  '_cell_length_a   4.9160(1)',
  '_cell_length_b   4.9160(1)',
  '_cell_length_c   5.4054(1)',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   120',
  'loop_',
  '_space_group_symop_operation_xyz',
  '  x,y,z', '  -y,x-y,z+2/3', '  -x+y,-x,z+1/3', '  y,x,-z', '  x-y,-y,-z+1/3', '  -x,-x+y,-z+2/3',
  'loop_',
  '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Si1 Si 0.4697(1) 0 0.66667',
  'O1 O 0.4135(3) 0.2669(3) 0.7858(2)',
  '',
].join('\n');

// V = a²·c·sin 120° and its s.u., worked out by hand above: 113.131(5) Å³.
const A = 4.916, C = 5.4054;
const V = A * A * C * Math.sqrt(3) / 2;
const V_TEXT = `V = ${V.toFixed(3)}(5) Å³`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page); // YBCO: no errors

  const read = () => page.evaluate(() => {
    const d = document.getElementById('fileStructureSummary');
    const cells = (sel) => [...d.querySelectorAll(`${sel} tr`)].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    return {
      chips: [...d.querySelectorAll('#fssParams .fss-chip')].map((c) => c.textContent),
      lattice: d.querySelector('#fssLattice').textContent.split('\n').map((line) => line.trim().split(/\s+/)),
      note: !d.querySelector('#fssSuNote').hidden,
      rows: cells('#fssPositionsBody'),
      wyckoff: cells('#fssWyckoffBody'),
      head: d.querySelector('#fssPositionsHead').textContent,
    };
  });

  await page.evaluate(() => document.querySelector('#fileStructureSummary .fss-summary').click());
  await page.waitForTimeout(300);
  let s = await read();
  H.check('without CIF errors: plain values, no note',
    s.chips[0] === 'a = 3.8200 Å' && !s.chips.join('').includes('(') && !s.rows.flat().join('').includes('(') && !s.note,
    JSON.stringify([s.chips, s.note]));

  // ---- quartz, errors read (the symmetry dialog's tick box), symmetry kept ----------
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    window.__cifLoad = cv.loadStructure(text, 'quartz.cif');
  }, QUARTZ_CIF);
  await page.waitForFunction(() => { const m = document.getElementById('cifSymmetryModal'); return !!m && !m.hidden; },
    null, { timeout: 30000, polling: 250 });
  await page.evaluate(() => {
    const box = /** @type {HTMLInputElement} */ (document.getElementById('cifSymmetryModalErrors'));
    if (!box.checked) box.click();
    [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')].find((b) => /Keep symmetry/.test(b.textContent || '')).click();
  });
  await page.evaluate(async () => { await window.__cifLoad; });
  await H.waitFor(page, async () => document.querySelectorAll('#fileStructureSummary #fssWyckoffBody tr').length > 0,
    { timeout: 20000, interval: 300 });
  s = await read();
  const read1 = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const st = fileBrowser.selectedStructure;
    return { read: !!st.cifErrors && !st.cifErrors.pending, atoms: st.atoms.length };
  });
  H.check('quartz loads with its errors read (9 atoms)', read1.read && read1.atoms === 9, JSON.stringify(read1));
  H.check('the lattice vectors\' components with their s.u., through the cell\'s orientation; exact zeros without',
    JSON.stringify(s.lattice) === JSON.stringify([
      ['4.91600(10)', '0.000000', '0.000000'],
      ['-2.45800(5)', '4.25738(9)', '0.000000'],
      ['0.000000', '0.000000', '5.40540(10)'],
    ]), JSON.stringify(s.lattice));
  // The same cell turned 90° about z: a = (0, a, 0) now carries σ(a) in y.
  const turned = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { latticeVectorSus } = await import('./model/cifErrors.js');
    const st = fileBrowser.selectedStructure;
    const lattice = st.lattice.map(([x, y, z]) => [-y, x, z]);
    return latticeVectorSus({ lattice, cifErrors: st.cifErrors });
  });
  const near = (m, want) => m && m.every((row, i) => row.every((v, k) => Math.abs(v - want[i][k]) < 1e-9));
  H.check('a rotated cell rotates the errors with it (a along y: σ(a_y) = σ(a))',
    near(turned, [[0, 1e-4, 0], [Math.sqrt(3) / 2 * 1e-4, 0.5e-4, 0], [0, 0, 1e-4]]), JSON.stringify(turned));
  H.check('cell parameters with their s.u.; the angles, given exactly, without',
    s.chips.slice(0, 6).join(' | ') === 'a = 4.91600(10) Å | b = 4.91600(10) Å | c = 5.40540(10) Å | α = 90.000° | β = 90.000° | γ = 120.000°',
    JSON.stringify(s.chips));
  H.check('the volume with its s.u., a = b counted once (tied by symmetry)', s.chips[6] === V_TEXT,
    `${s.chips[6]} expected ${V_TEXT}`);
  const o = s.rows.find((r) => r[1] === 'O' && r[2].startsWith('0.4135'));
  const copy = s.rows.find((r) => r[1] === 'O' && r[3].startsWith('0.1466'));
  const si = s.rows.find((r) => r[1] === 'Si' && r[2].startsWith('0.4697'));
  H.check('the O site\'s coordinates with their s.u.', o && o.slice(2).join(' ') === '0.4135(3) 0.2669(3) 0.7858(2)',
    JSON.stringify(o));
  H.check('a symmetry copy\'s through its operation: y\' = x − y gets √2·0.0003 → (4)',
    copy && copy[2] === '0.7331(3)' && copy[3] === '0.1466(4)' && copy[4] === '0.4525(2)', JSON.stringify(copy));
  H.check('Si on the 2-fold axis: x with its s.u., the exact 0 and 0.66667 without',
    si && si[2] === '0.46970(10)' && si[3] === '0.000000' && si[4] === '0.666670', JSON.stringify(si));
  // The rows show each orbit's representative (here a symmetry copy).
  H.check('the Wyckoff rows carry them too, and a note says where they come from',
    s.wyckoff.some((r) => r[0] === 'O' && r.slice(2).every((v) => /^\d\.\d+\(\d+\)$/.test(v)))
      && s.wyckoff.some((r) => r[0] === 'Si' && /\(10\)$/.test(r[2])) && s.note,
    JSON.stringify([s.wyckoff, s.note]));
  await page.evaluate(() => document.getElementById('fssCartBtn').click());
  await page.waitForTimeout(100);
  s = await read();
  H.check('Cartesian positions carry no errors', /Cartesian/.test(s.head) && !s.rows.flat().join('').includes('('),
    JSON.stringify(s.rows[0]));
  await page.evaluate(() => document.getElementById('fssFracBtn').click());

  const copies = await page.evaluate(async () => {
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
    });
    const d = document.getElementById('fileStructureSummary');
    for (const block of ['lattice', 'positions', 'wyckoff']) {
      d.querySelector(`[data-copy-block="${block}"]`).click();
      await new Promise((r) => setTimeout(r, 50));
    }
    return copied;
  });
  H.check('the copies carry the errors (lattice, positions, Wyckoff)',
    /a = 4\.91600\(10\) Å/.test(copies[0]) && copies[0].includes(V_TEXT) && /^\s+4\.91600\(10\)\s+0\.000000\s+0\.000000$/m.test(copies[0])
      && /0\.4135\(3\)\s+0\.2669\(3\)\s+0\.7858\(2\)/.test(copies[1]) && /O\s+6c\s+\S+\s+\d\.\d+\(\d\)/.test(copies[2] ?? ''),
    JSON.stringify(copies));

  // ---- Show CIF Errors ---------------------------------------------------------------
  await page.evaluate(async () => (await import('./ui/CifErrorsDisplay.js')).setCifErrorsShown(false));
  await page.waitForTimeout(100);
  s = await read();
  H.check('Show CIF Errors off: plain values, no note',
    s.chips[0] === 'a = 4.9160 Å' && !s.chips.join('').includes('(') && !s.rows.flat().join('').includes('(')
      && !s.lattice.flat().join('').includes('(')
      && !s.wyckoff.flat().join('').includes('(') && !s.note,
    JSON.stringify([s.chips, s.rows[0], s.note]));
  await page.evaluate(async () => (await import('./ui/CifErrorsDisplay.js')).setCifErrorsShown(true));
  await page.waitForTimeout(100);
  s = await read();
  H.check('on again: back', s.chips[0] === 'a = 4.91600(10) Å' && s.note, JSON.stringify(s.chips));

  // ---- a supercell keeps them --------------------------------------------------------
  // Out of the Wyckoff lock first (a supercell of a locked structure is not
  // what this is about), then 2×1×1.
  await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { fileBrowser } = await import('./state/store.js');
    fileBrowser.selectedStructure.symmetry = null;
    createSupercell(2, 1, 1);
  });
  await page.waitForTimeout(800);
  s = await read();
  const half = s.rows.find((r) => r[1] === 'O' && r[2].startsWith('0.20675'));
  H.check('a 2×1×1 supercell keeps them: a = 9.8320(2) Å, b and c as before, V doubled',
    s.chips[0] === 'a = 9.8320(2) Å' && s.chips[1] === 'b = 4.91600(10) Å' && s.chips[2] === 'c = 5.40540(10) Å'
      && s.chips[6] === `V = ${(2 * V).toFixed(3)}(10) Å³`,
    JSON.stringify(s.chips));
  H.check('… and the first lattice vector doubles with its s.u.: 9.8320(2)',
    s.lattice[0].join(' ') === '9.8320(2) 0.000000 0.000000' && s.lattice[1].join(' ') === '-2.45800(5) 4.25738(9) 0.000000',
    JSON.stringify(s.lattice));
  H.check('… and x halves with its s.u.: 0.4135(3) → 0.20675(15)',
    half && half[2] === '0.20675(15)' && half[3] === '0.2669(3)' && s.rows.length === 18, JSON.stringify([half, s.rows.length]));

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
