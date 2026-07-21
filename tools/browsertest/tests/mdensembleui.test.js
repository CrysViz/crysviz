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

  // ---- Simulated Annealing: expanding it IS the switch, so say so ----------
  const anneal = await page.evaluate(async () => {
    const card = document.querySelector('#cvPanelBody-backend .atomistic-card');
    const kids = [...card.children];
    const annealIdx = kids.findIndex((k) => k.querySelector('#mdAnnealHeader'));
    const buttonIdx = kids.findIndex((k) => k.querySelector('#mdStartBtn'));
    const header = document.getElementById('mdAnnealHeader');
    const badge = document.getElementById('mdAnnealBadge');
    const title = header.querySelector('.atomistic-anneal-title');

    const collapsed = {
      active: header.classList.contains('active'),
      badgeOpacity: getComputedStyle(badge).opacity,
      hint: document.getElementById('mdAnnealHint')?.textContent ?? '',
    };
    header.click();
    // The badge fades in over 120 ms; computed opacity mid-transition is still 0.
    await new Promise((r) => setTimeout(r, 250));
    const expanded = {
      active: header.classList.contains('active'),
      badgeOpacity: getComputedStyle(badge).opacity,
      badgeText: badge.textContent.trim(),
      titleColor: getComputedStyle(title).color,
      hint: document.getElementById('mdAnnealHint')?.textContent ?? '',
    };
    return { annealIdx, buttonIdx, collapsed, expanded };
  });

  H.check('start/stop sit below the annealing section',
    anneal.buttonIdx > anneal.annealIdx && anneal.annealIdx >= 0,
    `anneal at ${anneal.annealIdx}, buttons at ${anneal.buttonIdx}`);
  H.check('collapsed annealing shows no "on" badge',
    anneal.collapsed.active === false && anneal.collapsed.badgeOpacity === '0',
    JSON.stringify(anneal.collapsed));
  H.check('expanding annealing marks it on',
    anneal.expanded.active === true && anneal.expanded.badgeOpacity === '1'
      && anneal.expanded.badgeText === 'on',
    JSON.stringify(anneal.expanded));
  // The green is the whole point of the badge — check the channel, not the exact string.
  const green = anneal.expanded.titleColor.match(/\d+/g)?.map(Number) ?? [];
  H.check('the annealing header turns green while it applies',
    green.length >= 3 && green[1] > green[0] && green[1] > 150,
    anneal.expanded.titleColor);
  H.check('it spells out the schedule that overrides the fixed temperature',
    /start/i.test(anneal.expanded.hint) && /K/.test(anneal.expanded.hint),
    anneal.expanded.hint);

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
