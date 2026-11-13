// The volumetric field picked in the field list (ui/FieldPanel.js,
// structurePrefs field 'fieldSelected') is the one shown after a browser
// reload and the same file loaded again, instead of the file's first field;
// switching to another structure row and back keeps it too. A WAVECAR band is
// stored by its catalog node (band labels repeat across k-points): after the
// reload the CHGCAR alone shows its first field, and attaching the WAVECAR
// again expands and shows that band. The WAVECAR is a stand-in catalog with a
// lazy band leaf (as in wavecarattach.test.js); a real one is gigabytes.
'use strict';
const H = require('../harness');

const KEY = 'crysviz.structurePrefs.v1';

// A small spin-polarised CHGCAR: four fields once the spin channels are derived.
const LOAD_CHGCAR = async () => {
  const { loadStructure } = await import('./core/crystal-viewer.js');
  const n = 6;
  const block = (f) => Array.from({ length: n ** 3 }, (_, i) => f(i).toFixed(5)).join(' ');
  const text = ['test', '1.0', '4 0 0', '0 4 0', '0 0 4', 'Fe', '1', 'Direct', '0 0 0', '',
    `${n} ${n} ${n}`, block((i) => 1 + (i % 7)), `${n} ${n} ${n}`, block((i) => (i % 5) - 2), ''].join('\n');
  await loadStructure(new File([text], 'CHGCAR'), 'CHGCAR');
  await new Promise((r) => setTimeout(r, 300));
};

// Attach the stand-in WAVECAR (k-point 1 and 2, one band each, both "Band 1").
const ATTACH_WAVECAR = async () => {
  const { Field, FieldCatalog } = await import('./model/index.js');
  const { FieldCatalogNode, NodeKind } = await import('./model/FieldCatalog.js');
  const { fileBrowser } = await import('./state/store.js');
  const { attachFieldCatalog } = await import('./render/Render3DFieldModule.js');
  const structure = fileBrowser.selectedStructure;
  const n = 6;
  const lat = structure.lattice;
  const bands = {};
  window.__bandLoads = 0;
  const leaf = (k) => new FieldCatalogNode({
    id: `wf:1:${k}:1`, label: 'Band 1',
    load: async () => {
      window.__bandLoads++;
      await new Promise((r) => setTimeout(r, 200)); // a transform takes a while
      return (bands[k] ??= new Field({
        nx: n, ny: n, nz: n, voxel: lat.map((row) => row.map((x) => x / n)),
        values: new Float32Array(n ** 3).map((_, i) => k * (i % 3)), label: 'Band 1',
        minValue: 0, maxValue: 2 * k, absMinValue: 0, absMaxValue: 2 * k,
      }));
    },
    peek: () => bands[k] ?? null,
  });
  const catalog = new FieldCatalog({
    source: 'WAVECAR', hierarchical: true, summary: '2 k-points, 1 band',
    nodes: [1, 2].map((k) => new FieldCatalogNode({
      id: `wf:1:${k}`, label: `k-point ${k}`, kind: NodeKind.GROUP, children: [leaf(k)],
    })),
  });
  catalog.wavefunction = /** @type {any} */ ({ describe: () => '2 k-points, 1 band' });
  catalog.quantityRef = { value: 0 };
  attachFieldCatalog(structure, catalog, { fileName: 'WAVECAR', source: 'WAVECAR' });
};

const STATE = async () => {
  const { fileBrowser, groups } = await import('./state/store.js');
  const { fieldBrowser } = await import('./ui/FieldPanel.js');
  const catalog = fileBrowser.selectedStructure?.volumetricFields?.catalog;
  const node = fieldBrowser.selectedField && catalog?.nodeForField(fieldBrowser.selectedField);
  const checked = document.querySelector('#fieldCatalogMount .fc-leaf-radio:checked');
  return {
    selected: fieldBrowser.selectedField?.label ?? null,
    node: node?.id ?? null,
    active: groups.activeField?.label ?? null,
    checked: checked?.closest('.fc-leaf')?.querySelector('.fc-leaf-label')?.textContent ?? null,
    bandLoads: window.__bandLoads ?? 0,
  };
};

// Pick a leaf in the field list by label (and k-point group, for bands).
const PICK = async ({ label, group }) => {
  const { revealFieldPanelForCurrentStructure } = await import('./render/index.js');
  const { rebuildPanel } = await import('./ui/panels/PanelManager.js');
  revealFieldPanelForCurrentStructure();
  rebuildPanel('field'); // the app rebuilds it after a load (refreshActivePanels)
  await new Promise((r) => setTimeout(r, 200));
  const mount = document.getElementById('fieldCatalogMount');
  // Open every group so the leaves are rendered.
  for (let i = 0; i < 4; i++) {
    for (const t of mount.querySelectorAll('.fc-group-toggle[aria-expanded="false"]')) t.click();
  }
  const rows = [...mount.querySelectorAll('.fc-leaf')].filter((r) =>
    r.querySelector('.fc-leaf-label').textContent === label
    && (!group || r.closest('.fc-group')?.querySelector('.fc-group-label')?.textContent === group));
  const row = rows[0];
  if (!row) return false;
  const load = row.querySelector('.fc-load');
  if (load) load.click();
  else row.querySelector('.fc-leaf-radio').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 600));
  return true;
};

