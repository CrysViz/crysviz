// Supercells from the feature search (FeatureSearch.js, search/supercellQuery.js):
//   - Ctrl+F, "222": the first result is "Build a 2×2×2 supercell" with the
//     atom counts; Enter builds it (8× the atoms, lattice doubled) and the
//     Cell window's factor fields show 2 2 2
//   - "232" from there gives the 2×3×2 supercell of the same base cell (12×),
//     the same as the Cell window's Apply; "2x2x1", "2×3×4", "supercell 333"
//     are offered too; one number ("2", "supercell 3") or "2222" is not
//   - "111" goes back to the 1×1×1 cell; asking for the cell it already is
//     says so
//   - the Cell window's Apply with an empty field counts it as 1 (it tiled
//     no atoms at all: NaN)
//   - no structure: no supercell result
//   - a large supercell (over 20 000 atoms) names its step on the load
//     progress overlay, which goes away afterwards
'use strict';
const H = require('../harness');

function rutilePoscar(n) {
  const base = [['Ti', 0, 0, 0], ['Ti', 0.5, 0.5, 0.5], ['O', 0.3048, 0.3048, 0], ['O', 0.6952, 0.6952, 0], ['O', 0.8048, 0.1952, 0.5], ['O', 0.1952, 0.8048, 0.5]];
  const ti = [], o = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let l = 0; l < n; l++) {
    for (const [el, x, y, z] of base) (el === 'Ti' ? ti : o).push([(x + i) / n, (y + j) / n, (z + l) / n].map((v) => v.toFixed(6)).join(' '));
  }
  return ['rutile', '1.0', `${4.5937 * n} 0 0`, `0 ${4.5937 * n} 0`, `0 0 ${2.9587 * n}`, 'Ti O', `${ti.length} ${o.length}`, 'Direct', ...ti, ...o, ''].join('\n');
}

const STATE = async () => {
  const { fileBrowser } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  const len = (v) => Math.hypot(...v);
  return {
    atoms: s.atoms.length,
    supercell: s.supercell ? [s.supercell.nx, s.supercell.ny, s.supercell.nz] : null,
    abc: s.lattice.map((v) => +len(v).toFixed(4)),
    inputs: [...document.querySelectorAll('#latticeAndSupercellGroup .lsc-supercell-input')].map((i) => i.value),
    paletteOpen: document.getElementById('featureSearchOverlay')?.hidden === false,
  };
};

/** The palette's results for a query typed into it, as the user sees them. */
async function typed(page, query) {
  await page.fill('#featureSearchInput', query);
  await page.waitForTimeout(150);
  return page.evaluate(() => [...document.querySelectorAll('#featureSearchResults .feature-search-result')].map((li) => ({
    type: li.dataset.type,
    kind: li.querySelector('.feature-search-kind')?.textContent || '',
    label: li.querySelector('.feature-search-label').textContent,
    path: li.querySelector('.feature-search-path')?.textContent || '',
  })));
}

async function openPalette(page) {
  await page.mouse.click(900, 450); // focus the scene, no control
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(250);
}

