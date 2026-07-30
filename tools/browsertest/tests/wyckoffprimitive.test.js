// Wyckoff site chooser on a PRIMITIVE cell — the app's own startup structure.
//
// Si loads as the 2-atom primitive FCC cell of diamond, Fd-3m. Tabulated Wyckoff
// multiplicities are quoted for the conventional cell (8 atoms), so an equality
// test against them rejected every primitive structure and the Add Site chooser
// fell back to "free" — which is what a user hit. It only worked after
// converting to the conventional cell.
//
// What has to hold instead: sites are offered with the count they really produce
// in THIS cell (8a becomes 2a), and a site is offered only when its tabulated
// coordinates still mean that site here. Fd-3m's x,x,x sites survive the
// centring transform; 8b/16d/48f do not, and offering them would put an atom
// somewhere other than the site it was named after.
'use strict';
const H = require('../harness');

const MODIFY = '[data-panel-id="modifyStructure"]';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.waitForTimeout(2500); // the app loads Si by itself

  const start = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return { atoms: s?.atoms.length, elements: s?.uniqueElements };
  });
  H.check('startup structure is the 2-atom primitive Si cell',
    start.atoms === 2 && start.elements.join() === 'Si', JSON.stringify(start));

  await page.evaluate(async () => {
    const pm = await import('./ui/panels/PanelManager.js');
    pm.openPanel('symmetry');
  });
  await page.waitForTimeout(1500);
  await H.clickById(page, 'getWyckoffBtn');
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
  });
  await page.waitForTimeout(600);

  const locked = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return {
      group: s.symmetry?.number,
      ratio: s.symmetry?.conventionalCellRatio,
      orbits: s.symmetry?.orbitGroups.map((o) => `${o.multiplicity}${o.wyckoff}`),
      orbitRows: document.querySelectorAll(`${sel} .orbit-element`).length,
    };
  }, MODIFY);
  H.check('primitive Fd-3m locks as one 2-atom orbit, conventional cell 4x larger',
    locked.group === 227 && locked.ratio === 4
      && locked.orbits.join() === '2a' && locked.orbitRows === 1,
    JSON.stringify(locked));

  // The site list needs the 8.9 MB tables, fetched when the locked body mounts.
  await page.waitForFunction((sel) => {
    const select = document.querySelector(`${sel} #wyckoffNewSite`);
    return select && (select.options.length > 1
      || document.querySelector(`${sel} #wyckoffNewForm`)?.textContent === 'free');
  }, MODIFY, { timeout: 40000 });

  const offered = await page.evaluate(async (sel) => {
    const select = /** @type {HTMLSelectElement} */ (document.querySelector(`${sel} #wyckoffNewSite`));
    return {
      enabled: !select.disabled,
      labels: [...select.options].map((option) => option.textContent),
      letters: [...select.options].map((option) => option.value).filter(Boolean),
    };
  }, MODIFY);
  H.check('a primitive cell still offers Wyckoff sites, counted for ITS cell',
    offered.enabled && offered.labels.includes('2a (-43m)') && offered.labels.includes('8e (.3m)'),
    JSON.stringify(offered.labels));
  // 8b, 16d and 48f are the Fd-3m sites whose coordinates do not survive the
  // centring transform. Naming them here is the point: they must be absent
  // rather than silently placing an atom off-site.
  H.check('sites that cannot be expressed in this cell are left out',
    !offered.letters.includes('b') && !offered.letters.includes('d') && !offered.letters.includes('f')
      && offered.letters.includes('e'),
    JSON.stringify(offered.letters));

  // Every offered site must deliver exactly the count it advertises, on a
  // position that site actually allows.
  const added = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    const select = /** @type {HTMLSelectElement} */ (panel.querySelector('#wyckoffNewSite'));
    select.value = 'e'; // 32e conventionally, "x,x,x" -> 8 atoms here
    select.dispatchEvent(new Event('change', { bubbles: true }));
    /** @type {HTMLInputElement} */ (panel.querySelector('#wyckoffNewElement')).value = 'Ge';
    const x = /** @type {HTMLInputElement} */ (panel.querySelector('#wyckoffNewX'));
    x.value = '0.31';
    x.dispatchEvent(new Event('change', { bubbles: true }));

    const form = panel.querySelector('#wyckoffNewForm').textContent;
    const frozen = ['X', 'Y', 'Z'].map((axis) => panel.querySelector(`#wyckoffNew${axis}`).disabled);
    const coords = ['X', 'Y', 'Z'].map((axis) => panel.querySelector(`#wyckoffNew${axis}`).value);
    const promised = panel.textContent.match(/Adds (\d+) atom/);
    const before = s.atoms.length;
    /** @type {HTMLElement} */ (panel.querySelector('#wyckoffAddSite')).click();
    const last = s.symmetry.orbitGroups.at(-1);

    return {
      form, frozen, coords,
      promised: promised ? Number(promised[1]) : null,
      landed: s.atoms.length - before,
      orbit: `${last.multiplicity}${last.wyckoff}`,
      elements: [...new Set(last.atomIndices.map((i) => s.elements[i]))],
      stillWyckoff: s.symmetry.mode === 'wyckoff',
      indicesInRange: s.symmetry.orbitGroups.every((g) =>
        g.atomIndices.every((i) => i >= 0 && i < s.atoms.length)),
    };
  }, MODIFY);
  H.check('choosing a site drives the dependent coordinates from the free one',
    added.form === 'x,x,x' && added.frozen.join() === 'false,true,true'
      && added.coords.every((value) => Number(value) === 0.31),
    JSON.stringify(added));
  H.check('the site adds exactly what it promised, labelled with its letter',
    added.promised === 8 && added.landed === 8 && added.orbit === '8e'
      && added.elements.join() === 'Ge' && added.stillWyckoff && added.indicesInRange,
    JSON.stringify(added));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
