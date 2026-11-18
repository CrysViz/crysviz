// TrajectoryPlot.setSeries must not hand Plotly a 100k-point trace. A
// compute-stats / replay path can produce one series value per frame; each
// Plotly relayout redraws every point (10-15 ms), so a long run made the whole
// panel jerk. setSeries now decimates to at most `maxPts` samples, keeping the
// final frame, and maps the cursor/seek between original frame indices and the
// decimated sample space.
//
// Plotly's CDN is blocked in this harness, so the plot is created with a
// recorder stub (the `plotly` option) that captures what react() is drawn.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  const res = await page.evaluate(async () => {
    const { createTrajectoryPlot } = await import('./ui/TrajectoryPlot.js');

    // A minimal Plotly-like recorder. react() captures the traces it is asked
    // to draw and installs a controllable x-axis pixel->data map so a click can
    // be steered to a known step.
    const rec = { traces: null, dataX: 0 };
    const stub = {
      react(div, traces) {
        rec.traces = traces;
        div._fullLayout = { xaxis: { p2d: () => rec.dataX, _offset: 0, _length: 1e9 } };
        return Promise.resolve();
      },
      relayout() { return Promise.resolve(); },
      extendTraces() { return Promise.resolve(); },
      newPlot() { return Promise.resolve(); },
      purge() {},
      Plots: { resize() {} },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const plot = createTrajectoryPlot(host, { maxPts: 5000, plotly: stub });

    // 100k samples: a ramp so the decimated endpoint is checkable, with steps
    // at twice the frame index so the x-axis is non-unit spaced.
    const N = 100000;
    const etotEv = new Array(N);
    const steps = new Array(N);
    for (let i = 0; i < N; i++) { etotEv[i] = i; steps[i] = i * 2; }

    plot.setSeries({ etotEv }, { steps });
    await new Promise((r) => setTimeout(r, 50)); // let the async drawFull land

    const trace = rec.traces && rec.traces[0];
    const yLen = trace ? trace.y.length : -1;
    const xLen = trace ? trace.x.length : -1;
    const lastY = trace ? trace.y[trace.y.length - 1] : null;
    const lastX = trace ? trace.x[trace.x.length - 1] : null;
    const statsText = host.querySelector('.trajPlotStats').textContent;

    // Seek: steer the (stubbed) axis to step 40000 == original frame 20000 and
    // click; onSeek must report the ORIGINAL frame index, not the decimated one.
    let seeked = null;
    plot.onSeek((f) => { seeked = f; });
    rec.dataX = 40000; // step value -> nearest kept sample -> frame 20000
    const plotDiv = host.querySelector('.js-plotly-plot') || host.querySelector('div');
    // The click handler is wired on the plot's inner div; dispatch on the div
    // react() drew into (the one carrying _fullLayout).
    let target = null;
    host.querySelectorAll('div').forEach((d) => { if (d._fullLayout) target = d; });
    if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 3000, clientY: 30 }));

    // A tiny trajectory (below maxPts) must not decimate and shows no note.
    const plot2 = createTrajectoryPlot(document.body.appendChild(document.createElement('div')), { maxPts: 5000, plotly: stub });
    plot2.setSeries({ etotEv: [1, 2, 3, 4] });
    await new Promise((r) => setTimeout(r, 50));
    const smallLen = rec.traces[0].y.length;

    plot.remove();
    plot2.remove();
    return { N, yLen, xLen, lastY, lastX, statsText, seeked, smallLen };
  });

  console.log(`  ${res.N} samples -> trace length ${res.yLen}; stats: "${res.statsText}"`);
  H.check('a 100k-sample trace is decimated to <= maxPts', res.yLen > 0 && res.yLen <= 5000 && res.xLen === res.yLen,
    JSON.stringify({ yLen: res.yLen, xLen: res.xLen }));
  H.check('the final frame is preserved as the last point',
    res.lastY === res.N - 1 && res.lastX === (res.N - 1) * 2, JSON.stringify({ lastY: res.lastY, lastX: res.lastX }));
  H.check('the decimation note is shown', /every \d+\w+ step/.test(res.statsText), res.statsText);
  H.check('a click reports the ORIGINAL frame index (decimated -> frame mapped)',
    res.seeked === 20000, `seeked=${res.seeked}`);
  H.check('a short series is not decimated and shows no note', res.smallLen === 4, String(res.smallLen));

  H.check('no page errors', errors.filter((e) => !/esm\.sh|Failed to load resource/.test(e)).length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
