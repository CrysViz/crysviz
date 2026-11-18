// Energy, pressure and their source in .crysviz sessions and the Files
// window's Parameters section (ui/ShareModule.js frames, model/dataSource.js,
// ui/FileStructureSummary.js):
//   - an OUTCAR shows "Source: VASP" above its energy and pressure
//   - a .crysviz session keeps every frame's energy and stress (so the
//     pressure) and the file's source; reloaded, the Parameters section
//     shows them again, frame by frame, and the trajectory's energy series
//     is back
//   - a frame computed in the app (a relax step with PET-MAD) keeps its own
//     source beside the file's
//   - a single-frame session too
//   - an older session without them loads unchanged, with no source
//   - a share link carries none of it
//   - the potentials' short names for "Source:" (no ASE server address)
'use strict';
const H = require('../harness');

/** A VASP OUTCAR of NaCl with one ionic step per entry of `steps`. */
function outcar(steps) {
  const head = [
    ' vasp.6.4.2 20Jul23 complex',
    ' POTCAR:    PAW_PBE Na_pv 19Sep2006',
    ' POTCAR:    PAW_PBE Cl 06Sep2000',
    '   ions per type =               1   1', '',
  ];
  const step = ({ x, kB, toten }) => [
    '  direct lattice vectors                 reciprocal lattice vectors',
    '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
    '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
    '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
    '',
    ' POSITION                                       TOTAL-FORCE (eV/Angst)',
    ' -----------------------------------------------------------------------------------',
    '      0.00000      0.00000      0.00000         0.030000      0.040000      0.000000',
    `      ${x.toFixed(5)}      0.00000      0.00000        -0.030000     -0.040000      0.000000`,
    ' -----------------------------------------------------------------------------------',
    '    total drift:                                0.000000      0.000000      0.000000', '',
    // VASP order XX YY ZZ XY YZ ZX, compression positive, kB (= 0.1 GPa).
    `  in kB      ${kB.map((v) => v.toFixed(5)).join('     ')}      0.00      0.00      0.00`, '',
    '  FREE ENERGIE OF THE ION-ELECTRON SYSTEM (eV)',
    '  ---------------------------------------------------',
    `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`, '',
    `  energy  without entropy=      ${toten.toFixed(8)}  energy(sigma->0) =      ${toten.toFixed(8)}`, '',
  ];
  return [...head, ...steps.flatMap(step)].join('\n');
}

const TWO_STEPS = outcar([
  { x: 2.0, kB: [10, 20, 30], toten: -42.5 }, // pressure 2 GPa
  { x: 2.1, kB: [40, 40, 40], toten: -43.25 }, // pressure 4 GPa
]);
const ONE_STEP = outcar([{ x: 2.0, kB: [10, 20, 30], toten: -42.5 }]);

