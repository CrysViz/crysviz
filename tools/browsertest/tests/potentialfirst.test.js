// The Atomistic panel is potential-FIRST: the potential picker sits above the
// Relax/MD action switch, is its own persistent element, and the chosen
// potential survives switching action (it used to reset to NEP on every
// Relax<->MD rebuild). Order Structure / EOS read the same shared choice.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const r = await page.evaluate(async () => {
    const { general } = await import('./state/store.js');
    const selector = document.getElementById('BackendPotentialSelector');
    const modeSwitch = document.getElementById('BackendModeSwitch');
    const calc = document.getElementById('BackendCalcPanel');

    // DOM order: selector before the action switch before the body.
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const selectorBeforeSwitch = !!(selector.compareDocumentPosition(modeSwitch) & FOLLOWING);
    const switchBeforeBody = !!(modeSwitch.compareDocumentPosition(calc) & FOLLOWING);

    const clickPotential = (p) =>
      selector.querySelector(`[data-role="potential-toggle"] button[data-potential="${p}"]`)?.click();
    const clickMode = (m) => modeSwitch.querySelector(`button[data-mode="${m}"]`)?.click();
    const mlipHidden = () => selector.querySelector('[data-role="mlip-source"]').classList.contains('hidden');

    // Choose PET-MAD (mlip) while in the default Relax action.
    clickPotential('mlip');
    const afterPick = { potential: general.atomisticPotential, mlipShown: !mlipHidden(),
      relaxBody: !!calc.querySelector('#relaxBtn') };

    // Switch action to MD — the potential must NOT reset.
    clickMode('md');
    const afterMD = { potential: general.atomisticPotential, mlipShown: !mlipHidden(),
      mdBody: !!calc.querySelector('#mdStartBtn'), relaxBody: !!calc.querySelector('#relaxBtn') };

    // And back to Relax — still PET-MAD.
    clickMode('relax');
    const afterRelax = { potential: general.atomisticPotential, relaxBody: !!calc.querySelector('#relaxBtn') };

    // Reset to NEP so we don't leave a heavy backend selected for other tests.
    clickPotential('nep');

    return { selectorBeforeSwitch, switchBeforeBody, afterPick, afterMD, afterRelax,
      selectorVisible: !selector.classList.contains('hidden') };
  });

  H.check('potential picker sits above the Relax/MD switch, body last',
    r.selectorBeforeSwitch && r.switchBeforeBody, JSON.stringify(r));

  H.check('picking a potential updates state and shows its controls, action body intact',
    r.afterPick.potential === 'mlip' && r.afterPick.mlipShown && r.afterPick.relaxBody,
    JSON.stringify(r.afterPick));

  H.check('switching Relax->MD keeps the chosen potential (no reset to NEP)',
    r.afterMD.potential === 'mlip' && r.afterMD.mlipShown && r.afterMD.mdBody && !r.afterMD.relaxBody,
    JSON.stringify(r.afterMD));

  H.check('switching back to Relax still keeps the potential',
    r.afterRelax.potential === 'mlip' && r.afterRelax.relaxBody, JSON.stringify(r.afterRelax));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
