// Relax panel "Rattle" section: applies a random Gaussian displacement to the
// atoms (default 0.1 Å) and, when the lattice box is checked, a small random
// cell strain (±2%). Atoms move; the cell only changes when the box is ticked.
'use strict';
const H = require('../harness');

const snapshot = (page) => page.evaluate(async () => {
  const { fileBrowser } = await import('./state/store.js');
  const s = fileBrowser.selectedStructure;
  return {
    positions: s.atoms.map((a) => [...a.position]),
    lattice: s.lattice.map((r) => [...r]),
  };
});

function maxDelta(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < a[i].length; k++) m = Math.max(m, Math.abs(a[i][k] - b[i][k]));
  return m;
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(400);

  // Open the Atomistic (backend) panel, then switch to the Relax body.
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('backend');
  });
  await page.waitForTimeout(300);
  // Relax is the default active mode, so clicking it is a no-op that never
  // renders the body; toggle to MD and back to force the relax body to build.
  await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="relax"]')?.click());
  await page.waitForTimeout(400);

  const ui = await page.evaluate(() => ({
    hasBtn: !!document.getElementById('relaxRattleBtn'),
    hasAmp: !!document.getElementById('relaxRattleAmpInput'),
    ampDefault: document.getElementById('relaxRattleAmpInput')?.value,
    hasLatticeChk: !!document.getElementById('relaxRattleLatticeChk'),
  }));
  H.check('Rattle section present (button, displacement input default 0.1, lattice checkbox)',
    ui.hasBtn && ui.hasAmp && ui.ampDefault === '0.1' && ui.hasLatticeChk, JSON.stringify(ui));

  // --- rattle atoms only (lattice box unchecked) ---
  const before = await snapshot(page);
  await page.evaluate(() => {
    document.getElementById('relaxRattleLatticeChk').checked = false;
    document.getElementById('relaxRattleAmpInput').value = '0.1';
    document.getElementById('relaxRattleBtn').click();
  });
  await page.waitForTimeout(200);
  const afterAtoms = await snapshot(page);

  const atomMove = maxDelta(before.positions, afterAtoms.positions);
  const latticeMove1 = maxDelta(before.lattice, afterAtoms.lattice);
  H.check('atoms are displaced by the rattle', atomMove > 1e-4, `maxFracDelta=${atomMove}`);
  H.check('lattice is untouched when the box is unchecked', latticeMove1 === 0, `latticeDelta=${latticeMove1}`);

  // --- rattle with lattice box checked -> cell changes too ---
  const before2 = await snapshot(page);
  await page.evaluate(() => {
    document.getElementById('relaxRattleLatticeChk').checked = true;
    document.getElementById('relaxRattleBtn').click();
  });
  await page.waitForTimeout(200);
  const after2 = await snapshot(page);
  const latticeMove2 = maxDelta(before2.lattice, after2.lattice);
  // ±2% strain on cell vectors of length ~a few Å -> changes well above 1e-3 Å,
  // but bounded (not a wild distortion).
  const maxLatMag = Math.max(...before2.lattice.flat().map(Math.abs));
  H.check('lattice changes when the box is checked', latticeMove2 > 1e-3, `latticeDelta=${latticeMove2}`);
  H.check('lattice strain stays small (<= ~5% of the largest cell component)',
    latticeMove2 <= maxLatMag * 0.05 + 1e-6, `delta=${latticeMove2}, maxComp=${maxLatMag}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
