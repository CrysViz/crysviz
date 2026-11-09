// VASP 4 POSCARs (no line of element symbols; io/ReadPOSCARModule.js
// speciesForVasp4) and the protostructure label of the structure in issue
// #156 (ui/BackendPanel/MoyoWASM.js anonymousFormula).
//
// Fixture: an AFLOW CONTCAR (C11N4, ICSD 184896) — counts straight after the
// lattice, the element after each atom's coordinates, the formula in the title.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../harness');

const AFLOW = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tests', 'wav_dat', 'formats', 'C11N4_aflow_CONTCAR.vasp'), 'utf8');
// The same file without the per-atom labels: species must come from the title.
const NO_LABELS = AFLOW.split('\n').map((l) => l.replace(/^(\s*-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+)\s+[A-Z][a-z]?\s*$/, '$1')).join('\n');
// ...and with a title that names no elements: nothing to go on.
const NO_SPECIES = NO_LABELS.replace(/^[^\n]*/, 'POSCAR');

async function load(page, text, name) {
  return page.evaluate(async ({ text, name }) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');
    try {
      await cv.loadStructure(text, name);
    } catch (e) {
      document.getElementById('loadErrorModal')?.remove();
      return { error: String(e?.message || e) };
    }
    const s = fileBrowser.selectedStructure;
    return { elements: [...s.elements], lattice: s.lattice };
  }, { text, name });
}

const countsOf = (els) => els.reduce((m, e) => ({ ...m, [e]: (m[e] || 0) + 1 }), {});

(async () => {
  const { browser, page, errors } = await H.launchApp();
  page.on('dialog', (d) => d.accept());

  // ---- the AFLOW file as written ----------------------------------------------
  const a = await load(page, AFLOW, 'CONTCAR.relax.vasp');
  H.check('AFLOW CONTCAR loads', !a.error, a.error);
  H.check('11 C then 4 N, from the labels after the coordinates',
    !a.error && a.elements.length === 15 && a.elements.slice(0, 11).every((e) => e === 'C')
      && a.elements.slice(11).every((e) => e === 'N'), JSON.stringify(a.elements));
  H.check('lattice read (a = 3.540, c = 6.999)', !a.error && Math.abs(a.lattice[0][0] - 3.5402) < 1e-3
    && Math.abs(a.lattice[2][2] - 6.9989) < 1e-3, JSON.stringify(a.lattice));

  // ---- issue #156: letters follow the element order -----------------------------
  await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).openPanel('symmetry'));
  await page.waitForTimeout(1500);
  await H.clickById(page, 'getSymBtn');
  await page.waitForTimeout(500);
  const proto = await page.evaluate(() => document.querySelector('#symResult .sym-proto-value')?.textContent.trim());
  H.check('protostructure label is A11B4_tP15_111_1a1c1d1m1n_1n:C-N (issue #156)',
    proto === 'A11B4_tP15_111_1a1c1d1m1n_1n:C-N', proto);

  // ---- no labels: the title's formula names the species ------------------------
  const b = await load(page, NO_LABELS, 'no_labels.vasp');
  H.check('without labels, species come from the title formula',
    !b.error && JSON.stringify(countsOf(b.elements)) === JSON.stringify({ C: 11, N: 4 })
      && b.elements[0] === 'C' && b.elements[14] === 'N', b.error || JSON.stringify(countsOf(b.elements)));

  // ---- nothing names the species: a clear error, not a guess --------------------
  const c = await load(page, NO_SPECIES, 'no_species.vasp');
  H.check('no labels and a title like "POSCAR": refused with a VASP 4 message',
    !!c.error && /VASP 4/.test(c.error), JSON.stringify(c));

  // ---- VASP 5 files are unchanged ------------------------------------------------
  const d = await load(page, fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tests', 'wav_dat', 'formats', 'Si.poscar'), 'utf8'), 'Si.poscar');
  H.check('a VASP 5 POSCAR still loads', !d.error && d.elements.length > 0 && d.elements.every((e) => e === 'Si'),
    d.error || JSON.stringify(d.elements));

  // The refused file logs its own load error; anything else is unexpected.
  const unexpected = errors.filter((e) => !e.includes('Failed to load structure "no_species.vasp"'));
  H.check('no other page errors', unexpected.length === 0, unexpected.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
