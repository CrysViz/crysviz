// The plot's x-axis should read the real MD/relax STEP number (a multiple of
// the save stride, e.g. 2,4,6,…), not the 1-based frame index. Live feed carries
// point.step; replay carries a reserved `step` array. Cursor + seek map through
// the step values, not the index.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async () => {
    const { createTrajectoryPlot } = await import('./ui/TrajectoryPlot.js');
    async function waitChart(host) {
      for (let i = 0; i < 80; i++) {
        const c = host.querySelector('.js-plotly-plot');
        if (c && c.data && c.data.length) return c;
        await new Promise((r) => setTimeout(r, 100));
      }
      return host.querySelector('.js-plotly-plot');
    }

    // --- live feed with stride-2 steps ---
    const hostA = document.createElement('div');
    hostA.style.width = '480px'; hostA.style.height = '260px';
    document.body.appendChild(hostA);
    const seeks = [];
    const live = createTrajectoryPlot(hostA, {});
    live.onSeek((f) => seeks.push(f));
    for (let s = 2; s <= 10; s += 2) live.update({ step: s, temperatureK: 300 + s, etotEv: -10 + s * 0.01 });
    const cLive = await waitChart(hostA);
    const liveX = cLive.data[0].x.slice();
    const liveTitle = cLive.layout.xaxis.title.text;
    // cursor at frame index 2 -> step 6
    live.setCursor(2);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
    const cursorX = cLive.layout.shapes?.[0]?.x0 ?? null;
    // click near the far right -> nearest step is the last frame index
    const xa = cLive._fullLayout.xaxis;
    const rect = cLive.getBoundingClientRect();
    cLive.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + (xa._offset || 0) + (xa._length || 0) * 0.98,
      clientY: rect.top + rect.height / 2, bubbles: true,
    }));
    await new Promise((r) => setTimeout(r, 30));
    live.remove();

    // --- replay via setSeries with a reserved step array ---
    const hostB = document.createElement('div');
    hostB.style.width = '480px'; hostB.style.height = '260px';
    document.body.appendChild(hostB);
    const replay = createTrajectoryPlot(hostB, {});
    replay.setSeries({ step: [0, 5, 10, 15], etotEv: [-9, -9.2, -9.4, -9.6] });
    const cReplay = await waitChart(hostB);
    const replayX = cReplay.data[0].x.slice();
    const replayTitle = cReplay.layout.xaxis.title.text;
    const replayTraceNames = cReplay.data.map((t) => t.name);
    replay.remove();

    return { liveX, liveTitle, cursorX, seeks, replayX, replayTitle, replayTraceNames };
  });

  H.check('live x-axis holds real step numbers (2,4,6,8,10)',
    JSON.stringify(res.liveX) === JSON.stringify([2, 4, 6, 8, 10]), JSON.stringify(res.liveX));
  H.check('x-axis titled "Step" for stepped data', res.liveTitle === 'Step', res.liveTitle);
  H.check('cursor at frame index 2 sits at step 6', res.cursorX === 6, JSON.stringify(res));
  H.check('click near the end seeks the last frame index (4)',
    res.seeks.length >= 1 && res.seeks[res.seeks.length - 1] === 4, JSON.stringify(res.seeks));
  H.check('replay x uses the reserved step array (0,5,10,15)',
    JSON.stringify(res.replayX) === JSON.stringify([0, 5, 10, 15]), JSON.stringify(res.replayX));
  H.check('replay does not plot `step` as a series', !res.replayTraceNames.includes('step'), JSON.stringify(res.replayTraceNames));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
