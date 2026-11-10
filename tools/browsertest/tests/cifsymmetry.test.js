// Loading a CIF that declares a space group now offers to keep that symmetry
// (CifSymmetryLoad.js + CifSymmetryModal.js): the load-time modal compares the
// declared group against the one Moyo detects and, on a match, lets the user
// lock the cell into the Wyckoff editor in the CIF's own setting — or load it
// plain. This drives both outcomes.
'use strict';
const H = require('../harness');

// P4 (No. 75): two general-position atoms (of different elements, at generic z)
// in a tetragonal cell, each expanded by the four 4-fold operations the CIF
// lists. Two distinct species at unrelated heights break any accidental mirror,
// so Moyo detects exactly P4 from the geometry — matching the declared group.
// Symops are written unspaced (a spaced "x, y, z" would be split into three
// loop values by the whitespace-delimited CIF loop reader).
const P4_CIF = [
  'data_test',
  "_symmetry_space_group_name_H-M   'P 4'",
  "_space_group_name_Hall   'P 4'",
  '_space_group_IT_number   75',
  '_cell_length_a   4.0',
  '_cell_length_b   4.0',
  '_cell_length_c   5.0',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   90',
  'loop_',
  '_space_group_symop_operation_xyz',
  '  x,y,z',
  '  -y,x,z',
  '  -x,-y,z',
  '  y,-x,z',
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'Fe1 Fe 0.30 0.11 0.20',
  'O1  O  0.17 0.43 0.61',
  '',
].join('\n');

// Declares Fm-3m by name but lists no symmetry operations, so the file expands
// to only its two asymmetric-unit atoms — a Pm-3m (No. 221) geometry. The
// declared name and the detected group therefore disagree.
const MISMATCH_CIF = [
  'data_nacl',
  "_symmetry_space_group_name_H-M   'F m -3 m'",
  '_cell_length_a   4.0',
  '_cell_length_b   4.0',
  '_cell_length_c   4.0',
  '_cell_angle_alpha   90',
  '_cell_angle_beta    90',
  '_cell_angle_gamma   90',
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'Na1 Na 0.0 0.0 0.0',
  'Cl1 Cl 0.5 0.5 0.5',
  '',
].join('\n');

// Start a CIF load WITHOUT awaiting it (the loader blocks on the modal), then
// wait for the modal to appear.
async function beginLoad(page) {
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    // Held on window so the test can await completion after choosing.
    window.__cifLoad = cv.loadStructure(text, 'p4.cif');
  }, P4_CIF);
  await H.waitFor(page, () => {
    const m = document.getElementById('cifSymmetryModal');
    return !!m && !m.hidden;
  }, { timeout: 30000, interval: 250 });
}

// Click the modal choice whose label contains `needle`, then await the load.
async function chooseAndFinish(page, needle) {
  await page.evaluate((text) => {
    const buttons = [...document.querySelectorAll('#cifSymmetryModal .confirm-choice')];
    const btn = buttons.find((b) => (b.textContent || '').includes(text));
    if (!btn) throw new Error(`no modal choice matching "${text}"`);
    btn.click();
  }, needle);
  await page.evaluate(async () => { await window.__cifLoad; });
}

