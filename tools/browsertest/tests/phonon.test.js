// Phonon panel: phonopy files load through the normal loader, the modes are
// parsed, a mode animates the supercell, the displacement maths reproduces
// phonopy's own MODULATION output, and the mode map (driven with a synthetic
// potential — no wasm) recovers the phonon frequency from a harmonic surface
// and the minima of a double well.
//
// Fixture: a simple-cubic Lennard-Jones "Ar" crystal, generated with phonopy
// 4.4 (3x3x3 supercell). It is shear-unstable, so X and M carry imaginary
// modes — exactly the case the mode-map workflow is for. MPOSCAR is phonopy's
// write_modulations() output for the M-point mode (band 1, amplitude 0.8,
// argument 0) in a 2x2x2 supercell.
'use strict';
const H = require('../harness');

const BAND_YAML = String.raw`nqpoint: 12     
npath: 4      
segment_nqpoint:
- 3
- 3
- 3
- 3
labels:
- [ '$\Gamma$', 'X' ]
- [ 'X', 'M' ]
- [ 'M', '$\Gamma$' ]
- [ '$\Gamma$', 'R' ]
reciprocal_lattice:
- [   0.33333333,   0.00000000,   0.00000000 ] # a*
- [   0.00000000,   0.33333333,   0.00000000 ] # b*
- [   0.00000000,   0.00000000,   0.33333333 ] # c*
natom: 1      
lattice:
- [     3.000000000000000,     0.000000000000000,     0.000000000000000 ] # a
- [     0.000000000000000,     3.000000000000000,     0.000000000000000 ] # b
- [     0.000000000000000,     0.000000000000000,     3.000000000000000 ] # c
points:
- symbol: Ar # 1
  coordinates: [  0.000000000000000,  0.000000000000000,  0.000000000000000 ]
  mass: 39.948000

phonon:
- q-position: [    0.0000000,    0.0000000,    0.0000000 ]
  distance:    0.0000000
  band:
  - # 1
    frequency:   -0.0000000696
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -0.0000000342
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    0.0000000315
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.2500000,    0.0000000,    0.0000000 ]
  distance:    0.0833333
  band:
  - # 1
    frequency:   -0.6464340339
    eigenvector:
    - # atom 1
      - [ -0.00000000000000,  0.00000000000000 ]
      - [ -0.00464498663073,  0.00000000000000 ]
      - [ -0.99998921199141,  0.00000000000000 ]
  - # 2
    frequency:   -0.6464340339
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.99998921199141,  0.00000000000000 ]
      - [  0.00464498663073,  0.00000000000000 ]
  - # 3
    frequency:    2.9409991031
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.0000000,    0.0000000 ]
  distance:    0.1666667
  band:
  - # 1
    frequency:   -0.9141957780
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -0.9141957780
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    4.1592008185
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.0000000,    0.0000000 ]
  distance:    0.1666667
  band:
  - # 1
    frequency:   -0.9141957780
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -0.9141957780
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    4.1592008185
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.2500000,    0.0000000 ]
  distance:    0.2500000
  band:
  - # 1
    frequency:   -1.1766702254
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:    3.0066127207
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    4.2552406203
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.5000000,    0.0000000 ]
  distance:    0.3333333
  band:
  - # 1
    frequency:   -1.3904501855
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:    4.3491601517
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    4.3491601517
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.5000000,    0.5000000,    0.0000000 ]
  distance:    0.3333333
  band:
  - # 1
    frequency:   -1.3904501855
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:    4.3491601517
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    4.3491601517
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.2500000,    0.2500000,    0.0000000 ]
  distance:    0.4511845
  band:
  - # 1
    frequency:   -0.9493233853
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.00000000000000, -1.00000000000000 ]
  - # 2
    frequency:    2.8353713850
    eigenvector:
    - # atom 1
      - [ -0.70710678118655,  0.00000000000000 ]
      - [ -0.70710678118655, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]
  - # 3
    frequency:    3.1064231659
    eigenvector:
    - # atom 1
      - [  0.70710678118655,  0.00000000000000 ]
      - [ -0.70710678118655, -0.00000000000000 ]
      - [ -0.00000000000000, -0.00000000000000 ]

- q-position: [    0.0000000,    0.0000000,    0.0000000 ]
  distance:    0.5690356
  band:
  - # 1
    frequency:   -0.0000000696
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -0.0000000342
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    0.0000000315
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.0000000,    0.0000000,    0.0000000 ]
  distance:    0.5690356
  band:
  - # 1
    frequency:   -0.0000000696
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:   -0.0000000342
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    0.0000000315
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]

- q-position: [    0.2500000,    0.2500000,    0.2500000 ]
  distance:    0.7133732
  band:
  - # 1
    frequency:    2.7644578352
    eigenvector:
    - # atom 1
      - [  0.57735026918963,  0.00000000000000 ]
      - [  0.57735026918963,  0.00000000000000 ]
      - [  0.57735026918963,  0.00000000000000 ]
  - # 2
    frequency:    3.0749430366
    eigenvector:
    - # atom 1
      - [ -0.81649658092773,  0.00000000000000 ]
      - [  0.40824829046386,  0.00000000000000 ]
      - [  0.40824829046386,  0.00000000000000 ]
  - # 3
    frequency:    3.0749430366
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [ -0.70710678118655,  0.00000000000000 ]
      - [  0.70710678118655,  0.00000000000000 ]

- q-position: [    0.5000000,    0.5000000,    0.5000000 ]
  distance:    0.8577107
  band:
  - # 1
    frequency:    4.3912326295
    eigenvector:
    - # atom 1
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
  - # 2
    frequency:    4.3912326295
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
  - # 3
    frequency:    4.3912326295
    eigenvector:
    - # atom 1
      - [  0.00000000000000,  0.00000000000000 ]
      - [  1.00000000000000,  0.00000000000000 ]
      - [  0.00000000000000,  0.00000000000000 ]`;