async function reload(page) {
  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000); // init + default structure load, as launchApp
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await H.loadDefaultStructure(page);
  await page.evaluate((k) => localStorage.removeItem(k), KEY);

  // ---- a CHGCAR field --------------------------------------------------------
  await page.evaluate(LOAD_CHGCAR);
  const first = await page.evaluate(STATE);
  H.check('a fresh CHGCAR shows its first field', first.selected === 'Charge Density', JSON.stringify(first));
  const picked = await page.evaluate(PICK, { label: 'Spin Down Density' });
  const afterPick = await page.evaluate(STATE);
  const stored = await page.evaluate((k) => Object.values(JSON.parse(localStorage.getItem(k) || '{}'))
    .map((r) => r.fieldSelected).filter(Boolean), KEY);
  H.check('picking a field in the list shows it and stores it',
    picked && afterPick.selected === 'Spin Down Density' && afterPick.active === 'Spin Down Density'
    && stored.length === 1 && stored[0].key === 'CHGCAR|Spin Down Density',
    JSON.stringify({ afterPick, stored }));

  // Another row and back.
  const rows = await page.evaluate(async () => {
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const { selectContainer } = await import('./ui/FileBrowswerPanel.js');
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const chg = structureShip.container.find((c) => c.fileName === 'CHGCAR');
    const other = structureShip.container.find((c) => c !== chg);
    selectContainer(other);
    await new Promise((r) => setTimeout(r, 200));
    const away = fileBrowser.selectedStructure?.volumetricFields ? fieldBrowser.selectedField?.label : null;
    selectContainer(chg);
    await new Promise((r) => setTimeout(r, 200));
    return { away, back: fieldBrowser.selectedField?.label ?? null };
  });
  H.check('switching to another row and back keeps the picked field',
    rows.away === null && rows.back === 'Spin Down Density', JSON.stringify(rows));

  // ---- reload, same file --------------------------------------------------------
  await reload(page);
  await page.evaluate(LOAD_CHGCAR);
  const reloaded = await page.evaluate(STATE);
  H.check('after a reload the same CHGCAR shows the picked field, also in the list',
    reloaded.selected === 'Spin Down Density' && reloaded.active === 'Spin Down Density'
    && reloaded.checked === 'Spin Down Density', JSON.stringify(reloaded));

  // ---- a WAVECAR band ------------------------------------------------------------
  await page.evaluate(ATTACH_WAVECAR);
  const keptOnAttach = await page.evaluate(STATE);
  H.check('attaching a WAVECAR keeps the field on screen', keptOnAttach.selected === 'Spin Down Density',
    JSON.stringify(keptOnAttach));
  await page.evaluate(PICK, { label: 'Band 1', group: 'k-point 2' });
  const bandPicked = await page.evaluate(STATE);
  H.check('loading a band in the list shows it and stores its node',
    bandPicked.selected === 'Band 1' && /wf:1:2:1$/.test(bandPicked.node || ''), JSON.stringify(bandPicked));

  await reload(page);
  await page.evaluate(LOAD_CHGCAR);
  const beforeWavecar = await page.evaluate(STATE);
  H.check('after a reload the CHGCAR alone shows its first field (the band is not there yet)',
    beforeWavecar.selected === 'Charge Density', JSON.stringify(beforeWavecar));
  await page.evaluate(ATTACH_WAVECAR);
  await page.waitForTimeout(800);
  const band = await page.evaluate(STATE);
  H.check('attaching the WAVECAR again expands and shows the same band (k-point 2, not 1)',
    band.selected === 'Band 1' && /wf:1:2:1$/.test(band.node || '') && band.active === 'Band 1'
    && band.bandLoads === 1, JSON.stringify(band));

  // ---- the user's pick wins over a pending restore -----------------------------
  await reload(page);
  await page.evaluate(LOAD_CHGCAR);
  await page.evaluate(async () => {
    const { revealFieldPanelForCurrentStructure } = await import('./render/index.js');
    revealFieldPanelForCurrentStructure();
  });
  await page.evaluate(ATTACH_WAVECAR); // the band starts loading (200 ms)
  await page.evaluate(PICK, { label: 'Magnetization Density' });
  await page.waitForTimeout(600);
  const userWins = await page.evaluate(STATE);
  H.check('a field picked while the stored band loads stays selected',
    userWins.selected === 'Magnetization Density', JSON.stringify(userWins));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
