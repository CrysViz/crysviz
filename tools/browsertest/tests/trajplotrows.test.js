// Trajectory plot (ui/TrajectoryPlot.js): one plot per quantity, stacked in
// rows on a shared step axis, or side by side when the chart is wide and
// short (the side dock along the bottom, a landscape phone's fullscreen). A
// relaxation feeds E, mean |F| and P; with the old overlaid right-hand axes
// the |F| axis title ran under the P tick labels in the sidebar. Checks, on
// the real Plotly (esm.sh), that each plot is labelled with its quantity and
// unit, labels its data minimum and maximum (kept current while points stream
// in), and that no text of the chart overlaps any other or leaves the chart —
// compact and fullscreen, in the sidebar, the side dock on either side and on
// a phone in both orientations. Stacked, the step axis sits under the bottom
// row; side by side, every plot has its own step axis (zoomed together), its
// own cursor line, and a click in any of them seeks. A row with two lines
// (T and T target, MD) brings the legend back, above the top row's label.
'use strict';
const H = require('../harness');

async function waitForChart(page, minTraces) {
  for (let i = 0; i < 150; i++) {
    const ok = await page.evaluate((min) => {
      const chart = document.querySelector('#trajPlotHost .js-plotly-plot');
      return !!(chart && chart.data && chart.data.length >= min && chart.querySelector('.main-svg'));
    }, minTraces);
    if (ok) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** Layout facts plus every rendered text box of the chart, and their overlaps. */
async function readChart(page, sel = '#trajPlotHost .js-plotly-plot') {
  await page.waitForTimeout(800); // a height-driven re-layout lands a frame later
  return page.evaluate((sel) => {
    const chart = document.querySelector(sel);
    const L = chart.layout;
    const rows = ['yaxis', 'yaxis2', 'yaxis3', 'yaxis4'].filter((k) => L[k]).map((k) => L[k].domain);
    const svg = chart.querySelector('.main-svg').getBoundingClientRect();
    const texts = [...chart.querySelectorAll('svg text')]
      .filter((t) => t.textContent.trim() && !t.closest('.hoverlayer') && t.getBoundingClientRect().width > 0)
      .map((t) => {
        const r = t.getBoundingClientRect();
        return { text: t.textContent.trim(), l: r.left, r: r.right, t: r.top, b: r.bottom };
      });
    const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
    const overlaps = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) if (hit(texts[i], texts[j])) overlaps.push(`${texts[i].text} / ${texts[j].text}`);
    }
    const outside = texts.filter((b) => b.l < svg.left - 0.5 || b.r > svg.right + 0.5 || b.t < svg.top - 0.5 || b.b > svg.bottom + 0.5)
      .map((b) => b.text);
    // Each row's labelled ends against its own data: [tickMin, dataMin, tickMax, dataMax].
    const ends = ['y', 'y2', 'y3', 'y4'].filter((id) => L[id === 'y' ? 'yaxis' : `yaxis${id.slice(1)}`]).map((id) => {
      const ax = L[id === 'y' ? 'yaxis' : `yaxis${id.slice(1)}`];
      const ys = chart.data.filter((t) => (t.yaxis || 'y') === id).flatMap((t) => t.y).filter(Number.isFinite);
      return [Math.min(...(ax.tickvals || [NaN])), Math.min(...ys), Math.max(...(ax.tickvals || [NaN])), Math.max(...ys)];
    });
    const xKeys = Object.keys(L).filter((k) => /^xaxis\d*$/.test(k)).sort();
    return {
      arrangement: L.xaxis2 ? 'columns' : 'rows',
      columns: xKeys.map((k) => ({ domain: L[k].domain, matches: L[k].matches || null })),
      chartH: Math.round(svg.height),
      rows,
      ends,
      xAnchor: L.xaxis.anchor,
      labels: (L.annotations || []).map((a) => a.text),
      legend: L.showlegend,
      overlaps,
      outside,
      size: `${Math.round(svg.width)}x${Math.round(svg.height)}`,
    };
  }, sel);
}

const clean = (c) => c.overlaps.length === 0 && c.outside.length === 0;
const labelsBoth = (c) => c.ends.every(([tmin, dmin, tmax, dmax]) => Math.abs(tmin - dmin) < 1e-9 && Math.abs(tmax - dmax) < 1e-9);

/** Feed a relaxation-like run into the Trajectory panel's live plot. */
async function feedRelax(page) {
  await page.evaluate(async () => {
    const tp = await import('./ui/TrajectoryPanel.js');
    tp.resetLivePlot();
    tp.ensureTrajectoryPanelForLive();
    for (let step = 1; step <= 40; step++) {
      tp.feedLiveStep({
        step: step * 4,
        etotEv: -231 + 14 * Math.exp(-step / 4),
        meanForce: 4 * Math.exp(-step / 5),
        pressure: 18 * Math.exp(-step / 4) * Math.cos(step / 3),
      });
    }
    tp.endLiveFeed();
  });
  await waitForChart(page, 3);
}