const read = (page) => page.evaluate(async () => {
  const d = document.getElementById('fileStructureSummary');
  const { fileBrowser } = await import('./state/store.js');
  return {
    props: d.querySelector('#fssProperties').textContent,
    source: d.querySelector('#fssSource')?.textContent ?? null,
    energy: fileBrowser.selectedStructure?.energy ?? null,
  };
});

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  page.on('dialog', (d) => d.accept());
  // The Parameters section open, as a user reading it has it.
  await page.evaluate(() => { const d = document.getElementById('fileStructureSummary'); if (!d.open) d.querySelector('.fss-summary').click(); });

  const load = (text, name) => page.evaluate(async ({ text, name }) => {
    window.confirm = () => true;
    await (await import('./core/crystal-viewer.js')).loadStructure(text, name);
  }, { text, name });
  const showFrame = (i) => page.evaluate(async (i) => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    (await import('./ui/TrajectoryPanel.js')).showTrajectoryFrame(i, structureShip.container[fileBrowser.selectedRowIndex]);
  }, i);
  const capture = () => page.evaluate(async () => JSON.parse(JSON.stringify(
    (await import('./ui/ShareModule.js')).captureState({ includeFrames: true, includeFields: true }))));
  const apply = (state, name) => page.evaluate(async ({ state, name }) => {
    window.confirm = () => true;
    return (await import('./ui/ShareModule.js')).applySharedState(state, name);
  }, { state, name });
  const series = () => page.evaluate(async () => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    return Array.from(structureShip.container[fileBrowser.selectedRowIndex].energySeries?.() ?? []);
  });

  // ---- an OUTCAR names VASP ----
  await load(TWO_STEPS, 'OUTCAR');
  await page.waitForTimeout(1200);
  await showFrame(0);
  await page.waitForTimeout(300);
  let s = await read(page);
  H.check('an OUTCAR shows "Source: VASP" above its energy and pressure',
    s.source === 'Source: VASP' && /^Source: VASP/.test(s.props) && /Energy = -42\.500000 eV/.test(s.props)
      && /Pressure = 2\.0000 GPa/.test(s.props), JSON.stringify(s));

  // ---- the session keeps them ----
  const session = await capture();
  const f = session.frames ?? [];
  const GPA = 160.21766208;
  H.check('the session keeps every frame\'s energy and stress (eV/Å³) and the file\'s source',
    session.dataSource === 'VASP' && f.length === 2 && f[0].energy === -42.5 && f[1].energy === -43.25
      && Math.abs(f[0].stress[2][2] * GPA - 3) < 1e-9 && Math.abs(f[1].stress[0][0] * GPA - 4) < 1e-9
      && !('dataSource' in f[0]) && !('dataSource' in f[1]),
    JSON.stringify({ dataSource: session.dataSource, frames: f.map((x) => ({ e: x.energy, s: x.stress, d: x.dataSource })) }));

  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);
  s = await read(page);
  H.check('(the start-up structure has no source)', s.source === null, JSON.stringify(s));

  H.check('the session loads', await apply(session, 'nacl.crysviz') === true);
  await page.waitForTimeout(1500);
  await showFrame(0);
  await page.waitForTimeout(300);
  s = await read(page);
  H.check('reloaded: Source: VASP, the first frame\'s energy and pressure',
    s.source === 'Source: VASP' && /Energy = -42\.500000 eV/.test(s.props) && /Pressure = 2\.0000 GPa/.test(s.props), JSON.stringify(s));
  await showFrame(1);
  await page.waitForTimeout(300);
  s = await read(page);
  H.check('… and the second frame\'s', s.source === 'Source: VASP' && /Energy = -43\.250000 eV/.test(s.props)
    && /Pressure = 4\.0000 GPa/.test(s.props), JSON.stringify(s));
  const e = await series();
  H.check('the trajectory\'s energy series is back', e.length === 2 && e[0] === -42.5 && e[1] === -43.25, JSON.stringify(e));

  // ---- a frame computed in the app keeps its own source ----
  // A relax run's trajectory: its frames snapshot the structure with the
  // potential's result on it (BackendPanel/AtomisticPanels.js).
  await page.evaluate(async () => {
    const { Structure, Atom, Stress, TrajectoryContainer } = await import('./model/index.js');
    const { initializeUIOnLoad } = await import('./ui/StructureInputModule.js');
    const frame = (x, energy, gpa, dataSource) => new Structure({
      elements: ['Na', 'Cl'], uniqueElements: ['Na', 'Cl'],
      lattice: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
      atoms: [new Atom({ element: 'Na', position: [0, 0, 0], uuid: `na${x}` }), new Atom({ element: 'Cl', position: [x, 0, 0], uuid: `cl${x}` })],
      energy, dataSource,
      stress: new Stress({ tensor: [[gpa / 160.21766208, 0, 0], [0, gpa / 160.21766208, 0], [0, 0, gpa / 160.21766208]] }),
    });
    const c = TrajectoryContainer.fromStructures('relax_nacl', [frame(0.5, -42.5, 2, null), frame(0.52, -44, 0.5, 'PET-MAD xs')]);
    c.dataSource = 'VASP';
    initializeUIOnLoad(c, { restoreStoredPrefs: false });
  });
  await page.waitForTimeout(1200);
  const relax = await capture();
  H.check('a frame computed in the app saves its own source beside the file\'s',
    relax.dataSource === 'VASP' && !('dataSource' in relax.frames[0]) && relax.frames[1].dataSource === 'PET-MAD xs',
    JSON.stringify({ d: relax.dataSource, f: relax.frames.map((x) => x.dataSource ?? null) }));
  await apply(relax, 'relax.crysviz');
  await page.waitForTimeout(1500);
  await showFrame(0);
  await page.waitForTimeout(300);
  const r0 = await read(page);
  await showFrame(1);
  await page.waitForTimeout(300);
  const r1 = await read(page);
  await showFrame(0);
  await page.waitForTimeout(300);
  const r0again = await read(page);
  H.check('reloaded, frame 1 shows VASP, frame 2 PET-MAD xs, and frame 1 VASP again after it',
    r0.source === 'Source: VASP' && r1.source === 'Source: PET-MAD xs' && /Energy = -44\.000000 eV/.test(r1.props)
      && /Pressure = 0\.5000 GPa/.test(r1.props) && r0again.source === 'Source: VASP',
    JSON.stringify({ r0, r1, r0again }));

  // ---- a single frame ----
  await load(ONE_STEP, 'OUTCAR');
  await page.waitForTimeout(1200);
  const single = await capture();
  H.check('a single-frame session keeps the energy, stress and source',
    single.frames?.length === 1 && single.frames[0].energy === -42.5 && Array.isArray(single.frames[0].stress)
      && single.dataSource === 'VASP',
    JSON.stringify({ d: single.dataSource, f: single.frames }));
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);
  await apply(single, 'single.crysviz');
  await page.waitForTimeout(1500);
  s = await read(page);
  H.check('… and shows them again', s.source === 'Source: VASP' && /Energy = -42\.500000 eV/.test(s.props)
    && /Pressure = 2\.0000 GPa/.test(s.props), JSON.stringify(s));

  // ---- an older session ----
  const old = JSON.parse(JSON.stringify(session));
  delete old.dataSource;
  for (const fr of old.frames) { delete fr.energy; delete fr.stress; delete fr.dataSource; }
  H.check('an older session without them loads', await apply(old, 'old.crysviz') === true);
  await page.waitForTimeout(1500);
  s = await read(page);
  H.check('… with no energy, pressure or source', s.source === null && !/Energy|Pressure/.test(s.props) && s.energy === null,
    JSON.stringify(s));

  // ---- a broken one ----
  const broken = JSON.parse(JSON.stringify(session));
  broken.dataSource = { evil: true };
  broken.frames[0].energy = 'lots';
  broken.frames[0].stress = [[1, 2], [3]];
  broken.frames[1].dataSource = 7;
  H.check('a session with malformed values still loads', await apply(broken, 'broken.crysviz') === true);
  await page.waitForTimeout(1500);
  await showFrame(0);
  await page.waitForTimeout(300);
  s = await read(page);
  H.check('… dropping them', s.source === null && !/Energy|Pressure/.test(s.props), JSON.stringify(s));

  // ---- links ----
  await load(ONE_STEP, 'OUTCAR');
  await page.waitForTimeout(1200);
  const link = await page.evaluate(async () => {
    const st = (await import('./ui/ShareModule.js')).captureState();
    return { top: 'dataSource' in st, keys: Object.keys(st.structure ?? {}) };
  });
  H.check('a share link carries none of it', !link.top && !link.keys.some((k) => /energy|stress|dataSource/.test(k)),
    JSON.stringify(link));

  // ---- the potentials' names ----
  const names = await page.evaluate(async () => {
    const pn = await import('./atomistic/potentialNotice.js');
    const out = { nep: pn.potentialSource('nep'), mlip: pn.potentialSource('mlip') };
    pn.setPotentialLabel('mlip', 'pet-mad-s-v1.0 (in your browser)');
    out.mlipS = pn.potentialSource('mlip');
    pn.setPotentialLabel('mlip', 'my.pt (local file, in your browser)');
    out.local = pn.potentialSource('mlip');
    pn.setPotentialLabel('ase', 'mace-mp-0 on http://lab-server:8000');
    out.ase = pn.potentialSource('ase');
    pn.setPotentialLabel('ase', 'a model on your ASE server at http://lab-server:8000 (not connected)');
    out.aseOff = pn.potentialSource('ase');
    pn.setPotentialLabel('mlip', 'PET-MAD xs (in your browser)');
    return out;
  });
  H.check('"Source:" names the potential\'s model, never the ASE server\'s address',
    names.nep === 'NEP89' && names.mlip === 'PET-MAD xs' && names.mlipS === 'pet-mad-s-v1.0' && names.local === 'my.pt (local file)'
      && names.ase === 'mace-mp-0 (ASE server)' && names.aseOff === 'ASE server', JSON.stringify(names));

  const own = errors.filter((x) => !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/.test(x));
  H.check('no console/page errors', own.length === 0, own.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
