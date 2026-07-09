// "Reset UI" (#resetUiButton -> resetAllPanels) restores every panel's
// default dock slot/anchor and title-bar (strip) state, but historically left
// the body's collapsed/expanded state untouched. For a panel whose default is
// a collapsed title bar (Atomistic/backend, Files) — a 3px unlabeled strip —
// a body the user had folded before hitting reset left the whole panel with
// no visible title AND no visible body: indistinguishable from being gone.
// Reset UI must also restore the body's default open/closed state; the
// per-panel "⌂ restore default position" button must NOT (narrower, position-
// only reset).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Fold the Atomistic (backend) panel's body closed — its title bar is
  // barCollapsed by default (a thin strip), so a folded body on top of that
  // makes the whole panel disappear.
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="backend"] .cv-panel-fold').click();
  });
  const folded = await page.evaluate(() => {
    const el = document.querySelector('.cv-panel[data-panel-id="backend"]');
    return { collapsed: el.classList.contains('cv-collapsed'), h: el.getBoundingClientRect().height };
  });
  H.check('folding the body collapses the panel to a near-invisible strip',
    folded.collapsed && folded.h < 10, JSON.stringify(folded));

  await page.evaluate(() => document.getElementById('resetUiButton')?.click());
  await page.waitForTimeout(300);
  const afterReset = await page.evaluate(() => {
    const el = document.querySelector('.cv-panel[data-panel-id="backend"]');
    return { collapsed: el.classList.contains('cv-collapsed'), h: el.getBoundingClientRect().height };
  });
  H.check('Reset UI reopens the Atomistic panel body (its default is expanded)',
    !afterReset.collapsed && afterReset.h > 100, JSON.stringify(afterReset));

  // The per-panel "restore default position" (⌂) button is narrower: it must
  // NOT force the body open, only fix placement/bar state.
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="backend"] .cv-panel-fold').click();
  });
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="backend"] .cv-panel-home').click();
  });
  await page.waitForTimeout(200);
  const afterHome = await page.evaluate(() => {
    const el = document.querySelector('.cv-panel[data-panel-id="backend"]');
    return { collapsed: el.classList.contains('cv-collapsed'), h: el.getBoundingClientRect().height };
  });
  H.check('the per-panel restore-position button still leaves collapsed state as the user left it',
    afterHome.collapsed && afterHome.h < 10, JSON.stringify(afterHome));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
