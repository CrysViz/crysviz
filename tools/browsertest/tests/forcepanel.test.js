// Force Histogram panel (ui/AnalysisPanels/ForceHistogram.js): the Forces
// window's "Force Histogram" button (ui/ForcePanel.js), binning/stats
// correctness, and the click-to-highlight/clear interaction contract shared
// with BondLengthHistogram.js / CoordinationHistogram.js.
//
// This file previously also exercised ForcePanel's colormap/arrow-shape/cel
// controls, but those sliders don't exist in the current ForcePanel.js (only
// Global Scaling + Arrow Size) — that was written against a version of the
// panel that isn't in this tree. Rewritten to cover only what's actually
// built: the histogram.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  // --- No forces yet: the histogram button is disabled ---
  await page.evaluate(async () => {
    const { addForcePanel } = await import('./ui/ForcePanel.js');
    const body = document.createElement('div');
    body.id = 'cvPanelBody-forces';
    document.body.appendChild(body);
    addForcePanel('cvPanelBody-forces');
  });
  const disabledState = await page.evaluate(() => ({
    disabled: /** @type {HTMLButtonElement} */ (document.getElementById('openForceHistogram'))?.disabled,
  }));
  H.check('histogram button disabled with no force data', disabledState.disabled === true, JSON.stringify(disabledState));

  // Give the structure a spread of forces so binning/highlighting has range.
  await page.evaluate(async () => {
    const { fileBrowser, general } = await import('./state/store.js');
    const { Force } = await import('./model/index.js');
    const { updateForces } = await import('./render/index.js');
    const s = fileBrowser.selectedStructure;
    s.forces = s.atoms.map((_, i) => new Force({ vector: [0.1 + i * 0.3, 0.05, -0.02 * i] }));
    general.forcesActive = true;
    updateForces();
  });
  await page.waitForTimeout(200);

  const base = await page.evaluate(async () => {
    const { groups } = await import('./state/store.js');
    return { count: groups.forcesShaftMesh?.count ?? 0 };
  });
  H.check('force arrows built', base.count > 0, `count=${base.count}`);

  // Rebuild the Forces panel now that the structure has forces (redraw()
  // only runs the no-forces-note/button sync on the panel's own controls).
  const enabledState = await page.evaluate(async () => {
    const { addForcePanel } = await import('./ui/ForcePanel.js');
    addForcePanel('cvPanelBody-forces');
    return { disabled: /** @type {HTMLButtonElement} */ (document.getElementById('openForceHistogram'))?.disabled };
  });
  H.check('histogram button enabled once forces exist', enabledState.disabled === false, JSON.stringify(enabledState));

  // --- Histogram: no compute while closed, stats when open ---
  const closed = await page.evaluate(async () => {
    const { refreshForceHistogram, getForceStats } = await import('./ui/AnalysisPanels/ForceHistogram.js');
    refreshForceHistogram();
    return getForceStats();
  });
  H.check('closed histogram computes nothing', closed === null, JSON.stringify(closed));

  await H.clickById(page, 'openForceHistogram');
  // Plotly is lazy-loaded on first render, so wait for the trace to land.
  await H.waitFor(page, () => {
    const plot = /** @type {any} */ (document.getElementById('forceHistogramPlot'));
    return !!plot?.data?.length;
  });

  const open = await page.evaluate(async () => {
    const { getForceStats } = await import('./ui/AnalysisPanels/ForceHistogram.js');
    const plot = /** @type {any} */ (document.getElementById('forceHistogramPlot'));
    const binned = (plot?.data ?? []).reduce((n, t) => n + t.y.reduce((a, b) => a + b, 0), 0);
    return {
      stats: getForceStats(),
      bars: binned,
      statsText: document.querySelector('.fh-stats')?.textContent?.trim() ?? '',
    };
  });
  H.check('open histogram has stats', !!open.stats && open.stats.n > 0, JSON.stringify(open.stats));
  H.check('stats are self-consistent',
    !!open.stats && open.stats.min <= open.stats.mean && open.stats.mean <= open.stats.max
      && open.stats.rms >= open.stats.mean - 1e-9,
    JSON.stringify(open.stats));
  H.check('histogram binned every atom', open.bars === open.stats.n, `binned=${open.bars} n=${open.stats?.n}`);
  H.check('stats readout rendered', /max/.test(open.statsText), open.statsText);

  // --- Click-to-highlight contract (matches BondLengthHistogram.js /
  // CoordinationHistogram.js): clicking a bar with atoms in it highlights
  // those atoms in 3D; clicking the same bar again clears the highlight.
  // Simulated via the plot div's own event emitter (Plotly wires
  // 'plotly_click' through it) rather than real mouse coordinates, which
  // would be brittle against bar layout/zoom.
  const clickResult = await page.evaluate(async () => {
    const { highlightHover } = await import('./state/store.js');
    const plot = /** @type {any} */ (document.getElementById('forceHistogramPlot'));
    const trace = (plot.data ?? []).find((t) => (t.customdata ?? []).some((c) => c?.length));
    if (!trace) return { error: 'no bar with atoms in it' };
    const pointIndex = trace.customdata.findIndex((c) => c?.length);
    const customdata = trace.customdata[pointIndex];

    plot.emit('plotly_click', { points: [{ data: trace, pointIndex, customdata }] });
    const afterFirstClick = (highlightHover.currentlyHighlightedAtomInstances ?? []).length;

    plot.emit('plotly_click', { points: [{ data: trace, pointIndex, customdata }] });
    const afterSecondClick = (highlightHover.currentlyHighlightedAtomInstances ?? []).length;

    return { afterFirstClick, afterSecondClick, atomsInBin: customdata.length };
  });
  H.check('clicking a bar highlights its atoms', !clickResult.error && clickResult.afterFirstClick > 0,
    JSON.stringify(clickResult));
  H.check('clicking the same bar again clears the highlight', clickResult.afterSecondClick === 0,
    JSON.stringify(clickResult));

  // --- Bin/range controls redraw the plot ---
  const controlsChange = await page.evaluate(() => {
    const plot = /** @type {any} */ (document.getElementById('forceHistogramPlot'));
    const before = plot.data.length;
    const binSlider = /** @type {HTMLInputElement} */ (document.querySelector('.fh-bin-slider'));
    binSlider.value = '6';
    binSlider.dispatchEvent(new Event('input'));
    return { before, binsAfter: binSlider.value };
  });
  H.check('bin slider present and settable', controlsChange.binsAfter === '6', JSON.stringify(controlsChange));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