(async () => {
  const { browser, page, errors } = await H.launchApp({ firstRunFeatures: true });
  await H.loadDefaultStructure(page);
  const state = () => page.evaluate(STATE);
  // The Cell & Supercell window open, so its fields are built.
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('cell'));
  await page.waitForTimeout(400);
  const unit = await state();
  H.check('the default structure is a 1×1×1 cell; the Cell window fields read 1 1 1',
    unit.atoms > 0 && unit.inputs.join() === '1,1,1', JSON.stringify(unit));
  const n = unit.atoms;

  // ---- "222" -------------------------------------------------------------------------------
  await openPalette(page);
  let list = await typed(page, '222');
  H.check('Ctrl+F "222": the first result builds a 2×2×2 supercell, with the atom counts',
    list[0]?.label === 'Build a 2×2×2 supercell' && list[0]?.type === 'action' && list[0]?.kind === 'Action'
      && list[0]?.path === `Cell & Supercell · ${n} atoms → ${8 * n} atoms`, JSON.stringify(list.slice(0, 3)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const s222 = await state();
  H.check('Enter builds it: 8× the atoms, every lattice vector doubled, the palette closed',
    s222.atoms === 8 * n && s222.supercell?.join() === '2,2,2' && s222.abc.every((v, i) => Math.abs(v - 2 * unit.abc[i]) < 1e-3) && !s222.paletteOpen,
    JSON.stringify({ unit, s222 }));
  H.check('the Cell window fields show the factors (2 2 2)', s222.inputs.join() === '2,2,2', JSON.stringify(s222.inputs));
  const confirm = await page.evaluate(() => document.querySelector('#view .cv-confirm-banner')?.textContent || '');
  H.check('it confirms in green: "✓ 2×2×2 supercell built (104 atoms)"', confirm === `✓ 2×2×2 supercell built (${8 * n} atoms)`, confirm);

  // ---- "232" from the 2×2×2: the same base cell -------------------------------------------
  await openPalette(page);
  list = await typed(page, '232');
  H.check('"232" offers the 2×3×2 supercell, counted from the base cell',
    list[0]?.label === 'Build a 2×3×2 supercell' && list[0]?.path === `Cell & Supercell · ${8 * n} atoms → ${12 * n} atoms`, JSON.stringify(list.slice(0, 2)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const s232 = await state();
  const fromSearch = await page.evaluate(async () => (await import('./state/store.js')).fileBrowser.selectedStructure.atoms.map((a) => a.position.map((v) => v.toFixed(6)).join(',')).join(';'));
  H.check('Enter builds it: 12× the atoms, a 2a × 3b × 2c cell, fields 2 3 2',
    s232.atoms === 12 * n && s232.supercell?.join() === '2,3,2' && s232.inputs.join() === '2,3,2'
      && [2, 3, 2].every((f, i) => Math.abs(s232.abc[i] - f * unit.abc[i]) < 1e-3), JSON.stringify(s232));
  // The same through the Cell window's own Apply: back to 1×1×1, then 2 3 2.
  const viaApply = await page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('#latticeAndSupercellGroup .lsc-supercell-input')];
    const apply = [...document.querySelectorAll('#latticeAndSupercellGroup .lsc-panel-btn')].find((b) => b.textContent === 'Apply');
    const reset = [...document.querySelectorAll('#latticeAndSupercellGroup .lsc-panel-btn')].find((b) => b.textContent === 'Reset');
    reset.click();
    ['2', '3', '2'].forEach((v, i) => { inputs[i].value = v; });
    apply.click();
    return (await import('./state/store.js')).fileBrowser.selectedStructure.atoms.map((a) => a.position.map((v) => v.toFixed(6)).join(',')).join(';');
  });
  H.check('it is the same supercell the Cell window\'s Apply builds', viaApply === fromSearch, `${viaApply.length} vs ${fromSearch.length}`);

  // ---- other spellings, and what is not a supercell -----------------------------------------
  await openPalette(page);
  const offered = {};
  for (const q of ['2x2x1', '2×3×4', '2 2 3', 'supercell 333', '3x3x3 supercell', 'sc 411']) offered[q] = (await typed(page, q))[0]?.label;
  H.check('"2x2x1", "2×3×4", "2 2 3", "supercell 333", "3x3x3 supercell", "sc 411" are offered',
    offered['2x2x1'] === 'Build a 2×2×1 supercell' && offered['2×3×4'] === 'Build a 2×3×4 supercell' && offered['2 2 3'] === 'Build a 2×2×3 supercell'
      && offered['supercell 333'] === 'Build a 3×3×3 supercell' && offered['3x3x3 supercell'] === 'Build a 3×3×3 supercell'
      && offered['sc 411'] === 'Build a 4×1×1 supercell', JSON.stringify(offered));
  const notOffered = {};
  for (const q of ['2', '12', '2222', '202', 'supercell', 'supercell 3', 'sc 2']) notOffered[q] = (await typed(page, q)).filter((r) => /supercell$|1×1×1 cell/.test(r.label) && /^Build|^Back/.test(r.label)).map((r) => r.label);
  H.check('one number ("2", "12", also "supercell 3", "sc 2"), "2222", "202" or the word alone offers no supercell',
    Object.values(notOffered).every((l) => l.length === 0), JSON.stringify(notOffered));
  list = await typed(page, '232');
  H.check('asking for the cell it already is says so', list[0]?.label === 'Build a 2×3×2 supercell' && /it is 2×3×2 now/.test(list[0]?.path), JSON.stringify(list[0]));

  // ---- "111": back to the cell ---------------------------------------------------------------
  list = await typed(page, '111');
  H.check('"111" offers going back to the 1×1×1 cell', list[0]?.label === 'Back to the 1×1×1 cell' && list[0]?.path === `Cell & Supercell · ${12 * n} atoms → ${n} atoms`, JSON.stringify(list[0]));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const back = await state();
  H.check('Enter goes back: the original atom count and lattice, fields 1 1 1',
    back.atoms === n && back.supercell?.join() === '1,1,1' && back.inputs.join() === '1,1,1' && back.abc.every((v, i) => Math.abs(v - unit.abc[i]) < 1e-4), JSON.stringify(back));

  // ---- Apply with an empty field -------------------------------------------------------------
  const emptyField = await page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('#latticeAndSupercellGroup .lsc-supercell-input')];
    const apply = [...document.querySelectorAll('#latticeAndSupercellGroup .lsc-panel-btn')].find((b) => b.textContent === 'Apply');
    inputs[0].value = '2'; inputs[1].value = ''; inputs[2].value = '1';
    apply.click();
    const s = (await import('./state/store.js')).fileBrowser.selectedStructure;
    return { atoms: s.atoms.length, supercell: s.supercell, fields: inputs.map((i) => i.value) };
  });
  H.check('Apply with an empty field counts it as 1 (2 _ 1: twice the atoms, not none)',
    emptyField.atoms === 2 * n && emptyField.supercell.ny === 1 && emptyField.fields.join() === '2,1,1', JSON.stringify(emptyField));

  // ---- no structure: no supercell result -----------------------------------------------------
  const noStructure = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const { searchEntries } = await import('./ui/FeatureSearch.js');
    const saved = fileBrowser.selectedStructure;
    fileBrowser.selectedStructure = null;
    try { return searchEntries('222').filter((r) => r.entry.supercell).length; } finally { fileBrowser.selectedStructure = saved; }
  });
  H.check('without a structure "222" offers no supercell', noStructure === 0, String(noStructure));
  await page.keyboard.press('Escape');

  // ---- a large one: the progress overlay -----------------------------------------------------
  await page.evaluate(async (t) => { await (await import('./core/crystal-viewer.js')).loadStructure(t, 'POSCAR'); }, rutilePoscar(3));
  await page.waitForTimeout(1500);
  await openPalette(page);
  list = await typed(page, '5x5x5');
  H.check('"5x5x5" of 162 atoms offers 20,250 atoms', list[0]?.label === 'Build a 5×5×5 supercell' && /162 atoms → 20,250 atoms/.test(list[0]?.path), JSON.stringify(list[0]));
  await page.evaluate(() => {
    const text = document.getElementById('bootProgressText');
    const overlay = document.getElementById('bootProgress');
    window.__supercellSteps = [];
    const seen = new MutationObserver(() => { if (!overlay.hidden && !window.__supercellSteps.includes(text.textContent)) window.__supercellSteps.push(text.textContent); });
    seen.observe(text, { childList: true, characterData: true, subtree: true });
    seen.observe(overlay, { attributes: true });
  });
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForFunction(async () => (await import('./state/store.js')).fileBrowser.selectedStructure.atoms.length === 20250, null, { timeout: 120000 });
  await page.waitForFunction(() => document.getElementById('bootProgress').hidden, null, { timeout: 60000 });
  const large = await page.evaluate(() => ({ steps: window.__supercellSteps, hidden: document.getElementById('bootProgress').hidden }));
  H.check('a supercell over 20 000 atoms names its step on the progress overlay, which then goes away',
    large.steps.some((s) => /Building the 5×5×5 supercell \(20,250 atoms\)/.test(s)) && large.hidden, JSON.stringify(large) + ` ${Date.now() - t0} ms`);

  H.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
