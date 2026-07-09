// Docked histogram canvas must resize to its panel width, not stay pinned to
// the width it was created at (BondAnalysisPanel.js addHistogramPanel).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(async () => {
    const { addHistogramPanel } = await import('./ui/AnalysisPanels/BondAnalysisPanel.js');
    addHistogramPanel([[1.9, 2.0, 2.1, 2.2]], ['Si-Si']);
  });
  await page.waitForTimeout(300);

  // Dock the floating histogram panel, then compare canvas width to the dock.
  await page.evaluate(() => {
    document.querySelector('.cv-panel[data-panel-id="histogram"] .cv-panel-dock').click();
  });
  await page.waitForTimeout(400);

  const widths = await page.evaluate(() => {
    const panelBody = document.getElementById('cvPanelBody-histogram');
    const canvas = panelBody.querySelector('#histCanvas');
    return { panel: panelBody.clientWidth, canvas: canvas.clientWidth };
  });
  H.check('docked histogram canvas fits its panel', widths.canvas <= widths.panel + 2,
    `canvas=${widths.canvas} panel=${widths.panel}`);
  H.check('canvas shrank from its 600px floating default', widths.canvas < 500, `canvas=${widths.canvas}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
