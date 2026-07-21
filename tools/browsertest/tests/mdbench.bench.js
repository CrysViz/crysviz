// MD throughput benchmark: how many steps/s does a ~1300-atom cell get, and
// where does the time go? Drives the real MD panel button — so the viewer
// update, the trajectory save and the live plot are all inside the measurement
// — with general.mdProfile on, and echoes the profile MD.js prints.
//
// Not a pass/fail test, it prints a table. Run before and after a change:
//   tools/browsertest/run.sh tests/mdbench.bench.js
'use strict';
const H = require('../harness');

// YBCO (13 atoms) tiled 5x5x4 = 1300 atoms.
const NX = 5;
const NY = 5;
const NZ = 4;
const STEPS = 60;
// MDBENCH_WORKER=0 runs the potential on the main thread, for an A/B against
// the worker path.
const USE_WORKER = process.env.MDBENCH_WORKER !== '0';

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Echo the in-page profile (and nothing else) to the test output.
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[MD profile]')) console.log(text.split('\n').map((l) => `  ${l}`).join('\n'));
    // Surface the worker falling back — it silently halves the point of the run.
    if (text.includes('NEP worker')) console.log(`  WARN ${text}`);
  });

  await H.loadDefaultStructure(page);

  const built = await page.evaluate(async ({ nx, ny, nz, useWorker }) => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { fileBrowser, general } = await import('./state/store.js');
    general.mdProfile = true;
    general.mdWorker = useWorker;
    createSupercell(nx, ny, nz);
    return { atoms: fileBrowser.selectedStructure.atoms.length };
  }, { nx: NX, ny: NY, nz: NZ, useWorker: USE_WORKER });
  console.log(`  structure: ${built.atoms} atoms (${NX}x${NY}x${NZ} supercell), `
    + `NEP ${USE_WORKER ? 'in worker' : 'on main thread'}`);

  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('backend');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click());
  await page.waitForTimeout(400);

  const run = await page.evaluate(async (steps) => {
    const stepsInput = document.getElementById('mdStepsInput');
    const startBtn = document.getElementById('mdStartBtn');
    if (!stepsInput || !startBtn) return { error: 'MD controls not found' };
    stepsInput.value = String(steps);

    // The button re-enables in the run's finally block. The first click also
    // pays for loading the 14.9 MB NEP model, so allow a generous deadline.
    startBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    const deadline = Date.now() + 10 * 60 * 1000;
    while (startBtn.disabled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const resultEl = document.querySelector('#BackendPanel .atomistic-result, #mdResult');
    return { finished: !startBtn.disabled, result: resultEl?.textContent ?? '' };
  }, STEPS);

  console.log(`  run: ${JSON.stringify(run)}`);
  H.check('the MD run finished', run.finished === true, JSON.stringify(run));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
