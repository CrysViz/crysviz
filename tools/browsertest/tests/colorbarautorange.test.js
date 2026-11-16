// Colour-bar Auto Range and ticks (Forces and Spins windows).
// Log scale: Auto Range used to pad the linear range by 20%, clamp it at 0
// and then replace that 0 with a fixed 0.01, so every force or moment below
// 0.01 sat on the bottom colour. Now the range is padded in decades from the
// smallest positive value and rounded out to 1, 2 or 5 × 10^k
// (utils/AutoRange.js).
// Linear, small forces of a relaxed structure: Auto Range gave 0 .. 0.0101
// and the ticks, at fixed fractions with two decimals, read "0, 0.01, 0.01";
// switching to log then made it 0.01 .. 0.0101. Now: 0 .. 0.011, ticks at
// round values (utils/ColorBarTicks.js), and log starts below the data.
// Driven through the real Log Scale box and Auto Range button.
'use strict';
const H = require('../harness');

// Forces over 3.5 decades: 0.002 .. 6 eV/Å (and one atom with none).
const XYZ = [
  '5', 'Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 1 1 1   0.002 0 0',
  'Cl 4 1 1   0 0.03 0',
  'Na 1 4 1   0 0 0.5',
  'Cl 4 4 1   6 0 0',
  'Na 1 1 4   0 0 0',
].join('\n');

// Moments from 0.004 to 4 muB.
const MCIF = [
  'data_m', '_space_group_magn.name_BNS  "P1"',
  '_cell_length_a 8', '_cell_length_b 8', '_cell_length_c 8',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  'loop_', '_space_group_symop_magn_operation.id', '_space_group_symop_magn_operation.xyz', '1 x,y,z,+1',
  'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Fe1 Fe 0.1 0.1 0.1', 'Fe2 Fe 0.5 0.1 0.1', 'Fe3 Fe 0.1 0.5 0.1', 'Fe4 Fe 0.5 0.5 0.1',
  'loop_', '_atom_site_moment.label', '_atom_site_moment.crystalaxis_x', '_atom_site_moment.crystalaxis_y', '_atom_site_moment.crystalaxis_z',
  'Fe1 0 0 0.004', 'Fe2 0 0 0.04', 'Fe3 0 0 0.4', 'Fe4 0 0 4', '',
].join('\n');

// Small forces, 0.0001 .. 0.0084 eV/Å, and one atom with none.
const SMALL = [
  '5', 'Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 1 1 1   0.0001 0 0',
  'Cl 4 1 1   0 0.002 0',
  'Na 1 4 1   0 0 0.0084',
  'Cl 4 4 1   0.003 0 0',
  'Na 1 1 4   0 0 0',
].join('\n');

async function setLog(page, logId, on) {
  await page.evaluate(({ logId, on }) => {
    const box = document.getElementById(logId);
    if (box.checked !== on) box.click();
  }, { logId, on });
  await page.waitForTimeout(400);
}

/** Press Auto Range; read the range and the bar's drawn tick labels. */
async function readBar(page, panel, { minKey, maxKey }, press = true) {
  return page.evaluate(async ({ panel, minKey, maxKey, press }) => {
    const body = document.getElementById(`cvPanelBody-${panel}`);
    if (press) {
      [...body.querySelectorAll('.cv-auto-range-btn')].find((b) => b.textContent.trim() === 'Auto Range')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    const { general } = await import('./state/store.js');
    const ticks = [...body.querySelectorAll('.cv-colorbar-tick-label')].map((el) => el.textContent.trim());
    return { min: general[minKey], max: general[maxKey], ticks };
  }, { panel, minKey, maxKey, press });
}

/** Pick a scalar colour map, tick Log Scale, press Auto Range; read the range. */
async function logAutoRange(page, panel, { mapId, logId, minKey, maxKey }) {
  await page.evaluate(async (panel) => (await import('./ui/panels/PanelManager.js')).openPanel(panel), panel);
  await page.waitForTimeout(600);
  await H.setSelect(page, mapId, 'viridis');
  await page.waitForTimeout(400);
  await setLog(page, logId, true);
  return readBar(page, panel, { minKey, maxKey });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'forces.xyz'), XYZ);
  await page.waitForTimeout(1200);
  await H.clickById(page, 'showForcesToggle');
  await page.waitForTimeout(600);
  const forces = await logAutoRange(page, 'forces', {
    mapId: 'forceColorMapSelect', logId: 'forceLogScaleCheckbox', minKey: 'forceMin', maxKey: 'forceMax',
  });
  // 0.002 .. 6 is 3.48 decades; 10% of that (0.35 decade) either side is
  // 0.000897 .. 13.4, rounded out to 1-2-5.
  H.check('forces, log scale: Auto Range starts below the smallest force at a round value (was a fixed 0.01)',
    forces.min === 0.0005 && forces.max === 20, JSON.stringify(forces));
  H.check('forces, log scale: decade ticks, clear of the Min/Max fields',
    JSON.stringify(forces.ticks) === JSON.stringify(['0.01', '0.1', '1']), JSON.stringify(forces));

  // Small forces on a linear bar, then switched to log.
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'small.xyz'), SMALL);
  await page.waitForTimeout(1200);
  await setLog(page, 'forceLogScaleCheckbox', false);
  const lin = await readBar(page, 'forces', { minKey: 'forceMin', maxKey: 'forceMax' });
  H.check('small forces, linear: Auto Range rounds out to 0 .. 0.011 (was 0 .. 0.0101)',
    lin.min === 0 && lin.max === 0.011, JSON.stringify(lin));
  H.check('small forces, linear: distinct round tick labels (were "0, 0.01, 0.01")',
    JSON.stringify(lin.ticks) === JSON.stringify(['0.0025', '0.005', '0.0075']), JSON.stringify(lin));
  await setLog(page, 'forceLogScaleCheckbox', true);
  const toLog = await readBar(page, 'forces', { minKey: 'forceMin', maxKey: 'forceMax' }, false);
  H.check('small forces, switched to log: min drops below the smallest force (was 0.01, above nearly all of them)',
    // (1e-4 would sit under the 5e-5 field, so 1-2-5 values stand in.)
    toLog.min === 0.00005 && toLog.max === 0.011 && JSON.stringify(toLog.ticks) === JSON.stringify(['2e-4', '1e-3']),
    JSON.stringify(toLog));
  const logAuto = await readBar(page, 'forces', { minKey: 'forceMin', maxKey: 'forceMax' });
  H.check('small forces, log Auto Range: 0.00005 .. 0.02',
    logAuto.min === 0.00005 && logAuto.max === 0.02, JSON.stringify(logAuto));

  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'moments.mcif'), MCIF);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const t = document.getElementById('showSpinsToggle'); if (!t.checked) t.click(); });
  await page.waitForTimeout(600);
  const spins = await logAutoRange(page, 'spins', {
    mapId: 'spinColorMapSelect', logId: 'spinLogScaleCheckbox', minKey: 'spinMin', maxKey: 'spinMax',
  });
  // 0.004 and 0.04 μB are under the 0.05 μB draw threshold (no arrow), so
  // the range covers the drawn 0.4 .. 4: a decade, padded 0.1, rounded out.
  H.check('spins, log scale: Auto Range starts below the smallest drawn moment at a round value',
    spins.min === 0.2 && spins.max === 10, JSON.stringify(spins));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
