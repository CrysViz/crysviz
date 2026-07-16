// Every registered panel with a titlebar should carry an info ("i") button
// (using an existing markdown blurb, or a new placeholder one), and that
// button should sit small/flush in the titlebar, not towering over the
// fold/home/dock/close icons next to it.
'use strict';
const H = require('../harness');

const EXPECTED_PANEL_IDS = [
  'measure', 'view', 'info', 'backend', 'files', 'features', 'trajectory',
  'comparison', 'forces', 'spins', 'field', 'planes', 'bonds', 'cell',
  'symmetry', 'polyhedra', 'visual', 'eos', 'eosPlots', 'splitDemo', 'landscape',
  'landscapePlots', 'settings',
];

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  await page.waitForTimeout(500);

  const result = await page.evaluate(async (ids) => {
    // Resolve via the registry: closed-by-default windows (eos, splitDemo,
    // landscape) are registered but detached from the document.
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const missing = [];
    for (const id of ids) {
      const el = getPanel(id)?.el;
      const btn = el?.querySelector('.cv-panel-titlebar > .cv-panel-info');
      if (!btn) missing.push(id);
    }
    // Size check against a sibling titlebar icon (fold caret).
    const settingsPanel = document.querySelector('.cv-panel[data-panel-id="settings"]');
    const info = settingsPanel?.querySelector('.cv-panel-info');
    const fold = settingsPanel?.querySelector('.cv-panel-fold');
    const infoRect = info?.getBoundingClientRect();
    const foldRect = fold?.getBoundingClientRect();
    return {
      missing,
      infoSize: infoRect ? { w: infoRect.width, h: infoRect.height } : null,
      foldSize: foldRect ? { w: foldRect.width, h: foldRect.height } : null,
    };
  }, EXPECTED_PANEL_IDS);

  H.check('every listed panel has a titlebar info button', result.missing.length === 0, JSON.stringify(result.missing));
  const ratio = result.infoSize && result.foldSize ? result.infoSize.h / result.foldSize.h : null;
  H.check('info button is not oversized next to its sibling titlebar icons',
    ratio !== null && ratio < 1.6, `ratio=${ratio} info=${JSON.stringify(result.infoSize)} fold=${JSON.stringify(result.foldSize)}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