/** Put the Trajectory window in the side dock, on `side` ('right' | 'bottom'). */
async function sideDock(page, side) {
  await page.evaluate(async (side) => {
    const pm = await import('./ui/panels/PanelManager.js');
    const rd = await import('./ui/panels/SideDock.js');
    const panel = pm.getPanel('trajectory');
    if (panel.dock !== 'right') {
      pm.closePanel('trajectory');
      panel.dock = 'right';
      pm.openPanel('trajectory');
    }
    rd.setSideDockCollapsed(false);
    if (side) rd.setSideDockSide(side);
    const win = document.querySelector('.cv-panel[data-panel-id="trajectory"]');
    if (win) win.classList.remove('cv-bar-collapsed', 'cv-collapsed');
    document.querySelector('#trajPlotHost .trajPlot')?.scrollIntoView({ block: 'end' });
  }, side);
  await page.waitForTimeout(1500);
}

async function fullscreen(page, on) {
  await page.evaluate((on) => {
    if (on) [...document.querySelectorAll('#trajPlotHost .split-item-action-btn')].find((b) => b.title === 'Expand')?.click();
    else document.querySelector('#trajPlotHost .split-item-close-btn')?.click();
  }, on);
  await page.waitForTimeout(1500);
}

const stacked = (rows) => rows.every((d, i) => d[0] < d[1] && (i === 0 || d[1] < rows[i - 1][0]));

