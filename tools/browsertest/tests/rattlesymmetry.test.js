// Rattle in Wyckoff mode must stay inside the locked symmetry, the same way
// constrained MD/relax do. An unprojected Gaussian kick moves every atom
// independently and an unprojected random strain shears the cell, so a rattle
// used to drop the structure to P1 — including sites that have no freedom to
// move at all.
'use strict';
const H = require('../harness');

// C6N8, hexagonal. The two N sites at (2/3,1/3,3/4) and (1/3,2/3,1/4) are fully
// pinned: the constraint must leave them exactly where they are.
const C6N8_POSCAR = `C6 N8
1.0
   3.2252631334172732   -5.5863196148575156    0.0000000000000000
   3.2252631334172732    5.5863196148575156    0.0000000000000000
   0.0000000000000000    0.0000000000000000    2.4231400000000001
C N
6 8
direct
   0.7732450000000001    0.5949050000000000    0.7500000000000000
   0.4050950000000000    0.1783400000000000    0.7500000000000000
   0.8216599999999991    0.2267549999999990    0.7500000000000000
   0.2267549999999990    0.4050950000000000    0.2500000000000000
   0.5949050000000000    0.8216599999999991    0.2500000000000000
   0.1783400000000000    0.7732450000000001    0.2500000000000000
   0.0333069999999990    0.7034199999999990    0.7500000000000000
   0.2965800000000000    0.3298870000000000    0.7500000000000000
   0.6701130000000000    0.9666929999999990    0.7500000000000000
   0.9666929999999990    0.2965800000000000    0.2500000000000000
   0.7034199999999990    0.6701130000000000    0.2500000000000000
   0.3298870000000000    0.0333069999999990    0.2500000000000000
   0.6666666666666661    0.3333333333333330    0.7500000000000000
   0.3333333333333330    0.6666666666666661    0.2500000000000000
`;

const PINNED = [12, 13];

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Load C6N8 and bring up the Relax body (Relax is the default mode, so a
  // click on it never rebuilds the body — toggle away and back).
  await page.evaluate(async (poscar) => {
    const cv = await import('./core/crystal-viewer.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    await cv.loadStructure(poscar, 'C6N8.poscar');
    openPanel('backend');
  }, C6N8_POSCAR);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="relax"]')?.click());
  await page.waitForTimeout(400);

  const rattle = (opts) => page.evaluate(async ({ lattice, amp }) => {
    const { fileBrowser } = await import('./state/store.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    const s = fileBrowser.selectedStructure;
    const before = {
      positions: s.atoms.map((a) => [...a.position]),
      lattice: s.lattice.map((r) => [...r]),
      group: (await sym.analyzeStructureSymmetry(s, sym.DEFAULT_SYMPREC)).number,
    };

    document.getElementById('relaxRattleLatticeChk').checked = lattice;
    document.getElementById('relaxRattleAmpInput').value = String(amp);
    document.getElementById('relaxRattleBtn').click();
    await new Promise((r) => setTimeout(r, 250));

    const after = {
      positions: s.atoms.map((a) => [...a.position]),
      lattice: s.lattice.map((r) => [...r]),
      group: (await sym.analyzeStructureSymmetry(s, sym.DEFAULT_SYMPREC)).number,
    };
    const moved = before.positions.map((p, i) => Math.max(
      ...[0, 1, 2].map((k) => Math.abs(((after.positions[i][k] - p[k] + 0.5) % 1 + 1) % 1 - 0.5))));
    const cellLengths = (L) => L.map((r) => Math.hypot(r[0], r[1], r[2]));
    return {
      groupBefore: before.group,
      groupAfter: after.group,
      moved,
      maxMoved: Math.max(...moved),
      lengthsBefore: cellLengths(before.lattice),
      lengthsAfter: cellLengths(after.lattice),
    };
  }, opts);

  // --- unconstrained control: a plain rattle does break the symmetry --------
  const free = await rattle({ lattice: false, amp: 0.1 });
  H.check('control: without the Wyckoff lock a rattle leaves the space group',
    free.groupBefore !== free.groupAfter,
    JSON.stringify({ before: free.groupBefore, after: free.groupAfter }));

  // Restore the pristine structure and lock it.
  await page.evaluate(async (poscar) => {
    const cv = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');
    const sym = await import('./ui/SymmetryEditModule.js');
    await cv.loadStructure(poscar, 'C6N8_locked.poscar');
    await sym.activateWyckoffMode(fileBrowser.selectedStructure, sym.DEFAULT_SYMPREC);
  }, C6N8_POSCAR);
  await page.waitForTimeout(300);

  // --- atoms only ------------------------------------------------------------
  const locked = await rattle({ lattice: false, amp: 0.1 });
  H.check('Wyckoff rattle keeps the space group',
    locked.groupAfter === locked.groupBefore,
    JSON.stringify({ before: locked.groupBefore, after: locked.groupAfter }));
  H.check('Wyckoff rattle leaves zero-freedom sites exactly put',
    PINNED.every((i) => locked.moved[i] < 1e-9),
    JSON.stringify(PINNED.map((i) => locked.moved[i])));
  H.check('Wyckoff rattle still moves the sites that are free',
    locked.maxMoved > 1e-4, String(locked.maxMoved));

  // --- atoms + cell ----------------------------------------------------------
  const strained = await rattle({ lattice: true, amp: 0.1 });
  H.check('Wyckoff rattle keeps the space group when the cell is strained too',
    strained.groupAfter === strained.groupBefore,
    JSON.stringify({ before: strained.groupBefore, after: strained.groupAfter }));
  H.check('the strained cell actually changed size',
    Math.abs(strained.lengthsAfter[2] - strained.lengthsBefore[2]) > 1e-4
      || Math.abs(strained.lengthsAfter[0] - strained.lengthsBefore[0]) > 1e-4,
    JSON.stringify({ before: strained.lengthsBefore, after: strained.lengthsAfter }));
  // Hexagonal: |a| and |b| have to stay equal to each other through the strain.
  H.check('the symmetrized strain keeps |a| = |b|',
    Math.abs(strained.lengthsAfter[0] - strained.lengthsAfter[1]) < 1e-9,
    JSON.stringify(strained.lengthsAfter));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
