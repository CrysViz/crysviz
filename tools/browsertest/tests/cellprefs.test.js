// Per-structure persistence of the cell boundary and the supercell (issue #18,
// state/cellPrefs.js): set both through the "Cell & Supercell" window on the
// boot default structure, reload, and they come back (model + widgets), with a
// colour put on a supercell-only atom landing on the same atom. Then "Clear
// local data", run the programmatic apply paths, reload: nothing comes back.
'use strict';
const H = require('../harness');

const STATE = async () => {
  const { general, fileBrowser } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const panel = document.getElementById('periodicBoundaryContent');
  return {
    bounds: general.periodicBounds,
    showPeriodic: general.showPeriodic,
    toggle: document.getElementById('showPeriodic')?.checked ?? null,
    supercell: s?.supercell ?? null,
    atoms: s?.atoms?.length ?? 0,
    lattice0: s?.lattice?.[0] ? Math.hypot(...s.lattice[0]) : 0,
    pbnd: panel ? [...panel.querySelectorAll('.pbnd-end')].map((el) => el.value) : null,
    scInputs: [...document.querySelectorAll('.lsc-supercell-input')].map((el) => el.value),
    stored: localStorage.getItem('crysviz.structurePrefs.v1'),
  };
};

async function openCellPanel(page) {
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('cell').expand();
  });
  await page.waitForTimeout(300);
}

async function reload(page) {
  await page.reload({ waitUntil: 'load' });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return (fileBrowser.selectedStructure?.atoms?.length ?? 0) > 0;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1500);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => localStorage.removeItem('crysviz.structurePrefs.v1'));

  await openCellPanel(page);
  const base = await page.evaluate(STATE);
  H.check('boot default loaded, unit cell, 1x1x1', base.atoms > 0 && base.pbnd?.length === 6
    && base.scInputs.join() === '1,1,1', JSON.stringify({ ...base, stored: undefined }));

  // ---- boundary: a-max typed, c-min through its slider ---------------------
  await page.evaluate(() => {
    const ends = document.querySelectorAll('#periodicBoundaryContent .pbnd-end');
    ends[1].value = '1.5';
    ends[1].dispatchEvent(new Event('change'));
    const cMin = document.querySelectorAll('#periodicBoundaryContent .pbnd-range-min')[2];
    cMin.value = '-0.3';
    cMin.dispatchEvent(new Event('input'));
  });
  // ---- supercell 2x1x1 through Apply ---------------------------------------
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('.lsc-supercell-input');
    inputs[0].value = '2';
    [...document.querySelectorAll('#supercellContent button')].find((b) => b.textContent === 'Apply').click();
  });
  await page.waitForTimeout(300);
  // A colour on an atom that exists only in the supercell (second image).
  await page.evaluate(async (n) => {
    const { fileBrowser } = await import('./state/store.js');
    const { saveAtomColors } = await import('./utils/ColorModule.js');
    // The two writes every colour editor makes (ColorEditor.js).
    const atom = fileBrowser.selectedStructure.atoms[n + 1];
    atom.userColor = '#ff00ff';
    atom.setColor('#ff00ff');
    saveAtomColors();
  }, base.atoms);
  await page.waitForTimeout(600); // past the boundary save debounce

  const edited = await page.evaluate(STATE);
  const rec = Object.values(JSON.parse(edited.stored || '{}'))[0] || {};
  H.check('edits applied live', edited.atoms === 2 * base.atoms
    && edited.bounds.xmax === 1.5 && Math.abs(edited.bounds.zmin + 0.3) < 1e-9,
  JSON.stringify({ ...edited, stored: undefined }));
  H.check('stored periodicBounds + supercell', rec.supercell?.nx === 2 && rec.supercell?.ny === 1
    && rec.periodicBounds?.xmax === 1.5 && Math.abs(rec.periodicBounds?.zmin + 0.3) < 1e-9,
  JSON.stringify(rec));
  H.check('stored record count is 1 (key fixed on the base cell)',
    Object.keys(JSON.parse(edited.stored || '{}')).length === 1, edited.stored?.slice(0, 200));

  // ---- reload: everything back --------------------------------------------
  await reload(page);
  await openCellPanel(page);
  const back = await page.evaluate(STATE);
  H.check('boundary restored', back.bounds.xmax === 1.5 && Math.abs(back.bounds.zmin + 0.3) < 1e-9
    && back.bounds.xmin === 0 && back.bounds.ymax === 1, JSON.stringify(back.bounds));
  H.check('showPeriodic on + checkbox', back.showPeriodic === true && back.toggle === true);
  H.check('boundary widgets restored', back.pbnd?.[1] === '1.5' && back.pbnd?.[4] === '-0.3',
    JSON.stringify(back.pbnd));
  H.check('supercell restored', back.supercell?.nx === 2 && back.supercell?.ny === 1
    && back.supercell?.nz === 1 && back.atoms === 2 * base.atoms
    && Math.abs(back.lattice0 - 2 * base.lattice0) < 1e-6, JSON.stringify({ ...back, stored: undefined }));
  H.check('supercell inputs restored', back.scInputs.join() === '2,1,1', back.scInputs.join());
  const colour = await page.evaluate(async (n) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const wrap = s.periodic?.visibleWrapped || s.periodic?.wrapped;
    return {
      target: s.atoms[n + 1]?.userColor, baseTwin: s.atoms[1]?.userColor ?? null,
      wrappedMax: wrap ? Math.max(...wrap.srcIndex) : -1,
    };
  }, base.atoms);
  H.check('colour on a supercell-only atom restored on the same atom',
    String(colour.target).toLowerCase() === '#ff00ff' && colour.baseTwin == null, JSON.stringify(colour));
  H.check('the drawn periodic images cover the supercell', colour.wrappedMax === 2 * base.atoms - 1,
    JSON.stringify(colour));

  // ---- Clear local data, programmatic paths, reload: nothing comes back -----
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('settings').expand();
  });
  await page.waitForTimeout(300);
  await H.clickById(page, 'clearLocalDataButton');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { applyFieldPeriodicBounds } = await import('./render/Render3DFieldModule.js');
    const { applyPlanesPeriodicBounds } = await import('./ui/PlanesPanel.js');
    const { selectLastAddedRow } = await import('./ui/FileBrowswerPanel.js');
    const { refreshPeriodicBoundaryControls } = await import('./ui/LatticeSupercellPanel.js');
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPeriodic: true, reRenderLattice: true });
    applyFieldPeriodicBounds();
    applyPlanesPeriodicBounds();
    refreshPeriodicBoundaryControls();
    selectLastAddedRow();
  });
  await page.waitForTimeout(600);
  const afterClear = await page.evaluate(() => localStorage.getItem('crysviz.structurePrefs.v1'));
  H.check('nothing written back after clear + programmatic applies', !afterClear
    || !/periodicBounds|supercell/.test(afterClear), String(afterClear).slice(0, 200));

  await reload(page);
  await openCellPanel(page);
  const cleared = await page.evaluate(STATE);
  const b = cleared.bounds || {};
  H.check('boundary back at the unit cell', (b.xmin ?? 0) === 0 && (b.xmax ?? 1) === 1
    && (b.zmin ?? 0) === 0 && (b.zmax ?? 1) === 1, JSON.stringify(b));
  H.check('supercell back at 1x1x1', cleared.atoms === base.atoms
    && cleared.scInputs.join() === '1,1,1', JSON.stringify({ ...cleared, stored: undefined }));
  H.check('no stored record with the cell fields', !cleared.stored
    || !/periodicBounds|supercell/.test(cleared.stored), String(cleared.stored).slice(0, 200));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
