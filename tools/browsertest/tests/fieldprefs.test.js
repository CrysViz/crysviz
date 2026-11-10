// Per-structure persistence of the volumetric-field settings (issue #18,
// ui/FieldPanel.js 'fieldIso' + 'fieldMaterial'): a synthetic Cube field is
// attached to the boot default structure the way the app attaches one
// (fieldBrowser.setCatalog -> setActiveField -> updateField), the iso value is
// typed, the absolute toggle flipped, a colour and the opacity changed through
// the Field window, reload, the same field attached again: everything comes
// back (field + widgets). Then "Clear local data", run the programmatic apply
// paths, reload: nothing comes back.
'use strict';
const H = require('../harness');

const KEY = 'crysviz.structurePrefs.v1';

// Build the Gaussian blob field (source 'Cube', label 'TestBlob') and attach it
// to the selected structure like parseCubeFile/adoptEagerFieldContainer does.
const ATTACH = async () => {
  const { Field, FieldContainer } = await import('./model/index.js');
  const { fileBrowser } = await import('./state/store.js');
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const { setActiveField, updateField, revealFieldPanelForCurrentStructure } = await import('./render/index.js');
  const structure = fileBrowser.selectedStructure;
  const lat = structure.lattice;
  const n = 16;
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

const STATE = async () => {
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const { groups } = await import('./state/store.js');
  const { getIsosurfaceMaterialSettings } = await import('./model/index.js');
  const f = fieldBrowser.selectedField;
  const hex = (id) => document.querySelectorAll(`#${id} .cv-colorpicker-input-field`)[1]?.value?.toLowerCase() ?? null;
  return {
    iso: f?.isoValue ?? null,
    abs: f?.useAbsoluteIsoValue ?? null,
    activeIsSelected: !!f && groups.activeField === f,
    mat: getIsosurfaceMaterialSettings(),
    meshColor: groups.isosurfaceGroup?.meshes?.positive?.material?.color?.getHexString?.() ?? null,
    meshOpacity: groups.isosurfaceGroup?.meshes?.positive?.material?.opacity ?? null,
    isoBox: document.getElementById('isoValue')?.value ?? null,
    absBox: document.getElementById('FieldAbsoluteValueToggle')?.checked ?? null,
    opacitySlider: document.getElementById('FieldOpacitySlider')?.value ?? null,
    posHex: hex('FieldPosColorPicker'),
    negHex: hex('FieldNegColorPicker'),
    stored: localStorage.getItem('crysviz.structurePrefs.v1'),
  };
};

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
  await page.evaluate((k) => localStorage.removeItem(k), KEY);

  await page.evaluate(ATTACH);
  await page.waitForTimeout(500);
  const base = await page.evaluate(STATE);
  H.check('field attached, panel built, defaults', base.activeIsSelected && base.iso === 0.5
    && base.abs === false && base.isoBox === '5.000e-1' && base.mat.opacity === 0.6
    && base.posHex === '#33aaff' && !base.stored, JSON.stringify(base));

  // ---- user edits through the Field window ----------------------------------
  await page.evaluate(() => {
    const box = document.getElementById('isoValue');
    box.value = '0.25';
    box.dispatchEvent(new Event('change'));
  });
  await H.clickById(page, 'FieldAbsoluteValueToggle');
  await page.evaluate(() => {
    const hex = document.querySelectorAll('#FieldPosColorPicker .cv-colorpicker-input-field')[1];
    hex.value = '#123456';
    hex.dispatchEvent(new Event('change'));
  });
  await H.setSlider(page, 'FieldOpacitySlider', 0.33);
  await page.waitForTimeout(700);
  const edited = await page.evaluate(STATE);
  const rec = Object.values(JSON.parse(edited.stored || '{}'))[0] || {};
  H.check('iso + abs stored under source|label', JSON.stringify(rec.fieldIso)
    === JSON.stringify({ 'Cube|TestBlob': { isoValue: 0.25, abs: true } }), JSON.stringify(rec));
  H.check('only the changed material keys stored', JSON.stringify(rec.fieldMaterial)
    === JSON.stringify({ positiveColor: '#123456', opacity: 0.33 }), JSON.stringify(rec));

  // ---- reload: attach the same field again -> restored -----------------------
  await reload(page);
  await page.evaluate(ATTACH);
  await page.waitForTimeout(600);
  const back = await page.evaluate(STATE);
  H.check('iso value and absolute flag restored on the field', back.iso === 0.25 && back.abs === true,
    JSON.stringify({ ...back, stored: undefined }));
  H.check('iso widgets restored', back.isoBox === '2.500e-1' && back.absBox === true,
    JSON.stringify({ ...back, stored: undefined }));
  H.check('material restored (settings + mesh)', back.mat.positiveColor === '#123456'
    && back.mat.negativeColor === '#ff3333' && Math.abs(back.mat.opacity - 0.33) < 1e-9
    && back.meshColor === '123456' && Math.abs(back.meshOpacity - 0.33) < 1e-6,
    JSON.stringify({ ...back, stored: undefined }));
  H.check('material widgets restored', back.posHex === '#123456' && back.negHex === '#ff3333'
    && Math.abs(parseFloat(back.opacitySlider) - 0.33) < 1e-9, JSON.stringify({ ...back, stored: undefined }));
  H.check('the restore itself wrote nothing new', back.stored === edited.stored, String(back.stored).slice(0, 300));

  // ---- Clear local data, programmatic paths, reload: nothing comes back -----
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('settings').expand();
  });
  await page.waitForTimeout(300);
  await H.clickById(page, 'clearLocalDataButton');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const { fileBrowser, groups } = await import('./state/store.js');
    const { fieldBrowser, restoreFieldPrefs } = await import('./ui/FieldPanel.js');
    const { setActiveField, updateField } = await import('./render/index.js');
    const { applyMaterialSettingsToStoredIsosurfaces, getIsosurfaceMaterialSettings } = await import('./model/index.js');
    const { getContainerForStructure } = await import('./state/structures.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { selectLastAddedRow } = await import('./ui/FileBrowswerPanel.js');
    const s = fileBrowser.selectedStructure;
    fieldBrowser.setSelectedField(0);
    setActiveField(fieldBrowser.selectedField);
    updateField(0.3);
    applyMaterialSettingsToStoredIsosurfaces(groups.isosurfaceGroup, getIsosurfaceMaterialSettings());
    restoreFieldPrefs(getContainerForStructure(s), s);
    updateVisualization({ reRenderAtoms: true, reRenderField: true });
    selectLastAddedRow();
  });
  await page.waitForTimeout(700);
  const afterClear = await page.evaluate((k) => localStorage.getItem(k), KEY);
  H.check('nothing written back after clear + programmatic applies',
    !afterClear || !/fieldIso|fieldMaterial/.test(afterClear), String(afterClear).slice(0, 300));

  await reload(page);
  await page.evaluate(ATTACH);
  await page.waitForTimeout(600);
  const cleared = await page.evaluate(STATE);
  H.check('after clear + reload the field starts at its own values', cleared.iso === 0.5
    && cleared.abs === false && cleared.isoBox === '5.000e-1' && cleared.absBox === false,
    JSON.stringify({ ...cleared, stored: undefined }));
  H.check('after clear + reload the material is the default', cleared.mat.positiveColor === '#33aaff'
    && cleared.mat.opacity === 0.6 && cleared.posHex === '#33aaff', JSON.stringify({ ...cleared, stored: undefined }));
  H.check('no fieldIso/fieldMaterial record left', !cleared.stored || !/fieldIso|fieldMaterial/.test(cleared.stored),
    String(cleared.stored).slice(0, 300));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
