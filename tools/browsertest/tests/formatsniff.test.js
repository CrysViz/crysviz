// Input-format identification (io/formats.js) and the readers behind the new
// formats (SHELX/AIRSS .res, CASTEP .cell / .geom, FHI-aims geometry.in /
// aims.out), driven by the small reference files in tests/wav_dat/formats/.
//
// Four layers, each a statement of the detection rules documented at the top
// of io/formats.js:
//   1. content alone (empty filename) picks every format that has a sniffer,
//      and the candidate set is exactly what the table comments promise
//      (aims.out also matches the geometry sniffer; CHGCAR/ELFCAR share one);
//   2. content beats a misleading filename;
//   3. with no usable head, the filename decides — these cases pin the CURRENT
//      name rules (including their known quirks, e.g. any `.md` is a CASTEP
//      trajectory) and are expected to change if smarter matching lands;
//   4. every new-format fixture loads end to end with the right atoms, cell,
//      energies and forces.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'tests', 'wav_dat', 'formats');
const FIXTURES = Object.fromEntries(fs.readdirSync(FIXTURE_DIR)
  .map((name) => [name, fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')]));

// [fixture, expected id, expected candidate set (table order)]. A single
// candidate means the sniffer is disjoint from every other sniffer on this
// content; a longer list documents a deliberate overlap that table order or
// the name resolves.
const CONTENT_CASES = [
  ['Al13.res', 'res', ['res']],
  ['two_blocks.res', 'res', ['res']],
  ['shelx_sucrose.res', 'res', ['res']],
  ['Si.cell', 'castep-cell', ['castep-cell']],
  ['Al_slab_seed.cell', 'castep-cell', ['castep-cell']],
  ['H2_seed.cell', 'castep-cell', ['castep-cell']],
  ['H2.geom', 'castep-geom', ['castep-geom']],
  ['Si.geometry.in', 'aims-geometry', ['aims-geometry']],
  ['H2O.geometry.in', 'aims-geometry', ['aims-geometry']],
  // The output echoes geometry.in lines: both sniffers fire, table order wins.
  ['Si.aims.out', 'aims-out', ['aims-out', 'aims-geometry']],
  ['session.crysviz', 'crysviz', ['crysviz']],
  ['H2.cube', 'cube', ['cube']],
  // Same layout as ELFCAR; with no name, the first in the table (CHGCAR) wins.
  ['CHGCAR', 'chgcar', ['chgcar', 'elfcar']],
  ['MnO.mcif', 'mcif', ['mcif']],
  ['NaCl.cif', 'cif', ['cif']],
  ['NaCl.scf.out', 'pwscf-out', ['pwscf-out']],
  ['NaCl.scf.in', 'pwscf-in', ['pwscf-in']],
  ['OUTCAR', 'outcar', ['outcar']],
  ['Si.xyz', 'xyz', ['xyz']],
  // No sniffer claims a POSCAR: it is the fallback when nothing else matches.
  ['Si.poscar', 'poscar', []],
];

// Content wins over a name that points elsewhere (rules 2 and 3).
const MISLEADING_NAME_CASES = [
  ['Si.aims.out', 'relax.scf.out', 'aims-out'],
  ['Si.aims.out', 'Si.out', 'aims-out'],
  ['NaCl.cif', 'download', 'cif'],
  ['MnO.mcif', 'structure.cif', 'mcif'],
  ['CHGCAR', 'ELFCAR', 'elfcar'],
  ['CHGCAR', 'CHGCAR.spin', 'chgcar'],
  ['CHGCAR', 'density.dat', 'chgcar'],
  ['Si.geometry.in', 'structure.xyz', 'aims-geometry'],
  ['Al13.res', 'candidates.txt', 'res'],
  ['Si.cell', 'seed.txt', 'castep-cell'],
  ['H2.geom', 'run.castep', 'castep-geom'],
  ['OUTCAR', 'vasp.log', 'outcar'],
  ['NaCl.scf.out', 'espresso.txt', 'pwscf-out'],
  ['Si.xyz', 'frames.dat', 'xyz'],
];

// Statements of the CURRENT filename rules, reached when the head is empty or
// carries nothing a sniffer recognises. Expected to change if more
// sophisticated name/content matching is implemented — update deliberately.
const NAME_FALLBACK_CASES = [
  ['x.res', 'res'],
  ['seed.cell', 'castep-cell'],
  ['relax.geom', 'castep-geom'],
  ['run.md', 'castep-geom'],
  ['neb.ts', 'castep-geom'],
  // Known quirk of the extension rule above: not a CASTEP file at all.
  ['README.md', 'castep-geom'],
  ['aims.out', 'aims-out'],
  ['run.aims', 'aims-out'],
  ['geometry.in', 'aims-geometry'],
  ['geometry.in.next_step', 'aims-geometry'],
  ['x.scf.in', 'pwscf-in'],
  ['x.vcrx.in', 'pwscf-in'],
  ['x.scf.out', 'pwscf-out'],
  ['x.vcrx.in.out', 'pwscf-out'],
  ['OUTCAR', 'outcar'],
  ['OUTCAR.relax1', 'outcar'],
  ['x.vasp.out', 'outcar'],
  ['CHGCAR', 'chgcar'],
  ['ELFCAR', 'elfcar'],
  ['density.cube', 'cube'],
  ['x.xyz', 'xyz'],
  ['x.exyz', 'xyz'],
  ['x.cif', 'cif'],
  ['x.mcif', 'mcif'],
  ['x.traj', 'traj'],
  ['WAVECAR', 'wavecar'],
  ['x.crysviz', 'crysviz'],
  ['POSCAR', 'poscar'],
  ['CONTCAR', 'poscar'],
  // A generic `.out` has no name rule: only its content can identify it.
  ['relax.out', 'poscar'],
  ['x.pwi', 'poscar'],
];

// A POSCAR has no sniffer, so nothing can veto a wrong name for one.
const POSCAR_NAMED_AS = [['Si.poscar', 'Si.cif', 'cif'], ['Si.poscar', 'Si.xyz', 'xyz']];

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const detect = await page.evaluate(async ({ fixtures, content, misleading, fallback, poscarNamed }) => {
    const F = await import('./io/formats.js');
    const ids = (head) => F.FORMATS.filter((f) => f.sniff && f.sniff(F.prepareHead(head))).map((f) => f.id);
    const out = { content: {}, misleading: {}, fallback: {}, tinyHead: {}, poscarNamed: {}, looksLike: {} };
    for (const [name] of content) {
      out.content[name] = { id: F.detectFormat({ fileName: '', head: fixtures[name] }).id, candidates: ids(fixtures[name]) };
    }
    for (const [name, fileName] of misleading) {
      out.misleading[`${name} as ${fileName}`] = F.detectFormat({ fileName, head: fixtures[name] }).id;
    }
    for (const [fileName] of fallback) {
      out.fallback[fileName] = F.detectFormat({ fileName, head: '' }).id;
      // A head that exists but is too small to carry any marker must behave
      // exactly like no head at all.
      out.tinyHead[fileName] = F.detectFormat({ fileName, head: '\n' }).id;
    }
    for (const [name, fileName] of poscarNamed) {
      out.poscarNamed[`${name} as ${fileName}`] = F.detectFormat({ fileName, head: fixtures[name] }).id;
    }
    out.looksLike = {
      resIsRes: F.looksLike('res', fixtures['Al13.res']),
      resIsNotCif: !F.looksLike('cif', fixtures['Al13.res']),
      cellIsCell: F.looksLike('castep-cell', fixtures['Si.cell']),
      geomIsGeom: F.looksLike('castep-geom', fixtures['H2.geom']),
      aimsOutIsAimsOut: F.looksLike('aims-out', fixtures['Si.aims.out']),
      geometryIsGeometry: F.looksLike('aims-geometry', fixtures['Si.geometry.in']),
      poscarNeverLooksLikeAnything: !F.looksLike('poscar', fixtures['Si.poscar']),
      unknownIdIsFalse: !F.looksLike('no-such-format', fixtures['Al13.res']),
    };

    // Binary formats: sniffed from bytes, which only a byte head can carry.
    const enc = new TextEncoder();
    const ulm = enc.encode('- of Ulm' + ' '.repeat(64));
    const ulmHead = F.headOf(ulm);
    const wavecarBytes = (rtag, nspin = 1, recl = 1e5) => {
      const f = new Float64Array([recl, nspin, rtag, 0]);
      return new Uint8Array(f.buffer);
    };
    out.binary = {
      trajFromBytes: F.detectFormat({ fileName: '', head: ulmHead }).id,
      trajFromJsonHeader: F.detectFormat({ fileName: '', head: '{"descriptor": ["ulm"]}' }).id,
      wavecarSingle: F.detectFormat({ fileName: '', head: F.headOf(wavecarBytes(45200)) }).id,
      wavecarDouble: F.detectFormat({ fileName: '', head: F.headOf(wavecarBytes(45210)) }).id,
      wavecarSpin2: F.detectFormat({ fileName: '', head: F.headOf(wavecarBytes(45200, 2)) }).id,
      wrongRtag: F.detectFormat({ fileName: '', head: F.headOf(wavecarBytes(12345)) }).id,
      badSpin: F.detectFormat({ fileName: '', head: F.headOf(wavecarBytes(45200, 3)) }).id,
      wavecarLooksLike: F.looksLike('wavecar', wavecarBytes(45200)),
      textHeadHasNoBytes: F.headOf('abc').bytes === null,
    };
    return out;
  }, { fixtures: FIXTURES, content: CONTENT_CASES, misleading: MISLEADING_NAME_CASES,
    fallback: NAME_FALLBACK_CASES, poscarNamed: POSCAR_NAMED_AS });

  for (const [name, id, candidates] of CONTENT_CASES) {
    const got = detect.content[name];
    H.check(`content only: ${name} -> ${id}`, got.id === id, JSON.stringify(got));
    H.check(`content only: ${name} candidates are exactly [${candidates.join(', ')}]`,
      JSON.stringify(got.candidates) === JSON.stringify(candidates), JSON.stringify(got.candidates));
  }
  for (const [name, fileName, id] of MISLEADING_NAME_CASES) {
    const key = `${name} as ${fileName}`;
    H.check(`content beats name: ${key} -> ${id}`, detect.misleading[key] === id, detect.misleading[key]);
  }
  for (const [fileName, id] of NAME_FALLBACK_CASES) {
    H.check(`name fallback (no head): ${fileName} -> ${id}`, detect.fallback[fileName] === id, detect.fallback[fileName]);
    H.check(`name fallback (tiny head): ${fileName} -> ${id}`, detect.tinyHead[fileName] === id, detect.tinyHead[fileName]);
  }
  for (const [name, fileName, id] of POSCAR_NAMED_AS) {
    const key = `${name} as ${fileName}`;
    H.check(`current behaviour: a POSCAR named ${fileName} goes to ${id}`, detect.poscarNamed[key] === id, detect.poscarNamed[key]);
  }
  H.check('looksLike answers from content alone', Object.values(detect.looksLike).every(Boolean), JSON.stringify(detect.looksLike));
  H.check('ASE .traj is sniffed from the ULM magic or its JSON header',
    detect.binary.trajFromBytes === 'traj' && detect.binary.trajFromJsonHeader === 'traj', JSON.stringify(detect.binary));
  H.check('WAVECAR is sniffed from the RTAG/spin header floats',
    detect.binary.wavecarSingle === 'wavecar' && detect.binary.wavecarDouble === 'wavecar'
      && detect.binary.wavecarSpin2 === 'wavecar' && detect.binary.wavecarLooksLike, JSON.stringify(detect.binary));
  H.check('bytes with a wrong RTAG or spin count are not a WAVECAR',
    detect.binary.wrongRtag === 'poscar' && detect.binary.badSpin === 'poscar', JSON.stringify(detect.binary));
  H.check('a string head carries no bytes', detect.binary.textHeadHasNoBytes === true, JSON.stringify(detect.binary));

  // ---- end to end: every new-format fixture through loadStructure ----------
  const LOAD_CASES = ['Al13.res', 'two_blocks.res', 'shelx_sucrose.res', 'Si.cell', 'Al_slab_seed.cell',
    'H2_seed.cell', 'H2.geom', 'Si.geometry.in', 'H2O.geometry.in', 'Si.aims.out'];
  const loaded = {};
  for (const name of LOAD_CASES) {
    loaded[name] = await page.evaluate(async ({ text, name }) => {
      const cv = await import('./core/crystal-viewer.js');
      const { fileBrowser, structureShip } = await import('./state/store.js');
      try {
        const result = await cv.loadStructure(text, name);
        if (result && result.ok === false) return { error: result.error || result.message || 'load returned ok:false' };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
      const container = structureShip.container[fileBrowser.selectedRowIndex];
      const frames = await Promise.resolve(container.framesSlice());
      const len = (v) => Math.hypot(v[0], v[1], v[2]);
      const cart = (s, i) => {
        const p = s.atoms[i].position; const L = s.lattice;
        return [0, 1, 2].map((k) => p[0] * L[0][k] + p[1] * L[1][k] + p[2] * L[2][k]);
      };
      const dist = (s, i, j) => { const a = cart(s, i); const b = cart(s, j); return len([a[0] - b[0], a[1] - b[1], a[2] - b[2]]); };
      return {
        frameCount: container.frameCount,
        frames: frames.map((s) => ({
          natoms: s.atoms.length,
          elements: s.elements,
          abc: s.lattice.map(len).map((x) => Number(x.toFixed(4))),
          energy: s.energy ?? null,
          nforces: s.forces ? s.forces.length : 0,
          force0: s.forces && s.forces[0] ? s.forces[0].vector : null,
          occupancies: s.atoms.map((a) => (a.species && a.species[0] ? a.species[0].occupancy : null)),
          frac0: s.atoms[0].position.map((x) => Number(x.toFixed(4))),
          frac1: s.atoms[1] ? s.atoms[1].position.map((x) => Number(x.toFixed(4))) : null,
          d01: s.atoms[1] ? Number(dist(s, 0, 1).toFixed(4)) : null,
        })),
      };
    }, { text: FIXTURES[name], name });
  }
  const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
  const f0 = (name) => loaded[name].frames && loaded[name].frames[0];

  H.check('AIRSS .res loads 13 Al in a 20 Å cube',
    loaded['Al13.res'].frameCount === 1 && f0('Al13.res').natoms === 13
      && f0('Al13.res').elements.every((e) => e === 'Al') && f0('Al13.res').abc.every((x) => near(x, 20)),
    JSON.stringify(loaded['Al13.res']));
  H.check('a concatenated .res becomes a two-frame trajectory with SFAC-mapped elements',
    loaded['two_blocks.res'].frameCount === 2
      && loaded['two_blocks.res'].frames.every((s) => s.natoms === 2 && s.elements[0] === 'Na' && s.elements[1] === 'Cl'),
    JSON.stringify(loaded['two_blocks.res']));
  H.check('a concatenated .res carries the TITL enthalpy as the frame energy',
    near(loaded['two_blocks.res'].frames[0].energy, -10.5) && near(loaded['two_blocks.res'].frames[1].energy, -10.4),
    JSON.stringify(loaded['two_blocks.res'].frames.map((s) => s.energy)));
  H.check('a SHELX .res reads only the atom lines (ZERR/UNIT/FVAR/HKLF are instructions)',
    loaded['shelx_sucrose.res'].frameCount === 1 && f0('shelx_sucrose.res').natoms === 4
      && JSON.stringify(f0('shelx_sucrose.res').elements) === JSON.stringify(['O', 'C', 'H', 'O']),
    JSON.stringify(loaded['shelx_sucrose.res']));
  H.check('a SHELX .res decodes the 10*k+p site occupation factor (11.0 -> 1, 10.5 -> 0.5)',
    !!f0('shelx_sucrose.res') && JSON.stringify(f0('shelx_sucrose.res').occupancies) === JSON.stringify([1, 1, 1, 0.5]),
    JSON.stringify(f0('shelx_sucrose.res') && f0('shelx_sucrose.res').occupancies));
  H.check('CASTEP .cell with LATTICE_ABC + POSITIONS_FRAC loads 8 Si in a 5.43 Å cube',
    f0('Si.cell') && f0('Si.cell').natoms === 8 && f0('Si.cell').abc.every((x) => near(x, 5.43)),
    JSON.stringify(loaded['Si.cell']));
  H.check('AIRSS buildcell seed .cell (LATTICE_CART, # hints) loads 5 Al with c = 35.96 Å',
    f0('Al_slab_seed.cell') && f0('Al_slab_seed.cell').natoms === 5 && near(f0('Al_slab_seed.cell').abc[2], 35.9646),
    JSON.stringify(loaded['Al_slab_seed.cell']));
  H.check('a lattice-less POSITIONS_ABS seed loads as a boxed molecule keeping the H-H distance',
    f0('H2_seed.cell') && f0('H2_seed.cell').natoms === 2 && near(f0('H2_seed.cell').d01, 0.74),
    JSON.stringify(loaded['H2_seed.cell']));
  H.check('CASTEP .geom loads two frames of H2 with lattice, energy and forces converted from a.u.',
    loaded['H2.geom'].frameCount === 2
      && loaded['H2.geom'].frames.every((s) => s.natoms === 2 && s.nforces === 2 && s.abc.every((x) => near(x, 6.0, 1e-3)))
      && near(loaded['H2.geom'].frames[0].energy, -1.1089287934762380 * 27.211386245988, 1e-6)
      && near(loaded['H2.geom'].frames[0].d01, 1.0, 1e-3) && near(loaded['H2.geom'].frames[1].d01, 0.75, 1e-3),
    JSON.stringify(loaded['H2.geom']));
  H.check('FHI-aims geometry.in (atom_frac) loads the Si primitive cell',
    f0('Si.geometry.in') && f0('Si.geometry.in').natoms === 2
      && f0('Si.geometry.in').abc.every((x) => near(x, Math.hypot(2.715, 2.715)))
      && JSON.stringify(f0('Si.geometry.in').frac1) === JSON.stringify([0.25, 0.25, 0.25]),
    JSON.stringify(loaded['Si.geometry.in']));
  H.check('FHI-aims geometry.in (Cartesian, no lattice) loads a boxed water molecule',
    f0('H2O.geometry.in') && f0('H2O.geometry.in').natoms === 3 && f0('H2O.geometry.in').elements[0] === 'O'
      && near(f0('H2O.geometry.in').d01, Math.hypot(0.707, 0.707)),
    JSON.stringify(loaded['H2O.geometry.in']));
  H.check('FHI-aims aims.out loads the input echo plus the updated structure as two frames with energies and forces',
    loaded['Si.aims.out'].frameCount === 2
      && loaded['Si.aims.out'].frames.every((s) => s.natoms === 2 && s.nforces === 2)
      && near(loaded['Si.aims.out'].frames[0].energy, -15757.893855934, 1e-6)
      && near(loaded['Si.aims.out'].frames[1].energy, -15757.8939, 1e-6)
      && near(loaded['Si.aims.out'].frames[1].force0[0], 0.001, 1e-9)
      && near(loaded['Si.aims.out'].frames[1].d01, Math.hypot(1.36, 1.36, 1.36), 1e-3),
    JSON.stringify(loaded['Si.aims.out']));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
