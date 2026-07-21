// The MD panel's ensemble controls.
//
// This replaced a checkbox labelled "NPT (relax cell)", which was wrong twice
// over: it rendered as an oversized tick that broke the grid, and "relax" is
// what this panel's OTHER top-level mode is called, so the label read as if it
// relaxed the structure. It is now a segmented NVT/NPT switch matching the
// Relax/MD and potential switches, with the pressure and barostat inputs gated
// behind it.
'use strict';
const H = require('../harness');

// Deuterium-free, hydrogen-bearing cell: the timestep default must notice.
const HYDRIDE_POSCAR = `PdH
1.0
4.00 0.00 0.00
0.00 4.00 0.00
0.00 0.00 4.00
Pd H
1 1
Direct
0.0 0.0 0.0
0.5 0.5 0.5
`;

async function openMD(page) {
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('backend');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click());
  await page.waitForTimeout(400);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await openMD(page);

  const initial = await page.evaluate(() => {
    const active = document.querySelector('#mdEnsembleSwitch button.active');
    return {
      hasSwitch: !!document.getElementById('mdEnsembleSwitch'),
      hasOldCheckbox: !!document.getElementById('mdNptChk'),
      active: active?.dataset.ensemble,
      buttons: [...document.querySelectorAll('#mdEnsembleSwitch button')].map((b) => b.textContent.trim()),
      pressureDisabled: document.getElementById('mdPressureInput')?.disabled,
      tauPDisabled: document.getElementById('mdTauPInput')?.disabled,
      tauT: document.getElementById('mdTauTInput')?.value,
      hint: document.getElementById('mdEnsembleHint')?.textContent ?? '',
      timestep: document.getElementById('mdTimestepInput')?.value,
    };
  });

  H.check('the ensemble switch replaced the checkbox',
    initial.hasSwitch && !initial.hasOldCheckbox, JSON.stringify(initial));
  H.check('it offers NVT and NPT, defaulting to NVT',
    initial.buttons.join('/') === 'NVT/NPT' && initial.active === 'nvt',
    JSON.stringify(initial.buttons) + ' active=' + initial.active);
  H.check('NVT gates off the pressure and barostat inputs',
    initial.pressureDisabled === true && initial.tauPDisabled === true, JSON.stringify(initial));
  H.check('NVT explains itself without the word "relax"',
    /fixed/i.test(initial.hint) && !/relax/i.test(initial.hint), initial.hint);
  H.check('thermostat tau defaults to 20 fs', initial.tauT === '20', String(initial.tauT));

  // Switch to NPT.
  const npt = await page.evaluate(() => {
    document.querySelector('#mdEnsembleSwitch button[data-ensemble="npt"]')?.click();
    return {
      active: document.querySelector('#mdEnsembleSwitch button.active')?.dataset.ensemble,
      pressureDisabled: document.getElementById('mdPressureInput')?.disabled,
      tauPDisabled: document.getElementById('mdTauPInput')?.disabled,
      hint: document.getElementById('mdEnsembleHint')?.textContent ?? '',
    };
  });
  H.check('NPT enables pressure and the barostat coupling',
    npt.active === 'npt' && npt.pressureDisabled === false && npt.tauPDisabled === false,
    JSON.stringify(npt));
  H.check('NPT says what it does to the cell, without saying "relax"',
    /volume/i.test(npt.hint) && !/relax/i.test(npt.hint), npt.hint);

  // A barostat as fast as the thermostat is unstable — the hint must say so.
  const warn = await page.evaluate(() => {
    const tauP = document.getElementById('mdTauPInput');
    tauP.value = '50';
    tauP.dispatchEvent(new Event('input'));
    return document.getElementById('mdCouplingHint')?.textContent ?? '';
  });
  H.check('a too-fast barostat tau is called out', /at least/i.test(warn), warn);

  // Timestep must follow the lightest element: 1 fs for a C/O-ish cell is fine,
  // but a hydride needs a smaller one or the X-H stretch is under-integrated.
  const heavyDt = Number(initial.timestep);
  const lightDt = await page.evaluate(async (poscar) => {
    const cv = await import('./core/crystal-viewer.js');
    await cv.loadStructure(poscar, 'PdH.poscar');
    return null;
  }, HYDRIDE_POSCAR).then(async () => {
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="relax"]')?.click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('#BackendModeSwitch button[data-mode="md"]')?.click());
    await page.waitForTimeout(400);
    return page.evaluate(() => Number(document.getElementById('mdTimestepInput')?.value));
  });

  console.log(`  timestep: YBCO ${heavyDt} fs, PdH ${lightDt} fs`);
  H.check('the default timestep shrinks for a hydrogen-bearing cell',
    lightDt < heavyDt && lightDt <= 0.5, `YBCO ${heavyDt} -> PdH ${lightDt}`);
  H.check('the default timestep is a round number',
    [0.25, 0.5, 1, 1.5, 2].includes(heavyDt) && [0.25, 0.5, 1, 1.5, 2].includes(lightDt),
    `YBCO ${heavyDt}, PdH ${lightDt}`);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
