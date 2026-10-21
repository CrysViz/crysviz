// "Clear local data" (Settings window, ui/panels/defaultPanels.js ->
// state/structurePrefs.js clearLocalData) must remove EVERYTHING the app keeps
// in this browser, and nothing may come back without a new user edit.
//
// 1. The registered per-structure fields are exactly the known list: a new
//    field must be added here (and set below) so this test keeps covering it.
// 2. Every field is set through the real UI on the boot default structure,
//    arrows on an inline OUTCAR trajectory; plus the app-level blobs (panel
//    layout, theme, Custom User Settings). Each one lands in localStorage.
// 3. The real button empties localStorage; then every programmatic apply path
//    (debounce windows, frame steps, row re-selection, rebuilds, arrow/field/
//    plane/focus redraws, a window resize, the pagehide flush) runs without a
//    user edit and must leave it empty.
// 4. After a reload and the same loads, every quantity is at its default.
'use strict';
const H = require('../harness');

const KEY = 'crysviz.structurePrefs.v1';
const FIELDS = [
  'colors', 'focusRegions', 'fieldIso', 'fieldMaterial', 'planes', 'spinStyle', 'forceStyle',
  'atomSize', 'bondRadius', 'atomRadiusScales', 'bondCategoryStyles', 'bondUserStyles', 'bondLengths',
  'supercell', 'periodicBounds',
].sort();

// Same fixture as arrowprefs.test.js: two ionic steps, Fe + O, spins + forces.
const STEP = (oX, toten) => [
  '  direct lattice vectors                 reciprocal lattice vectors',
  '     4.000000000  0.000000000  0.000000000     0.250000000  0.000000000  0.000000000',
  '     0.000000000  4.000000000  0.000000000     0.000000000  0.250000000  0.000000000',
  '     0.000000000  0.000000000  4.000000000     0.000000000  0.000000000  0.250000000',
  '',
  ' magnetization (x)',
  ' ',
  '# of ion       s       p       d       tot',
  '------------------------------------------',
  '    1        0.010   0.020   2.170   2.200',
  '    2        0.000   0.300   0.000   0.300',
  '--------------------------------------------------',
  'tot          0.010   0.320   2.170   2.500',
  '',
  ' POSITION                                       TOTAL-FORCE (eV/Angst)',
  ' -----------------------------------------------------------------------------------',
  '      0.00000      0.00000      0.00000         0.800000      0.100000      0.000000',
  `      ${oX.toFixed(5)}      2.00000      2.00000        -0.300000      0.000000      0.200000`,
  ' -----------------------------------------------------------------------------------',
  '    total drift:                                0.000000      0.000000      0.000000',
  '',
  `  free  energy   TOTEN  =      ${toten.toFixed(8)} eV`,
  '',
];
const OUTCAR = [
  ' vasp.6.4.2 20Jul23 complex',
  ' POTCAR:    PAW_PBE Fe 06Sep2000',
  ' POTCAR:    PAW_PBE O 08Apr2002',
  '   ions per type =               1   1',
  '',
  ...STEP(2.0, -10.0), ...STEP(1.9, -11.0),
].join('\n');

// Gaussian-blob Cube field 'TestBlob' attached to the selected structure the
// way a field file is (fieldprefs.test.js).
const ATTACH = async () => {
  const { Field, FieldContainer } = await import('./model/index.js');
  const { fileBrowser } = await import('./state/store.js');
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const { setActiveField, updateField, revealFieldPanelForCurrentStructure } = await import('./render/index.js');
  const structure = fileBrowser.selectedStructure;
  const lat = structure.lattice;
  const n = 12;
  const values = new Float32Array(n * n * n);
  const c = (n - 1) / 2;
  let maxV = 0;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = Math.exp(-((i - c) ** 2 + (j - c) ** 2 + (k - c) ** 2) / 18);
    values[i + n * (j + n * k)] = v;
    if (v > maxV) maxV = v;
  }
  const voxel = lat.map((row) => row.map((x) => x / n));
  const field = new Field({
    nx: n, ny: n, nz: n, origin: [0, 0, 0], voxel, values, label: 'TestBlob',
    isoValue: 0.5, minValue: 0, maxValue: maxV, absMinValue: 0, absMaxValue: maxV,
    useAbsoluteIsoValue: null, isVisible: true,
  });
  structure.volumetricFields = new FieldContainer({ fileName: 'blob.cube', source: 'Cube', fields: [field] });
  fieldBrowser.setCatalog(structure.volumetricFields.catalog);
  setActiveField(fieldBrowser.selectedField);
  updateField();
  revealFieldPanelForCurrentStructure();
};

