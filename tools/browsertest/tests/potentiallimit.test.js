// In-browser potentials have hard size limits (atomistic/potentialLimits.js):
// past its 2 GB wasm heap NEP aborts and stays dead for the session (17,576 Si
// atoms evaluate, 21,952 abort), PET-MAD needs ~2.5 MB per atom of its 4 GB.
// Checks: the runners refuse an oversized structure BEFORE it reaches the wasm
// and still work afterwards (main-thread NEP and the NEP worker); with PET-MAD
// selected and a 1,625-atom cell the Relax and MD panels say so on opening, and
// EFS / Relax / MD start refuse without creating a trajectory row.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const limits = await page.evaluate(async () => {
    const L = await import('./atomistic/potentialLimits.js');
    return {
      nep: L.potentialAtomLimit('nep'),
      mlip: L.potentialAtomLimit('mlip'),
      ase: L.potentialAtomLimit('ase'),
      okAtLimit: L.potentialSizeProblem('nep', 15000) === null,
      msg: L.potentialSizeProblem('mlip', 1625),
    };
  });
  H.check('limits: NEP 15,000, PET-MAD 1,000, ASE unlimited', limits.nep === 15000 && limits.mlip === 1000
    && limits.ase === Infinity && limits.okAtLimit, JSON.stringify(limits));
  H.check('the refusal names the potential, the limit and the atom count',
    /PET-MAD/.test(limits.msg) && /1,000/.test(limits.msg) && /1,625/.test(limits.msg), limits.msg);

  const runners = await page.evaluate(async () => {
    const { general, fileBrowser } = await import('./state/store.js');
    general.atomisticPotential = 'nep';
    const { ensureCalculatorRunner } = await import('./ui/BackendPanel/AtomisticPanels.js');
    const { buildNEPStructure } = await import('./atomistic/relaxer.js');
    const { runner } = await ensureCalculatorRunner(() => {});
    const small = buildNEPStructure(runner, fileBrowser.selectedStructure);
    const n = 15001;
    const big = {
      lattice: [[100, 0, 0], [0, 100, 0], [0, 0, 100]],
      positions: Array.from({ length: n }, (_, i) => [(i % 25) * 4, (Math.floor(i / 25) % 25) * 4, Math.floor(i / 625) * 4]),
      types: new Array(n).fill(small.types[0]),
    };
    const out = {};
    try { await runner.compute(big); out.mainRefused = false; } catch (e) { out.mainRefused = e.code === 'POTENTIAL_TOO_MANY_ATOMS'; out.mainMsg = e.message; }
    out.mainStillWorks = Number.isFinite((await runner.compute(small)).total_energy);
    const c = await import('./atomistic/nepWorkerClient.js');
    const ev = c.createWorkerNEPForceEvaluator();
    try { await ev(big); out.workerRefused = false; } catch (e) { out.workerRefused = e.code === 'POTENTIAL_TOO_MANY_ATOMS'; }
    out.workerStillWorks = Number.isFinite((await ev(small)).total_energy);
    return out;
  });
  H.check('main-thread NEP refuses 15,001 atoms before the wasm sees them', runners.mainRefused, JSON.stringify(runners));
  H.check('main-thread NEP still evaluates a small cell afterwards', runners.mainStillWorks, JSON.stringify(runners));
  H.check('the NEP worker refuses 15,001 atoms', runners.workerRefused, JSON.stringify(runners));
  H.check('the NEP worker still evaluates a small cell afterwards', runners.workerStillWorks, JSON.stringify(runners));

  const ui = await page.evaluate(async () => {
    const { general, structureShip } = await import('./state/store.js');
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    createSupercell(5, 5, 5); // 1,625 atoms: over PET-MAD's limit, well under NEP's
    await new Promise((r) => setTimeout(r, 500));
    general.atomisticPotential = 'mlip';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 300));
    const sw = (mode) => document.querySelector(`#BackendModeSwitch button[data-mode="${mode}"]`)?.click();
    const out = {};
    sw('md'); await new Promise((r) => setTimeout(r, 300));
    sw('relax'); await new Promise((r) => setTimeout(r, 300));
    out.relaxNotice = document.body.innerText.includes('limited to 1,000 atoms');
    const rows0 = structureShip.container.length;
    document.getElementById('relaxEfsCard')?.click();
    await new Promise((r) => setTimeout(r, 300));
    out.efsRefused = /EFS failed: PET-MAD .*limited to 1,000/.test(document.body.innerText);
    document.getElementById('relaxBtn')?.click();
    await new Promise((r) => setTimeout(r, 300));
    out.relaxRefused = /Relax failed: PET-MAD .*limited to 1,000/.test(document.body.innerText);
    sw('md'); await new Promise((r) => setTimeout(r, 300));
    out.mdNotice = document.body.innerText.includes('limited to 1,000 atoms');
    const start = document.getElementById('mdStartBtn');
    start.click();
    await new Promise((r) => setTimeout(r, 800));
    out.mdRefused = /MD failed: PET-MAD .*limited to 1,000/.test(document.body.innerText);
    out.startReenabled = !start.disabled;
    out.rowsAdded = structureShip.container.length - rows0;
    general.atomisticPotential = 'nep';
    return out;
  });
  H.check('Relax panel says on opening that the cell is too big for PET-MAD', ui.relaxNotice, JSON.stringify(ui));
  H.check('EFS is refused with the size message', ui.efsRefused, JSON.stringify(ui));
  H.check('Relax is refused with the size message', ui.relaxRefused, JSON.stringify(ui));
  H.check('MD panel says on opening that the cell is too big', ui.mdNotice, JSON.stringify(ui));
  H.check('MD start is refused, the button comes back, and no trajectory row is created',
    ui.mdRefused && ui.startReenabled && ui.rowsAdded === 0, JSON.stringify(ui));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})();
