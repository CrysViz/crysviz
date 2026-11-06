// Sharing a COLOURED SUPERCELL has to bring the colours back on the same atoms.
//
// The share state writes a POSCAR and re-parses it. That export used to group
// atoms by element, which permutes a supercell (the tiling interleaves species)
// — structure.atoms was put back afterwards, but structure.periodic was not, and
// the renderer colours instance i from atoms[periodic.wrapped.srcIndex[i]]. The
// result was a restored cell with the right colours on the wrong atoms. A unit
// cell hid it: its atoms already arrive element-grouped, so the "permutation"
// was the identity.
'use strict';
const H = require('../harness');

// What the viewer actually paints: instance position -> colour of the atom the
// wrap points at. Comparing this (rather than structure.atoms) is the point —
// the model was already correct while the picture was wrong.
const PAINTED = async () => {
  const { fileBrowser } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const wrap = s.periodic?.visibleWrapped || s.periodic?.wrapped;
  const hex = (c) => (typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : String(c).toLowerCase());
  const out = {};
  for (let i = 0; i < wrap.srcIndex.length; i++) {
    out[wrap.frac[i].map(v => Number(v).toFixed(5)).join(',')] = hex(s.atoms[wrap.srcIndex[i]].getColor());
  }
  return out;
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const { url, before, coloured } = await page.evaluate(async (painted) => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { fileBrowser } = await import('./state/store.js');
    const { updateAtoms } = await import('./render/index.js');
    const { shareStructure } = await import('./ui/ShareModule.js');
    createSupercell(2, 2, 1);
    const s = fileBrowser.selectedStructure;
    // Scattered, so a permutation cannot coincidentally land on the same atoms.
    s.atoms.forEach((a, i) => { if (i % 5 === 0) a.color = '#ff00ff'; });
    updateAtoms();
    const before = await (new Function(`return ${painted}`)())();
    await shareStructure();
    return {
      url: document.getElementById('shareLinkUrl').value,
      before,
      coloured: Object.values(before).filter(c => c === '#ff00ff').length,
    };
  }, PAINTED.toString());

  H.check('the supercell really is multi-species and multi-coloured',
    Object.keys(before).length > 40 && coloured > 5, `${Object.keys(before).length} sites, ${coloured} coloured`);

  await page.goto(url, { waitUntil: 'load' });
  await H.waitFor(page, async () => {
    const { fileBrowser } = await import('./state/store.js');
    return (fileBrowser.selectedStructure?.atoms?.length ?? 0) > 0;
  }, { timeout: 40000, interval: 1000 });

  const after = await page.evaluate(async (painted) => (new Function(`return ${painted}`)())(), PAINTED.toString());

  const missing = Object.keys(before).filter(k => !(k in after));
  const moved = Object.keys(before).filter(k => k in after && after[k] !== before[k]);
  H.check('every shared site comes back',
    missing.length === 0, `${missing.length} missing, e.g. ${missing.slice(0, 3)}`);
  H.check('every atom keeps its colour after sharing a coloured supercell',
    moved.length === 0,
    `${moved.length} of ${Object.keys(before).length} changed, e.g. ` +
    JSON.stringify(moved.slice(0, 3).map(k => ({ site: k, was: before[k], now: after[k] }))));

  H.check('no page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
