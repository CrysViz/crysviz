// Attaching a WAVECAR to a structure that already holds a volumetric field
// (render/Render3DFieldModule.js attachFieldCatalog, the step parseWavecarFile
// ends in) ADDS its band tree next to the existing fields instead of replacing
// the structure's FieldContainer: the CHGCAR/cube fields stay listed, stay
// selected and stay what a .crysviz save stores, and the field panel shows one
// group per file. A real WAVECAR is gigabytes, so the wavefunction catalog here
// is a stand-in with the same shape (groups, a lazy band leaf, `wavefunction`
// and `quantityRef` set), built through the real FieldCatalog.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());
  await H.loadDefaultStructure(page);

  const result = await page.evaluate(async () => {
    const { Field, FieldContainer, FieldCatalog } = await import('./model/index.js');
    const { FieldCatalogNode, NodeKind } = await import('./model/FieldCatalog.js');
    const { fileBrowser } = await import('./state/store.js');
    const { fieldBrowser } = await import('./ui/FieldPanel.js');
    const { attachFieldCatalog } = await import('./render/Render3DFieldModule.js');
    const { revealFieldPanelForCurrentStructure } = await import('./render/index.js');
    const structure = fileBrowser.selectedStructure;
    const lat = structure.lattice;

    const makeField = (label, scale) => {
      const n = 8;
      const values = new Float32Array(n * n * n).map((_, i) => scale * ((i % 7) / 7));
      return new Field({
        nx: n, ny: n, nz: n, origin: [0, 0, 0], voxel: lat.map((row) => row.map((x) => x / n)), values,
        label, isoValue: 0.5 * scale, minValue: 0, maxValue: scale, absMinValue: 0, absMaxValue: scale,
        useAbsoluteIsoValue: false, isVisible: true,
      });
    };

    // The host file: a CHGCAR-like flat container, its first field selected.
    const charge = makeField('Charge density', 1);
    const magnet = makeField('Magnetization', 2);
    structure.volumetricFields = new FieldContainer({ fileName: 'CHGCAR', source: 'CHGCAR', fields: [charge, magnet] });
    fieldBrowser.setCatalog(structure.volumetricFields.catalog);
    fieldBrowser.selectField(magnet);
    const hostContainer = structure.volumetricFields;

    // The WAVECAR: k-point group -> lazy band leaf, nothing loaded yet.
    let band = null;
    const quantityRef = { value: 0 };
    const wfCatalog = new FieldCatalog({
      source: 'WAVECAR', hierarchical: true, summary: '1 k-point, 1 band',
      nodes: [new FieldCatalogNode({
        id: 'wf:1:1', label: 'k-point 1', kind: NodeKind.GROUP,
        children: [new FieldCatalogNode({
          id: 'wf:1:1:1', label: 'Band 1',
          load: async () => (band ??= makeField('Band 1', 3)),
          peek: () => band,
        })],
      })],
    });
    wfCatalog.wavefunction = /** @type {any} */ ({ describe: () => '1 k-point, 1 band' });
    wfCatalog.quantityRef = quantityRef;

    attachFieldCatalog(structure, wfCatalog, { fileName: 'WAVECAR', source: 'WAVECAR' });

    const container = structure.volumetricFields;
    const catalog = container.catalog;
    const beforeLoad = {
      sameContainer: container === hostContainer,
      fields: container.fields.map((f) => f.label),
      available: fieldBrowser.availableFields.map((f) => f.label),
      selected: fieldBrowser.selectedField?.label ?? null,
      groups: catalog.nodes.map((n) => n.label),
      combined: catalog.combined,
      hasWavefunction: Boolean(catalog.wavefunction),
      browserCatalog: fieldBrowser.catalog === catalog,
    };

    // Loading a band adds it to the menus next to the host fields.
    const leaf = [...catalog.walk()].find((n) => n.label === 'Band 1');
    await leaf.ensureLoaded();
    catalog.quantity = 2;
    const afterLoad = {
      available: fieldBrowser.availableFields.map((f) => f.label),
      quantity: quantityRef.value,
      ids: [...catalog.walk()].map((n) => n.id),
    };

    revealFieldPanelForCurrentStructure();
    await new Promise((r) => setTimeout(r, 500));
    const body = document.getElementById('cvPanelBody-field');
    const panel = {
      source: body?.querySelector('.field-info')?.textContent ?? '',
      text: body?.textContent ?? '',
      quantitySelect: Boolean(body?.querySelector('.field-catalog-toolbar select')),
    };
    return { beforeLoad, afterLoad, panel };
  });

  const { beforeLoad, afterLoad, panel } = result;
  H.check('the host keeps its FieldContainer and its own fields',
    beforeLoad.sameContainer && JSON.stringify(beforeLoad.fields) === JSON.stringify(['Charge density', 'Magnetization']),
    JSON.stringify(beforeLoad));
  H.check('host fields stay in every menu, and the field on screen stays selected',
    JSON.stringify(beforeLoad.available) === JSON.stringify(['Charge density', 'Magnetization'])
    && beforeLoad.selected === 'Magnetization' && beforeLoad.browserCatalog, JSON.stringify(beforeLoad));
  H.check('one group per file, wavefunction controls kept',
    beforeLoad.combined && JSON.stringify(beforeLoad.groups) === JSON.stringify(['CHGCAR', 'WAVECAR'])
    && beforeLoad.hasWavefunction, JSON.stringify(beforeLoad));
  H.check('a loaded band joins the host fields; the Quantity drives the WAVECAR',
    JSON.stringify(afterLoad.available) === JSON.stringify(['Charge density', 'Magnetization', 'Band 1'])
    && afterLoad.quantity === 2 && new Set(afterLoad.ids).size === afterLoad.ids.length, JSON.stringify(afterLoad));
  H.check('the field panel names both files and shows both trees',
    /CHGCAR \+ WAVECAR/.test(panel.source) && panel.text.includes('Charge density')
    && panel.text.includes('k-point 1') && panel.quantitySelect, JSON.stringify(panel));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
