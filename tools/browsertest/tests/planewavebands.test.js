// Crystal planes on WAVECAR bands (ui/PlanesPanel.js, model/FieldCatalog.js).
// A band expanded under several quantities (|ψ|² and signed |ψ|) stays in the
// field lists under each of them, so a plane can show either; the plane's
// Field dropdown follows each newly loaded band. Restored after a reload
// before its WAVECAR is back, a band plane is drawn plain (no colormap with
// nothing to sample, which rendered black) and without a colour bar; when the
// WAVECAR is attached again the plane's band is expanded under its stored
// quantity and drawn as before. The WAVECAR is a stand-in source with the
// shape FieldCatalog.fromWavefunction reads (a real one is gigabytes).
'use strict';
const H = require('../harness');

const PREFS_KEY = 'crysviz.structurePrefs.v1';

// A Cube-like host field and the stand-in WAVECAR, attached like the app does.
const ATTACH_HOST = async () => {
  const { Field, FieldContainer } = await import('./model/index.js');
  const { fileBrowser } = await import('./state/store.js');
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const structure = fileBrowser.selectedStructure;
  const n = 8;
  const field = new Field({
    nx: n, ny: n, nz: n, voxel: structure.lattice.map((row) => row.map((x) => x / n)),
    values: new Float32Array(n ** 3).map((_, i) => (i % 9) / 9), label: 'Host',
    minValue: 0, maxValue: 8 / 9, absMinValue: 0, absMaxValue: 8 / 9,
  });
  structure.volumetricFields = new FieldContainer({ fileName: 'host.cube', source: 'Cube', fields: [field] });
  fieldBrowser.setCatalog(structure.volumetricFields.catalog);
  document.dispatchEvent(new CustomEvent('crysviz:fields-changed'));
  await new Promise((r) => setTimeout(r, 200));
};

const ATTACH_WAVECAR = async () => {
  const { Field, FieldCatalog } = await import('./model/index.js');
  const { fileBrowser } = await import('./state/store.js');
  const { attachFieldCatalog } = await import('./render/Render3DFieldModule.js');
  const structure = fileBrowser.selectedStructure;
  const n = 8;
  const cache = new Map();
  window.__waveLoads = [];
  const names = { 0: '', 1: ' [Re ψ]', 2: ' [Im ψ]', 3: ' [signed |ψ|]' };
  const wf = {
    noncollinear: false, nspin: 1, nkpts: 1, nbands: 2, kpoints: [[0, 0, 0]],
    eigenvalues: [[[-1, 1]]], describe: () => '1 k-point, 2 bands',
    peekField: (s, k, b, q) => cache.get(`${s}:${k}:${b}:${q}`) ?? null,
    getField: async (s, k, b, q) => {
      const key = `${s}:${k}:${b}:${q}`;
      if (cache.has(key)) return cache.get(key);
      window.__waveLoads.push(key);
      await new Promise((r) => setTimeout(r, 100));
      // |ψ|² is positive, signed |ψ| straddles zero.
      const values = new Float32Array(n ** 3).map((_, i) => (q === 0 ? (i % 5) / 50 : ((i % 5) - 2) / 20));
      const f = new Field({
        nx: n, ny: n, nz: n, voxel: structure.lattice.map((row) => row.map((x) => x / n)), values,
        label: `k1 band ${b}${names[q]}`,
        minValue: q === 0 ? 0 : -0.1, maxValue: q === 0 ? 0.08 : 0.1, absMinValue: 0, absMaxValue: 0.1,
      });
      f.wavefunction = { source: wf, spin: s, kpt: k, band: b, quantity: q, spinor: -1 };
      cache.set(key, f);
      return f;
    },
    pinField: () => {},
  };
  attachFieldCatalog(structure, FieldCatalog.fromWavefunction(wf), { fileName: 'WAVECAR', source: 'WAVECAR' });
  await new Promise((r) => setTimeout(r, 200));
};

// Load band `band` under quantity `q` through the field list's own controls.
const LOAD_BAND = async ({ band, q }) => {
  const { rebuildPanel } = await import('./ui/panels/PanelManager.js');
  const { revealFieldPanelForCurrentStructure } = await import('./render/index.js');
  revealFieldPanelForCurrentStructure();
  rebuildPanel('field');
  await new Promise((r) => setTimeout(r, 200));
  const mount = document.getElementById('fieldCatalogMount');
  const select = mount.querySelector('.field-catalog-select');
  select.value = String(q);
  select.dispatchEvent(new Event('change'));
  rebuildPanel('field');
  await new Promise((r) => setTimeout(r, 200));
  for (const t of document.querySelectorAll('#fieldCatalogMount .fc-group-toggle[aria-expanded="false"]')) t.click();
  await new Promise((r) => setTimeout(r, 100));
  const row = [...document.querySelectorAll('#fieldCatalogMount .fc-leaf')]
    .find((r) => r.querySelector('.fc-leaf-label').textContent === `Band ${band}`);
  row.querySelector('.fc-load')?.click();
  await new Promise((r) => setTimeout(r, 500));
};

