// During a live MD/relax run the plot streams every saved frame. The transport
// (slider + "N / N" indicator) must track that growth too — previously it froze
// at whatever count the last panel rebuild saw, so the number under the slider
// disagreed with the plot (e.g. slider 135 while the plot showed 176 samples).
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();

  const res = await page.evaluate(async () => {
    const { openPanel } = await import('./ui/panels/PanelManager.js');
    const { fileBrowser, structureShip } = await import('./state/store.js');
    const { StructureContainer } = await import('./model/StructureContainer.js');
    const tp = await import('./ui/TrajectoryPanel.js');

    // A live-MD-style container, selected, starting with a seed frame.
    const seed = fileBrowser.selectedStructure;
    const live = new StructureContainer({ fileName: 'live', structures: [seed] });
    live.plotSeries = { temperatureK: [NaN], etotEv: [NaN] };
    structureShip.container.push(live);
    fileBrowser.selectedRowIndex = structureShip.container.length - 1;

    tp.resetLivePlot();
    tp.ensureTrajectoryPanelForLive();
    await new Promise((r) => setTimeout(r, 200));

    const sliderMaxAt = [];
    // Emulate the MD loop: each saved step pushes a frame then feeds the plot.
    for (let s = 1; s <= 30; s++) {
      live.structures.push(seed);
      tp.feedLiveStep({ step: s, temperatureK: 300 + s, etotEv: -10 + s * 0.01 });
      const slider = document.getElementById('frameSlider');
      sliderMaxAt.push(Number(slider?.max));
    }

    const slider = document.getElementById('frameSlider');
    const ind = document.getElementById('frameIndicator');
    return {
      frames: live.structures.length,          // 1 seed + 30 = 31
      sliderMax: Number(slider?.max),          // should be frames - 1 = 30
      indicatorTotal: ind?.querySelector('.tfTot')?.textContent,
      grew: sliderMaxAt[0] < sliderMaxAt[sliderMaxAt.length - 1],
    };
  });

  H.check('slider max tracks the growing live trajectory', res.sliderMax === res.frames - 1, JSON.stringify(res));
  H.check('slider grew across the run (did not freeze)', res.grew, JSON.stringify(res));
  H.check('frame indicator total matches the frame count', String(res.indicatorTotal) === String(res.frames), JSON.stringify(res));
  H.check('no page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
