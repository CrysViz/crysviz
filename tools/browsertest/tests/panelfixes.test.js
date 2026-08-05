// Two follow-up fixes:
//  1. Order Structure's Size dropdown must default to a supercell that can
//     actually resolve the site occupancies. A Cl 0.6 / Va 0.4 site needs 5x
//     (0.6·5=3, 0.4·5=2) — the smallest EXACT multiplier — not an
//     unresolvable 1x1x1. The options are read from the disordered structure,
//     never the ordered preview that a build temporarily selects.
//  2. The atomistic panel spacing: a clear gap between the potential picker and
//     the Relax/MD switch, and less wasted card padding.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const r = await page.evaluate(async () => {
    const { Atom, Structure } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { addLatticeAndSupercellPanel } = await import('./ui/LatticeSupercellPanel.js');

    // Si2 + a Cl 0.6 / Va 0.4 site — smallest exact ordering cell is 5x (15 atoms).
    const atoms = [
      new Atom({ position: [0, 0, 0], element: 'Si' }),
      new Atom({ position: [0.5, 0.5, 0.5], element: 'Si' }),
      new Atom({ position: [0.25, 0.25, 0.25], species: [
        { element: 'Cl', occupancy: 0.6 }, { element: 'Va', occupancy: 0.4 }] }),
    ];
    fileBrowser.selectedStructure = new Structure({
      atoms, elements: ['Si', 'Si', 'Cl'], lattice: [[4, 0, 0], [0, 4, 0], [0, 0, 4]] });

    let host = document.getElementById('cvPanelBody-cell');
    if (!host) { host = document.createElement('div'); host.id = 'cvPanelBody-cell'; document.body.appendChild(host); }

    addLatticeAndSupercellPanel('cvPanelBody-cell');
    const sel = document.getElementById('osSizeSelect');
    const label = sel.selectedOptions[0]?.textContent ?? '';
    return {
      defaultVal: sel.value,
      label,
      optionCount: sel.options.length,
      defaultIsApproximate: /approximate/i.test(label),
    };
  });

  H.check('Size defaults to the smallest EXACT cell (5x, 15 atoms) — not 1x1x1',
    r.defaultVal === '5' && /15 atoms/.test(r.label) && !r.defaultIsApproximate,
    JSON.stringify(r));

  H.check('Order Structure offers several supercell sizes',
    r.optionCount > 1, JSON.stringify(r));

  // The Cell panel doesn't rebuild on an in-place occupancy edit, so the size
  // options have to react to the crysviz:atoms-changed the Modify editor emits.
  const live = await page.evaluate(async () => {
    const { Atom, Structure } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { addLatticeAndSupercellPanel } = await import('./ui/LatticeSupercellPanel.js');

    const atom = new Atom({ position: [0, 0, 0], species: [
      { element: 'Fe', occupancy: 0.5 }, { element: 'Ni', occupancy: 0.5 }] });
    fileBrowser.selectedStructure = new Structure({
      atoms: [atom], elements: ['Fe'], lattice: [[3, 0, 0], [0, 3, 0], [0, 0, 3]] });
    addLatticeAndSupercellPanel('cvPanelBody-cell');
    const before = document.getElementById('osSizeSelect').value; // 0.5/0.5 -> 2x

    // Edit the occupancies in place (0.5/0.5 -> 0.6/0.4 now needs 5x) and emit
    // the same event the Modify Atoms editor does — without rebuilding the panel.
    atom.species[0].occupancy = 0.6;
    atom.species[1].occupancy = 0.4;
    document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
    const after = document.getElementById('osSizeSelect').value;

    return { before, after };
  });

  H.check('size options update live when occupancy is edited in place',
    live.before === '2' && live.after === '5', JSON.stringify(live));

  const css = await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('backend').expand();
    const sel = getComputedStyle(document.getElementById('BackendPotentialSelector'));
    const source = document.querySelector('#BackendPotentialSelector .atomistic-source-panel');
    const sw = document.querySelector('#BackendModeSwitch');
    return {
      selectorGap: sel.marginBottom,
      sourcePad: source ? getComputedStyle(source).paddingTop : null,
      switchPad: sw ? getComputedStyle(sw).paddingTop : null,
    };
  });

  H.check('potential picker has a gap below it (above Relax/MD)',
    parseFloat(css.selectorGap) >= 10, css.selectorGap);

  H.check('potential card and action switch padding are trimmed',
    parseFloat(css.sourcePad) <= 6 && parseFloat(css.switchPad) <= 5, JSON.stringify(css));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