(async () => {
  const { browser, page, errors } = await H.launchApp();

  // --- a relaxation: E tot, mean |F|, P, in the sidebar ---------------------------
  await feedRelax(page);
  const relax = await readChart(page);
  H.check('relax plot: three rows stacked top to bottom, the step axis under the bottom one',
    relax.rows.length === 3 && stacked(relax.rows) && relax.xAnchor === 'y3', JSON.stringify(relax));
  H.check('relax plot: each row labelled with its quantity and unit; no legend for one line per row',
    ['E tot (eV)', 'mean |F| (eV/Å)', 'P (GPa)'].every((t) => relax.labels.includes(t)) && relax.legend === false,
    JSON.stringify(relax.labels));
  H.check('relax plot: every row labels its own minimum and maximum',
    relax.ends.length === 3 && relax.ends.every(([tmin, dmin, tmax, dmax]) => Math.abs(tmin - dmin) < 1e-9 && Math.abs(tmax - dmax) < 1e-9),
    JSON.stringify(relax.ends));
  const modeBar = await page.evaluate(() => !!document.querySelector('#trajPlotHost .modebar'));
  H.check('no Plotly mode bar (export and fullscreen live in the plot toolbar)', modeBar === false, String(modeBar));
  H.check('relax plot (sidebar): no text overlaps another or leaves the chart',
    relax.overlaps.length === 0 && relax.outside.length === 0, JSON.stringify(relax));

  // Fullscreen (⛶): bigger fonts, same rules.
  await page.evaluate(() => [...document.querySelectorAll('#trajPlotHost .split-item-action-btn')]
    .find((b) => b.title === 'Expand')?.click());
  await page.waitForTimeout(1200);
  const full = await readChart(page);
  H.check('relax plot (fullscreen): stacked, no overlapping or clipped text',
    full.rows.length === 3 && stacked(full.rows) && full.overlaps.length === 0 && full.outside.length === 0,
    JSON.stringify(full));
  await page.evaluate(() => document.querySelector('#trajPlotHost .split-item-close-btn')?.click());
  await page.waitForTimeout(800);

  // --- MD: T and T target share a row, so the legend comes back ---------------------
  await page.evaluate(async () => {
    const tp = await import('./ui/TrajectoryPanel.js');
    tp.resetLivePlot();
    tp.ensureTrajectoryPanelForLive();
    for (let step = 1; step <= 30; step++) {
      tp.feedLiveStep({
        step,
        temperatureK: 300 + 40 * Math.sin(step / 2),
        targetTemperatureK: 300,
        etotEv: -10 + step * 0.01,
        pressure: 2 * Math.sin(step / 4),
      });
    }
    tp.endLiveFeed();
  });
  await waitForChart(page, 4);
  const md = await readChart(page);
  H.check('MD plot: T, E and P in three rows, the legend shown for T / T target',
    md.rows.length === 3 && stacked(md.rows) && md.legend === true && md.labels.includes('T (K)'),
    JSON.stringify(md));
  H.check('MD plot: the ends of every row follow the streamed data (min and max labelled)',
    md.ends.every(([tmin, dmin, tmax, dmax]) => Math.abs(tmin - dmin) < 1e-9 && Math.abs(tmax - dmax) < 1e-9),
    JSON.stringify(md.ends));
  H.check('MD plot: legend, row labels and ticks do not overlap or leave the chart',
    md.overlaps.length === 0 && md.outside.length === 0, JSON.stringify(md));

  // --- a wide, short chart puts the plots side by side ------------------------------
  const standalone = async (w, h) => page.evaluate(async ({ w, h }) => {
    const { createTrajectoryPlot } = await import('./ui/TrajectoryPlot.js');
    document.getElementById('figTestHost')?.remove();
    const host = document.createElement('div');
    host.id = 'figTestHost';
    Object.assign(host.style, { position: 'fixed', left: '10px', top: '10px', width: `${w}px`, height: `${h}px`, zIndex: 99999, background: '#222' });
    document.body.appendChild(host);
    const plot = createTrajectoryPlot(host, { maxPts: 5000 });
    window.__figSeeks = [];
    plot.onSeek((f) => window.__figSeeks.push(f));
    const n = 30;
    const step = Array.from({ length: n }, (_, i) => (i + 1) * 3);
    plot.setSeries({
      step,
      etotEv: step.map((_, i) => -231 + 14 * Math.exp(-i / 3)),
      meanForce: step.map((_, i) => 4 * Math.exp(-i / 4)),
      pressure: step.map((_, i) => 18 * Math.exp(-i / 4) * Math.cos(i / 3)),
    });
    window.__figPlot = plot;
    for (let i = 0; i < 100; i++) {
      const c = host.querySelector('.js-plotly-plot');
      if (c && c.data && c.data.length === 3 && c.querySelector('.main-svg')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, { w, h });

  await standalone(1100, 260);
  const wide = await readChart(page, '#figTestHost .js-plotly-plot');
  const colsOk = wide.columns.length === 3
    && wide.columns.every((c, i) => i === 0 ? !c.matches : c.matches === 'x')
    && wide.columns.every((c, i) => i === 0 || c.domain[0] > wide.columns[i - 1].domain[1]);
  H.check('a wide, short chart (1100x260): the plots side by side, step axes zoomed together',
    wide.arrangement === 'columns' && colsOk, JSON.stringify(wide));
  H.check('side by side: each plot labels its own min and max; no overlapping or clipped text',
    labelsBoth(wide) && clean(wide), JSON.stringify(wide));
  const seekCols = await page.evaluate(async () => {
    window.__figPlot.setCursor(9);
    await new Promise((r) => setTimeout(r, 450)); // the cursor relayout is throttled
    const chart = document.querySelector('#figTestHost .js-plotly-plot');
    const cursor = (chart.layout.shapes || []).map((sh) => sh.xref);
    // A click near the right end of the THIRD plot seeks to a late frame.
    const xa = chart._fullLayout.xaxis3;
    const rect = chart.getBoundingClientRect();
    chart.dispatchEvent(new MouseEvent('click', { clientX: rect.left + xa._offset + xa._length * 0.9, clientY: rect.top + rect.height / 2, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return { cursor, seeks: window.__figSeeks };
  });
  const lastSeek = seekCols.seeks[seekCols.seeks.length - 1];
  H.check('side by side: a cursor line in every plot; a click in the third one seeks',
    JSON.stringify(seekCols.cursor) === JSON.stringify(['x', 'x2', 'x3']) && lastSeek >= 24 && lastSeek <= 29,
    JSON.stringify(seekCols));

  await standalone(380, 620);
  const tall = await readChart(page, '#figTestHost .js-plotly-plot');
  H.check('a tall chart (380x620): the plots stacked, labelled, nothing overlapping',
    tall.arrangement === 'rows' && tall.rows.length === 3 && stacked(tall.rows) && labelsBoth(tall) && clean(tall),
    JSON.stringify(tall));
  await page.evaluate(() => { window.__figPlot.remove(); document.getElementById('figTestHost')?.remove(); });

  // --- the side dock, on the right and along the bottom ------------------------------
  await feedRelax(page);
  await sideDock(page, 'right');
  const right = await readChart(page);
  H.check('side dock on the right: stacked rows, min and max labelled, nothing overlapping',
    right.arrangement === 'rows' && labelsBoth(right) && clean(right), JSON.stringify(right));
  await sideDock(page, 'bottom');
  const bottom = await readChart(page);
  H.check('side dock along the bottom: side by side, min and max labelled, nothing overlapping',
    bottom.arrangement === 'columns' && labelsBoth(bottom) && clean(bottom), JSON.stringify(bottom));

  H.check('no page errors', errors.length === 0, errors[0] || '');

  // --- a phone: the side dock is a bottom sheet (portrait) or a right pane ------------
  for (const [label, w, h, expect] of [['portrait', 390, 844, 'rows'], ['landscape', 844, 390, 'columns']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(async () => (await import('./ui/panels/PanelManager.js')).setPhoneScreenOverride(true));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
    await feedRelax(page);
    await sideDock(page, null);
    const docked = await readChart(page);
    H.check(`phone ${label}, side-docked: a readable chart (>= 150px tall), nothing overlapping`,
      docked.chartH >= 150 && labelsBoth(docked) && clean(docked), JSON.stringify(docked));
    await fullscreen(page, true);
    const full = await readChart(page);
    H.check(`phone ${label}, fullscreen: ${expect === 'rows' ? 'stacked' : 'side by side'}, nothing overlapping`,
      full.arrangement === expect && labelsBoth(full) && clean(full), JSON.stringify(full));
    await fullscreen(page, false);
  }

  H.check('no page errors on the phone', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
