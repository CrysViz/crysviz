// The bulk atom paste accepts an optional occupancy: "Element x y z [occ]
// [color]". The two trailing fields are order-tolerant — a #RRGGBB token is the
// colour, a bare number is the occupancy — so a partially occupied site can be
// entered in bulk, not just full-occupancy atoms.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const r = await page.evaluate(async () => {
    const { createAtomTableEditor } = await import('./ui/addToStructureModule/AtomTableInput.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = createAtomTableEditor(host, {});

    host.querySelector('#bulkInput').value =
      'C 2 2 2\n' +               // bare        -> occ 1 (the default)
      'H 0.5 0.5 0.5 #FF0000\n' + // colour only -> occ 1
      'Fe 1 1 1 0.6\n' +          // occupancy only
      'O 1.5 1.5 1.5 0.4 #00FF00'; // occupancy + colour
    host.querySelector('#applyBulk').click();

    return editor.getAtoms().map((a) => ({
      element: a.element, occ: a.occupancy, color: (a.color || '').toLowerCase() }));
  });

  const byEl = (el) => r.find((a) => a.element === el);
  const c = byEl('C'); const h = byEl('H'); const fe = byEl('Fe'); const o = byEl('O');

  H.check('bare "element x y z" line defaults to full occupancy',
    !!c && c.occ === 1, JSON.stringify(c));

  H.check('colour-only line keeps full occupancy',
    !!h && h.occ === 1 && h.color.includes('ff0000'), JSON.stringify(h));

  H.check('occupancy-only line sets a partial site, no colour',
    !!fe && fe.occ === 0.6 && !fe.color.includes('ff'), JSON.stringify(fe));

  H.check('occupancy + colour line sets both',
    !!o && o.occ === 0.4 && o.color.includes('00ff00'), JSON.stringify(o));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
