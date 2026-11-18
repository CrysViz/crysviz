// Which potential a window computes with, and how far to trust it
// (atomistic/potentialNotice.js). The Atomistic window carries the accuracy
// caveat under its potential picker, plus a warning when NEP meets high
// pressure (relax target, NPT target, computed pressure); EOS, Order Structure
// (fractional occupation) and phonon mode maps name the potential they run
// with, follow it when it changes, and carry the same caveat. The Atomistic
// info page explains the models and the warning.
'use strict';
const H = require('../harness');

const NOTICE = '[data-role="potential-notice"]';

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const read = (host) => page.evaluate(({ host, notice }) => {
    const n = document.querySelector(`${host} ${notice}`);
    const text = (role) => n?.querySelector(`[data-role="${role}"]`)?.textContent ?? null;
    return { present: !!n, line: text('potential-notice-line'), caveat: text('potential-notice-caveat'), alert: text('potential-notice-alert') };
  }, { host, notice: NOTICE });
  const pick = (potential) => page.evaluate(async (p) => {
    document.querySelector(`#BackendPotentialSelector [data-potential="${p}"]`).click();
    await new Promise((r) => setTimeout(r, 100));
  }, potential);

  // --- The Atomistic window: NEP by default.
  await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    general.atomisticPotential = 'nep';
    openPanel('backend');
    await new Promise((r) => setTimeout(r, 300));
  });
  await pick('nep');
  const nep = await read('#BackendPotentialSelector');
  H.check('the Atomistic window warns that the potentials need checking against DFT before production runs',
    nep.present && /own errors/.test(nep.caveat) && /against DFT/.test(nep.caveat) && /production runs/.test(nep.caveat)
      && nep.line === null, JSON.stringify(nep));
  H.check('with NEP the general caveat has no extra NEP line, and there is no alarm at 0 GPa',
    !/NEP/.test(nep.caveat) && nep.alert === null, JSON.stringify(nep));

  const setInput = (selector, value) => page.evaluate(async ({ selector, value }) => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
  }, { selector, value });
  await setInput('#relaxTargetPressureInput', '12');
  const high = await read('#BackendPotentialSelector');
  H.check('a 12 GPa relax target with NEP raises the high-pressure warning',
    /^⚠ Target pressure 12 GPa\. For pressures above 5 GPa, PET\u2011MAD models are recommended\.$/.test(high.alert || ''), JSON.stringify(high));

  await pick('mlip');
  const pet = await read('#BackendPotentialSelector');
  H.check('with PET-MAD the general caveat stays, the NEP warnings go',
    /against DFT/.test(pet.caveat) && !/NEP/.test(pet.caveat) && pet.alert === null, JSON.stringify(pet));
  await setInput('#relaxTargetPressureInput', '0');

  // --- EOS names the potential and follows it.
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('eos');
    await new Promise((r) => setTimeout(r, 300));
  });
  const eosPet = await read('#cvPanelBody-eos');
  H.check('EOS (Compute from potential) says it runs with PET-MAD and which model',
    /Runs with PET-MAD — PET-MAD xs \(in your browser\)\. Change it in the Atomistic window\./.test(eosPet.line || '')
      && /against DFT/.test(eosPet.caveat) && eosPet.alert === null, JSON.stringify(eosPet));
  await pick('nep');
  const eosNep = await read('#cvPanelBody-eos');
  H.check('switching to NEP updates EOS, which warns that its P max of 20 GPa is too high for NEP',
    /Runs with NEP — NEP89/.test(eosNep.line || '') && /^⚠ P max 20 GPa\. For pressures above 5 GPa, PET\u2011MAD models are recommended\.$/.test(eosNep.alert || ''),
    JSON.stringify(eosNep));
  await setInput('#eosComputePMax', '4.9');
  const eosLow = await read('#cvPanelBody-eos');
  await setInput('#eosComputePMax', '5');
  const eosAt = await read('#cvPanelBody-eos');
  H.check('the threshold is 5 GPa: P max 4.9 has no alarm, 5 has',
    eosLow.alert === null && /Runs with NEP/.test(eosLow.line || '') && /^⚠ P max 5 GPa\. /.test(eosAt.alert || ''),
    JSON.stringify({ low: eosLow.alert, at: eosAt.alert }));
  await pick('ase');
  const eosAse = await read('#cvPanelBody-eos');
  H.check('with ASE not connected, EOS says so and where it would connect',
    /Runs with ASE — a model on your ASE server at http:\/\/localhost:5001 \(not connected\)/.test(eosAse.line || ''), JSON.stringify(eosAse));
  await pick('nep');

  // --- Order Structure (fractional occupation): a 50/50 Na/K rocksalt.
  await page.evaluate(async () => {
    const cv = await import('./core/crystal-viewer.js');
    const rows = [];
    const cat = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
    cat.forEach(([x, y, z], i) => { rows.push(`Na${i + 1} Na ${x} ${y} ${z} 0.5`); rows.push(`K${i + 1} K ${x} ${y} ${z} 0.5`); });
    cat.forEach(([x, y, z], i) => rows.push(`Cl${i + 1} Cl ${x + 0.5 > 1 ? x - 0.5 : x + 0.5} ${y} ${z} 1`));
    const text = ['data_mix', "_symmetry_space_group_name_H-M 'P 1'", '_cell_length_a 5.6', '_cell_length_b 5.6', '_cell_length_c 5.6',
      '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90', 'loop_', '_atom_site_label', '_atom_site_type_symbol',
      '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z', '_atom_site_occupancy', ...rows, ''].join('\n');
    await cv.loadStructure(text, 'mixed_rocksalt.cif');
    await new Promise((r) => setTimeout(r, 800));
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('cell');
    await new Promise((r) => setTimeout(r, 500));
  });
  const order = await read('#osPotentialNotice');
  H.check('Order Structure says which potential Compare Energy ranks with, with the caveat',
    /Runs with NEP — NEP89/.test(order.line || '') && /against DFT/.test(order.caveat), JSON.stringify(order));
  await pick('mlip');
  const orderPet = await read('#osPotentialNotice');
  H.check('and follows a change of potential', /Runs with PET-MAD/.test(orderPet.line || ''), JSON.stringify(orderPet));

  // --- The Atomistic info page: the models and the warning, not the old modes.
  const info = await page.evaluate(async () => (await fetch('./data/backendInfo.md')).text());
  H.check('the Atomistic info page explains the potentials and carries the warning',
    /^# Atomistic/.test(info) && /Check before you trust/.test(info) && /NEP at high pressure/.test(info)
      && /### NEP/.test(info) && /### PET-MAD/.test(info) && /### ASE/.test(info) && !/four different modes/.test(info),
    info.slice(0, 120));

  const relevant = errors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Plotly/.test(e));
  H.check('no page errors', relevant.length === 0, relevant[0] || '');
  await H.finish(browser);
})().catch(H.crash);
