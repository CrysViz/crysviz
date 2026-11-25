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
//
// The card's dual-range slider fill is checked alongside: it used to be
// painted once while the card was collapsed (slider 0 px wide -> a made-up
// 120 px geometry, so the green bar came out too short) and never repainted
// until the whole window changed width. It must match the slider's real
// width right after expanding and after every dock move.
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
  return page.evaluate(async ({ plotId, cardId }) => {
    const { getPanel } = await import('./ui/panels/PanelManager.js');
    const p = getPanel('bondLengthHistogram');
    const el = p?.el;
    const body = el?.querySelector('.cv-panel-body');
    const plot = document.getElementById(plotId);
    // Expected fill geometry from the slider's live width: thumbs travel
    // between half a thumb (6 px) in from either edge.
    const card = document.getElementById(cardId);
    const slider = card?.querySelector('.blh-range-slider');
    const fill = card?.querySelector('.blh-range-fill');
    const minIn = card?.querySelector('.blh-range-min');
    const maxIn = card?.querySelector('.blh-range-max');
    let fillOk = null;
    if (slider && fill && minIn && maxIn && slider.clientWidth) {
      const w = slider.clientWidth;
      const pos = (v) => 6 + ((v - Number(minIn.min)) / (Number(minIn.max) - Number(minIn.min))) * (w - 12);
      const expLeft = pos(Number(minIn.value));
      const expWidth = pos(Number(maxIn.value)) - expLeft;
      fillOk = Math.abs(parseFloat(fill.style.left) - expLeft) < 1.5 && Math.abs(parseFloat(fill.style.width) - expWidth) < 1.5;
    }
    return {
      fillOk,
      sliderW: slider?.clientWidth ?? 0,
      fillW: fill ? parseFloat(fill.style.width) : null,
      dock: p?.dock ?? null,
      bodyW: body?.getBoundingClientRect().width ?? 0,
      plotW: plot?.getBoundingClientRect().width ?? 0,
      inMainDock: !!document.querySelector('#dock .cv-panel[data-panel-id="bondLengthHistogram"]'),
      inSideDock: !!document.querySelector('#splitPaneBody > .cv-panel[data-panel-id="bondLengthHistogram"]'),
      floating: !!el?.classList.contains('cv-floating'),
    };
  }, { plotId: ALL_PAIRS_PLOT, cardId: ALL_PAIRS_CARD });
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
  H.check('the range slider\'s green fill spans the real slider width right after expanding the card',
    s.fillOk === true && s.sliderW > 150, `slider=${s.sliderW} fill=${s.fillW} ok=${s.fillOk}`);
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
  H.check('the fill followed the slider into the narrow dock', s.fillOk === true,
    `slider=${s.sliderW} fill=${s.fillW} ok=${s.fillOk}`);

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
  H.check('the fill followed the slider back to the wide dock', s.fillOk === true,
    `slider=${s.sliderW} fill=${s.fillW} ok=${s.fillOk}`);

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