const STATE = async () => {
  const { fileBrowser, app } = await import('./state/store.js');
  const { Plane } = await import('./model/Plane.js');
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const plane = fileBrowser.selectedStructure?.planes?.[0];
  const mesh = app.scene.children.find((c) => c instanceof Plane);
  const bar = document.getElementById('planesColorBarContainer');
  return {
    available: fieldBrowser.availableFields.map((f) => f.label),
    options: [...document.querySelectorAll('#planesFieldSelect option')].map((o) => o.value).filter(Boolean),
    bound: plane?.field?.label ?? null,
    meshMode: mesh?.mode ?? null,
    meshColors: Boolean(mesh?.geometry?.attributes?.color),
    barShown: Boolean(bar && !bar.hidden && bar.childElementCount),
    loads: window.__waveLoads ?? [],
  };
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await page.evaluate((k) => localStorage.removeItem(k), PREFS_KEY);
  const expandPlanes = () => page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('planes').expand();
    await new Promise((r) => setTimeout(r, 300));
  });

  await page.evaluate(ATTACH_HOST);
  await page.evaluate(ATTACH_WAVECAR);
  await expandPlanes();
  await H.clickById(page, 'addPlaneBtn');
  await page.waitForTimeout(200);

  await page.evaluate(LOAD_BAND, { band: 2, q: 0 });
  const one = await page.evaluate(STATE);
  H.check('a loaded band shows up in the selected plane\'s Field dropdown',
    one.options.includes('k1 band 2'), JSON.stringify(one));

  await page.evaluate(LOAD_BAND, { band: 2, q: 3 });
  const both = await page.evaluate(STATE);
  H.check('after switching the quantity both grids of the band are listed',
    both.available.includes('k1 band 2') && both.available.includes('k1 band 2 [signed |ψ|]')
    && both.options.includes('k1 band 2') && both.options.includes('k1 band 2 [signed |ψ|]'),
    JSON.stringify(both));

  await H.setSelect(page, 'planesFieldSelect', 'k1 band 2 [signed |ψ|]');
  await page.waitForTimeout(300);
  const drawn = await page.evaluate(STATE);
  H.check('the plane shows the signed |ψ| band with its colour bar',
    drawn.bound === 'k1 band 2 [signed |ψ|]' && drawn.meshMode === 'Field' && drawn.meshColors && drawn.barShown,
    JSON.stringify(drawn));
  const legend = await page.evaluate(() => document.querySelector('#planesColorBarContainer .cv-colorbar-legend, #planeColorBarFloating .cv-colorbar-legend')?.textContent);
  H.check('the legend names the newly picked field, not the previous one',
    legend === 'k1 band 2 [signed |ψ|]', JSON.stringify(legend));

  await page.evaluate(async () => (await import('./state/structurePrefs.js')).flushPendingStructurePrefSaves());
  const stored = await page.evaluate((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}'))
    .flatMap((r) => r.planes ?? []), PREFS_KEY);
  H.check('the plane stores its band and quantity, and no stale legend',
    stored.length === 1 && JSON.stringify(stored[0].fieldWave) === JSON.stringify({ spin: 1, kpt: 1, band: 2, quantity: 3 })
    && !('legendText' in stored[0]), JSON.stringify(stored));

  // ---- reload: the WAVECAR is not back yet ------------------------------------
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(5000);
  await page.evaluate(ATTACH_HOST);
  await expandPlanes();
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#planesTableBody tr'))?.click());
  await page.waitForTimeout(200);
  const pending = await page.evaluate(STATE);
  H.check('before its WAVECAR is back the plane is drawn plain, with no colormap or colour bar',
    pending.bound === null && pending.meshMode === 'None' && !pending.meshColors && !pending.barShown,
    JSON.stringify(pending));

  await page.evaluate(ATTACH_WAVECAR);
  await page.waitForTimeout(600);
  const back = await page.evaluate(STATE);
  H.check('attaching the WAVECAR again expands the plane\'s band under its quantity and draws it',
    back.bound === 'k1 band 2 [signed |ψ|]' && back.meshMode === 'Field' && back.meshColors
    && back.loads.includes('1:1:2:3') && back.options.includes('k1 band 2 [signed |ψ|]'),
    JSON.stringify(back));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
