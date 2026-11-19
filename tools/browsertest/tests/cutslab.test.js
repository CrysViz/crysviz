// The Cell & Supercell window's "Cut Slab (h k l)" section and the host's
// build_slab are one path (ui/addToStructureModule/CutSlab.js): the window's
// cut of fcc Cu (111), 4 layers, 15 Å makes the same new row build_slab does,
// and a bad input is refused inline in the window, not by an alert.
'use strict';
const H = require('../harness');

const CU = `Cu fcc conventional
1.0
3.615 0 0
0 3.615 0
0 0 3.615
Cu
4
Direct
0 0 0
0 0.5 0.5
0.5 0 0.5
0.5 0.5 0
`;

(async () => {
  const { browser, page, errors } = await H.launchApp();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.evaluate(async (text) => (await import('./core/crystal-viewer.js')).loadStructure(text, 'Cu.vasp'), CU);
  await page.waitForTimeout(1500);

  const r = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const { structureShip, fileBrowser } = await import('./state/store.js');
    const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const host = (command, args) => window.crysvizHost.dispatch({ command, args });
    const type = (id, value) => {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const cut = async (h, k, l, layers, vacuum) => {
      type('slabH', h); type('slabK', k); type('slabL', l); type('slabLayers', layers); type('slabVacuum', vacuum);
      /** @type {HTMLElement} */ (document.getElementById('cutSlabBtn')).click();
      await frames();
    };
    const status = () => document.getElementById('slabStatus')?.textContent ?? '';

    const cu = (await host('get_state', { include: ['structures'] })).result.structures.at(-1);
    getPanel('cell').expand();
    await frames();
    const sectionShown = !!document.getElementById('cutSlabBtn');

    // The window's cut.
    const rows0 = structureShip.container.length;
    await cut(1, 1, 1, 4, 15);
    const ui = {
      rows: structureShip.container.length - rows0,
      atoms: fileBrowser.selectedStructure.atoms.length,
      c: fileBrowser.selectedStructure.lattice[2][2],
      name: String(structureShip.container.at(-1).fileName),
      status: status(),
    };

    // The host's cut of the same crystal, the same input.
    await host('select_structure', { structure: cu.id });
    const built = await host('build_slab', { hkl: [1, 1, 1], layers: 4, vacuum: 15 });

    // Bad inputs, from the Cu row again: all-zero hkl, zero layers, negative
    // vacuum, a fractional index, an empty field. Each refused inline, no row.
    await host('select_structure', { structure: cu.id });
    await frames();
    const rows1 = structureShip.container.length;
    const refusals = [];
    for (const input of [[0, 0, 0, 4, 15], [1, 1, 1, 0, 15], [1, 1, 1, 4, -1], [1, 0.5, 0, 4, 15], ['', 1, 1, 4, 15]]) {
      await cut(...input);
      refusals.push(status());
    }
    return { sectionShown, ui, built, refusals, rowsAfterRefusals: structureShip.container.length - rows1 };
  });

  H.check('the Cell & Supercell window has the Cut Slab section', r.sectionShown);
  H.check('Cut Slab adds one new structure row', r.ui.rows === 1, JSON.stringify(r.ui));
  H.check('Cu(111), 4 layers: 16 atoms in the window\'s slab', r.ui.atoms === 16, JSON.stringify(r.ui));
  H.check('build_slab gives the same slab for the same input',
    r.built.ok && r.built.result.atomCount === r.ui.atoms && Math.abs(r.built.result.c - r.ui.c) < 1e-3
      && r.built.result.name === r.ui.name, JSON.stringify({ built: r.built, ui: r.ui }));
  H.check('the window reports the cut', /16 atoms/.test(r.ui.status), r.ui.status);
  H.check('invalid inputs are refused inline, every one', r.refusals.every((text) => text.length > 0 && !/16 atoms/.test(text)),
    JSON.stringify(r.refusals));
  H.check('the refusals name the problem', /not all zero/.test(r.refusals[0]) && /layers/.test(r.refusals[1])
    && /vacuum/.test(r.refusals[2]) && /integers/.test(r.refusals[3]) && /integers/.test(r.refusals[4]), JSON.stringify(r.refusals));
  H.check('a refused cut adds no row', r.rowsAfterRefusals === 0, String(r.rowsAfterRefusals));
  H.check('no alert()', dialogs.length === 0, dialogs.join(' | '));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