const MPOSCAR = `generated by phonopy
   1.0
     6.0000000000000000    0.0000000000000000    0.0000000000000000
     0.0000000000000000    6.0000000000000000    0.0000000000000000
     0.0000000000000000    0.0000000000000000    6.0000000000000000
Ar
   8
Direct
  0.0000000000000000  0.0000000000000000  0.0074584094677673
  0.5000000000000000  0.0000000000000000  0.9925415905322327
  0.0000000000000000  0.5000000000000000  0.9925415905322327
  0.5000000000000000  0.5000000000000000  0.0074584094677673
  0.0000000000000000  0.0000000000000000  0.5074584094677672
  0.5000000000000000  0.0000000000000000  0.4925415905322327
  0.0000000000000000  0.5000000000000000  0.4925415905322327
  0.5000000000000000  0.5000000000000000  0.5074584094677672`;

const TOTAL_DOS = `# Tetrahedron method
        0.9047593175        0.0000000000
        0.9218720234        0.0000000000
        0.9389847293        0.0000000000
        0.9560974352        0.0000000000
        0.9732101411        0.0000000000
        0.9903228470        0.0000000000
        1.0074355529        0.0000000000
        1.0245482588        0.0000000000
        1.0416609648        0.0000000000
        1.0587736707        0.0000000000
        1.0758863766        0.0000000000
        1.0929990825        0.0000000000
        1.1101117884        0.0000000000
        1.1272244943        0.0000000000
        1.1443372002        0.0000000000
        1.1614499061        0.0000000000
        1.1785626121        0.0000000000
        1.1956753180        2.3132981454
        1.2127880239        2.7637933464
        1.2299007298        3.2032637611
        1.2470134357        3.6317093894
        1.2641261416        4.0491302313
        1.2812388475        6.5736142475
        1.2983515534        6.8040783130
        1.3154642593        6.7074354699
        1.3325769653        0.1988277059
        1.3496896712        0.1973291042
        1.3668023771        0.1958360523
        1.3839150830        0.1943485502
        1.4010277889        0.1928665979
        1.4181404948        0.1913901954
        1.4352532007        0.1899193427
        1.4523659066        0.1884540397
        1.4694786126        0.1869942866
        1.4865913185        0.1855400833
        1.5037040244        1.4149715360
        1.5208167303        1.3708389263
        1.5379294362        1.3258816193
        1.5550421421        1.2800996150`;

// The same cell written in Bohr (a = 3 Å = 5.669 Bohr): phonopy would write a
// QE run this way, and the file itself says nothing about the unit.
const BAND_YAML_BOHR = BAND_YAML.replace(/3\.000000000000000/g, (3 / 0.529177210903).toFixed(15));

/** Load a phonopy mode file that will raise the length-unit dialog
 *  (phonon/phononSession.js resolveUndeclaredUnit), answer it with the
 *  first or second choice, and return what the dialog showed. */
async function loadAnsweringUnitDialog(page, text, name, pick = 1) {
  await page.evaluate(({ text, name }) => {
    window.__phLoad = import('./core/crystal-viewer.js').then((cv) => cv.loadStructure(text, name));
  }, { text, name });
  await page.waitForSelector('#confirmModal:not([hidden])', { timeout: 15000 });
  const dialog = await page.evaluate(() => ({
    title: document.getElementById('confirmModalTitle').textContent,
    message: document.getElementById('confirmModalMessage').textContent,
    detail: document.getElementById('confirmModalDetail').textContent,
    choices: [...document.querySelectorAll('#confirmModalActions .confirm-choice-label')].map((el) => el.textContent),
  }));
  await page.click(`#confirmModalActions button:nth-child(${pick})`);
  await page.evaluate(() => window.__phLoad);
  return dialog;
}

