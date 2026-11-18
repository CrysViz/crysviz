// The Atomistic window's Relax / MD switch (ui/BackendPanel/BackendSwitchPanel.js)
// works like tabs: clicking the mode already selected keeps it and its panel,
// with what was typed into it. (It used to switch the mode off and collapse
// the panel.) Clicking the other mode still switches.
'use strict';
const H = require('../harness');

const state = (page) => page.evaluate(async () => {
  const { general } = await import('./state/store.js');
  const btn = (m) => document.querySelector(`#BackendModeSwitch button[data-mode="${m}"]`);
  const selector = document.getElementById('BackendPotentialSelector');
  return {
    backendState: general.backendState,
    relaxOn: btn('relax')?.classList.contains('relax') ?? null,
    mdOn: btn('md')?.classList.contains('md') ?? null,
    selectorShown: !!selector && !selector.classList.contains('hidden'),
    body: (document.getElementById('BackendCalcPanel')?.innerHTML.length ?? 0) > 0,
    mdSteps: document.getElementById('mdStepsInput')?.value ?? null,
  };
});

const click = (page, mode) => page.evaluate((m) => {
  document.querySelector(`#BackendModeSwitch button[data-mode="${m}"]`)?.click();
}, mode);

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    openPanel('backend');
  });
  await page.waitForTimeout(400);

  let s = await state(page);
  H.check('the window opens on Relax with its panel', s.backendState === 'relax' && s.relaxOn && !s.mdOn
    && s.selectorShown && s.body, JSON.stringify(s));

  await click(page, 'relax');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('clicking Relax again keeps Relax and its panel', s.backendState === 'relax' && s.relaxOn
    && s.selectorShown && s.body, JSON.stringify(s));

  await click(page, 'md');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('clicking MD switches to MD', s.backendState === 'md' && s.mdOn && !s.relaxOn && s.body
    && s.mdSteps !== null, JSON.stringify(s));

  await page.evaluate(() => {
    const steps = /** @type {HTMLInputElement} */ (document.getElementById('mdStepsInput'));
    steps.value = '1234';
  });
  await click(page, 'md');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('clicking MD again keeps MD, its panel and what was typed in it', s.backendState === 'md' && s.mdOn
    && s.selectorShown && s.mdSteps === '1234', JSON.stringify(s));

  await click(page, 'relax');
  await page.waitForTimeout(300);
  s = await state(page);
  H.check('clicking Relax switches back', s.backendState === 'relax' && s.relaxOn && !s.mdOn && s.body,
    JSON.stringify(s));

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  H.check('no console/page errors', real.length === 0, real.join(' | '));
  await H.finish(browser);
})().catch(H.crash);
