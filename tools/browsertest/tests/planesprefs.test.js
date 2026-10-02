// Crystal planes persisted per structure (ui/PlanesPanel.js, field 'planes' in
// state/structurePrefs.js): planes created and edited through the real panel
// inputs survive a reload of the same structure, with their cut mode and
// field/colormap settings; a plane bound to a volumetric field re-binds once
// that field is attached again after the reload; and "Clear local data"
// removes it all without the programmatic plane paths (rebuild, periodic-bounds
// sync, row re-selection, a field re-attach) writing it back.
'use strict';
const H = require('../harness');

const PREFS_KEY = 'crysviz.structurePrefs.v1';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());

  async function expandPanel(id) {
    await page.evaluate(async (id) => {
      const { getPanel } = await import('./ui/panels/PanelManager.js');
      getPanel(id).expand();
    }, id);
    await page.waitForTimeout(300);
  }

  // Attach an in-page Gaussian-blob field 'TestBlob' to the displayed structure
  // the way a field file does (catalog -> setSelectedField).
  async function attachField() {
    await page.evaluate(async () => {
      const { Field, FieldContainer } = await import('./model/index.js');
      const { fileBrowser } = await import('./state/store.js');
      const { fieldBrowser } = await import('./ui/FieldPanel.js');
      const structure = fileBrowser.selectedStructure;
      const lat = structure.lattice;
      const n = 12;
      const values = new Float32Array(n * n * n);
      let maxV = 0;
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = (n - 1) / 2;
        const v = Math.exp(-((i - c) ** 2 + (j - c) ** 2 + (k - c) ** 2) / 18);
        values[i + n * (j + n * k)] = v;
        if (v > maxV) maxV = v;
      }
      const voxel = lat.map((row) => row.map((x) => x / n));
      const field = new Field({
        nx: n, ny: n, nz: n, origin: [0, 0, 0], voxel, values, label: 'TestBlob',
        isoValue: 0.5, minValue: 0, maxValue: maxV, absMinValue: 0, absMaxValue: maxV,
        useAbsoluteIsoValue: false, isVisible: true,
      });
      structure.volumetricFields = new FieldContainer({ fileName: 'blob.cube', source: 'Cube', fields: [field] });
      fieldBrowser.setCatalog(structure.volumetricFields.catalog);
    });
    await page.waitForTimeout(300);
  }

  async function setNumberAndBlur(id, value) {
    await page.evaluate(({ id, value }) => {
      const el = document.getElementById(id);
      el.focus();
      el.value = String(value);
      el.blur();
    }, { id, value });
  }

  const storedPlanes = () => page.evaluate((key) => {
    const store = JSON.parse(localStorage.getItem(key) || '{}');
    return Object.values(store).map((r) => r.planes).filter(Boolean);
  }, PREFS_KEY);

  const planeState = () => page.evaluate(async () => {
    const { fileBrowser, app } = await import('./state/store.js');
    const { Plane } = await import('./model/Plane.js');
    const planes = fileBrowser.selectedStructure?.planes ?? [];
    const meshes = app.scene.children.filter((c) => c instanceof Plane);
    return {
      planes: planes.map((p) => ({
        params: p.params, cutMode: p.cutMode, visualization: p.visualization,
        colormap: p.colormap, fieldLabel: p.fieldLabel ?? null, fieldBound: p.field?.label ?? null,
        enabled: p.enabled,
      })),
      meshCount: meshes.length,
      fieldMeshes: meshes.filter((m) => m._field).length,
      rows: document.querySelectorAll('#planesTableBody tr').length,
      rowFieldText: [...document.querySelectorAll('#planesTableBody .planes-td-field')].map((td) => td.textContent),
    };
  });

  // ---- 1. Create two planes through the real panel -------------------------
  await expandPanel('planes');
  await attachField();

  await H.clickById(page, 'addPlaneBtn'); // (1 1 1), selected
  await setNumberAndBlur('planeH', 1);
  await setNumberAndBlur('planeK', 0);
  await setNumberAndBlur('planeL', 0);
  await H.setSelect(page, 'planeCutMode', 'AlongNormal');

  await H.clickById(page, 'addPlaneBtn'); // second plane, selected
  await setNumberAndBlur('planeH', 0);
  await setNumberAndBlur('planeK', 0);
  await setNumberAndBlur('planeL', 1);
  await H.setSelect(page, 'planesFieldSelect', 'TestBlob');
  await H.setSelect(page, 'planesColormapSelect', 'viridis');
  await page.waitForTimeout(500);

  const before = await planeState();
  H.check('two planes created through the panel', before.planes.length === 2
    && JSON.stringify(before.planes[0].params) === JSON.stringify({ type: 'hkl', h: 1, k: 0, l: 0 })
    && JSON.stringify(before.planes[1].params) === JSON.stringify({ type: 'hkl', h: 0, k: 0, l: 1 })
    && before.planes[1].fieldBound === 'TestBlob', JSON.stringify(before));

  const saved = await storedPlanes();
  H.check('planes saved to structurePrefs', saved.length === 1 && saved[0].length === 2
    && saved[0][0].cutMode === before.planes[0].cutMode && saved[0][0].cutMode === 'AlongNormal'
    && saved[0][1].fieldLabel === 'TestBlob' && saved[0][1].visualization === 'Field'
    && saved[0][1].colormap === 'viridis' && !('field' in saved[0][1]), JSON.stringify(saved));

  // ---- 2. Reload: planes come back, the field plane waits for its field -----
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  await expandPanel('planes');

  const after = await planeState();
  H.check('planes restored with same params and cut mode', after.planes.length === 2
    && JSON.stringify(after.planes.map((p) => p.params)) === JSON.stringify(before.planes.map((p) => p.params))
    && after.planes[0].cutMode === before.planes[0].cutMode, JSON.stringify(after));
  H.check('restored planes have meshes and table rows', after.meshCount === 2 && after.rows === 2,
    JSON.stringify(after));
  H.check('field plane restored pending (label kept, no field yet)',
    after.planes[1].visualization === 'Field' && after.planes[1].fieldLabel === 'TestBlob'
    && after.planes[1].fieldBound === null && after.planes[1].colormap === 'viridis'
    && after.rowFieldText[1] === 'TestBlob', JSON.stringify(after));

  const atomCut = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    return (general.atomCutPlanes || []).filter((p) => p.source === 'structure-plane').length;
  });
  H.check('restored cut mode drives the atom cut plane', atomCut === 1, String(atomCut));

  await attachField();
  const rebound = await planeState();
  H.check('field plane re-binds once the field is attached after the reload',
    rebound.planes[1].fieldBound === 'TestBlob' && rebound.fieldMeshes === 1 && rebound.meshCount === 2,
    JSON.stringify(rebound));

  // No double restore: a second restore pass must not duplicate planes.
  const dup = await page.evaluate(async () => {
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { restoreStructurePrefs } = await import('./state/structurePrefs.js');
    restoreStructurePrefs(structureShip.container[0], 'afterSelect', fileBrowser.selectedStructure);
    return fileBrowser.selectedStructure.planes.length;
  });
  H.check('re-running the restorer does not duplicate planes', dup === 2, String(dup));

  // ---- 3. Clear local data, then the programmatic paths must not re-save ---
  await expandPanel('settings');
  await H.clickById(page, 'clearLocalDataButton');
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const { syncPlanesForSelectedStructure, applyPlanesPeriodicBounds, resolvePendingPlaneFields } =
      await import('./ui/PlanesPanel.js');
    const { selectStructure } = await import('./ui/FileBrowswerPanel.js');
    syncPlanesForSelectedStructure();
    applyPlanesPeriodicBounds();
    resolvePendingPlaneFields();
    selectStructure(0);
  });
  await attachField();
  await page.waitForTimeout(600);
  const afterClear = await storedPlanes();
  H.check('no planes record after clear + programmatic paths', afterClear.length === 0, JSON.stringify(afterClear));

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const cleared = await planeState();
  const clearedStore = await storedPlanes();
  H.check('after clear + reload no planes are restored', cleared.planes.length === 0 && cleared.meshCount === 0
    && clearedStore.length === 0, JSON.stringify({ cleared, clearedStore }));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
