// Regression: after a live MD run streams a long series into container B, the
// plot must RE-SYNC to whatever container is selected next. Selecting a plain
// energy-only trajectory A (fewer frames) had left the plot showing B's long
// live series, so the plot sample count didn't match the scrubber's frame count.
'use strict';
const H = require('../harness');

async function chartSampleCount(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#trajPlotHost .js-plotly-plot');
    if (!c || !c.data || !c.data.length) return -1;
    return Math.max(...c.data.map((t) => (t.x ? t.x.length : 0)));
  });
}

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // Container A: a plain 3-frame energy trajectory (no plotSeries).
  const A = [
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3:energy=-10.0', 'Na 0 0 0', 'Cl 2 0 0',
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3:energy=-10.1', 'Na 0.1 0 0', 'Cl 2.1 0 0',
    '2', 'Lattice="4 0 0 0 4 0 0 0 4" Properties=species:S:1:pos:R:3:energy=-10.2', 'Na 0.2 0 0', 'Cl 2.2 0 0',
  ].join('\n');

  const res = await page.evaluate(async (a) => {
    const cv = await import('./core/crystal-viewer.js');
    const { openPanel, refreshActivePanels } = await import('./ui/panels/PanelManager.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { StructureContainer } = await import('./model/StructureContainer.js');
    const tp = await import('./ui/TrajectoryPanel.js');

    // Load A (becomes selected at index 0) and open the panel.
    await cv.loadStructure(a, 'A.xyz');
    const idxA = fileBrowser.selectedRowIndex;
    // Guarantee A carries per-frame energy (the real OUTCAR case), independent
    // of extxyz comment-line energy parsing.
    structureShip.container[idxA].structures.forEach((s, i) => { s.energy = -10 - i * 0.1; });
    openPanel('trajectory');
    await new Promise((r) => setTimeout(r, 250));

    // Simulate a live-MD container B with a long streamed series, selected.
    const seed = structureShip.container[idxA].structures[0];
    const B = new StructureContainer({ fileName: 'B_live', structures: [] });
    const N = 40;
    B.structures = Array.from({ length: N }, () => seed);
    B.plotSeries = {
      temperatureK: Array.from({ length: N }, (_, i) => 300 + i),
      etotEv: Array.from({ length: N }, (_, i) => -9 - i * 0.01),
    };
    structureShip.container.push(B);
    const idxB = structureShip.container.length - 1;

    // Select B and rebuild the panel (what selecting the live row does).
    fileBrowser.selectedRowIndex = idxB;
    fileBrowser.selectedStructure = B.structures[0];
    tp.removeTrajectoryPlayer();
    tp.addTrajectoryPlayer('cvPanelBody-trajectory');
    for (let i = 0; i < 60; i++) {
      const c = document.querySelector('#trajPlotHost .js-plotly-plot');
      if (c && c.data && c.data.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const countAfterB = (() => {
      const c = document.querySelector('#trajPlotHost .js-plotly-plot');
      return c && c.data ? Math.max(...c.data.map((t) => (t.x ? t.x.length : 0))) : -1;
    })();

    // Now select A again and re-sync (the row-click path calls refreshActivePanels).
    fileBrowser.selectedRowIndex = idxA;
    fileBrowser.selectedStructure = structureShip.container[idxA].structures[0];
    refreshActivePanels();
    for (let i = 0; i < 60; i++) {
      const c = document.querySelector('#trajPlotHost .js-plotly-plot');
      if (c && c.data && c.data.length && Math.max(...c.data.map((t) => (t.x ? t.x.length : 0))) <= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const countAfterA = (() => {
      const c = document.querySelector('#trajPlotHost .js-plotly-plot');
      return c && c.data ? Math.max(...c.data.map((t) => (t.x ? t.x.length : 0))) : -1;
    })();

    return { framesA: structureShip.container[idxA].structures.length, countAfterB, countAfterA };
  }, A);

  H.check('plot shows B\'s long live series when B is selected', res.countAfterB === 40, JSON.stringify(res));
  H.check('plot RE-SYNCS to A (3 samples) when A is reselected — matches scrubber frames',
    res.countAfterA === res.framesA, JSON.stringify(res));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
