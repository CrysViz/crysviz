// A window nobody is looking at must cost nothing.
//
// The bond-length and coordination histograms are pushed from every bond
// rebuild — during MD, from every topology refresh. Their redraw was already
// skipped while closed, but the DATA behind them (a walk over every bond,
// building per-pair arrays keyed by instance id) was computed unconditionally
// and thrown away. Now the producer bails when both windows are closed, and a
// window fills the data in for itself on the way open.
//
// The shared `bondLengths` map in the store is the honest witness for both
// halves: empty while closed, populated once something is looking.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const res = await page.evaluate(async () => {
    const { createSupercell } = await import('./ui/SuperCellModule.js');
    const { bondLengths, coordinationNumbers } = await import('./state/store.js');
    const bondHist = await import('./ui/AnalysisPanels/BondLengthHistogram.js');
    const { updateVisualization } = await import('./core/crystal-viewer.js');
    const { fileBrowser } = await import('./state/store.js');

    // A supercell build renders bonds several times over, with both histogram
    // windows closed throughout.
    createSupercell(2, 2, 2);
    await new Promise((r) => setTimeout(r, 700));
    const closed = {
      open: bondHist.isBondLengthHistogramOpen(),
      bondKeys: Object.keys(bondLengths).length,
      coordKeys: Object.keys(coordinationNumbers).length,
      bonds: fileBrowser.selectedStructure.bonds?.length ?? 0,
    };

    // Another rebuild, still closed — still nothing.
    updateVisualization({ bondsUpdate: true, reRenderBonds: true });
    await new Promise((r) => setTimeout(r, 600));
    const stillClosed = Object.keys(bondLengths).length;

    // Open it: the data it skipped has to appear.
    bondHist.addBondLengthHistogramPanel();
    await new Promise((r) => setTimeout(r, 700));
    const afterOpen = {
      open: bondHist.isBondLengthHistogramOpen(),
      bondKeys: Object.keys(bondLengths).length,
    };

    // And a rebuild while open must keep it current and drawn.
    updateVisualization({ bondsUpdate: true, reRenderBonds: true });
    await new Promise((r) => setTimeout(r, 700));
    const host = document.getElementById('bondLengthHistogramPlot');
    const afterRebuild = {
      bondKeys: Object.keys(bondLengths).length,
      drawn: host ? host.children.length > 0 : false,
    };

    return { closed, stillClosed, afterOpen, afterRebuild };
  });

  console.log(`  ${res.closed.bonds} bonds — closed: ${res.closed.bondKeys} pair groups,`
    + ` open: ${res.afterOpen.bondKeys}, after rebuild: ${res.afterRebuild.bondKeys}`);

  H.check('the structure really does have bonds to histogram',
    res.closed.bonds > 0, String(res.closed.bonds));
  H.check('building bonds with both windows closed computes no histogram data',
    res.closed.bondKeys === 0 && res.closed.coordKeys === 0,
    `bond=${res.closed.bondKeys} coord=${res.closed.coordKeys}`);
  H.check('a further rebuild while closed still computes nothing',
    res.stillClosed === 0, String(res.stillClosed));
  H.check('opening the window fills in the data it skipped',
    res.afterOpen.open === true && res.afterOpen.bondKeys > 0,
    JSON.stringify(res.afterOpen));
  H.check('a rebuild while open keeps the data current and drawn',
    res.afterRebuild.bondKeys > 0 && res.afterRebuild.drawn === true,
    JSON.stringify(res.afterRebuild));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
