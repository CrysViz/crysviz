// Two follow-up fixes:
//  1. Order Structure's Size dropdown must remember the chosen supercell size
//     across a panel rebuild (showing a built candidate reselects the row and
//     rebuilds the whole Cell panel) — it used to snap back to the default.
//  2. The atomistic panel spacing: a clear gap between the potential picker and
//     the Relax/MD switch, and less wasted outer padding.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const r = await page.evaluate(async () => {
    const { Atom, Structure } = await import('./model/index.js');
    const { fileBrowser } = await import('./state/store.js');
    const { addLatticeAndSupercellPanel } = await import('./ui/LatticeSupercellPanel.js');

    // A 50/50 site: exact ordering needs a 2x supercell, so the Size dropdown
    // offers several multipliers with a non-1 default (2x).
    const atoms = [new Atom({ position: [0, 0, 0], species: [
      { element: 'Fe', occupancy: 0.5 }, { element: 'Ni', occupancy: 0.5 }] })];
    fileBrowser.selectedStructure = new Structure({
      atoms, elements: ['Fe'], lattice: [[3, 0, 0], [0, 3, 0], [0, 0, 3]] });

    let host = document.getElementById('cvPanelBody-cell');
    if (!host) { host = document.createElement('div'); host.id = 'cvPanelBody-cell'; document.body.appendChild(host); }

    addLatticeAndSupercellPanel('cvPanelBody-cell');
    const sel1 = document.getElementById('osSizeSelect');
    const optionCount = sel1.options.length;
    const defaultVal = sel1.value;
    // Pick a different offered size and notify the panel, as a real user would.
    const other = [...sel1.options].map((o) => o.value).find((v) => v !== defaultVal);
    sel1.value = other;
    sel1.dispatchEvent(new Event('change'));

    // Rebuild the whole Cell panel — what showing a built candidate triggers.
    addLatticeAndSupercellPanel('cvPanelBody-cell');
    const afterRebuild = document.getElementById('osSizeSelect').value;

    return { optionCount, defaultVal, other, afterRebuild };
  });

  H.check('Order Structure Size dropdown offers several sizes with a non-1 default',
    r.optionCount > 1 && r.defaultVal !== r.other, JSON.stringify(r));

  H.check('chosen Size survives a panel rebuild (no snap back to default)',
    r.afterRebuild === r.other, JSON.stringify(r));

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