// Everything per-structure on the default structure (field attached).
const DSTATE = async () => {
  const { general, fileBrowser } = await import('./state/store.js');
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const { getIsosurfaceMaterialSettings } = await import('./model/index.js');
  const { getFocusRegions } = await import('./render/FocusRegionModule.js');
  const s = fileBrowser.selectedStructure;
  const f = fieldBrowser.selectedField;
  const styled = (store) => Object.values(store ?? {}).filter((e) => e && Object.keys(e).some((k) => k !== 'elements')).length;
  const b = general.periodicBounds || {};
  return {
    atoms: s?.atoms?.length ?? 0,
    supercell: [s?.supercell?.nx ?? 1, s?.supercell?.ny ?? 1, s?.supercell?.nz ?? 1].join('x'),
    bounds: ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'].map((k) => b[k] ?? null).join(','),
    colors: (s?.atoms ?? []).filter((a) => a.userColor != null).length,
    focusRegions: getFocusRegions(s).length,
    planes: (s?.planes ?? []).length,
    atomSize: general.atomSize,
    bondRadius: general.bondRadius,
    radiusScales: (s?.atoms ?? []).filter((a) => Math.abs(a.getRadiusScale() - 1) > 1e-9).length,
    bondCat: styled(s?.bondCategoryStyles),
    bondUser: styled(s?.bondUserStyles),
    cn: JSON.stringify(general.bondLengths?.['C-N'] ?? null),
    iso: f?.isoValue ?? null,
    abs: f?.useAbsoluteIsoValue ?? null,
    mat: JSON.stringify(getIsosurfaceMaterialSettings()),
  };
};

// The arrow settings (global general.* + the OUTCAR frame's overrides).
const ASTATE = async () => {
  const { general, fileBrowser } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const keys = ['spinScale', 'spinRadius', 'spinTipLength', 'spinLengthLogScale', 'spinColorMap', 'spinColorScale',
    'spinMin', 'spinMax', 'spinLegendText', 'forceScale', 'forceRadius', 'forceColorMap', 'forceColorScale',
    'forceMin', 'forceMax', 'forceLengthLogScale', 'forceLegendText'];
  const g = {};
  for (const k of keys) g[k] = general[k] ?? null;
  return {
    g,
    spinCat: Object.keys(s?.spinCategoryStyles ?? {}).length,
    forceCat: Object.keys(s?.forceCategoryStyles ?? {}).length,
    spins: s?.spins?.length ?? 0,
    forces: s?.forces?.length ?? 0,
  };
};

const storageSnapshot = () => {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return { length: localStorage.length, keys: keys.sort() };
};

async function waitDefault(page) {
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return (fileBrowser.selectedStructure?.atoms?.length ?? 0) > 0;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(1500);
}

async function expandPanel(page, id) {
  await page.evaluate(async (id) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel(id).expand();
  }, id);
  await page.waitForTimeout(300);
}

async function openTab(page, mode) {
  await page.evaluate(async (mode) => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const btn = [...document.querySelectorAll('.segmented-control button, button')].find((b) => b.dataset.mode === mode);
    btn?.click();
  }, mode);
  await page.waitForTimeout(400);
}

