// Plotly trajectory plot: the playback cursor (setCursor) draws a vertical
// layout shape at the current frame, and clicking the plot seeks the trajectory
// (onSeek) — the two directions of scrubber<->plot sync. Also checks the
// pressure convention (the mean of the diagonal, not the raw trace or minus it).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async () => {
    const { createTrajectoryPlot } = await import('./ui/TrajectoryPlot.js');
    const host = document.createElement('div');
    host.style.width = '480px';
    host.style.height = '260px';
    document.body.appendChild(host);

    const seeks = [];
    const plot = createTrajectoryPlot(host, { maxPts: 5000 });
    plot.onSeek((f) => seeks.push(f));
    plot.setSeries({ etotEv: [-10, -9.8, -9.6, -9.4, -9.2, -9.0, -8.8] });

    // wait for the Plotly draw
    let chart = null;
    for (let i = 0; i < 80; i++) {
      chart = host.querySelector('.js-plotly-plot');
      if (chart && chart.data && chart.data.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Cursor: set to frame 3 and let the rAF-throttled relayout land.
    plot.setCursor(3);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
    const shapes = chart?.layout?.shapes || [];
    const cursorX = shapes.length ? shapes[0].x0 : null; // 1-based frame

    // Seek: synthesize a click near the right end of the plotting area and
    // confirm onSeek fires with a plausible late-frame index.
    const fl = chart._fullLayout;
    const xa = fl.xaxis;
    const rect = chart.getBoundingClientRect();
    const px = rect.left + (xa._offset || 0) + (xa._length || 0) * 0.9;
    const py = rect.top + rect.height / 2;
    chart.dispatchEvent(new MouseEvent('click', { clientX: px, clientY: py, bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

    plot.remove();
    return { cursorX, seeks, nFrames: 7 };
  });

  H.check('setCursor draws a vertical cursor shape at the frame (1-based x=4 for frame idx 3)',
    res.cursorX === 4, JSON.stringify(res));
  H.check('clicking the plot fires onSeek with a late-frame index',
    res.seeks.length >= 1 && res.seeks[res.seeks.length - 1] >= 4 && res.seeks[res.seeks.length - 1] <= 6,
    JSON.stringify(res));

  // Pressure convention: (S_xx+S_yy+S_zz)/3 of the compression-positive stress,
  // not the raw trace and with no minus sign.
  const press = await page.evaluate(async () => {
    const { pressureEvA3 } = await import('./model/index.js');
    return { mean: pressureEvA3([[3, 0, 0], [0, 6, 0], [0, 0, 9]]) };
  });
  H.check('pressure = +trace/3 (6, not 18 or -6)', press.mean === 6, JSON.stringify(press));

  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
