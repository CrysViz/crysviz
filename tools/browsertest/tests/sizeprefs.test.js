// Per-structure persistence of the size settings (issue #18, ui/SizePrefs.js):
// Atom Size / Bond Diameter sliders, a per-element atom radius scale (Atoms
// tab element editor), a bond category size (Bonds tab category editor) and a
// customised bond-pair cutoff (Bonds tab range slider), all on the boot
// default structure. Reload -> everything back (model + widgets + bonds mesh).
// Then "Clear local data", run the programmatic paths, reload -> defaults.
'use strict';
const H = require('../harness');

const KEY = 'crysviz.structurePrefs.v1';
const FIELDS = /"(atomSize|bondRadius|atomRadiusScales|bondCategoryStyles|bondUserStyles|bondLengths)"/;

const STATE = async () => {
  const { general, fileBrowser } = await import('./state/store.js');
  const { bondKey } = await import('./render/BondsFracUpdateModule.js');
  const s = fileBrowser.selectedStructure;
  const pairOf = (b) => (b.elements[0] < b.elements[1] ? `${b.elements[0]}-${b.elements[1]}` : `${b.elements[1]}-${b.elements[0]}`);
  const cn = (s?.bonds ?? []).filter((b) => pairOf(b) === 'C-N');
  const scales = {};
  (s?.atoms ?? []).forEach((a, i) => { if (Math.abs(a.getRadiusScale() - 1) > 1e-9) scales[i] = a.getRadiusScale(); });
  return {
    atomSize: general.atomSize,
    bondRadius: general.bondRadius,
    atomSlider: document.getElementById('atomSize')?.value,
    bondSlider: document.getElementById('bondWidth')?.value,
    atomSliderDefault: document.getElementById('atomSize')?.defaultValue,
    bondSliderDefault: document.getElementById('bondWidth')?.defaultValue,
    scales,
    cat: s?.bondCategoryStyles?.['C-N'] ?? null,
    user: Object.keys(s?.bondUserStyles ?? {}).length,
    cnRange: general.bondLengths['C-N'],
    cnDefault: general.defaultBondLengths['C-N'],
    cnBonds: cn.length,
    cnRadius: cn[0]?.radius ?? null,
    cnUserKey: cn[0] ? bondKey(cn[0].indices) : null,
    stored: localStorage.getItem('crysviz.structurePrefs.v1'),
  };
};

async function openTab(page, mode) {
  await page.evaluate(async (mode) => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
    const btn = [...document.querySelectorAll('.segmented-control button, button')].find((b) => b.dataset.mode === mode);
    btn?.click();
  }, mode);
  await page.waitForTimeout(400);
}

async function reload(page) {
  await page.reload({ waitUntil: 'load' });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return (fileBrowser.selectedStructure?.atoms?.length ?? 0) > 0;
  }, { timeout: 40000, interval: 1000 });
  await page.waitForTimeout(2000);
}