async function loadOutcar(page) {
  await page.evaluate(async (text) => {
    const { general } = await import('./state/store.js');
    general.spinsActive = true;
    general.forcesActive = true;
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(text, 'OUTCAR');
  }, OUTCAR);
  await page.waitForTimeout(1500);
  await expandPanel(page, 'spins');
  await expandPanel(page, 'forces');
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await page.evaluate((k) => localStorage.removeItem(k), KEY);

  // ---- a. the registry is exactly the known list ----------------------------
  const registered = await page.evaluate(async () => {
    const { registeredStructurePrefFields } = await import('./state/structurePrefs.js');
    return registeredStructurePrefFields();
  });
  H.check('registered structurePrefs fields are exactly the known 15 (extend this test for a new one)',
    JSON.stringify([...registered].sort()) === JSON.stringify(FIELDS), JSON.stringify([...registered].sort()));

  // ---- baseline on the default structure ------------------------------------
  await expandPanel(page, 'cell');
  await page.evaluate(ATTACH);
  await page.waitForTimeout(500);
  const base = await page.evaluate(DSTATE);
  H.check('baseline default structure', base.atoms > 0 && base.iso === 0.5 && base.planes === 0
    && base.colors === 0 && base.cn !== 'null', JSON.stringify(base));

  // ---- b. set every field through the UI ------------------------------------
  // Cell boundary (a-max typed) + supercell 2x1x1 (Apply), cellprefs.test.js.
  await page.evaluate(() => {
    const ends = document.querySelectorAll('#periodicBoundaryContent .pbnd-end');
    ends[1].value = '1.5';
    ends[1].dispatchEvent(new Event('change'));
    const inputs = document.querySelectorAll('.lsc-supercell-input');
    inputs[0].value = '2';
    [...document.querySelectorAll('#supercellContent button')].find((b) => b.textContent === 'Apply').click();
  });
  await page.waitForTimeout(800);

  // Atom colour, the two writes every colour editor makes.
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { saveAtomColors } = await import('./utils/ColorModule.js');
    const atom = fileBrowser.selectedStructure.atoms[1];
    atom.userColor = '#ff00ff';
    atom.setColor('#ff00ff');
    saveAtomColors();
  });

  // Sizes (sizeprefs.test.js): sliders, element size, bond category size, C-N cutoff.
  await H.setSlider(page, 'atomSize', 0.6);
  await H.setSlider(page, 'bondWidth', 0.5);
  await openTab(page, 'atoms');
  const elemEdit = await page.evaluate(() => {
    const editor = document.querySelector('#composition .element-color-editor');
    const row = [...(editor?.querySelectorAll('.si-row') ?? [])].find((r) => r.querySelector('.si-row-label')?.textContent === 'Size');
    const slider = row?.querySelector('input[type="range"]');
    if (!slider) return false;
    slider.value = '1.7';
    slider.dispatchEvent(new Event('input'));
    return true;
  });
  await openTab(page, 'bonds');
  const bondEdit = await page.evaluate(() => {
    const control = document.querySelector('.bond-control[data-pair="C-N"]');
    const row = [...(control?.querySelectorAll('.bond-cat-editor .bond-cat-row') ?? [])]
      .find((r) => r.querySelector('.bond-cat-row-label')?.textContent === 'Size');
    const size = row?.querySelector('input[type="range"]');
    const range = control?.querySelectorAll('.bond-range-slider input[type="range"]');
    if (!size || range?.length !== 2) return false;
    size.value = '2';
    size.dispatchEvent(new Event('input'));
    range[1].value = '1.5';
    range[1].dispatchEvent(new Event('input'));
    return true;
  });
  await page.waitForTimeout(800); // bond rebuild after the cutoff change
  // Per-bond size through an individual bond row's editor (Bonds tab row).
  const bondRowEdit = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { createIndividualBondRow } = await import('./ui/StructureInfoPanel/components/IndividualBondRow.js');
    const s = fileBrowser.selectedStructure;
    if (!s.bonds?.length) return false;
    const row = createIndividualBondRow(s.bonds[0], 0);
    document.body.appendChild(row);
    const sizeRow = [...row.querySelectorAll('.bond-color-editor .si-row')]
      .find((r) => r.querySelector('.si-row-label')?.textContent === 'Size');
    const slider = sizeRow?.querySelector('input[type="range"]');
    if (slider) {
      slider.value = '1.8';
      slider.dispatchEvent(new Event('input'));
    }
    row.remove();
    return !!slider;
  });
  H.check('size editors found (element, bond category/range, individual bond)',
    elemEdit && bondEdit && bondRowEdit, JSON.stringify({ elemEdit, bondEdit, bondRowEdit }));

  // Focus region created from an atom (the panel's create action).
  await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const focus = await import('./render/FocusRegionModule.js');
    const w = fileBrowser.selectedStructure.periodic.visibleWrapped;
    focus.createFocusRegion([{ sourceIndex: w.srcIndex[0], element: w.elements[0], position: w.cart[0] }]);
  });

  // Field iso value / colour / opacity through the Field window (on the supercell).
  await page.evaluate(ATTACH);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const box = document.getElementById('isoValue');
    box.value = '0.25';
    box.dispatchEvent(new Event('change'));
    const hex = document.querySelectorAll('#FieldPosColorPicker .cv-colorpicker-input-field')[1];
    hex.value = '#123456';
    hex.dispatchEvent(new Event('change'));
  });
  await H.setSlider(page, 'FieldOpacitySlider', 0.33);

  // Crystal plane bound to the field with a colormap (planesprefs.test.js).
  await expandPanel(page, 'planes');
  await H.clickById(page, 'addPlaneBtn');
  await H.setSelect(page, 'planesFieldSelect', 'TestBlob');
  await H.setSelect(page, 'planesColormapSelect', 'viridis');
  await page.waitForTimeout(700);
  const editedDefault = await page.evaluate(DSTATE);

  // Arrows on a second structure (the OUTCAR trajectory).
  await loadOutcar(page);
  const arrowBase = await page.evaluate(ASTATE);
  H.check('OUTCAR fixture has spins and forces', arrowBase.spins === 2 && arrowBase.forces === 2,
    JSON.stringify(arrowBase));
  await H.setSlider(page, 'spinLengthSlider', 2.5);
  await H.setSelect(page, 'spinColorMapSelect', 'viridis');
  await H.setSlider(page, 'forceScaleSlider', 3);
  await H.setSelect(page, 'forceColorMapSelect', 'jet');
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const { flushPendingStructurePrefSaves } = await import('./state/structurePrefs.js');
    flushPendingStructurePrefSaves();
  });

  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), KEY);
  const records = Object.values(stored);
  const union = new Set(records.flatMap((r) => Object.keys(r)));
  const missing = FIELDS.filter((f) => !union.has(f));
  H.check('two structure records stored (default + OUTCAR)', records.length === 2,
    JSON.stringify(records.map((r) => [r.name, Object.keys(r)])));
  H.check('every registered field is stored', missing.length === 0,
    `missing: ${missing.join(', ') || 'none'}; edited=${JSON.stringify(editedDefault)}`);

  // ---- c. the other app-level blobs -----------------------------------------
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('planes').collapse(); // layout change -> 'panelLayout'
    const { applyTheme } = await import('./ui/ThemeManager.js');
    applyTheme(undefined, 'dark');
  });
  // Custom User Settings radius override (customusersettings.test.js).
  await expandPanel(page, 'customSettings');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#cvPanelBody-customSettings button')]
      .filter((b) => b.textContent.trim() === 'Configure via Periodic Table')[1];
    btn.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('.cv-cus-popup button[data-symbol="O"]').click());
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const input = document.querySelector('.cv-cus-popup .radius-preview-input');
    input.value = '1.23';
    input.dispatchEvent(new Event('input'));
  });
  await page.click('.cv-cus-popup .radius-preview-apply');
  await page.waitForTimeout(150);
  await page.click('.cv-cus-popup .cv-cus-close-btn');
  await page.waitForTimeout(600); // past the layout-save debounce

  const before = await page.evaluate(storageSnapshot);
  console.log(`  localStorage keys before the clear: ${before.keys.join(', ')}`);
  const wanted = [KEY, 'panelLayout', 'crysvizCustomUserSettings'];
  H.check('app-level blobs present before the clear (structurePrefs, layout, custom settings, theme)',
    wanted.every((k) => before.keys.includes(k)) && before.keys.length >= wanted.length + 1,
    JSON.stringify(before.keys));

  // ---- d. the real button ------------------------------------------------------
  await expandPanel(page, 'settings'); // schedules a layout save the clear must cancel
  await H.clickById(page, 'clearLocalDataButton');
  const right = await page.evaluate(storageSnapshot);
  H.check('localStorage empty right after the click', right.length === 0, JSON.stringify(right.keys));

  // ---- e. programmatic paths, no user edit -------------------------------------
  const groupsRun = [
    ['debounce windows (600 ms)', async () => {}],
    ['trajectory frame steps (showTrajectoryFrame / applyFrameFast)', async () => {
      const { fileBrowser, structureShip } = await import('./state/store.js');
      const { showTrajectoryFrame } = await import('./ui/TrajectoryPanel.js');
      const { applyFrameFast } = await import('./render/FastFrameModule.js');
      const container = structureShip.container[fileBrowser.selectedRowIndex];
      showTrajectoryFrame(1, container);
      await new Promise((r) => setTimeout(r, 200));
      applyFrameFast(container.structures[0]);
      showTrajectoryFrame(0, container);
      applyFrameFast(fileBrowser.selectedStructure);
    }],
    ['row re-selection (selectStructure / selectLastAddedRow)', async () => {
      const { structureShip } = await import('./state/store.js');
      const { selectStructure, selectLastAddedRow } = await import('./ui/FileBrowswerPanel.js');
      for (let i = 0; i < structureShip.container.length; i++) {
        selectStructure(i);
        await new Promise((r) => setTimeout(r, 300));
      }
      selectLastAddedRow();
    }],
    ['arrow redraws (updateSpins / updateForces / rebuildPanel)', async () => {
      const { general } = await import('./state/store.js');
      const { updateSpins, updateForces } = await import('./render/index.js');
      const { rebuildPanel } = await import('./ui/panels/PanelManager.js');
      updateSpins(general.spinScale, false, [], general.spinColorMap);
      updateForces();
      rebuildPanel('spins');
      rebuildPanel('forces');
    }],
    ['default structure: updateVisualization / rebuildBonds', async () => {
      const { selectStructure } = await import('./ui/FileBrowswerPanel.js');
      const { updateVisualization } = await import('./core/crystal-viewer.js');
      const { rebuildBonds } = await import('./render/index.js');
      selectStructure(0);
      await new Promise((r) => setTimeout(r, 300));
      updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderPeriodic: true });
      rebuildBonds();
    }],
    ['field / planes / focus applies', async () => {
      const { fileBrowser } = await import('./state/store.js');
      const { fieldBrowser } = await import('./ui/FieldPanel.js');
      const { setActiveField, updateField } = await import('./render/index.js');
      const { syncPlanesForSelectedStructure, applyPlanesPeriodicBounds } = await import('./ui/PlanesPanel.js');
      const { applyFocusRegions } = await import('./render/FocusRegionModule.js');
      const s = fileBrowser.selectedStructure;
      const vf = s.volumetricFields;
      if (vf && !fieldBrowser.selectedField) fieldBrowser.setCatalog(vf.catalog);
      const field = fieldBrowser.selectedField ?? vf?.fields?.[0];
      if (field) setActiveField(field);
      updateField();
      syncPlanesForSelectedStructure();
      applyPlanesPeriodicBounds();
      applyFocusRegions();
    }],
  ];
  const writers = [];
  for (const [name, fn] of groupsRun) {
    await page.evaluate(fn);
    await page.waitForTimeout(600);
    const snap = await page.evaluate(storageSnapshot);
    if (snap.length) writers.push(`${name}: ${snap.keys.join(',')}`);
    H.check(`still empty after ${name}`, snap.length === 0, JSON.stringify(snap.keys));
  }
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  let snap = await page.evaluate(storageSnapshot);
  H.check('still empty after a window resize', snap.length === 0, JSON.stringify(snap.keys));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(300);
  snap = await page.evaluate(storageSnapshot);
  H.check('still empty after pagehide (the flush hook)', snap.length === 0, JSON.stringify(snap.keys));
  if (writers.length) console.log(`  writers after clear: ${writers.join(' | ')}`);

  // ---- f. reload: everything at default ---------------------------------------
  await page.reload({ waitUntil: 'load' });
  await waitDefault(page);
  await expandPanel(page, 'cell');
  await page.evaluate(ATTACH);
  await page.waitForTimeout(600);
  const after = await page.evaluate(DSTATE);
  const diff = Object.keys(base).filter((k) => JSON.stringify(base[k]) !== JSON.stringify(after[k]));
  H.check('default structure: every quantity back at its default', diff.length === 0,
    `differs: ${diff.map((k) => `${k} ${JSON.stringify(base[k])} -> ${JSON.stringify(after[k])}`).join('; ') || 'none'}`);
  await loadOutcar(page);
  const arrowsAfter = await page.evaluate(ASTATE);
  H.check('OUTCAR: arrow settings back at their defaults',
    JSON.stringify(arrowsAfter) === JSON.stringify(arrowBase),
    JSON.stringify({ before: arrowBase, after: arrowsAfter }));
  const finalStore = await page.evaluate((k) => localStorage.getItem(k), KEY);
  H.check('no structurePrefs record after reload + loads', !finalStore || finalStore === '{}',
    String(finalStore).slice(0, 300));

  // ---- g. ----------------------------------------------------------------------
  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
