// The Bond Length Histogram window moved between its three homes via the ≡
// window menu's Position section, and its Plotly chart resizing to each home:
// it opens side-docked (wide), "Main dock" squeezes it into the narrow side
// panel (the chart must follow the panel width, not stay pinned to the width
// it was created at), "Float" pops it out, and "Side dock" returns it.
//
// The panel now holds one card PER bond pair plus a combined "All Pairs" card,
// each with its own plot div (`bondLengthHistogramPlot__<key>`) — there is no
// single `bondLengthHistogramPlot` any more — and every card starts collapsed.
// This drives the combined card, which is always present, and expands it first:
// a collapsed card's chart is display:none and has no width to measure.
'use strict';
const H = require('../harness');

// ALL_PAIRS_KEY 'All Pairs' through BondLengthHistogram.js's id sanitiser.
const ALL_PAIRS_PLOT = 'bondLengthHistogramPlot__All_Pairs';
const ALL_PAIRS_CARD = 'blh-card__All_Pairs';

async function pickPosition(page, panelId, label) {
  await page.evaluate((id) => {
    document.querySelector(`.cv-panel[data-panel-id="${id}"] .cv-panel-menu-btn`).click();
  }, panelId);
  await page.waitForTimeout(100);
  await page.evaluate((label) => {
    [...document.querySelectorAll('.cv-panel-menu-item')]
      .find((b) => b.textContent === label)?.click();
  }, label);
  await page.waitForTimeout(500);
}

function histState(page) {
  return page.evaluate(async (plotId) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel('bondLengthHistogram');
    const el = p?.el;
    const body = el?.querySelector('.cv-panel-body');
    const plot = document.getElementById(plotId);
    return {
      dock: p?.dock ?? null,
      bodyW: body?.getBoundingClientRect().width ?? 0,
      plotW: plot?.getBoundingClientRect().width ?? 0,
      inMainDock: !!document.querySelector('#dock .cv-panel[data-panel-id="bondLengthHistogram"]'),
      inSideDock: !!document.querySelector('#splitPaneBody > .cv-panel[data-panel-id="bondLengthHistogram"]'),
      floating: !!el?.classList.contains('cv-floating'),
    };
  }, ALL_PAIRS_PLOT);
}

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // Open via the Bonds window's single button: side-docked, wide.
  await page.evaluate(async () => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    getPanel('bonds').expand();
  });
  await page.waitForTimeout(300);
  await H.clickById(page, 'openBondLengthHistogram');
  await page.waitForTimeout(800);

  // Cards open collapsed by design; expand the combined one so its chart has a
  // size to follow across the dock moves below.
  await page.evaluate((cardId) => {
    /** @type {HTMLElement} */ (
      document.getElementById(cardId).querySelector('.blh-collapse-toggle')).click();
  }, ALL_PAIRS_CARD);
  await page.waitForTimeout(800); // Plotly first render

  let s = await histState(page);
  H.check('histogram opens side-docked with a wide chart',
    s.dock === 'right' && s.inSideDock && s.plotW > 300, JSON.stringify(s));
  const wideW = s.plotW;

  // ≡ Position ▸ Main dock: the chart must squeeze to the side panel's width.
  await pickPosition(page, 'bondLengthHistogram', 'Main dock');
  await page.waitForTimeout(600); // ResizeObserver + Plotly relayout
  s = await histState(page);
  H.check('Position ▸ Main dock moves the window into #dock',
    s.dock === 'left' && s.inMainDock, JSON.stringify(s));
  H.check('docked histogram chart fits its panel', s.plotW <= s.bodyW + 2,
    `plot=${s.plotW} body=${s.bodyW}`);
  H.check('chart shrank from its side-dock width', s.plotW < wideW - 20,
    `plot=${s.plotW} was=${wideW}`);

  // ≡ Position ▸ Float: pops out over the scene.
  await pickPosition(page, 'bondLengthHistogram', 'Float');
  s = await histState(page);
  H.check('Position ▸ Float pops the window out', s.dock === false && s.floating,
    JSON.stringify(s));

  // ≡ Position ▸ Side dock: returns as the front tab.
  await pickPosition(page, 'bondLengthHistogram', 'Side dock');
  await page.waitForTimeout(600);
  s = await histState(page);
  H.check('Position ▸ Side dock returns the window to the side dock',
    s.dock === 'right' && s.inSideDock, JSON.stringify(s));
  H.check('chart grew back to the wide dock', s.plotW > 300, `plot=${s.plotW}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
