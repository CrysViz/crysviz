// The bond-length double range slider's colored fill (.range-track) must
// line up with where the thumbs actually sit — a plain 0-100% overlay drifts
// from the thumb centers near the ends because a native range thumb can
// never travel past thumbWidth/2 from either edge.
'use strict';
const H = require('../harness');

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);

  await page.evaluate(async () => {
    const { setStructurePanelOpen } = await import('./ui/StructureInfoPanel/General.js');
    setStructurePanelOpen(true);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.segmented-control button, button')]
      .find((b) => b.dataset.mode === 'bonds');
    btn?.click();
  });
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const sliderContainer = document.querySelector('.bond-range-slider');
    const track = sliderContainer?.querySelector('.range-track');
    const minInput = sliderContainer?.querySelectorAll('input[type="range"]')[0];
    const maxInput = sliderContainer?.querySelectorAll('input[type="range"]')[1];
    if (!sliderContainer || !track || !minInput || !maxInput) {
      return { found: false };
    }
    // Push both sliders to their extremes so the thumbs sit at their true
    // travel limits (inset by half their own width from the container edge).
    minInput.value = '0';
    minInput.dispatchEvent(new Event('input'));
    maxInput.value = '6';
    maxInput.dispatchEvent(new Event('input'));

    const containerRect = sliderContainer.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const minInputRect = minInput.getBoundingClientRect();
    const maxInputRect = maxInput.getBoundingClientRect();
    // The visible fill's left/right edge should land at the thumb's actual
    // travel-limit inset (half the thumb's own width), not flush at 0/100%
    // of the container (which is where the OLD percent-based math put it).
    const thumbWidth = 16;
    const expectedLeft = containerRect.left + thumbWidth / 2;
    const expectedRight = containerRect.right - thumbWidth / 2;
    return {
      found: true,
      leftGap: Math.abs(trackRect.left - expectedLeft),
      rightGap: Math.abs(trackRect.right - expectedRight),
      containerWidth: containerRect.width,
    };
  });

  H.check('bond-range-slider found', result.found, JSON.stringify(result));
  H.check('fill left edge aligns with the min thumb\'s travel limit',
    result.leftGap < 1.5, JSON.stringify(result));
  H.check('fill right edge aligns with the max thumb\'s travel limit',
    result.rightGap < 1.5, JSON.stringify(result));

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);
