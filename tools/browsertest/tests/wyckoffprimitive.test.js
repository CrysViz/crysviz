// Wyckoff site chooser on a PRIMITIVE cell.
//
// Si is loaded explicitly rather than taken from the app's startup default: this
// file is about an F-centred cell whose primitive form is 4x smaller than the
// conventional one, and the default (Pnnm C3N4) has no centring to test.
//
// Si is the 2-atom primitive FCC cell of diamond, Fd-3m. Tabulated Wyckoff
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
  await H.loadDefaultStructure(page, 'defaultPOSCAR5', 'Si');

  const start = await page.evaluate(async () => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    return { atoms: s?.atoms.length, elements: s?.uniqueElements };
  });
  H.check('the loaded structure is the 2-atom primitive Si cell',
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
    const promised = panel.querySelector('.wyckoff-add-preview').textContent.match(/^(\d+) atom/);
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

  // --- An existing orbit's site is editable, like its element and colour ----
  // Every cell of a row has to be a control; the site used to be a dead label,
  // so a frozen coordinate had no route to becoming free.
  const moved = await page.evaluate(async (sel) => {
    const { fileBrowser } = await import('./state/store.js');
    const s = fileBrowser.selectedStructure;
    const panel = document.querySelector(sel);
    const row = [...panel.querySelectorAll('tr')].find((r) => r.querySelector('.orbit-element'));
    const select = /** @type {HTMLSelectElement} */ (row.querySelector('.orbit-site'));
    const before = {
      enabled: !select.disabled,
      value: select.value,
      atoms: s.atoms.length,
      orbits: s.symmetry.orbitGroups.length,
      // Si sits on 'a', which is fixed: all three coordinates are frozen.
      frozen: ['x', 'y', 'z'].map((axis) => row.querySelector(`.orbit-${axis}`).disabled),
    };

    select.value = 'g'; // one free parameter, 24 atoms here
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const movedRow = [...panel.querySelectorAll('tr')].find((r) => r.querySelector('.orbit-element'));
    const orbit = s.symmetry.orbitGroups.find((g) => g.orbitId === 0);
    return {
      before,
      after: {
        atoms: s.atoms.length,
        orbits: s.symmetry.orbitGroups.length,
        label: orbit ? `${orbit.multiplicity}${orbit.wyckoff}` : null,
        element: orbit ? orbit.element : null,
        rowIndex: [...panel.querySelectorAll('tr')].filter((r) => r.querySelector('.orbit-element')).indexOf(movedRow),
        frozen: ['x', 'y', 'z'].map((axis) => movedRow.querySelector(`.orbit-${axis}`).disabled),
        stillWyckoff: s.symmetry.mode === 'wyckoff',
        indicesInRange: s.symmetry.orbitGroups.every((g) =>
          g.atomIndices.every((i) => i >= 0 && i < s.atoms.length)),
      },
    };
  }, MODIFY);
  H.check('an existing orbit\'s site is a live control, not a label',
    moved.before.enabled && moved.before.value === 'a'
      && moved.before.frozen.join() === 'true,true,true',
    JSON.stringify(moved.before));
  H.check('changing the site re-expands the orbit and frees a coordinate',
    moved.after.label === '24g' && moved.after.element === 'Si'
      // the 2-atom orbit becomes 24, the Ge one added above is untouched
      && moved.after.atoms === moved.before.atoms + 22
      && moved.after.orbits === moved.before.orbits
      && moved.after.stillWyckoff && moved.after.indicesInRange,
    JSON.stringify(moved.after));
  // 24g is "x,x,z": x and z are typed, y follows x. The lock on its own reports
  // all three free (its freedom has a component along each), which left every
  // box editable and let y be typed independently of x.
  H.check('only the site\'s independent coordinates are editable',
    moved.after.frozen.join() === 'false,true,false', JSON.stringify(moved.after));
  H.check('the moved orbit keeps its row position', moved.after.rowIndex === 0,
    JSON.stringify(moved.after));

  // --- NaCl: centred cells whose orbits are not stored as the table's point --
  // Fm-3m 4b is tabulated as 1/2,0,0. The agreement test used to compare only
  // each orbit's first atom with that point, so a Cl orbit represented by
  // 1/2,1/2,1/2 rejected the whole lock and left the chooser disabled at "free"
  // - on the primitive cell AND on the conventional one Conv. Cell produces.
  const NACL_PRIMITIVE = 'NaCl primitive\n1.0\n0 2.82 2.82\n2.82 0 2.82\n2.82 2.82 0\nNa Cl\n1 1\nDirect\n0 0 0\n0.5 0.5 0.5\n';

  const loadPoscar = async (poscar, label) => {
    await page.evaluate(async ({ poscar, label }) => {
      const cv = await import('./core/crystal-viewer.js');
      await cv.loadStructure(poscar, label);
    }, { poscar, label });
    await page.waitForTimeout(2000);
    await page.evaluate(async () => {
      const pm = await import('./ui/panels/PanelManager.js');
      pm.openPanel('symmetry');
    });
    await page.waitForTimeout(1500);
  };

  // Enabling the editor removes any Modify panel left from the previous
  // structure, so the wait below cannot be satisfied by a stale chooser.
  const lockAndReadChooser = async () => {
    await H.clickById(page, 'getWyckoffBtn');
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      /** @type {HTMLElement} */ (document.getElementById('addButton')).click();
    });
    await page.waitForFunction((sel) => {
      const select = document.querySelector(`${sel} #wyckoffNewSite`);
      return select && (select.options.length > 1
        || document.querySelector(`${sel} #wyckoffNewForm`)?.textContent === 'free');
    }, MODIFY, { timeout: 40000 });
    return page.evaluate(async (sel) => {
      const { fileBrowser } = await import('./state/store.js');
      const s = fileBrowser.selectedStructure;
      const select = /** @type {HTMLSelectElement} */ (document.querySelector(`${sel} #wyckoffNewSite`));
      return {
        atoms: s.atoms.length,
        group: s.symmetry?.number,
        orbits: s.symmetry?.orbitGroups.map((o) => `${o.element}${o.multiplicity}${o.wyckoff}`),
        enabled: !select.disabled,
        labels: [...select.options].map((option) => option.textContent),
      };
    }, MODIFY);
  };

  // Picked the way a user does - selectOption refuses a disabled control.
  const pickAndAdd = async (letter, element) => {
    await page.selectOption(`${MODIFY} #wyckoffNewSite`, letter);
    await page.fill(`${MODIFY} #wyckoffNewElement`, element);
    return page.evaluate(async (sel) => {
      const { fileBrowser } = await import('./state/store.js');
      const s = fileBrowser.selectedStructure;
      const panel = document.querySelector(sel);
      const value = /** @type {HTMLSelectElement} */ (panel.querySelector('#wyckoffNewSite')).value;
      const form = panel.querySelector('#wyckoffNewForm').textContent;
      const before = s.atoms.length;
      /** @type {HTMLElement} */ (panel.querySelector('#wyckoffAddSite')).click();
      const last = s.symmetry.orbitGroups.at(-1);
      return { value, form, landed: s.atoms.length - before, orbit: `${last.element}${last.multiplicity}${last.wyckoff}` };
    }, MODIFY);
  };

  await loadPoscar(NACL_PRIMITIVE, 'NaCl');
  const nacl = await lockAndReadChooser();
  H.check('primitive NaCl locks as Fm-3m with Na on a and Cl on b',
    nacl.atoms === 2 && nacl.group === 225 && nacl.orbits.join() === 'Na1a,Cl1b',
    JSON.stringify(nacl));
  // 4b itself is left out here: in primitive coordinates 1/2,0,0 is another site.
  H.check('primitive NaCl still offers several Wyckoff sites',
    nacl.enabled && nacl.labels.includes('1a (m-3m)') && nacl.labels.includes('2c (-43m)'),
    JSON.stringify(nacl.labels));
  const picked = await pickAndAdd('c', 'Na');
  H.check('the chosen site sticks and adds what it offers',
    picked.value === 'c' && picked.form === '1/4,1/4,1/4'
      && picked.landed === 2 && picked.orbit === 'Na2c',
    JSON.stringify(picked));

  await loadPoscar(NACL_PRIMITIVE, 'NaCl');
  await H.clickById(page, 'getConvBtn');
  await page.waitForTimeout(2500);
  const conv = await lockAndReadChooser();
  H.check('conventional NaCl (Conv. Cell) offers every Fm-3m site',
    conv.atoms === 8 && conv.orbits.join() === 'Na4a,Cl4b' && conv.enabled
      && conv.labels.includes('4b (m-3m)') && conv.labels.includes('8c (-43m)'),
    JSON.stringify(conv));
  const convPicked = await pickAndAdd('c', 'Na');
  H.check('on the conventional cell the chosen site sticks and adds 8 atoms',
    convPicked.value === 'c' && convPicked.landed === 8 && convPicked.orbit === 'Na8c',
    JSON.stringify(convPicked));

  // Checking any atom of an orbit must not let a cell in another origin
  // through: the same rock salt shifted by 1/4,1/4,1/4 has no atom on a
  // tabulated a or b point, so the letters mean nothing in its coordinates.
  await loadPoscar(`NaCl shifted origin\n1.0\n5.64 0 0\n0 5.64 0\n0 0 5.64\nNa Cl\n4 4\nDirect\n${
    ['0.25 0.25 0.25', '0.25 0.75 0.75', '0.75 0.25 0.75', '0.75 0.75 0.25',
      '0.75 0.75 0.75', '0.75 0.25 0.25', '0.25 0.75 0.25', '0.25 0.25 0.75'].join('\n')}\n`, 'NaCl shifted');
  const shifted = await lockAndReadChooser();
  H.check('a cell in a different origin still falls back to free coordinates',
    shifted.group === 225 && !shifted.enabled && shifted.labels.join() === 'free',
    JSON.stringify(shifted));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