const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await page.evaluate((k) => localStorage.removeItem(k), KEY);

  const base = await page.evaluate(STATE);
  H.check('boot default has C-N bonds', base.cnBonds > 0 && !!base.cnDefault, JSON.stringify({ ...base, stored: undefined }));

  // ---- global size sliders ---------------------------------------------------
  await H.setSlider(page, 'atomSize', 0.6);
  await H.setSlider(page, 'bondWidth', 0.5);

  // ---- per-element radius scale through the Atoms tab element editor -------
  await openTab(page, 'atoms');
  const elemEdit = await page.evaluate(() => {
    const editor = document.querySelector('#composition .element-color-editor');
    const row = [...(editor?.querySelectorAll('.si-row') ?? [])].find((r) => r.querySelector('.si-row-label')?.textContent === 'Size');
    const slider = row?.querySelector('input[type="range"]');
    if (!slider) return { found: false };
    slider.value = '1.7';
    slider.dispatchEvent(new Event('input'));
    return { found: true };
  });
  H.check('element size slider found', elemEdit.found, JSON.stringify(elemEdit));

  // ---- Bonds tab: category size + pair cutoff --------------------------------
  await openTab(page, 'bonds');
  const bondEdit = await page.evaluate(() => {
    const control = document.querySelector('.bond-control[data-pair="C-N"]');
    const row = [...(control?.querySelectorAll('.bond-cat-editor .bond-cat-row') ?? [])]
      .find((r) => r.querySelector('.bond-cat-row-label')?.textContent === 'Size');
    const size = row?.querySelector('input[type="range"]');
    const range = control?.querySelectorAll('.bond-range-slider input[type="range"]');
    if (!size || range?.length !== 2) return { found: false };
    size.value = '2';
    size.dispatchEvent(new Event('input'));
    range[1].value = '1.5';
    range[1].dispatchEvent(new Event('input'));
    return { found: true };
  });
  H.check('bond category size + range slider found', bondEdit.found, JSON.stringify(bondEdit));
  await page.waitForTimeout(800); // past the save debounce + bond rebuild

  const edited = await page.evaluate(STATE);
  const rec = Object.values(JSON.parse(edited.stored || '{}'))[0] || {};
  H.check('edits applied live', !near(edited.atomSize, base.atomSize) && !near(edited.bondRadius, base.bondRadius)
    && Object.keys(edited.scales).length > 0 && edited.cat?.radiusScale === 2 && near(edited.cnRange.max, 1.5) && edited.cnBonds > 0 && edited.cnBonds < base.cnBonds,
  JSON.stringify({ ...edited, stored: undefined }));
  H.check('stored all size fields', near(rec.atomSize, edited.atomSize) && near(rec.bondRadius, edited.bondRadius)
    && Object.keys(rec.atomRadiusScales || {}).length === Object.keys(edited.scales).length
    && rec.bondCategoryStyles?.['C-N']?.radiusScale === 2 && near(rec.bondLengths?.['C-N']?.max, 1.5)
    && Object.keys(rec.bondLengths || {}).length === 1 && !('bondUserStyles' in rec),
  JSON.stringify(rec));

  // ---- reload: everything back ----------------------------------------------
  await reload(page);
  const back = await page.evaluate(STATE);
  H.check('atomSize + slider restored', near(back.atomSize, edited.atomSize) && near(back.atomSlider, 0.6, 1e-3),
    JSON.stringify([back.atomSize, back.atomSlider]));
  H.check('bondRadius + slider restored', near(back.bondRadius, edited.bondRadius) && near(back.bondSlider, 0.5, 1e-3),
    JSON.stringify([back.bondRadius, back.bondSlider]));
  H.check('per-atom radius scales restored', JSON.stringify(back.scales) === JSON.stringify(edited.scales),
    JSON.stringify(back.scales));
  H.check('bond category style restored', back.cat?.radiusScale === 2, JSON.stringify(back.cat));
  H.check('C-N cutoff restored', near(back.cnRange?.max, 1.5) && near(back.cnRange?.min, edited.cnRange.min)
    && near(back.cnDefault?.max, base.cnDefault.max), JSON.stringify([back.cnRange, back.cnDefault]));
  H.check('bonds mesh reflects it (count + radius)', back.cnBonds === edited.cnBonds
    && near(back.cnRadius, back.bondRadius * 2), JSON.stringify([back.cnBonds, edited.cnBonds, back.cnRadius]));
  await openTab(page, 'bonds');
  const widgets = await page.evaluate(() => {
    const control = document.querySelector('.bond-control[data-pair="C-N"]');
    const row = [...(control?.querySelectorAll('.bond-cat-editor .bond-cat-row') ?? [])]
      .find((r) => r.querySelector('.bond-cat-row-label')?.textContent === 'Size');
    const range = control?.querySelectorAll('.bond-range-slider input[type="range"]');
    return { size: row?.querySelector('input[type="range"]')?.value, max: range?.[1]?.value };
  });
  H.check('Bonds tab widgets show the restored values', near(widgets.size, 2) && near(widgets.max, 1.5),
    JSON.stringify(widgets));

  // ---- Reset Bond Lengths drops the stored ranges ---------------------------
  await H.clickById(page, 'resetBondLengths');
  await page.waitForTimeout(500);
  const afterReset = await page.evaluate(STATE);
  const rec2 = Object.values(JSON.parse(afterReset.stored || '{}'))[0] || {};
  H.check('Reset Bond Lengths drops bondLengths from storage', !('bondLengths' in rec2)
    && near(afterReset.cnRange.max, base.cnDefault.max), JSON.stringify(rec2));

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
    const { rebuildBonds } = await import('./render/index.js');
    const { createBondLengthControls } = await import('./ui/BondLengthPanel.js');
    const { selectLastAddedRow } = await import('./ui/FileBrowswerPanel.js');
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderComposition: 'open' });
    rebuildBonds();
    createBondLengthControls('infoBondControls');
    selectLastAddedRow();
  });
  await page.waitForTimeout(800);
  const afterClear = await page.evaluate((k) => localStorage.getItem(k), KEY);
  H.check('nothing written back after clear + programmatic applies', !afterClear || !FIELDS.test(afterClear),
    String(afterClear).slice(0, 200));

  await reload(page);
  const cleared = await page.evaluate(STATE);
  H.check('sizes back at default', near(cleared.atomSize, base.atomSize) && near(cleared.bondRadius, base.bondRadius)
    && cleared.atomSlider === cleared.atomSliderDefault && cleared.bondSlider === cleared.bondSliderDefault,
  JSON.stringify({ ...cleared, stored: undefined }));
  H.check('radius scales / bond styles / cutoff back at default', Object.keys(cleared.scales).length === 0
    && cleared.cat == null && near(cleared.cnRange.max, base.cnRange.max) && cleared.cnBonds === base.cnBonds,
  JSON.stringify({ ...cleared, stored: undefined }));
  H.check('no stored record with the size fields', !cleared.stored || !FIELDS.test(cleared.stored),
    String(cleared.stored).slice(0, 200));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
