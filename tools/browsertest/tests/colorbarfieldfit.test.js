// Colour-bar Min/Max fields fit their value from the start (Forces, Spins).
// The Forces and Spins windows build their content as they expand, before
// the body is shown, where a field cannot measure its own text; the width
// came from a canvas estimate alone. In Chrome the number field's spinner
// took ~15px of the text room the estimate did not count, so a log-scale
// Min such as 5e-4 (or a stored 0.12, shown as "0.1") was cut off until a
// focus/blur re-measured the laid-out field.
'use strict';
const H = require('../harness');

// Forces 0.002 .. 6 eV/Å: log Auto Range 0.0005 .. 20.
const XYZ = [
  '5', 'Lattice="8 0 0 0 8 0 0 0 8" Properties=species:S:1:pos:R:3:forces:R:3',
  'Na 1 1 1   0.002 0 0',
  'Cl 4 1 1   0 0.03 0',
  'Na 1 4 1   0 0 0.5',
  'Cl 4 4 1   6 0 0',
  'Na 1 1 4   0 0 0',
].join('\n');

// Moments 0.06 .. 4 muB: log Auto Range 0.02 .. 10.
const MCIF = [
  'data_m', '_space_group_magn.name_BNS  "P1"',
  '_cell_length_a 8', '_cell_length_b 8', '_cell_length_c 8',
  '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
  'loop_', '_space_group_symop_magn_operation.id', '_space_group_symop_magn_operation.xyz', '1 x,y,z,+1',
  'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
  'Fe1 Fe 0.1 0.1 0.1', 'Fe2 Fe 0.5 0.1 0.1', 'Fe3 Fe 0.1 0.5 0.1', 'Fe4 Fe 0.5 0.5 0.1',
  'loop_', '_atom_site_moment.label', '_atom_site_moment.crystalaxis_x', '_atom_site_moment.crystalaxis_y', '_atom_site_moment.crystalaxis_z',
  'Fe1 0 0 0.06', 'Fe2 0 0 0.4', 'Fe3 0 0 1', 'Fe4 0 0 4', '',
].join('\n');

/** Min/Max fields of a window's bar: value, width, and whether the text overflows. */
function fields(page, panel) {
  return page.evaluate((panel) => [...document.querySelectorAll(`#cvPanelBody-${panel} .cv-colorbar-value-input`)]
    .map((i) => ({ value: i.value, width: i.style.width, over: i.scrollWidth - i.clientWidth, shown: i.clientWidth > 0 })), panel);
}

/** Focus and blur each field: the re-measure that used to widen them. */
async function focusBlur(page, panel) {
  await page.evaluate((panel) => {
    for (const i of document.querySelectorAll(`#cvPanelBody-${panel} .cv-colorbar-value-input`)) { i.focus(); i.blur(); }
  }, panel);
  await page.waitForTimeout(300);
}

async function open(page, panel) {
  await page.evaluate(async (panel) => (await import('./ui/panels/PanelManager.js')).openPanel(panel), panel);
  await page.waitForTimeout(800);
}

async function checkBar(page, panel, label, expectMin) {
  const first = await fields(page, panel);
  H.check(`${label}: Min shows the log Auto Range value`, first[0]?.value === expectMin, JSON.stringify(first));
  H.check(`${label}: both fields fit their text on the first build (no focus needed)`,
    first.length === 2 && first.every((f) => f.shown && f.over <= 0), JSON.stringify(first));
  await focusBlur(page, panel);
  const after = await fields(page, panel);
  H.check(`${label}: a focus/blur does not resize them (the build already had the laid-out width)`,
    JSON.stringify(after.map((f) => f.width)) === JSON.stringify(first.map((f) => f.width)),
    `${JSON.stringify(first)} -> ${JSON.stringify(after)}`);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Log scale first, so the structure's own range (set when it is entered)
  // is the log Auto Range; a scalar spin map so the Spins window has a bar.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    general.forceColorScale = 'log';
    general.spinColorScale = 'log';
    general.spinColorMap = 'viridis';
  });
  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'forces.xyz'), XYZ);
  await page.waitForTimeout(1200);
  // The window builds on expand, before its body is shown.
  H.check('setup: the Forces window has no bar until it is opened', (await fields(page, 'forces')).length === 0);
  await open(page, 'forces');
  await checkBar(page, 'forces', 'Forces', '5e-4');

  // A longer value typed in widens the field as it is entered.
  await page.evaluate(() => {
    const i = document.querySelector('#cvPanelBody-forces .cv-colorbar-value-input');
    i.value = '0.000025';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const typed = await fields(page, 'forces');
  H.check('Forces: a longer typed Min still fits', typed[0].value === '0.000025' && typed[0].over <= 0, JSON.stringify(typed));

  await page.evaluate(async (t) => (await import('./core/crystal-viewer.js')).loadStructure(t, 'moments.mcif'), MCIF);
  await page.waitForTimeout(1200);
  H.check('setup: the Spins window has no bar until it is opened', (await fields(page, 'spins')).length === 0);
  await open(page, 'spins');
  await checkBar(page, 'spins', 'Spins', '0.02');

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
