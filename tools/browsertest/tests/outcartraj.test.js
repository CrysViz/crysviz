// Regression: a multi-step VASP OUTCAR must load. Since the trajectory rework
// a multi-frame file comes back as a TrajectoryContainer whose `structures`
// is a SPARSE array (no slot is occupied until a frame is first shown), and
// the load path's "did anything load" guard in core/crystal-viewer.js indexed
// that array with `.some(...)`, which skips holes — so every good relaxation
// or MD OUTCAR was rejected with "No atoms or structures were found". The
// guard now goes through the frame seam (frameCount / hasAtoms).
//
// The second check keeps the guard honest: an OUTCAR with a header but no
// ionic step must still be rejected with that message.
'use strict';
const H = require('../harness');

// Two ionic steps, 2 atoms (Na, Cl), a 4 Å cubic cell. Only the lines the
// reader keys on are present; the values are chosen so every assertion below
// pins one parsed quantity to one line of this text.
const STEP = (clX, toten) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
  '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
  '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
  '',
  ' POSITION                                       TOTAL-FORCE (eV/Angst)',
  ' -----------------------------------------------------------------------------------',
  `      0.00000      0.00000      0.00000         0.100000      0.000000      0.000000`,
  `      ${clX.toFixed(5)}      0.00000      0.00000        -0.100000      0.000000      0.000000`,
  ' -----------------------------------------------------------------------------------',
  '    total drift:                                0.000000      0.000000      0.000000',
  '',
  '  FREE ENERGIE OF THE ION-ELECTRON SYSTEM (eV)',
  '  ---------------------------------------------------',
  `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`,
  '',
  `  energy  without entropy=      ${toten.toFixed(8)}  energy(sigma->0) =      ${toten.toFixed(8)}`,
  '',
];

const HEADER = [
  ' vasp.6.4.2 20Jul23 complex',
  ' POTCAR:    PAW_PBE Na_pv 19Sep2006',
  ' POTCAR:    PAW_PBE Cl 06Sep2000',
  '   ions per type =               1   1',
  '',
];

const OUTCAR = [...HEADER, ...STEP(2.0, -10.0), ...STEP(1.9, -11.0)].join('\n');
const HEADER_ONLY = HEADER.join('\n');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async ({ good, empty }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { TrajectoryContainer } = await import('./model/index.js');

    let loadError = null;
    try { await cv.loadStructure(good, 'OUTCAR'); } catch (e) { loadError = String(e && e.message); }
    const container = structureShip.container[fileBrowser.selectedRowIndex];

    // The frame the app is displaying after the load (the live Structure).
    const shown = fileBrowser.selectedStructure;

    let emptyError = null;
    try { await cv.loadStructure(empty, 'OUTCAR.header'); } catch (e) { emptyError = String(e && e.message); }
    const modal = document.getElementById('loadErrorModal');
    const modalVisible = !!modal && !modal.hidden;
    const ok = document.getElementById('loadErrorOk');
    if (ok) ok.click();

    return {
      loadError,
      isTrajectory: container instanceof TrajectoryContainer,
      frameCount: container ? container.frameCount : -1,
      structuresLength: container ? container.structures.length : -1,
      hasAtoms: typeof container?.hasAtoms === 'function' ? container.hasAtoms() : null,
      fileName: container ? container.fileName : null,
      energies: container ? container.energySeries() : null,
      shownAtoms: shown ? shown.atoms.length : -1,
      shownElements: shown ? shown.elements.join(',') : '',
      shownForces: shown ? (shown.forces ? shown.forces.length : 0) : -1,
      clFracX: container && container.frameCount === 2
        ? [0, 1].map((i) => container.frameAt(i).atoms[1].position[0]) : null,
      emptyError,
      modalVisible,
      rowCount: structureShip.container.length,
    };
  }, { good: OUTCAR, empty: HEADER_ONLY });

  const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) < tol;

  H.check('multi-step OUTCAR loads without error', res.loadError === null, String(res.loadError));
  H.check('loaded as a TrajectoryContainer', res.isTrajectory === true, JSON.stringify(res.isTrajectory));
  H.check('2 frames', res.frameCount === 2, String(res.frameCount));
  H.check('structures array reports the frame count', res.structuresLength === 2, String(res.structuresLength));
  H.check('hasAtoms() is true', res.hasAtoms === true, String(res.hasAtoms));
  H.check('file name kept', res.fileName === 'OUTCAR', String(res.fileName));
  H.check('per-frame energies', Array.isArray(res.energies) && near(res.energies[0], -10) && near(res.energies[1], -11), JSON.stringify(res.energies));
  H.check('shown frame has 2 atoms', res.shownAtoms === 2, String(res.shownAtoms));
  H.check('shown frame elements', res.shownElements === 'Na,Cl', res.shownElements);
  H.check('shown frame carries forces', res.shownForces === 2, String(res.shownForces));
  H.check('Cl moves between frames (x: 0.5 -> 0.475)', res.clFracX && near(res.clFracX[0], 0.5) && near(res.clFracX[1], 0.475), JSON.stringify(res.clFracX));

  // The guard still rejects a file that carries no ionic step at all.
  H.check('header-only OUTCAR is rejected', /No atoms or structures/.test(res.emptyError || ''), String(res.emptyError));
  H.check('rejection shows the warning modal', res.modalVisible === true, String(res.modalVisible));
  H.check('rejected file added no row', res.rowCount === 2, String(res.rowCount)); // default structure + OUTCAR

  const unexpected = errors.filter((e) => !/OUTCAR\.header|No atoms|structure/i.test(e));
  H.check('no unexpected console/page errors', unexpected.length === 0, unexpected[0] || '');
  await H.finish(browser);
})().catch(H.crash);