// The Files window's Parameters section (ui/FileStructureSummary.js), unfolded,
// read once its Wyckoff block shows `needle`.
async function readParameters(page, needle) {
  await page.evaluate(() => {
    const d = document.getElementById('fileStructureSummary');
    if (d && !d.open) d.open = true;
  });
  const ok = await page.waitForFunction((text) => {
    const line = document.querySelector('#fssSpaceGroup');
    return !!line && new RegExp(text).test(line.textContent || '');
  }, needle, { timeout: 20000, polling: 250 }).then(() => true, () => false);
  const info = await page.evaluate(() => ({
    line: document.querySelector('#fssSpaceGroup')?.textContent ?? '',
    link: document.querySelector('#fssSpaceGroup a.sym-link')?.getAttribute('href') ?? null,
    rows: [...document.querySelectorAll('#fssWyckoffBody tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)),
  }));
  return { ok, ...info };
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // --- Match case: keep the CIF's symmetry -----------------------------------
  await beginLoad(page);

  const modalInfo = await page.evaluate(() => {
    const modal = document.getElementById('cifSymmetryModal');
    const detail = document.getElementById('cifSymmetryModalDetail');
    const title = document.getElementById('cifSymmetryModalTitle');
    const labels = [...document.querySelectorAll('#cifSymmetryModal .confirm-choice-label')]
      .map((el) => el.textContent);
    const tolRow = document.getElementById('cifSymmetryModalTolRow');
    return {
      detail: detail ? detail.textContent : '',
      title: title ? title.textContent : '',
      labels,
      // Computed styles, not attributes: the overlay is styled by id and the
      // tolerance row's display:flex must not defeat its [hidden].
      position: getComputedStyle(modal).position,
      tolDisplay: tolRow ? getComputedStyle(tolRow).display : '',
    };
  });
  H.check('match: modal titled for a matching group', /Keep symmetry from the CIF/i.test(modalInfo.title),
    modalInfo.title);
  H.check('match: detail reports the declared group', /No\. 75/.test(modalInfo.detail), modalInfo.detail);
  H.check('match: a keep option is offered',
    modalInfo.labels.some((l) => /Keep symmetry/i.test(l)), modalInfo.labels.join(' | '));
  H.check('match: modal renders as a fixed overlay', modalInfo.position === 'fixed', modalInfo.position);
  H.check('match: tolerance row is really hidden', modalInfo.tolDisplay === 'none', modalInfo.tolDisplay);
  await page.screenshot({ path: `${require('path').join(__dirname, '..', 'artifacts', 'cifsymmetry-match.png')}` });

  await chooseAndFinish(page, 'Keep symmetry');

  const kept = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return {
      mode: s?.symmetry?.mode ?? null,
      number: s?.symmetry?.number ?? null,
      orbitCount: s?.symmetry?.orbitGroups?.length ?? null,
      multiplicity: s?.symmetry?.orbitGroups?.[0]?.multiplicity ?? null,
      opCount: s?.symmetry?.operations?.length ?? null,
      atomCount: s?.atoms?.length ?? null,
      // The Wyckoff lock tints the UI (body.theme-symmetry, see
      // ui/BackendPanel/BackendTheme.js), exactly as the Symmetry panel's own
      // Wyckoff button does.
      tint: document.body.classList.contains('theme-symmetry') ? 'symmetry' : 'standard',
    };
  });
  H.check('keep: Wyckoff mode is active', kept.mode === 'wyckoff', JSON.stringify(kept));
  H.check('keep: UI switches to the symmetry tint', kept.tint === 'symmetry', kept.tint);
  H.check('keep: space group number is 75', kept.number === 75, String(kept.number));
  H.check('keep: two orbits of multiplicity 4', kept.orbitCount === 2 && kept.multiplicity === 4,
    JSON.stringify(kept));
  H.check('keep: four CIF operations kept', kept.opCount === 4, String(kept.opCount));
  H.check('keep: eight atoms expanded', kept.atomCount === 8, String(kept.atomCount));
  await page.screenshot({ path: `${require('path').join(__dirname, '..', 'artifacts', 'cifsymmetry-kept.png')}` });

  // Parameters section: the kept lock carries Moyo's letters (P4 general
  // position 4d) and links the CIF's own Hall symbol.
  const keptParams = await readParameters(page, 'from the active Wyckoff lock');
  H.check('keep: Parameters shows the lock with real Wyckoff letters',
    keptParams.ok && /P4 \(75\)/.test(keptParams.line) && /from the active Wyckoff lock/.test(keptParams.line)
      && keptParams.rows.length === 2 && keptParams.rows.every((r) => r[1] === '4d'),
    JSON.stringify(keptParams));
  H.check('keep: space group links the CIF Hall symbol',
    /symdata\..*\/hall\/p_4\//.test(keptParams.link || ''), String(keptParams.link));

  // Closure guard: the CIF's operations are only usable as a lock while every
  // image of every atom lands on an atom. Nudge one atom off its site on a
  // copy and the builder must refuse (null) instead of silently mapping the
  // stray atom to the identity.
  const guard = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    const s = fileBrowser.selectedStructure;
    const copy = {
      elements: [...s.elements],
      atoms: s.atoms.map((a) => ({ position: [...a.position] })),
    };
    const intact = sym.cifSymmetryIsUsable(copy, s.cifSymmetry);
    copy.atoms[3].position[0] += 0.05;
    const broken = sym.cifSymmetryIsUsable(copy, s.cifSymmetry);
    const built = sym.buildCifWyckoffSymmetryState(copy, s.cifSymmetry, 0.01);
    return { intact, broken, built: built === null };
  });
  H.check('guard: intact cell is usable', guard.intact === true, JSON.stringify(guard));
  H.check('guard: nudged atom makes the CIF ops unusable', guard.broken === false && guard.built === true,
    JSON.stringify(guard));

  // --- Normal case: same CIF, load plain -------------------------------------
  await beginLoad(page);
  await chooseAndFinish(page, 'normal structure');

  const plain = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return {
      symmetry: s?.symmetry ?? null,
      atomCount: s?.atoms?.length ?? null,
      tint: document.body.classList.contains('theme-symmetry') ? 'symmetry' : 'standard',
    };
  });
  H.check('normal: no symmetry lock', plain.symmetry === null, JSON.stringify(plain));
  H.check('normal: UI keeps the standard tint', plain.tint === 'standard', plain.tint);

  // Parameters section without a lock: the CIF's declared group and orbits,
  // not a fresh tight-tolerance analysis; letters filled in by Moyo.
  const plainParams = await readParameters(page, 'declared by the CIF');
  await H.waitFor(page, () => [...document.querySelectorAll('#fssWyckoffBody tr')]
    .every((tr) => /^\d+[a-z]$/.test(tr.children[1]?.textContent || '')), { timeout: 20000, interval: 250 });
  const lettered = await readParameters(page, 'declared by the CIF');
  H.check('normal: Parameters reports the CIF-declared group',
    plainParams.ok && /P4 \(75\)/.test(plainParams.line) && /2 orbits \(declared by the CIF\)/.test(plainParams.line),
    plainParams.line);
  H.check('normal: Moyo letters fill in and no disagreement is reported',
    lettered.rows.length === 2 && lettered.rows.every((r) => r[1] === '4d') && !/geometry at/.test(lettered.line),
    JSON.stringify(lettered));
  H.check('normal: eight atoms still expanded', plain.atomCount === 8, String(plain.atomCount));

  // --- Mismatch case: declared group differs, symmetrise to the detected one --
  // Declares Fm-3m by name but lists no operations, so only the two ASU atoms
  // load — a Pm-3m geometry. Declared and detected disagree, so the modal offers
  // to symmetrise; doing so locks the cell to the detected group.
  await page.evaluate(async (text) => {
    const cv = await import('./core/crystal-viewer.js');
    window.__cifLoad = cv.loadStructure(text, 'mismatch.cif');
  }, MISMATCH_CIF);
  await H.waitFor(page, () => {
    const m = document.getElementById('cifSymmetryModal');
    return !!m && !m.hidden;
  }, { timeout: 30000, interval: 250 });

  const mism = await page.evaluate(() => ({
    title: document.getElementById('cifSymmetryModalTitle')?.textContent ?? '',
    detail: document.getElementById('cifSymmetryModalDetail')?.textContent ?? '',
    tolDisplay: getComputedStyle(document.getElementById('cifSymmetryModalTolRow')).display,
    labels: [...document.querySelectorAll('#cifSymmetryModal .confirm-choice-label')].map((el) => el.textContent),
  }));
  H.check('mismatch: modal reports the disagreement', /does not match/i.test(mism.title), mism.title);
  H.check('mismatch: detected group differs from declared', /Detected\s*:\s*Pm-3m/i.test(mism.detail),
    mism.detail);
  H.check('mismatch: a tolerance input is visible', mism.tolDisplay === 'flex', mism.tolDisplay);
  // Name-only file: no operations to keep, so no "keep as declared" choice.
  H.check('mismatch: no keep option without operations',
    !mism.labels.some((l) => /Keep CIF symmetry/i.test(l)), mism.labels.join(' | '));
  await page.screenshot({ path: `${require('path').join(__dirname, '..', 'artifacts', 'cifsymmetry-mismatch.png')}` });

  await chooseAndFinish(page, 'Symmetrise');

  const sym = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return {
      mode: s?.symmetry?.mode ?? null,
      number: s?.symmetry?.number ?? null,
      atomCount: s?.atoms?.length ?? null,
      tint: document.body.classList.contains('theme-symmetry') ? 'symmetry' : 'standard',
    };
  });
  H.check('symmetrise: Wyckoff mode is active', sym.mode === 'wyckoff', JSON.stringify(sym));
  H.check('symmetrise: UI switches to the symmetry tint', sym.tint === 'symmetry', sym.tint);
  H.check('symmetrise: locked to detected Pm-3m (221)', sym.number === 221, String(sym.number));

  H.check('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' ; '));

  await H.finish(browser);
})().catch(H.crash);