(async () => {
  // The mode map is experimental (debug/experimentalMode.js): first confirm it
  // is absent on a plain load, then run everything else with ?experimental.
  const { browser, page, errors } = await H.launchApp({ navigate: false });
  const base = new URL(process.env.CRYSVIZ_URL || 'http://localhost:8123/index.html');
  await page.goto(base.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  // ---- 0. length-unit dialog: band.yaml declares no unit, the geometry does -
  const dlgA = await loadAnsweringUnitDialog(page, BAND_YAML, 'band.yaml', 1);
  H.check('a bare band.yaml raises the length-unit dialog', dlgA.title === 'Phonon cell: length unit', dlgA.title);
  H.check('the Å cell (Ar–Ar 3.0 Å) is detected as Å with the alternative offered',
    dlgA.choices[0] === 'Use Å (detected)' && dlgA.choices[1] === 'Use Bohr' && /almost certainly in Å/.test(dlgA.message), JSON.stringify(dlgA.choices));
  H.check('the dialog shows both readings', /as Å.*Ar–Ar 3\.00 Å.*normal contact/.test(dlgA.detail) && /as Bohr.*1\.59 Å.*overlap/.test(dlgA.detail), dlgA.detail);
  const plain = await page.evaluate(async () => {
    const { phononState } = await import('./phonon/phononSession.js');
    const { isExperimentalMode } = await import('./debug/experimentalMode.js');
    return {
      experimental: isExperimentalMode(), scanBtn: !!document.getElementById('phScanBtn'), card: !!document.getElementById('phonon-modemap-plot-wrapper'), bands: !!document.getElementById('phonon-band-plot'),
      unit: phononState.detectedUnit, source: phononState.detectedUnitSource, a: phononState.dataset.cell.lattice[0][0],
      note: document.getElementById('phUnitNote')?.textContent,
    };
  });
  H.check('without ?experimental the mode map is absent but the bands are there', !plain.experimental && !plain.scanBtn && !plain.card && plain.bands, JSON.stringify(plain));
  H.check('confirming keeps the cell in Å and the panel says so', plain.unit === 'angstrom' && plain.source === 'user' && Math.abs(plain.a - 3) < 1e-9 && /Å — confirmed at load/.test(plain.note), JSON.stringify(plain));

  const dlgB = await loadAnsweringUnitDialog(page, BAND_YAML_BOHR, 'band_qe.yaml', 1);
  // The toy cell is denser than real argon (Ar–Ar 3.0 Å vs 3.76 Å in the fcc
  // solid), so its Å reading is only "loose", not isolated: the guess is Bohr
  // with low confidence, and the dialog says "probably" rather than "almost
  // certainly". A real Bohr cell reads as isolated and gets high confidence
  // (covered by the node-level cases in the module's own header comment).
  H.check('the same cell written in Bohr (5.67) is detected as Bohr', dlgB.choices[0] === 'Use Bohr (detected)' && /probably in Bohr/.test(dlgB.message), JSON.stringify([dlgB.choices, dlgB.message]));
  H.check('its readings: as Å a loose contact, as Bohr a normal one', /as Å.*5\.67 Å.*loose, unusual/.test(dlgB.detail) && /as Bohr.*3\.00 Å.*normal contact/.test(dlgB.detail), dlgB.detail);
  const bohr = await page.evaluate(async () => {
    const { phononState } = await import('./phonon/phononSession.js');
    return { unit: phononState.detectedUnit, a: phononState.dataset.cell.lattice[0][0], raw: phononState.dataset.cellRaw.lattice[0][0], shown: phononState.structure.lattice[0][0] };
  });
  H.check('the Bohr cell is shown converted to Å (a = 3.00)', bohr.unit === 'bohr' && Math.abs(bohr.a - 3) < 1e-9 && Math.abs(bohr.raw - 5.669) < 1e-3 && Math.abs(bohr.shown - 3) < 1e-9, JSON.stringify(bohr));

  // A forced unit (the Length unit selector) skips the dialog entirely.
  const forced = await page.evaluate(async (band) => {
    const S = await import('./phonon/phononSession.js');
    const cv = await import('./core/crystal-viewer.js');
    S.setLengthUnit('bohr');
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 8000));
    const outcome = await Promise.race([cv.loadStructure(band, 'band.yaml').then(() => 'loaded'), timeout]);
    const dialogShown = !!document.querySelector('#confirmModal:not([hidden])');
    const a = S.phononState.dataset.cell.lattice[0][0];
    S.setLengthUnit('auto');
    return { outcome, dialogShown, a };
  }, BAND_YAML);
  H.check('a forced Length unit loads without asking and applies (3 Bohr -> 1.59 Å)', forced.outcome === 'loaded' && !forced.dialogShown && Math.abs(forced.a - 3 * 0.529177210903) < 1e-9, JSON.stringify(forced));
  base.searchParams.set('experimental', '');
  await page.goto(base.toString(), { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  H.check('WebGL2 available', await H.webglAvailable(page));
  await H.loadDefaultStructure(page); // YBCO, so the phonon rows are not the first structure

  // ---- 1. format detection ------------------------------------------------
  const detected = await page.evaluate(async ({ band, dos }) => {
    const { detectFormat, headOf } = await import('./io/index.js');
    return {
      band: detectFormat({ fileName: 'whatever.txt', head: headOf(band) }).id,
      dosByContent: detectFormat({ fileName: 'x.dat', head: headOf(dos) }).id,
      dosByName: detectFormat({ fileName: 'total_dos.dat', head: headOf('1 2\n3 4\n5 6\n') }).id,
      cells: detectFormat({ fileName: 'x.yaml', head: headOf('phonopy:\n  version: "4.4.0"\nunit_cell:\n  lattice:\n  - [ 1, 0, 0 ]\n') }).id,
      poscar: detectFormat({ fileName: 'POSCAR', head: headOf('Ar\n1.0\n3 0 0\n0 3 0\n0 0 3\nAr\n1\nDirect\n0 0 0\n') }).id,
    };
  }, { band: BAND_YAML, dos: TOTAL_DOS });
  H.check('band.yaml detected by content', detected.band === 'phonopy-modes', detected.band);
  H.check('total_dos.dat detected by content', detected.dosByContent === 'phonopy-dos', detected.dosByContent);
  H.check('total_dos.dat detected by name', detected.dosByName === 'phonopy-dos', detected.dosByName);
  H.check('phonopy.yaml detected by content', detected.cells === 'phonopy-cells', detected.cells);
  H.check('POSCAR still falls through to poscar', detected.poscar === 'poscar', detected.poscar);

  // ---- 2. load band.yaml through the app loader ---------------------------
  const rowsBefore = await page.evaluate(async () => (await import('./state/store.js')).structureShip.container.length);
  await loadAnsweringUnitDialog(page, BAND_YAML, 'band.yaml', 1);
  const loaded = await page.evaluate(async (rowsBefore) => {
    const { phononState } = await import('./phonon/phononSession.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const ds = phononState.dataset;
    return {
      rowsBefore, rowsAfter: structureShip.container.length,
      kind: ds?.kind, natom: ds?.natom, nbands: ds?.nbands, nq: ds?.qpoints.length,
      segments: ds?.segments, labels: ds?.labels?.map((p) => p.join('-')),
      hasEig: ds?.hasEigenvectors, species: ds?.cell.species,
      firstFreqs: ds ? Array.from(ds.qpoints[0].freqs) : null,
      rowName: phononState.container?.fileName,
      selectedIsPhonon: fileBrowser.selectedStructure === phononState.structure,
      atoms: fileBrowser.selectedStructure?.atoms.length,
      panelOpen: !!getPanel('phonon') && !getPanel('phonon').closed && getPanel('phonon').isExpanded(),
      plotsOpen: !!getPanel('phononPlots') && !getPanel('phononPlots').closed,
      plotEl: !!document.getElementById('phonon-band-plot'),
    };
  }, rowsBefore);
  H.check('loading band.yaml adds one file-browser row', loaded.rowsAfter === loaded.rowsBefore + 1, JSON.stringify(loaded));
  H.check('dataset parsed: band, 1 atom, 3 bands, 12 q-points, 4 segments', loaded.kind === 'band' && loaded.natom === 1 && loaded.nbands === 3 && loaded.nq === 12 && loaded.segments.length === 4);
  H.check('labels parsed', JSON.stringify(loaded.labels) === JSON.stringify(['$\\Gamma$-X', 'X-M', 'M-$\\Gamma$', '$\\Gamma$-R']), JSON.stringify(loaded.labels));
  H.check('eigenvectors present, cell species Ar', loaded.hasEig && loaded.species[0] === 'Ar');
  H.check('acoustic modes at Γ are ~0', loaded.firstFreqs.every((f) => Math.abs(f) < 1e-3), JSON.stringify(loaded.firstFreqs));
  H.check('the phonon supercell row is selected (1x1x1, 1 atom)', loaded.selectedIsPhonon && loaded.atoms === 1 && loaded.rowName === 'phonon_band_1x1x1', loaded.rowName);
  H.check('Phonons controls window opened', loaded.panelOpen);
  H.check('Phonon Plots window opened with the band plot element', loaded.plotsOpen && loaded.plotEl);

  // ---- 2b. the windows follow the selected row ------------------------------
  const follow = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const { selectStructure } = await import('./ui/FileBrowswerPanel.js');
    const S = await import('./phonon/phononSession.js');
    const { structureShip } = await import('./state/store.js');
    const phononRow = structureShip.container.findIndex((c) => c.fileName.startsWith('phonon_'));
    const plotsPanel = getPanel('phononPlots');
    const ctrl = getPanel('phonon');
    selectStructure(0, 0); // YBCO: no phonon data
    const away = { plotsClosed: plotsPanel.closed, ctrlAvail: ctrl.available, hasData: !!S.phononState.dataset, available: S.phononAvailable() };
    selectStructure(phononRow, 0);
    const back = { plotsOpen: !plotsPanel.closed, ctrlAvail: ctrl.available, available: S.phononAvailable(), rowHasRecord: !!(/** @type {any} */ (structureShip.container[phononRow])).phonon };
    return { away, back };
  });
  H.check('switching to another structure closes the plots window and greys the controls',
    follow.away.plotsClosed && !follow.away.ctrlAvail && !follow.away.available, JSON.stringify(follow.away));
  H.check('selecting the phonon row again reopens the plots window (data lives on the row)',
    follow.back.plotsOpen && follow.back.ctrlAvail && follow.back.available && follow.back.rowHasRecord, JSON.stringify(follow.back));

  // ---- 3. DOS joins the dataset, no new row -------------------------------
  const dosLoaded = await page.evaluate(async (dos) => {
    const cv = await import('./core/crystal-viewer.js');
    const { phononState } = await import('./phonon/phononSession.js');
    const { structureShip } = await import('./state/store.js');
    const before = structureShip.container.length;
    await cv.loadStructure(dos, 'total_dos.dat');
    return { before, after: structureShip.container.length, n: phononState.dos?.frequencies.length, total: phononState.dos?.total.length };
  }, TOTAL_DOS);
  H.check('DOS attached without a new row', dosLoaded.before === dosLoaded.after && dosLoaded.n === 39 && dosLoaded.total === 39, JSON.stringify(dosLoaded));

  // ---- 4. supercell + imaginary mode animation ----------------------------
  const anim = await page.evaluate(async () => {
    const S = await import('./phonon/phononSession.js');
    const { fileBrowser, groups } = await import('./state/store.js');
    S.setDims([2, 2, 2]);
    const ds = S.phononState.dataset;
    const imag = S.imaginaryModes();
    // M = (0.5, 0.5, 0): the most unstable mode of this crystal.
    const iqM = ds.qpoints.findIndex((qp) => Math.abs(qp.q[0] - 0.5) < 1e-6 && Math.abs(qp.q[1] - 0.5) < 1e-6 && Math.abs(qp.q[2]) < 1e-6);
    S.selectMode(iqM, 0);
    const eq = S.phononState.supercell.frac.map((f) => [...f]);
    const st = S.phononState.structure;
    const deviation = () => {
      let m = 0;
      st.atoms.forEach((a, j) => { for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(a.position[k] - eq[j][k])); });
      return m;
    };
    // Poll rather than sleep: under software GL the supercell refit's render
    // can hold the first animation tick back for a while.
    let maxDev = 0;
    for (let t = 0; t < 50 && !(maxDev > 1e-3); t++) {
      await new Promise((r) => setTimeout(r, 100));
      maxDev = deviation();
    }
    const arrows = !!groups.phononShaftMesh && groups.phononShaftMesh.count > 0;
    const playing = S.phononState.playing;
    S.stopAnimation();
    let maxAfterStop = 0;
    st.atoms.forEach((a, j) => { for (let k = 0; k < 3; k++) maxAfterStop = Math.max(maxAfterStop, Math.abs(a.position[k] - eq[j][k])); });
    return {
      atoms: st.atoms.length, rowName: S.phononState.container.fileName,
      nImag: imag.length, mostUnstable: imag[0]?.freq, iqM, freqM: ds.qpoints[iqM].freqs[0],
      commensurate: S.phononState.commensurate, playing, maxDev, arrows, maxAfterStop,
      selectedIsPhonon: fileBrowser.selectedStructure === st,
      label: S.qLabel(iqM),
    };
  });
  H.check('2x2x2 supercell has 8 atoms and the row was renamed', anim.atoms === 8 && anim.rowName === 'phonon_band_2x2x2', anim.rowName);
  H.check('imaginary modes listed, most unstable first', anim.nImag > 0 && anim.mostUnstable < -1.3, JSON.stringify({ n: anim.nImag, f: anim.mostUnstable }));
  H.check('M-point mode is imaginary and commensurate with 2x2x2', anim.freqM < -1 && anim.commensurate, JSON.stringify(anim));
  H.check('q label carries the band.yaml name', anim.label.startsWith('M '), anim.label);
  H.check('selecting a mode starts the animation and moves the atoms', anim.playing && anim.maxDev > 1e-3, `maxDev=${anim.maxDev}`);
  H.check('displacement arrows are drawn', anim.arrows);
  H.check('stop returns the atoms to equilibrium', anim.maxAfterStop < 1e-12 && anim.selectedIsPhonon, `maxAfterStop=${anim.maxAfterStop}`);

  // ---- 5. displacement maths vs phonopy's MPOSCAR -------------------------
  const mp = await page.evaluate(async (mposcar) => {
    const S = await import('./phonon/phononSession.js');
    const M = await import('./phonon/phononMath.js');
    const sc = S.phononState.supercell;
    const pattern = S.phononState.pattern; // M-point band 1, argument 0
    const u = M.phonopyModulationDisplacement(pattern, 0.8, new Float64Array(sc.natom * 3));
    const frac = M.displacedFractional(sc, u);
    const ref = M.parsePOSCAR(mposcar);
    let worst = 0;
    const used = new Set();
    for (let i = 0; i < frac.length; i++) {
      let best = Infinity, bj = -1;
      for (let j = 0; j < ref.frac.length; j++) {
        if (used.has(j)) continue;
        let d = 0;
        for (let k = 0; k < 3; k++) { let x = frac[i][k] - ref.frac[j][k]; x -= Math.round(x); d = Math.max(d, Math.abs(x)); }
        if (d < best) { best = d; bj = j; }
      }
      used.add(bj); worst = Math.max(worst, best);
    }
    const latErr = Math.max(...ref.lattice.flat().map((v, i) => Math.abs(v - sc.lattice.flat()[i])));
    // The normal-mode convention: sum m u^2 = Q^2.
    const uq = M.frozenDisplacement(pattern, sc.masses, 1.3, new Float64Array(sc.natom * 3));
    let s = 0; for (let j = 0; j < sc.natom; j++) s += sc.masses[j] * (uq[3 * j] ** 2 + uq[3 * j + 1] ** 2 + uq[3 * j + 2] ** 2);
    return { worst, latErr, maxU: M.maxDisplacement(u), qNorm: Math.sqrt(s) };
  }, MPOSCAR);
  H.check('frozen pattern matches phonopy MPOSCAR (2x2x2, amplitude 0.8)', mp.worst < 1e-6 && mp.latErr < 1e-9 && mp.maxU > 0.01, JSON.stringify(mp));
  H.check('normal-mode coordinate is normalised (Σ m u² = Q²)', Math.abs(mp.qNorm - 1.3) < 1e-9, `${mp.qNorm}`);

  // ---- 6. mode map with a synthetic potential -----------------------------
  // (a) harmonic surface at the phonopy frequency of a STABLE mode (R, band 3):
  //     the fit must give that frequency back.
  const harmonic = await page.evaluate(async () => {
    const S = await import('./phonon/phononSession.js');
    const M = await import('./phonon/phononMath.js');
    const { runModeMapScan } = await import('./phonon/modeMapScan.js');
    const { amplitudeGrid, thzToOmega2 } = await import('./phonon/modeMapFit.js');
    const { ingestScan } = await import('./ui/PhononPanel.js');
    const { structureShip } = await import('./state/store.js');
    const ds = S.phononState.dataset;
    const iqR = ds.qpoints.findIndex((qp) => qp.q.every((v) => Math.abs(v - 0.5) < 1e-6));
    S.selectMode(iqR, 2, { autoplay: false });
    const sc = S.phononState.supercell;
    const eq = M.cartesianPositions(sc);
    const omega2 = thzToOmega2(ds.qpoints[iqR].freqs[2]);
    // The scan hands the potential positions wrapped into the cell (as a real
    // periodic calculator expects), so a synthetic potential must measure the
    // displacement with the minimum-image convention (cubic cell here).
    const L = sc.lattice[0][0];
    const mic = (x) => x - L * Math.round(x / L);
    const runner = {
      modelInfo: { name: 'synthetic', element_list: ['Ar'] },
      compute({ positions }) {
        let e = 0;
        positions.forEach((r, j) => {
          const d = [mic(r[0] - eq[j][0]), mic(r[1] - eq[j][1]), mic(r[2] - eq[j][2])];
          e += 0.5 * omega2 * sc.masses[j] * (d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
        });
        return { total_energy: e + 3.0, energy_per_atom: (e + 3.0) / positions.length, forces: positions.map(() => [0, 0, 0]) };
      },
    };
    const rowsBefore = structureShip.container.length;
    const scan = await runModeMapScan(runner, sc, S.phononState.pattern, amplitudeGrid(-1.5, 1.5, 9));
    const mm = ingestScan(scan, { potential: 'synthetic', settings: { degree: 4, evenOnly: true } });
    return {
      fitTHz: mm.analysis.frequencyTHz, phononTHz: ds.qpoints[iqR].freqs[2], rms: mm.fit.rms,
      doubleWell: mm.analysis.isDoubleWell, nQ: mm.Q.length, hasZero: mm.Q.some((q) => q === 0),
      rowsBefore, rowsAfter: structureShip.container.length,
      lastRow: structureShip.container[structureShip.container.length - 1].fileName,
      frames: structureShip.container[structureShip.container.length - 1].structures.length,
      plotVisible: !document.getElementById('phonon-modemap-plot-wrapper').hidden,
    };
  });
  H.check('harmonic scan recovers the phonopy frequency', Math.abs(harmonic.fitTHz - harmonic.phononTHz) < 1e-6 && harmonic.rms < 1e-9 && !harmonic.doubleWell,
    `fit=${harmonic.fitTHz} phonopy=${harmonic.phononTHz} rms=${harmonic.rms}`);
  H.check('Q grid includes 0 and the scan became one trajectory row with one frame per point',
    harmonic.hasZero && harmonic.rowsAfter === harmonic.rowsBefore + 1 && harmonic.frames === harmonic.nQ && harmonic.lastRow.startsWith('modemap_synthetic_'), JSON.stringify(harmonic));
  H.check('mode-map plot card shown', harmonic.plotVisible);
  const scanFollow = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const { selectStructure } = await import('./ui/FileBrowswerPanel.js');
    const S = await import('./phonon/phononSession.js');
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const scanRow = structureShip.container.findIndex((c) => c.fileName.startsWith('modemap_'));
    selectStructure(scanRow, 3);
    const onScan = { plotsOpen: !getPanel('phononPlots').closed, available: S.phononAvailable(), atoms: fileBrowser.selectedStructure.atoms.length, playing: S.phononState.playing };
    // Put the mode-map card away and bring it back.
    const { setModeMapCardHidden } = await import('./ui/PhononPlotsPanel.js');
    setModeMapCardHidden(true);
    const hidden = document.getElementById('phonon-modemap-plot-wrapper').hidden;
    setModeMapCardHidden(false);
    const shown = !document.getElementById('phonon-modemap-plot-wrapper').hidden;
    const phononRow = structureShip.container.findIndex((c) => c.fileName.startsWith('phonon_'));
    selectStructure(phononRow, 0);
    return { onScan, hidden, shown };
  });
  H.check('a scan frame keeps the phonon windows open (row derived from the dataset)', scanFollow.onScan.plotsOpen && scanFollow.onScan.available && scanFollow.onScan.atoms === 8, JSON.stringify(scanFollow.onScan));
  H.check('the mode-map card can be put away and brought back', scanFollow.hidden && scanFollow.shown);

  // (b) double well: U = ½ω²Q² + bQ⁴ with ω² < 0 (the M-point imaginary mode).
  const dw = await page.evaluate(async () => {
    const S = await import('./phonon/phononSession.js');
    const M = await import('./phonon/phononMath.js');
    const { runModeMapScan } = await import('./phonon/modeMapScan.js');
    const { amplitudeGrid, thzToOmega2 } = await import('./phonon/modeMapFit.js');
    const { ingestScan } = await import('./ui/PhononPanel.js');
    const { structureShip } = await import('./state/store.js');
    const ds = S.phononState.dataset;
    const iqM = ds.qpoints.findIndex((qp) => Math.abs(qp.q[0] - 0.5) < 1e-6 && Math.abs(qp.q[1] - 0.5) < 1e-6 && Math.abs(qp.q[2]) < 1e-6);
    S.selectMode(iqM, 0, { autoplay: false });
    const sc = S.phononState.supercell;
    const eq = M.cartesianPositions(sc);
    const omega2 = thzToOmega2(ds.qpoints[iqM].freqs[0]); // negative
    const b = 0.02;
    const L = sc.lattice[0][0];
    const mic = (x) => x - L * Math.round(x / L);
    const runner = {
      modelInfo: { name: 'synthetic', element_list: ['Ar'] },
      compute({ positions }) {
        let q2 = 0;
        positions.forEach((r, j) => {
          const d = [mic(r[0] - eq[j][0]), mic(r[1] - eq[j][1]), mic(r[2] - eq[j][2])];
          q2 += sc.masses[j] * (d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
        });
        return { total_energy: 0.5 * omega2 * q2 + b * q2 * q2 };
      },
    };
    const rowsBefore = structureShip.container.length;
    const scan = await runModeMapScan(runner, sc, S.phononState.pattern, amplitudeGrid(-2, 2, 13));
    const mm = ingestScan(scan, { potential: 'synthetic', settings: { degree: 4, evenOnly: true } });
    const expectedQ = Math.sqrt(-omega2 / (4 * b));
    const expectedDepth = omega2 * omega2 / (16 * b);
    const mins = mm.analysis.minima.filter((m) => m.depth > 1e-9);
    // Load minimum through the panel button (the controls window is open).
    const btn = document.getElementById('phLoadMinBtn');
    const btnEnabled = btn && !btn.disabled;
    btn?.click();
    return {
      fitTHz: mm.analysis.frequencyTHz, phononTHz: ds.qpoints[iqM].freqs[0],
      doubleWell: mm.analysis.isDoubleWell, barrier: mm.analysis.barrier, expectedDepth,
      minQ: mins.map((m) => m.Q), expectedQ,
      rowsBefore, rowsAfter: structureShip.container.length, btnEnabled,
      lastRow: structureShip.container[structureShip.container.length - 1].fileName,
      // re-run replaced the scan row rather than adding a second one
      scanRows: structureShip.container.filter((c) => c.fileName.startsWith('modemap_')).length,
    };
  });
  H.check('double-well scan: imaginary fitted frequency matches phonopy', Math.abs(dw.fitTHz - dw.phononTHz) < 1e-6, `fit=${dw.fitTHz} phonopy=${dw.phononTHz}`);
  H.check('double well detected with the analytic minima and depth',
    dw.doubleWell && dw.minQ.length === 2 && dw.minQ.every((q) => Math.abs(Math.abs(q) - dw.expectedQ) < 1e-4) && Math.abs(dw.barrier - dw.expectedDepth) < 1e-8,
    JSON.stringify({ minQ: dw.minQ, expectedQ: dw.expectedQ, barrier: dw.barrier, expectedDepth: dw.expectedDepth }));
  H.check('re-running the scan replaced the previous scan row', dw.scanRows === 1, `${dw.scanRows}`);
  H.check('Load minimum adds the distorted structure as a new row', dw.btnEnabled && dw.rowsAfter === dw.rowsBefore + 1 && dw.lastRow.startsWith('phonon_min_'), dw.lastRow);

  // ---- 6c. the mode map's own supercell + units + labels -------------------
  const extra = await page.evaluate(async () => {
    const S = await import('./phonon/phononSession.js');
    const M = await import('./phonon/phononMath.js');
    const { parsePhonopyCells, BOHR_TO_ANGSTROM } = await import('./phonon/phonopyReader.js');
    const { runModeMapScan } = await import('./phonon/modeMapScan.js');
    const { amplitudeGrid } = await import('./phonon/modeMapFit.js');
    const { ingestScan } = await import('./ui/PhononPanel.js');
    const { structureShip } = await import('./state/store.js');
    const ds = S.phononState.dataset;
    // Scan supercell independent of the displayed 2x2x2: X = (0.5, 0, 0) only needs 2x1x1.
    const iqX = ds.qpoints.findIndex((qp) => Math.abs(qp.q[0] - 0.5) < 1e-6 && Math.abs(qp.q[1]) < 1e-6 && Math.abs(qp.q[2]) < 1e-6);
    S.selectMode(iqX, 0, { autoplay: false });
    const auto = document.getElementById('phScanDimsAuto');
    const dimsShown = ['phScanDim1', 'phScanDim2', 'phScanDim3'].map((id) => Number(document.getElementById(id).value));
    const dims = [2, 1, 1];
    const sc = M.buildSupercell(ds.cell, dims);
    const eig = S.selectedEigenvector();
    const pattern = M.modePattern(sc, ds.qpoints[iqX].q, eig, 0);
    const runner = { modelInfo: { element_list: ['Ar'] }, compute({ positions }) { return { total_energy: positions.length * 0.1 }; } };
    const scan = await runModeMapScan(runner, sc, pattern, amplitudeGrid(-1, 1, 5));
    const mm = ingestScan(scan, { potential: 'synthetic', settings: { degree: 2, evenOnly: true }, supercell: sc, pattern, dims });
    // The re-run replaced the earlier scan row in place, so look it up by name.
    const row = structureShip.container.find((c) => c.fileName.startsWith('modemap_'));
    // Units: phonopy.yaml from a QE run declares Bohr; forcing Bohr scales the cell.
    const qe = parsePhonopyCells('phonopy:\n  version: "4.4.0"\n  calculator: qe\n\nphysical_unit:\n  atomic_mass: "AMU"\n  length: "au"\n\nunit_cell:\n  lattice:\n  - [ 10.2, 0, 0 ]\n  - [ 0, 10.2, 0 ]\n  - [ 0, 0, 10.2 ]\n  points:\n  - symbol: Si # 1\n    coordinates: [ 0, 0, 0 ]\n    mass: 28.0855\n');
    const vasp = parsePhonopyCells('phonopy:\n  version: "4.4.0"\n\nphysical_unit:\n  atomic_mass: "AMU"\n  length: "angstrom"\n\nunit_cell:\n  lattice:\n  - [ 5, 0, 0 ]\n  - [ 0, 5, 0 ]\n  - [ 0, 0, 5 ]\n  points:\n  - symbol: Si # 1\n    coordinates: [ 0, 0, 0 ]\n    mass: 28.0855\n');
    const a0 = ds.cell.lattice[0][0];
    S.setLengthUnit('bohr');
    const aBohr = S.phononState.dataset.cell.lattice[0][0];
    const shownA = S.phononState.structure.lattice[0][0];
    S.setLengthUnit('auto');
    const aBack = S.phononState.dataset.cell.lattice[0][0];
    return {
      autoOn: auto.checked, dimsShown, scanAtoms: mm.supercell.natom, frames: row.frameCount,
      rowName: row.fileName, mmDims: mm.dims,
      qeUnit: qe.lengthUnit, qeCalc: qe.calculator, vaspUnit: vasp.lengthUnit,
      a0, aBohr, ratio: aBohr / a0, bohr: BOHR_TO_ANGSTROM, shownA, aBack,
      labels: [S.prettyLabel('$\\Gamma$'), S.prettyLabel('$\\mathrm{P}_0$'), S.prettyLabel('X_1'), S.prettyLabel('$\\mathrm{P}_0$', { html: true }), S.prettyLabel('$\\Sigma_{0}$')],
    };
  });
  H.check('scan supercell auto-follows the mode (X needs 2x1x1)', extra.autoOn && JSON.stringify(extra.dimsShown) === '[2,1,1]', JSON.stringify(extra.dimsShown));
  H.check('scan ran in its own 2x1x1 supercell (2 atoms) while 2x2x2 is displayed', extra.scanAtoms === 2 && extra.rowName.endsWith('_2x1x1') && extra.frames === 5 && JSON.stringify(extra.mmDims) === '[2,1,1]', JSON.stringify(extra));
  H.check('QE phonopy.yaml declares Bohr, VASP-style declares Å', extra.qeUnit === 'bohr' && extra.qeCalc === 'qe' && extra.vaspUnit === 'angstrom', JSON.stringify([extra.qeUnit, extra.vaspUnit]));
  H.check('forcing Bohr scales the cell by a0 and the shown structure follows', Math.abs(extra.ratio - extra.bohr) < 1e-12 && Math.abs(extra.shownA - 2 * extra.aBohr) < 1e-9 && Math.abs(extra.aBack - extra.a0) < 1e-12,
    JSON.stringify({ a0: extra.a0, aBohr: extra.aBohr, shownA: extra.shownA, aBack: extra.aBack }));
  H.check('LaTeX labels render as text and HTML', JSON.stringify(extra.labels) === JSON.stringify(['Γ', 'P₀', 'X₁', 'P<sub>0</sub>', 'Σ₀']), JSON.stringify(extra.labels));

  // ---- 7. export bundle ----------------------------------------------------
  const zip = await page.evaluate(async () => {
    const S = await import('./phonon/phononSession.js');
    const M = await import('./phonon/phononMath.js');
    const { frozenGeometries } = await import('./phonon/modeMapScan.js');
    const { buildZip, crc32 } = await import('./utils/zipWriter.js');
    const mm = S.phononState.modeMap;
    const sc = mm.supercell;
    const geoms = frozenGeometries(sc, mm.pattern, mm.Q);
    const poscar = M.toPOSCAR('test', sc.lattice, sc.species, geoms[0].frac);
    const back = M.parsePOSCAR(poscar);
    const bytes = buildZip([{ name: 'structures/POSCAR-000', data: poscar }, { name: 'mode_map.csv', data: 'a,b\n1,2\n' }]);
    const sig = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
    return { n: geoms.length, species: back.species.length, sig, len: bytes.length, crcHello: crc32(new TextEncoder().encode('hello')) };
  });
  H.check('export geometries round-trip through POSCAR and pack into a zip', zip.n === 5 && zip.species === 2 && zip.sig && zip.len > 100, JSON.stringify(zip));
  H.check('CRC32 is correct ("hello" = 0x3610a686)', zip.crcHello === 0x3610a686, zip.crcHello.toString(16));

  await H.shotCanvas(page, 'phonon-modemap');
  // Plotly comes from esm.sh (utils/plotlyLoader.js); in an offline sandbox the
  // fetch fails and the plot cards show the offline message instead — that
  // resource error is not a defect of this feature (same filter as rowstepjump).
  const real = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real[0] || '');
  await H.finish(browser);
})().catch(H.crash);
